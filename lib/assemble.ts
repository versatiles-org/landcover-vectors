// Tile every block on its own, then join all their tiles and pack.
//
// A block tiles itself: one tippecanoe run over its land/water polygons → a small mbtiles of just its own tiles,
// which is also the block's cache entry. The tiles on a block's edge get their buffer from the block's own margin
// (lib/block.ts), so no tile needs a neighbour's polygons, and the blocks of a zoom never have to meet in one big
// file. Blocks never share a tile, so joining them is a plain copy of rows into one mbtiles, which
// `versatiles convert` packs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { run, runQuiet, atomic } from './worldcover.ts';
import { file, meta, SCHEMA, TIPPECANOE_ARGS } from '../config.ts';

export type TileRange = { x0: number; y0: number; x1: number; y1: number }; // XYZ, x1/y1 exclusive
export type Layer = { name: 'land' | 'water_polygons'; file: string };

// Tile block polygons at zoom z → `out`, an mbtiles holding only the tiles of `range`. tippecanoe also writes
// tiles just outside the block, wherever the margin reaches into them; those belong to the neighbours.
export async function tileBlock(z: number, range: TileRange, layers: Layer[], out: string, tmpdir: string) {
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

// Join the block tilesets (disjoint tiles) into one mbtiles at `out`, in the order given, and write its metadata:
// the zoom range, the bounds of the tiles, and the vector layers the blocks declare.
export async function joinTilesets(tilesets: string[], out: string): Promise<void> {
	if (tilesets.length === 0) throw new Error('nothing to join — no block produced any tiles');
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

			const range = db.prepare('SELECT min(zoom_level) AS minzoom, max(zoom_level) AS maxzoom FROM tiles').get() as {
				minzoom: number | null;
				maxzoom: number | null;
			};
			if (range.maxzoom === null) throw new Error('nothing to join — the blocks hold no tiles');
			const { minzoom, maxzoom } = range as { minzoom: number; maxzoom: number };
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
				version: '2',
				type: 'overlay',
				format: 'pbf',
				minzoom: String(minzoom),
				maxzoom: String(maxzoom),
				bounds: bounds.map(fixed).join(','),
				center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2].map(fixed).join(',') + `,${minzoom}`,
				json: JSON.stringify({ vector_layers: [...layers.values()].map((l) => ({ ...l, description: '' })) }),
			}))
				insert.run(name, value);
		} finally {
			db.close();
		}
	});
}

// join every block's tiles and pack them into a brotli versatiles container (the build's final step).
// The container declares Shortbread explicitly: it writes Shortbread's own layer names and `kind` values,
// which is the whole point, and tippecanoe has no way to say so — without this it ships as "other" and a
// consumer cannot tell that a stock Shortbread style already fits.
export async function pack(tilesets: string[]): Promise<void> {
	await joinTilesets(tilesets, file.tiles);
	await fs.rm(file.container, { force: true });
	const pipeline = `[,vpl](from_container filename="${file.tiles}" | meta_update schema="${SCHEMA}")`;
	await run('versatiles', 'convert', ['-c', 'brotli'], pipeline, file.container);
}
