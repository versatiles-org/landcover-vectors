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

const SIEVE = process.env.POLYGONIZE_SIEVE !== undefined ? parseInt(process.env.POLYGONIZE_SIEVE, 10) : 8; // px; 0 = off
const CONCURRENCY = Math.max(1, os.availableParallelism() - 1);

// SQL (SQLite dialect) mapping the class code to a kind and dropping unmapped/nodata
const codes = Object.keys(codemap);
const whens = Object.entries(codemap)
	.map(([code, kind]) => `WHEN ${code} THEN '${kind}'`)
	.join(' ');
const SQL = `SELECT *, CASE code ${whens} END AS kind FROM tile WHERE code IN (${codes.join(',')})`;

// sieve → polygonize → tag with kind, writing one FlatGeobuf for a source tile
async function polygonizeTile(srcTif, outFgb) {
	const stem = path.join(os.tmpdir(), 'lc-' + path.basename(outFgb, '.fgb'));
	const sieved = `${stem}.sieve.tif`;
	const codeFgb = `${stem}.code.fgb`;
	try {
		const raster = SIEVE > 0 ? sieved : srcTif;
		if (SIEVE > 0) await runQuiet('gdal_sieve.py', ['-q', '-st', String(SIEVE), srcTif, sieved]);
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
		await fs.rm(sieved, { force: true });
		await fs.rm(codeFgb, { force: true });
	}
}

await fs.mkdir(dir.work, { recursive: true });

const tiles = (await fs.readdir(dir.source)).filter((f) => f.endsWith('.tif'));
if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run "npm run download" first`);
console.error('Polygonizing %d source tiles (%d workers, sieve=%d)', tiles.length, CONCURRENCY, SIEVE);

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

console.error('Merging %d tiles → %s', fgbs.length, file.geometry);
await run('ogr2ogr', ['-f', 'FlatGeobuf', '-nln', 'landcover', file.geometry, vrtPath]);

console.error('Done. Geometry written to %s', file.geometry);
