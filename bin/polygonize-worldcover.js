// Vectorize the code raster into the final polygon geometry.
//
// The argmax code raster is a clean coverage (every pixel one code), so this is a
// single global vectorization — no per-tile seams:
//   1. polygonize — one polygon per connected code region (field `code`).
//   2. tag + drop — map code → Shortbread `kind`, drop the no-data class.
//   3. simplify-coverage — replace the residual pixel staircase with straight lines,
//                topology-preserving so shared class borders stay aligned (no gaps/
//                slivers); --preserve-boundary keeps the world edge exact.
//   4. reproject — to EPSG:4326 for tippecanoe.
//
// Requires GDAL ≥ 3.11 (gdal raster polygonize, ogr2ogr, gdal vector simplify-coverage)
// on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { file, datadir, channels } from '../config.js';

// coverage-simplification tolerance in metres (EPSG:3857)
const SIMPLIFY = '2000';

// SQL (SQLite dialect): map code → kind and drop the no-data class (kind === null)
const kept = channels.filter((c) => c.kind);
const whens = kept.map((c) => `WHEN ${c.code} THEN '${c.kind}'`).join(' ');
const SQL = `SELECT *, CASE code ${whens} END AS kind FROM landcover WHERE code IN (${kept.map((c) => c.code).join(',')})`;

if (!existsSync(file.code)) throw new Error(`missing ${file.code} — run "npm run argmax" first`);

const codeFgb = path.join(datadir, '_code.fgb');
const taggedFgb = path.join(datadir, '_tagged.fgb');
const simplifiedFgb = path.join(datadir, '_simplified.fgb');

try {
	// 1. polygonize
	console.error('Polygonizing → %s', codeFgb);
	await fs.rm(codeFgb, { force: true });
	await run('gdal', [
		'raster',
		'polygonize',
		'-i',
		file.code,
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

	// 2. tag with kind, drop no-data
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

	// 3. coverage-simplify (topology-preserving, no gaps)
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

	// 4. reproject to EPSG:4326 for tippecanoe
	console.error('Reprojecting to EPSG:4326 → %s', file.geometry);
	await fs.rm(file.geometry, { force: true });
	await run('ogr2ogr', ['-t_srs', 'EPSG:4326', '-f', 'FlatGeobuf', '-nln', 'landcover', file.geometry, simplifiedFgb]);
} finally {
	await fs.rm(codeFgb, { force: true });
	await fs.rm(taggedFgb, { force: true });
	await fs.rm(simplifiedFgb, { force: true });
}

console.error('Done. Geometry written to %s — run "npm run tile" next', file.geometry);
