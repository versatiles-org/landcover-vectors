// Vectorize the reduced-resolution raster mirror into per-tile polygon geometry.
//
// Each source tile is processed in parallel: downsampled to the target zoom
// resolution, sieved (small specks merged into their neighbour), polygonized with
// GDAL (one polygon per connected class region), tagged with its Shortbread `kind`,
// and coverage-simplified to replace the pixel staircase with straight lines. The
// result is one FlatGeobuf per source tile in data/polygons; the merge step just
// concatenates them.
//
// This is the geospatially-correct vectorization (no per-tile potrace seams). The
// simplification is topology-preserving (gdal vector simplify-coverage), so shared
// boundaries between classes stay aligned (no slivers/gaps). It runs per tile —
// keeping it parallel and low-memory (a global simplify needs the whole coverage in
// RAM) — and --preserve-boundary keeps each tile's edge exact so the merge stays
// seamless across tiles.
//
// Requires GDAL ≥ 3.11 (gdal_translate, ogr2ogr, gdal raster sieve, gdal raster
// polygonize, gdal vector simplify-coverage) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runQuiet, pMap } from '../lib/worldcover.js';
import { progress } from '../lib/progress.js';
import { dir, codemap } from '../config.js';

// downsample each source tile before polygonizing, so the geometry matches the
// target zoom rather than the (finer) mirror resolution. The mirror is ~74 m
// (factor 8, z7-ready); 50% → ~152 m, which is native to zoom 6 and yields ~4×
// smaller geometry with no z6 quality loss. Use mode (dominant class) for categorical
// downsampling. Set to '100%' to keep full mirror resolution (e.g. for zoom 7).
const SCALE = process.env.POLYGONIZE_SCALE || '50%';
const SIEVE = process.env.POLYGONIZE_SIEVE !== undefined ? parseInt(process.env.POLYGONIZE_SIEVE, 10) : 100; // px; 0 = off

// coverage-simplification tolerance in degrees (EPSG:4326). ~0.0014° ≈ one ~152 m
// pixel; collapses the pixel staircase to straight lines (~2× smaller), topology-
// preserving. '0' disables.
const SIMPLIFY = process.env.POLYGONIZE_SIMPLIFY || '0.0014';
const simplifying = SIMPLIFY && SIMPLIFY !== '0';
const CONCURRENCY = Math.max(1, os.availableParallelism() - 1);

// SQL (SQLite dialect) mapping the class code to a kind and dropping unmapped/nodata
const codes = Object.keys(codemap);
const whens = Object.entries(codemap)
	.map(([code, kind]) => `WHEN ${code} THEN '${kind}'`)
	.join(' ');
const SQL = `SELECT *, CASE code ${whens} END AS kind FROM tile WHERE code IN (${codes.join(',')})`;

// downsample → sieve → polygonize → tag with kind → simplify, writing one FlatGeobuf for a source tile
async function polygonizeTile(srcTif, outFgb) {
	const stem = path.join(os.tmpdir(), 'lc-' + path.basename(outFgb, '.fgb'));
	const scaled = `${stem}.scale.tif`;
	const sieved = `${stem}.sieve.tif`;
	const codeFgb = `${stem}.code.fgb`;
	const kindFgb = `${stem}.kind.fgb`;
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
		// tag with kind; write straight to outFgb unless we still need to simplify, in
		// which case go via a temp file. ogr2ogr can't overwrite a FlatGeobuf in place
		// (-overwrite needs DeleteLayer, unsupported here), so remove any stale target.
		const tagged = simplifying ? kindFgb : outFgb;
		await fs.rm(tagged, { force: true });
		await runQuiet('ogr2ogr', [
			'-f',
			'FlatGeobuf',
			'-nln',
			'landcover',
			'-dialect',
			'SQLite',
			'-sql',
			SQL,
			tagged,
			codeFgb,
		]);

		// coverage-simplify: replace the pixel staircase with straight lines, preserving
		// topology between classes; --preserve-boundary keeps the tile edge exact so the
		// merge stays seamless across tiles
		if (simplifying) {
			await runQuiet('gdal', [
				'vector',
				'simplify-coverage',
				'--overwrite',
				'--preserve-boundary',
				'--output-layer',
				'landcover',
				'-i',
				kindFgb,
				'-o',
				outFgb,
				SIMPLIFY,
			]);
		}
	} finally {
		await fs.rm(scaled, { force: true });
		await fs.rm(sieved, { force: true });
		await fs.rm(codeFgb, { force: true });
		await fs.rm(kindFgb, { force: true });
	}
}

await fs.mkdir(dir.work, { recursive: true });

const tiles = (await fs.readdir(dir.source)).filter((f) => f.endsWith('.tif'));
if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run "npm run download" first`);
console.error(
	'Polygonizing %d source tiles (%d workers, scale=%s, sieve=%d, simplify=%s)',
	tiles.length,
	CONCURRENCY,
	SCALE,
	SIEVE,
	simplifying ? SIMPLIFY : 'off',
);

// polygonize every source tile in parallel (resumable: skip tiles already done)
const bar = progress(tiles.length, 'Polygonizing');
await pMap(tiles, CONCURRENCY, async (name) => {
	const out = path.join(dir.work, name.replace(/\.tif$/, '.fgb'));
	if (!existsSync(out)) await polygonizeTile(path.join(dir.source, name), out);
	bar.tick();
});
bar.done();

console.error('Done. Per-tile geometry in %s — run "npm run merge" next', dir.work);
