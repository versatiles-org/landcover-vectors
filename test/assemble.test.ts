// A block tiles itself, so its tileset must hold exactly its own tiles: tippecanoe also writes the neighbours'
// tiles the margin reaches into, and a join would then find two blocks claiming one tile. These run the real
// tippecanoe on a rectangle, so they are skipped where it is not installed (CI).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { tileBlock, tileCount, joinTilesets, containerMeta, gitCommit, readJoined } from '../lib/assemble.ts';
import { skipWithout } from './tools.ts';
import { blockWindow, meta as tilesetMeta, SCHEMA } from '../config.ts';

const skip = await skipWithout('tippecanoe', 'ogrinfo');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-assemble-'));
after(() => fs.rm(tmp, { recursive: true, force: true }));

// a block's window as one polygon of `kind` in EPSG:3857, the way the uniform branch emits it
async function windowPolygon(z: number, bx: number, by: number, kind: string): Promise<string> {
	const { minx, miny, maxx, maxy } = blockWindow(z, bx, by).window3857;
	const file = path.join(tmp, `z${z}_${bx}_${by}.geojson`);
	const ring = [
		[minx, miny],
		[maxx, miny],
		[maxx, maxy],
		[minx, maxy],
		[minx, miny],
	];
	const feature = { type: 'Feature', properties: { kind }, geometry: { type: 'Polygon', coordinates: [ring] } };
	await fs.writeFile(file, JSON.stringify({ type: 'FeatureCollection', features: [feature] }));
	return file;
}

const rows = (db: string, sql: string) => {
	const d = new DatabaseSync(db, { readOnly: true });
	try {
		return d.prepare(sql).all();
	} finally {
		d.close();
	}
};

async function block(z: number, bx: number, by: number): Promise<string> {
	const out = path.join(tmp, `z${z}_${bx}_${by}.mbtiles`);
	const layer = { name: 'land' as const, file: await windowPolygon(z, bx, by, 'forest') };
	await tileBlock(z, blockWindow(z, bx, by).tiles, [layer], out, tmp);
	return out;
}

describe('tileBlock', { skip }, () => {
	test("keeps the block's own tiles and none of the neighbours' the margin reaches into", async () => {
		const out = await block(5, 1, 2); // an interior block: its margin reaches into all eight neighbours
		const tiles = rows(out, 'SELECT tile_column AS x, 31 - tile_row AS y FROM tiles') as { x: number; y: number }[];
		assert.equal(tiles.length, 64);
		assert.ok(tiles.every(({ x, y }) => x >= 8 && x < 16 && y >= 16 && y < 24));
	});

	test('a block with nothing to show still leaves a tileset behind, so a rerun skips it', async () => {
		const out = path.join(tmp, 'empty.mbtiles');
		await tileBlock(5, blockWindow(5, 0, 0).tiles, [], out, tmp);
		assert.equal(tileCount(out), 0);
	});

	test('an empty layer is left out, and with no layer left the tileset is empty', async () => {
		const empty = path.join(tmp, 'nothing.geojson');
		await fs.writeFile(empty, JSON.stringify({ type: 'FeatureCollection', features: [] }));
		const range = blockWindow(5, 1, 2).tiles;
		const some = path.join(tmp, 'some.mbtiles');
		const land = { name: 'land' as const, file: await windowPolygon(5, 1, 2, 'forest') };
		await tileBlock(5, range, [land, { name: 'water_polygons', file: empty }], some, tmp);
		assert.equal(tileCount(some), 64);
		const none = path.join(tmp, 'none-left.mbtiles');
		await tileBlock(5, range, [{ name: 'water_polygons', file: empty }], none, tmp);
		assert.equal(tileCount(none), 0);
	});

	test('joining nothing but empty tilesets writes nothing and says so', async () => {
		const out = path.join(tmp, 'none.mbtiles');
		assert.equal(await joinTilesets([path.join(tmp, 'empty.mbtiles')], out), false);
		await assert.rejects(fs.stat(out));
	});
});

describe('joinTilesets', { skip }, () => {
	test("copies every block's tiles and describes them", async () => {
		const a = await block(5, 1, 2);
		const b = await block(5, 2, 2);
		const out = path.join(tmp, 'joined.mbtiles');
		await joinTilesets([a, b, path.join(tmp, 'empty.mbtiles')], out);
		assert.equal(tileCount(out), 128);
		const meta = Object.fromEntries(
			(rows(out, 'SELECT name, value FROM metadata') as { name: string; value: string }[]).map((r) => [
				r.name,
				r.value,
			]),
		);
		assert.equal(meta.minzoom, '5');
		assert.equal(meta.maxzoom, '5');
		assert.equal(meta.format, 'pbf');
		assert.equal(meta.name, tilesetMeta.name);
		assert.equal(meta.version, tilesetMeta.version);
		const { west, north } = blockWindow(5, 1, 2).innerLonLat;
		const { east, south } = blockWindow(5, 2, 2).innerLonLat;
		assert.deepEqual(
			meta.bounds.split(',').map(Number),
			[west, south, east, north].map((v) => Number(v.toFixed(6))),
		);
		assert.deepEqual(JSON.parse(meta.json).vector_layers, [
			{ id: 'land', minzoom: 5, maxzoom: 5, fields: { kind: 'String' }, description: tilesetMeta.layers.land },
		]);
	});

	test('the bounds cover every zoom, the coarse ones reaching further', async () => {
		const out = path.join(tmp, 'zooms.mbtiles');
		await joinTilesets([await block(5, 1, 2), await block(6, 2, 4)], out);
		const meta = Object.fromEntries(
			(rows(out, 'SELECT name, value FROM metadata') as { name: string; value: string }[]).map((r) => [
				r.name,
				r.value,
			]),
		);
		const { west, south, east, north } = blockWindow(5, 1, 2).innerLonLat;
		assert.deepEqual(
			meta.bounds.split(',').map(Number),
			[west, south, east, north].map((v) => Number(v.toFixed(6))),
		);
		assert.equal(meta.minzoom, '5');
		assert.equal(meta.maxzoom, '6');
		// what pack reads back for the container's metadata
		const joined = readJoined(out);
		assert.deepEqual(joined.bounds, meta.bounds.split(',').map(Number));
		assert.deepEqual([joined.minzoom, joined.maxzoom], [5, 6]);
		assert.deepEqual(joined.vector_layers, JSON.parse(meta.json).vector_layers);
	});

	test('two blocks claiming one tile is an error, not a silent overwrite', async () => {
		const a = await block(5, 1, 2);
		await assert.rejects(joinTilesets([a, a], path.join(tmp, 'dup.mbtiles')), /UNIQUE/);
	});
});

describe('container metadata', () => {
	test('is the whole TileJSON: config, schema, the joined extent and layers, and the build it came from', () => {
		const buildtime = new Date('2026-10-25T22:35:25.493Z');
		const joined = {
			bounds: [-180, -85.051129, 180, 85.051129],
			minzoom: 0,
			maxzoom: 10,
			vector_layers: [{ id: 'land' }],
		};
		assert.deepEqual(containerMeta(joined, { fingerprint: 'ce387963', commit: 'abc123', buildtime }), {
			tilejson: '3.0.0',
			name: tilesetMeta.name,
			description: tilesetMeta.description,
			attribution: tilesetMeta.attribution,
			version: tilesetMeta.version,
			type: 'overlay',
			tile_schema: SCHEMA,
			bounds: joined.bounds,
			center: tilesetMeta.center,
			minzoom: 0,
			maxzoom: 10,
			vector_layers: joined.vector_layers,
			'landcover:fingerprint': 'ce387963',
			'landcover:githash': 'abc123',
			'landcover:buildtime': '2026-10-25T22:35:25.493Z',
		});
		// outside a git checkout there is no commit to name, and no key that pretends otherwise
		const noCommit = containerMeta(joined, { fingerprint: 'ce387963', commit: null, buildtime });
		assert.ok(!('landcover:githash' in noCommit));
	});

	test('the commit is read from this checkout, and is null outside one', async () => {
		assert.match((await gitCommit()) ?? '', /^[0-9a-f]{40}(-dirty)?$/);
		assert.equal(await gitCommit(tmp), null);
	});

	test('every layer the tiles have is described', () => {
		assert.deepEqual(Object.keys(tilesetMeta.layers).sort(), ['land', 'water_polygons']);
	});
});
