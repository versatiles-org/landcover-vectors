// OSM's land use burned into ESA's classes (lib/landburn.ts): burns go in order, later over earlier, only the
// burned kinds count, and the world, built tile by tile, is the source with every burn in it — tiles without land
// use left to the source. Runs the real GDAL tools on a tiny synthetic world, so it is skipped without them.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { skipWithout } from './tools.ts';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-landburn-'));
process.env.LANDCOVER_SOURCE_DIR = tmp; // config.ts reads it on import, so import everything after this
after(() => fs.rm(tmp, { recursive: true, force: true }));

const { runQuiet } = await import('../lib/worldcover.ts');
const { burnLand, buildClasses } = await import('../lib/landburn.ts');
const { readBytes } = await import('../lib/inspect.ts');
const { MERC } = await import('../config.ts');

const skip = await skipWithout('gdal_create', 'gdal_rasterize', 'ogr2ogr', 'gdal_calc.py');

const PX = 64; // a 64² px world, in 4×4 tiles of 16 px
const M = (2 * MERC) / PX; // metres per pixel
const BURNS = [
	{ kinds: ['residential'], esa: 50 },
	{ kinds: ['forest'], esa: 10 },
];

// a box of whole pixels, columns c0..c1-1 and rows r0..r1-1, as a GeoJSON feature of `kind`
const box = (kind: string, c0: number, r0: number, c1: number, r1: number) => {
	const [x0, x1] = [-MERC + c0 * M, -MERC + c1 * M];
	const [y0, y1] = [MERC - r0 * M, MERC - r1 * M];
	const ring = [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
		[x0, y0],
	];
	return { type: 'Feature', properties: { kind }, geometry: { type: 'Polygon', coordinates: [ring] } };
};

async function land(name: string, features: object[]): Promise<string> {
	const json = path.join(tmp, `${name}.geojson`);
	const fgb = path.join(tmp, `${name}.fgb`);
	await fs.writeFile(json, JSON.stringify({ type: 'FeatureCollection', features }));
	await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-a_srs', 'EPSG:3857'], ['-nln', 'land'], fgb, json);
	return fgb;
}

// the world: all grassland (30)
async function world(name: string): Promise<string> {
	const tif = path.join(tmp, name);
	await runQuiet(
		'gdal_create',
		['-of', 'GTiff'],
		['-ot', 'Byte'],
		['-burn', 30],
		['-a_srs', 'EPSG:3857'],
		['-a_ullr', -MERC, MERC, MERC, -MERC],
		['-outsize', PX, PX],
		tif,
	);
	return tif;
}

const row = (px: Uint8Array, r: number, c0: number, c1: number) => [...px.subarray(r * PX + c0, r * PX + c1)];

describe('burnLand', { skip }, () => {
	test('burns in order, the later over the earlier, and only the burned kinds', async () => {
		const tif = await world('one.tif');
		const fgb = await land('one', [
			box('residential', 1, 1, 5, 5),
			box('forest', 3, 1, 7, 5), // over residential's two right columns
			box('cemetery', 0, 8, 4, 9), // not burned
		]);
		await burnLand(tif, fgb, BURNS, path.join(tmp, 'scratch'));
		const px = await readBytes(tif, tmp, PX);
		assert.deepEqual(row(px, 2, 0, 8), [30, 50, 50, 10, 10, 10, 10, 30]);
		assert.deepEqual(row(px, 8, 0, 5), [30, 30, 30, 30, 30]);
	});

	test('`keep` leaves the class before the burn under the kinds it names', async () => {
		const tif = await world('keep.tif');
		const fgb = await land('keep', [box('residential', 0, 0, 6, 1), box('park', 2, 0, 4, 1)]);
		await burnLand(tif, fgb, [{ kinds: ['residential'], esa: 50, keep: ['park'] }], path.join(tmp, 'scratch'));
		assert.deepEqual(row(await readBytes(tif, tmp, PX), 0, 0, 7), [50, 50, 30, 30, 50, 50, 30]);
	});
});

describe('buildClasses', { skip }, () => {
	test('is the source with every burn, tile by tile, and leaves tiles without land use to the source', async () => {
		// a VRT source, whose band is Undefined where the tiles cut from it are Gray: gdalbuildvrt would skip them
		const source = path.join(tmp, 'source.vrt');
		await runQuiet(
			'gdal_translate',
			'-q',
			['-of', 'VRT'],
			['-colorinterp', 'undefined'],
			await world('source.tif'),
			source,
		);
		// residential across the edge between tiles 0_0 and 1_0 (at column 16), forest in tile 3_3, and a cemetery,
		// which no burn reads, alone in tile 0_2
		const fgb = await land('world', [
			box('residential', 14, 2, 18, 4),
			box('forest', 60, 60, 62, 62),
			box('cemetery', 2, 40, 4, 42),
		]);
		const tilesDir = path.join(tmp, 'tiles');
		const out = path.join(tmp, 'classes.tif');
		await buildClasses(out, { source, land: fgb, burns: BURNS, tilesDir, fullPx: PX, tiles: 4, levels: 2 });

		const px = await readBytes(out, tmp, PX);
		assert.deepEqual(row(px, 3, 13, 19), [30, 50, 50, 50, 50, 30]);
		assert.deepEqual(row(px, 61, 59, 63), [30, 10, 10, 30]);
		assert.deepEqual(row(px, 41, 1, 5), [30, 30, 30, 30]);
		const others = px.filter((v, i) => v !== 30 && !(i >= 2 * PX && i < 4 * PX) && i < 60 * PX);
		assert.equal(others.length, 0, 'nothing else changed');
		assert.ok(!existsSync(tilesDir), 'the tiles are removed once the classes are written');

		const info = await import('node:child_process').then(
			(cp) =>
				new Promise<string>((resolve, reject) =>
					cp.execFile('gdalinfo', [out], (err, stdout) => (err ? reject(err) : resolve(stdout))),
				),
		);
		assert.match(info, /Overviews: 32x32, 16x16/);
	});
});
