// Step 6 — vectorize the code raster into the level's polygon geometry.
//
// A single global vectorization (no per-tile seams): polygonize → tag each polygon with its
// Shortbread `kind` and drop the no-data class → coverage-simplify (topology-preserving) →
// reproject to EPSG:4326 for tippecanoe. The intermediate FlatGeobufs are kept alongside the
// result. Skip if the result already exists.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../worldcover.js';
import { dir, channels as channelDefs, codePath, geometryPath, simplifyForLevel } from '../../config.js';

export async function polygonize(level) {
	const out = geometryPath(level);
	const code = codePath(level);
	if (!existsSync(code)) throw new Error(`missing ${code} — run the argmax step first`);
	if (existsSync(out)) return console.error('z%d polygonize: cached', level);
	await fs.mkdir(dir.polygonize, { recursive: true });

	const SIMPLIFY = String(simplifyForLevel(level)); // coverage-simplification tolerance in metres (EPSG:3857)
	const kept = channelDefs.filter((c) => c.kind);
	const whens = kept.map((c) => `WHEN ${c.code} THEN '${c.kind}'`).join(' ');
	const SQL = `SELECT *, CASE code ${whens} END AS kind FROM landcover WHERE code IN (${kept.map((c) => c.code).join(',')})`;
	const codeFgb = path.join(dir.polygonize, `${level}_code.fgb`);
	const taggedFgb = path.join(dir.polygonize, `${level}_tagged.fgb`);
	const simplifiedFgb = path.join(dir.polygonize, `${level}_simplified.fgb`);

	console.error('Polygonizing → %s', codeFgb);
	await fs.rm(codeFgb, { force: true }); // a FlatGeobuf can't be overwritten in place
	await run('gdal', [
		'raster',
		'polygonize',
		'-i',
		code,
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

	console.error('Coverage-simplifying (tolerance %s m) → %s', SIMPLIFY, simplifiedFgb);
	await run('gdal', [
		'vector',
		'simplify-coverage',
		'--overwrite',
		'--output-layer',
		'landcover',
		'-i',
		taggedFgb,
		'-o',
		simplifiedFgb,
		SIMPLIFY,
	]);
	console.error('Reprojecting to EPSG:4326 → %s', out);
	await fs.rm(out, { force: true });
	await run('ogr2ogr', ['-t_srs', 'EPSG:4326', '-f', 'FlatGeobuf', '-nln', 'landcover', out, simplifiedFgb]);
}
