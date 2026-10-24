// The ocean mask: the polygon burn (maskOcean, used by inspect --native) turns OSM's sea into a window's
// no-data and touches nothing else, and the sea-share pyramid holds the true sea share at every level. Runs
// the real GDAL tools on a tiny synthetic sea, so it is skipped where GDAL is not installed.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-ocean-'));
process.env.LANDCOVER_SOURCE_DIR = tmp; // config.ts reads it on import, so import everything after this

const { runQuiet, commandExists } = await import('../lib/worldcover.ts');
const { maskOcean, buildSeaShare, SEA } = await import('../lib/ocean.ts');
const { readBytes } = await import('../lib/inspect.ts');
const { file, MERC } = await import('../config.ts');

const haveGdal = (await commandExists('gdal_rasterize')) && (await commandExists('ogr2ogr'));
const PX = 10;

// a PX×PX raster of ESA class 30 (grassland) over [minx, minx+1000] × [0, 1000] in EPSG:3857
async function grassland(name: string, minx: number): Promise<string> {
	const tif = path.join(tmp, name);
	await runQuiet(
		'gdal_create',
		['-of', 'GTiff'],
		['-ot', 'Byte'],
		['-bands', 1],
		['-burn', 30],
		['-a_srs', 'EPSG:3857'],
		['-a_ullr', minx, 1000, minx + 1000, 0],
		['-outsize', PX, PX],
		tif,
	);
	return tif;
}

describe('maskOcean', { skip: !haveGdal && 'GDAL is not on PATH' }, () => {
	before(async () => {
		// the sea: the western half of the first window
		const gj = path.join(tmp, 'sea.geojson');
		const ring = [
			[0, 0],
			[500, 0],
			[500, 1000],
			[0, 1000],
			[0, 0],
		];
		await fs.writeFile(
			gj,
			JSON.stringify({
				type: 'FeatureCollection',
				crs: { type: 'name', properties: { name: 'EPSG:3857' } },
				features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
			}),
		);
		// typed like the real mask (lib/ocean.ts downloadOcean), which is what a simplified clip has to fit
		await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-nln', 'ocean'], ['-nlt', 'PROMOTE_TO_MULTI'], file.ocean, gj);
	});

	test('turns the sea into no-data and keeps the land', async () => {
		const tif = await grassland('coast.tif', 0);
		await maskOcean(tif, { minx: 0, miny: 0, maxx: 1000, maxy: 1000 }, PX, path.join(tmp, 'clip.fgb'));
		const px = await readBytes(tif, tmp, PX);
		for (let row = 0; row < PX; row++)
			for (let col = 0; col < PX; col++)
				assert.equal(px[row * PX + col], col < PX / 2 ? 0 : 30, `pixel ${col},${row}`);
	});

	test('leaves a window without sea untouched', async () => {
		const tif = await grassland('inland.tif', 5000);
		await maskOcean(tif, { minx: 5000, miny: 0, maxx: 6000, maxy: 1000 }, PX, path.join(tmp, 'clip.fgb'));
		assert.ok((await readBytes(tif, tmp, PX)).every((v) => v === 30));
	});
});

describe('buildSeaShare', { skip: !haveGdal && 'GDAL is not on PATH' }, () => {
	const FULL = 1024; // a tiny world: 1024² base pixels in 4×4 tiles
	const px = (2 * MERC) / FULL; // metres per base pixel
	const share = path.join(tmp, 'seashare.tif');

	// one band of `level` (-1 = the base) as bytes
	async function level(n: number, size: number): Promise<Uint8Array> {
		const out = path.join(tmp, `level${n}.tif`);
		await runQuiet('gdal_translate', '-q', ...(n >= 0 ? [['-oo', `OVERVIEW_LEVEL=${n}`]] : []), share, out);
		return readBytes(out, tmp, size);
	}

	before(async () => {
		// the sea: a strip 3 base pixels wide along the world's western edge, over the whole height
		const gj = path.join(tmp, 'strip.geojson');
		const [w, e] = [-MERC, -MERC + 3 * px];
		const ring = [
			[w, -MERC],
			[e, -MERC],
			[e, MERC],
			[w, MERC],
			[w, -MERC],
		];
		await fs.writeFile(
			gj,
			JSON.stringify({
				type: 'FeatureCollection',
				crs: { type: 'name', properties: { name: 'EPSG:3857' } },
				features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
			}),
		);
		const polygons = path.join(tmp, 'strip.fgb');
		await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-nln', 'ocean'], ['-nlt', 'PROMOTE_TO_MULTI'], polygons, gj);
		await buildSeaShare(share, {
			tilesDir: path.join(tmp, 'share-tiles'),
			polygons,
			fullPx: FULL,
			tiles: 4,
			levels: 3,
		});
	});

	test('the base is the burn: sea where a pixel centre is in the sea, land elsewhere', async () => {
		const base = await level(-1, FULL);
		for (const row of [0, FULL / 2, FULL - 1])
			assert.deepEqual([...base.subarray(row * FULL, row * FULL + 5)], [SEA, SEA, SEA, 0, 0], `row ${row}`);
		assert.equal(
			base.reduce((n, v) => n + (v === SEA ? 1 : 0), 0),
			3 * FULL,
		);
	});

	test('each overview holds the true sea share of its pixels', async () => {
		// level 0 halves: base columns 0-1 → 100 %, 2-3 → 50 %; level 1 quarters: columns 0-3 → 75 %
		const l0 = await level(0, FULL / 2);
		assert.deepEqual([...l0.subarray(0, 3)], [SEA, SEA / 2, 0]);
		const l1 = await level(1, FULL / 4);
		assert.deepEqual([...l1.subarray(0, 2)], [(3 * SEA) / 4, 0]);
	});

	test('cleans up its per-tile rasters', async () => {
		assert.equal(await fs.stat(path.join(tmp, 'share-tiles')).catch(() => null), null);
	});

	after(() => fs.rm(tmp, { recursive: true, force: true }));
});
