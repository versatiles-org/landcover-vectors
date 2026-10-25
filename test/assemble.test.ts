// A block tiles itself, so its tileset must hold exactly its own tiles: tippecanoe also writes the neighbours'
// tiles the margin reaches into, and a join would then find two blocks claiming one tile. These run the real
// tippecanoe on a rectangle.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { tileBlock, tileCount, joinTilesets } from '../lib/assemble.ts';
import { blockWindow } from '../config.ts';

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

describe('tileBlock', () => {
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
});

describe('joinTilesets', () => {
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
		const { west, north } = blockWindow(5, 1, 2).innerLonLat;
		const { east, south } = blockWindow(5, 2, 2).innerLonLat;
		assert.deepEqual(
			meta.bounds.split(',').map(Number),
			[west, south, east, north].map((v) => Number(v.toFixed(6))),
		);
		assert.deepEqual(JSON.parse(meta.json).vector_layers, [
			{ id: 'land', minzoom: 5, maxzoom: 5, fields: { kind: 'String' }, description: '' },
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
	});

	test('two blocks claiming one tile is an error, not a silent overwrite', async () => {
		const a = await block(5, 1, 2);
		await assert.rejects(joinTilesets([a, a], path.join(tmp, 'dup.mbtiles')), /UNIQUE/);
	});
});
