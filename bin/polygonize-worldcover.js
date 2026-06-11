// Vectorize the reduced-resolution raster mirror into one polygon geometry file.
//
// Each source tile is processed in parallel: optionally sieved (small specks merged
// into their neighbour), polygonized with GDAL (one polygon per connected class
// region), and tagged with its Shortbread `kind`. The per-tile results are then
// merged into a single FlatGeobuf that the tile step feeds to tippecanoe.
//
// This is the geospatially-correct vectorization (no per-tile potrace seams); tile
// boundaries between same-kind polygons are healed later by tippecanoe's coalescing.
//
// Requires GDAL (gdal_sieve.py, gdal raster polygonize, ogr2ogr) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, runQuiet, pMap } from '../lib/worldcover.js';
import { progress } from '../lib/progress.js';
import { dir, file, codemap } from '../config.js';

// downsample each source tile before polygonizing, so the geometry matches the
// target zoom rather than the (finer) mirror resolution. The mirror is ~74 m
// (factor 8, z7-ready); 50% → ~152 m, which is native to zoom 6 and yields ~4×
// smaller geometry with no z6 quality loss. Use mode (dominant class) for categorical
// downsampling. Set to '100%' to keep full mirror resolution (e.g. for zoom 7).
const SCALE = process.env.POLYGONIZE_SCALE || '50%';
const SIEVE = process.env.POLYGONIZE_SIEVE !== undefined ? parseInt(process.env.POLYGONIZE_SIEVE, 10) : 100; // px; 0 = off

// coverage-simplification tolerance in degrees (EPSG:4326). ~0.0014° ≈ one ~152 m
// pixel; collapses the pixel staircase to straight lines (~2× smaller), topology-
// preserving. '0' skips simplification.
const SIMPLIFY = process.env.POLYGONIZE_SIMPLIFY || '0.0014';
const CONCURRENCY = Math.max(1, os.availableParallelism() - 1);

// SQL (SQLite dialect) mapping the class code to a kind and dropping unmapped/nodata
const codes = Object.keys(codemap);
const whens = Object.entries(codemap)
	.map(([code, kind]) => `WHEN ${code} THEN '${kind}'`)
	.join(' ');
const SQL = `SELECT *, CASE code ${whens} END AS kind FROM tile WHERE code IN (${codes.join(',')})`;

// downsample → sieve → polygonize → tag with kind, writing one FlatGeobuf for a source tile
async function polygonizeTile(srcTif, outFgb) {
	const stem = path.join(os.tmpdir(), 'lc-' + path.basename(outFgb, '.fgb'));
	const scaled = `${stem}.scale.tif`;
	const sieved = `${stem}.sieve.tif`;
	const codeFgb = `${stem}.code.fgb`;
	try {
		let raster = srcTif;
		if (SCALE !== '100%') {
			await runQuiet('gdal_translate', ['-q', '-r', 'mode', '-outsize', SCALE, SCALE, raster, scaled]);
			raster = scaled;
		}
		if (SIEVE > 0) {
			await runQuiet('gdal', [
				'raster',
				'sieve',
				'-q',
				'--overwrite',
				'--size-threshold',
				String(SIEVE),
				'-i',
				raster,
				'-o',
				sieved,
			]);
			raster = sieved;
		}
		await runQuiet('gdal', [
			'raster',
			'polygonize',
			'-q',
			'-i',
			raster,
			'-o',
			codeFgb,
			'-f',
			'FlatGeobuf',
			'--attribute-name',
			'code',
			'--output-layer',
			'tile',
			'--overwrite',
		]);
		await runQuiet('ogr2ogr', [
			'-f',
			'FlatGeobuf',
			'-nln',
			'landcover',
			'-dialect',
			'SQLite',
			'-sql',
			SQL,
			outFgb,
			codeFgb,
		]);
	} finally {
		await fs.rm(scaled, { force: true });
		await fs.rm(sieved, { force: true });
		await fs.rm(codeFgb, { force: true });
	}
}

await fs.mkdir(dir.work, { recursive: true });

const tiles = (await fs.readdir(dir.source)).filter((f) => f.endsWith('.tif'));
if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run "npm run download" first`);
console.error('Polygonizing %d source tiles (%d workers, scale=%s, sieve=%d)', tiles.length, CONCURRENCY, SCALE, SIEVE);

// 1. polygonize every source tile in parallel (resumable: skip tiles already done)
const bar = progress(tiles.length, 'Polygonizing');
await pMap(tiles, CONCURRENCY, async (name) => {
	const out = path.join(dir.work, name.replace(/\.tif$/, '.fgb'));
	if (!existsSync(out)) await polygonizeTile(path.join(dir.source, name), out);
	bar.tick();
});
bar.done();

// 2. merge the per-tile geometry into one file (via an OGR VRT union, which handles
//    thousands of inputs without hitting command-line length limits)
const fgbs = (await fs.readdir(dir.work)).filter((f) => f.endsWith('.fgb'));
const vrtPath = path.join(dir.work, 'merged.vrt');
const vrtXml =
	`<OGRVRTDataSource>\n\t<OGRVRTUnionLayer name="landcover">\n` +
	fgbs
		.map(
			(f) =>
				`\t\t<OGRVRTLayer name="landcover"><SrcDataSource>${path.join(dir.work, f)}</SrcDataSource></OGRVRTLayer>`,
		)
		.join('\n') +
	`\n\t</OGRVRTUnionLayer>\n</OGRVRTDataSource>\n`;
await fs.writeFile(vrtPath, vrtXml);

const merged = path.join(dir.work, '_merged.fgb');
console.error('Merging %d tiles → %s', fgbs.length, merged);
await run('ogr2ogr', ['-progress', '-f', 'FlatGeobuf', '-nln', 'landcover', merged, vrtPath]);

// Post-process the merged geometry into the final file:
//   1. combine same-kind polygons into one multipart feature per kind
//   2. dissolve those multiparts (union touching same-kind parts, e.g. tile splits)
//   3. coverage-simplify: replace the pixel staircase with straight lines, preserving
//      topology between classes (no slivers/gaps)
// Each step reads the previous file and the intermediate is removed afterwards.
const combined = path.join(dir.work, '_combined.fgb');
console.error('1/3 combine by kind …');
await run('gdal', ['vector', 'combine', '--overwrite', '--group-by', 'kind', '-i', merged, '-o', combined]);
await fs.rm(merged, { force: true });

const dissolved = path.join(dir.work, '_dissolved.fgb');
console.error('2/3 dissolve …');
await run('gdal', ['vector', 'dissolve', '--overwrite', '-i', combined, '-o', dissolved]);
await fs.rm(combined, { force: true });

console.error('3/3 simplify-coverage (tolerance %s°) …', SIMPLIFY);
await run('gdal', [
	'vector',
	'simplify-coverage',
	'--overwrite',
	'--output-layer',
	'landcover',
	'-i',
	dissolved,
	'-o',
	file.geometry,
	SIMPLIFY,
]);
await fs.rm(dissolved, { force: true });

console.error('Done. Geometry written to %s', file.geometry);
