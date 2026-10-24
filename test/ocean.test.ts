// The ocean mask burns OSM's sea into a block's window as no-data, and touches nothing else. Runs the real
// ogr2ogr + gdal_rasterize on a tiny synthetic sea, so it is skipped where GDAL is not installed.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-ocean-'));
process.env.LANDCOVER_SOURCE_DIR = tmp; // config.ts reads it on import, so import everything after this

const { runQuiet, commandExists } = await import('../lib/worldcover.ts');
const { maskOcean } = await import('../lib/ocean.ts');
const { readBytes } = await import('../lib/inspect.ts');
const { file } = await import('../config.ts');

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
		await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-nln', 'ocean'], file.ocean, gj);
	});
	after(() => fs.rm(tmp, { recursive: true, force: true }));

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
