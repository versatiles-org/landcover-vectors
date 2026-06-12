// Vectorize the code raster into the final polygon geometry.
//
// The argmax code raster is a clean coverage (every pixel one code 10..100), so this
// is a single global vectorization — no per-tile seams:
//   1. sieve   — merge specks below POLYGONIZE_SIEVE px into their neighbour (the blur
//                already smooths, this just trims triple-point pixels); 0 disables.
//   2. polygonize — one polygon per connected code region (field `code`).
//   3. tag + drop — map code → Shortbread `kind`, drop code 100 (no data / no landcover).
//   4. simplify-coverage — replace the residual pixel staircase with straight lines,
//                topology-preserving so shared class borders stay aligned (no gaps/
//                slivers); --preserve-boundary keeps the world edge exact. Tolerance is
//                POLYGONIZE_SIMPLIFY metres (EPSG:3857); 0 disables (leaves it to tippecanoe).
//   5. reproject — to EPSG:4326 for tippecanoe.
//
// Requires GDAL ≥ 3.11 (gdal raster sieve, gdal raster polygonize, ogr2ogr,
// gdal vector simplify-coverage) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { file, datadir, channels } from '../config.js';

// the argmax step already sieves (regions < a circle of the blur radius), so this is
// off by default; set POLYGONIZE_SIEVE to a pixel count for an extra pass before polygonizing
const SIEVE = process.env.POLYGONIZE_SIEVE !== undefined ? parseInt(process.env.POLYGONIZE_SIEVE, 10) : 0; // px; 0 = off
const SIMPLIFY = process.env.POLYGONIZE_SIMPLIFY !== undefined ? process.env.POLYGONIZE_SIMPLIFY : '600'; // m; 0 = off
const simplifying = SIMPLIFY && SIMPLIFY !== '0';

// SQL (SQLite dialect): map code → kind and drop the no-data class (kind === null)
const kept = channels.filter((c) => c.kind);
const whens = kept.map((c) => `WHEN ${c.code} THEN '${c.kind}'`).join(' ');
const SQL = `SELECT *, CASE code ${whens} END AS kind FROM landcover WHERE code IN (${kept.map((c) => c.code).join(',')})`;

if (!existsSync(file.code)) throw new Error(`missing ${file.code} — run "npm run argmax" first`);

const sieved = path.join(datadir, '_sieved.tif');
const codeFgb = path.join(datadir, '_code.fgb');
const taggedFgb = path.join(datadir, '_tagged.fgb');
const simplifiedFgb = path.join(datadir, '_simplified.fgb');

try {
	// 1. sieve
	let raster = file.code;
	if (SIEVE > 0) {
		console.error('Sieving specks < %d px', SIEVE);
		await run('gdal', [
			'raster',
			'sieve',
			'--overwrite',
			'--size-threshold',
			String(SIEVE),
			'-i',
			file.code,
			'-o',
			sieved,
		]);
		raster = sieved;
	}

	// 2. polygonize
	console.error('Polygonizing → %s', codeFgb);
	await fs.rm(codeFgb, { force: true });
	await run('gdal', [
		'raster',
		'polygonize',
		'-i',
		raster,
		'-o',
		codeFgb,
		'-f',
		'FlatGeobuf',
		'--attribute-name',
		'code',
		'--output-layer',
		'landcover',
		'--overwrite',
	]);

	// 3. tag with kind, drop no-data
	console.error('Tagging kind and dropping no-data → %s', taggedFgb);
	await fs.rm(taggedFgb, { force: true });
	await run('ogr2ogr', [
		'-f',
		'FlatGeobuf',
		'-nln',
		'landcover',
		'-dialect',
		'SQLite',
		'-sql',
		SQL,
		taggedFgb,
		codeFgb,
	]);

	// 4. coverage-simplify (topology-preserving, no gaps)
	let source = taggedFgb;
	if (simplifying) {
		console.error('Coverage-simplifying (tolerance %s m) → %s', SIMPLIFY, simplifiedFgb);
		await run('gdal', [
			'vector',
			'simplify-coverage',
			'--overwrite',
			'--preserve-boundary',
			'--output-layer',
			'landcover',
			'-i',
			taggedFgb,
			'-o',
			simplifiedFgb,
			SIMPLIFY,
		]);
		source = simplifiedFgb;
	}

	// 5. reproject to EPSG:4326 for tippecanoe
	console.error('Reprojecting to EPSG:4326 → %s', file.geometry);
	await fs.rm(file.geometry, { force: true });
	await run('ogr2ogr', ['-t_srs', 'EPSG:4326', '-f', 'FlatGeobuf', '-nln', 'landcover', file.geometry, source]);
} finally {
	await fs.rm(sieved, { force: true });
	await fs.rm(codeFgb, { force: true });
	await fs.rm(taggedFgb, { force: true });
	await fs.rm(simplifiedFgb, { force: true });
}

console.error('Done. Geometry written to %s — run "npm run tile" next', file.geometry);
