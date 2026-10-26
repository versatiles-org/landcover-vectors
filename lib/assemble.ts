// Tile every block on its own, join each zoom's blocks, then join the zooms and pack.
//
// A block tiles itself: one tippecanoe run over its land/water polygons → a small mbtiles of just its own tiles,
// which is also the block's cache entry. The tiles on a block's edge get their buffer from the block's own margin
// (lib/block.ts), so no tile needs a neighbour's polygons, and the blocks of a zoom never have to meet in one big
// file of polygons. Blocks never share a tile, so joining them is a plain copy of rows: into one mbtiles per zoom
// once its blocks are done (lib/pipeline.ts), and the zooms into one at the end, which `versatiles convert` packs.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { run, runQuiet, runCapture, atomic } from './worldcover.ts';
import { file, meta, SCHEMA, TIPPECANOE_ARGS } from '../config.ts';

const execFileAsync = promisify(execFile);

export type TileRange = { x0: number; y0: number; x1: number; y1: number }; // XYZ, x1/y1 exclusive
export type Layer = { name: 'land' | 'water_polygons'; file: string };

// Tile block polygons at zoom z → `out`, an mbtiles holding only the tiles of `range`. tippecanoe also writes
// tiles just outside the block, wherever the margin reaches into them; those belong to the neighbours.
export async function tileBlock(z: number, range: TileRange, all: Layer[], out: string, tmpdir: string) {
	// tippecanoe refuses a run without any geometry, so empty layers are left out: a kind the histogram saw can
	// still be gone, under OSM's sea or sieved away (z8_21_16 held nothing but no-data in the end)
	const layers: Layer[] = [];
	for (const l of all) if ((await featureCount(l.file)) > 0) layers.push(l);
	if (layers.length === 0) return emptyTileset(out);
	await atomic(out, async (tmp) => {
		await runQuiet(
			'tippecanoe',
			['-o', tmp],
			'--force',
			'--quiet',
			['-t', tmpdir],
			['-Z', z],
			['-z', z],
			TIPPECANOE_ARGS.flat(),
			layers.map((l) => ['-L', `${l.name}:${l.file}`]).flat(),
		);
		const db = new DatabaseSync(tmp);
		try {
			const n = 2 ** z;
			// mbtiles rows count from the bottom (TMS): XYZ row y is n-1-y
			db.prepare(
				'DELETE FROM map WHERE zoom_level != ? OR tile_column < ? OR tile_column >= ? OR tile_row < ? OR tile_row >= ?',
			).run(z, range.x0, range.x1, n - range.y1, n - range.y0);
			db.exec('DELETE FROM images WHERE tile_id NOT IN (SELECT tile_id FROM map)');
		} finally {
			db.close();
		}
	});
}

// how many features the (single) layer of a vector file holds
async function featureCount(file: string): Promise<number> {
	const info = JSON.parse(await runCapture('ogrinfo', '-json', '-so', '-al', file));
	return info.layers?.[0]?.featureCount ?? 0;
}

// how many tiles a tileset holds
export function tileCount(tileset: string): number {
	const db = new DatabaseSync(tileset, { readOnly: true });
	try {
		return (db.prepare('SELECT count(*) AS n FROM tiles').get() as { n: number }).n;
	} finally {
		db.close();
	}
}

// a block with nothing to show still gets a tileset, so a rerun knows it is done
async function emptyTileset(out: string): Promise<void> {
	await atomic(out, async (tmp) => {
		const db = new DatabaseSync(tmp);
		try {
			db.exec(`CREATE TABLE metadata (name text, value text);
				CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);`);
		} finally {
			db.close();
		}
	});
}

// Join tilesets of disjoint tiles (a zoom's blocks, or the zooms) into one mbtiles at `out`, in the order given,
// and write its metadata: the zoom range, the bounds of the tiles, and the vector layers the inputs declare.
// False, and nothing written, if the inputs hold no tiles at all.
export async function joinTilesets(tilesets: string[], out: string): Promise<boolean> {
	if (!tilesets.some((t) => tileCount(t) > 0)) return false;
	await fs.mkdir(path.dirname(out), { recursive: true });
	await atomic(out, async (tmp) => {
		const db = new DatabaseSync(tmp);
		try {
			db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
				CREATE TABLE metadata (name text, value text);
				CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);
				CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);`);
			const layers = new Map<string, { id: string; minzoom: number; maxzoom: number; fields: object }>();
			const attach = db.prepare('ATTACH DATABASE ? AS b');
			for (const ts of tilesets) {
				attach.run(ts);
				// a duplicate tile would mean two blocks claim one tile — the unique index makes that an error
				db.exec('INSERT INTO tiles SELECT zoom_level, tile_column, tile_row, tile_data FROM b.tiles');
				const json = db.prepare("SELECT value FROM b.metadata WHERE name = 'json'").get() as
					{ value: string } | undefined;
				for (const l of json ? (JSON.parse(json.value).vector_layers ?? []) : []) {
					const seen = layers.get(l.id);
					layers.set(l.id, {
						id: l.id,
						minzoom: Math.min(seen?.minzoom ?? l.minzoom, l.minzoom),
						maxzoom: Math.max(seen?.maxzoom ?? l.maxzoom, l.maxzoom),
						fields: { ...seen?.fields, ...l.fields },
					});
				}
				db.exec('DETACH DATABASE b');
			}

			const { minzoom, maxzoom } = db
				.prepare('SELECT min(zoom_level) AS minzoom, max(zoom_level) AS maxzoom FROM tiles')
				.get() as { minzoom: number; maxzoom: number };
			// bounds: the extent of the tiles over all zooms (a coarse zoom's tiles reach further than a fine one's)
			const extents = db
				.prepare(
					'SELECT zoom_level AS z, min(tile_column) AS x0, max(tile_column) AS x1, min(tile_row) AS r0, max(tile_row) AS r1 FROM tiles GROUP BY zoom_level',
				)
				.all() as { z: number; x0: number; x1: number; r0: number; r1: number }[];
			const lon = (x: number, n: number) => (x / n) * 360 - 180;
			const lat = (row: number, n: number) =>
				(Math.atan(Math.sinh(Math.PI * (1 - (2 * (n - row)) / n))) * 180) / Math.PI;
			const boxes = extents.map(({ z, x0, x1, r0, r1 }) => {
				const n = 2 ** z;
				return [lon(x0, n), lat(r0, n), lon(x1 + 1, n), lat(r1 + 1, n)];
			});
			const bounds = [
				Math.min(...boxes.map((b) => b[0])),
				Math.min(...boxes.map((b) => b[1])),
				Math.max(...boxes.map((b) => b[2])),
				Math.max(...boxes.map((b) => b[3])),
			];
			const fixed = (v: number) => v.toFixed(6);

			const insert = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
			for (const [name, value] of Object.entries({
				name: meta.name,
				description: meta.description,
				attribution: meta.attribution,
				version: meta.version,
				type: 'overlay',
				format: 'pbf',
				minzoom: String(minzoom),
				maxzoom: String(maxzoom),
				bounds: bounds.map(fixed).join(','),
				center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2].map(fixed).join(',') + `,${minzoom}`,
				json: JSON.stringify({
					vector_layers: [...layers.values()].map((l) => ({ ...l, description: meta.layers[l.id] ?? '' })),
				}),
			}))
				insert.run(name, value);
		} finally {
			db.close();
		}
	});
	return true;
}

// Which build a container came from: its config fingerprint, the commit it was built from, and when.
export type Provenance = { fingerprint: string; commit: string | null; buildtime: Date };

// What pack lays over the joined tileset's metadata: the center to open at (the joined one is just the middle of
// the bounds), and the provenance, as `landcover:*` keys next to the `planetiler:*` ones of osm.versatiles.
export function containerMeta(p: Provenance): Record<string, unknown> {
	return {
		center: meta.center,
		'landcover:fingerprint': p.fingerprint,
		...(p.commit ? { 'landcover:githash': p.commit } : {}),
		'landcover:buildtime': p.buildtime.toISOString(),
	};
}

// the commit HEAD points at, marked "-dirty" when tracked files differ from it; null outside a git checkout
export async function gitCommit(cwd = path.resolve(import.meta.dirname, '..')): Promise<string | null> {
	try {
		const git = async (...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();
		const head = await git('rev-parse', 'HEAD');
		return (await git('status', '--porcelain', '--untracked-files=no')) ? `${head}-dirty` : head;
	} catch {
		return null;
	}
}

// join the per-zoom tilesets and pack them into a brotli versatiles container (the build's final step).
// The container declares Shortbread explicitly: it writes Shortbread's own layer names and `kind` values,
// which is the whole point, and tippecanoe has no way to say so — without this it ships as "other" and a
// consumer cannot tell that a stock Shortbread style already fits.
export async function pack(zooms: string[], provenance: Provenance, tmpdir: string): Promise<void> {
	if (!(await joinTilesets(zooms, file.tiles))) throw new Error('nothing to pack — no zoom produced any tiles');
	await fs.rm(file.container, { force: true });
	// custom keys survive only as a TileJSON update: versatiles reads just the standard ones from an mbtiles
	const update = path.join(tmpdir, 'container-meta.json');
	await fs.writeFile(update, JSON.stringify(containerMeta(provenance)));
	const pipeline =
		`[,vpl](from_container filename="${file.tiles}"` +
		` | meta_update schema="${SCHEMA}" tilejson_update_file="${update}")`;
	await run('versatiles', 'convert', ['-c', 'brotli'], pipeline, file.container);
}
