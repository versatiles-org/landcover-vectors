// Merge the per-tile polygon geometry into one simplified geometry file.
//
// Reads the per-tile FlatGeobuf produced by the polygonize step and:
//   1. merges them into one file (via an OGR VRT union, which handles thousands of
//      inputs without hitting command-line length limits),
//   2. combine --group-by kind → one multipart feature per kind,
//   3. dissolve → union the touching same-kind parts (e.g. tile-boundary splits),
//   4. simplify-coverage → replace the pixel staircase with straight lines
//      (topology-preserving, so shared class boundaries stay aligned; ~2× smaller).
// Produces data/landcover.fgb for the tile step.
//
// Unlike polygonize (parallel, per-tile), this runs single-threaded on the whole
// dataset, so it's the most memory-intensive step.
//
// Requires GDAL ≥ 3.11 (ogr2ogr, gdal vector combine / dissolve / simplify-coverage).

import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { dir, file } from '../config.js';

// coverage-simplification tolerance in degrees (EPSG:4326). ~0.0014° ≈ one ~152 m
// pixel; collapses the pixel staircase to straight lines (~2× smaller). '0' disables.
const SIMPLIFY = process.env.POLYGONIZE_SIMPLIFY || '0.0014';

const fgbs = (await fs.readdir(dir.work).catch(() => [])).filter((f) => f.endsWith('.fgb') && !f.startsWith('_'));
if (fgbs.length === 0) throw new Error(`no per-tile geometry in ${dir.work} — run "npm run polygonize" first`);

// 1. merge the per-tile geometry via an OGR VRT union
const vrtPath = path.join(dir.work, '_merged.vrt');
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
// ogr2ogr can't overwrite a FlatGeobuf in place, so remove any stale target first
await fs.rm(merged, { force: true });
await run('ogr2ogr', ['-progress', '-f', 'FlatGeobuf', '-nln', 'landcover', merged, vrtPath]);

// 2. combine same-kind polygons into one multipart feature per kind
const combined = path.join(dir.work, '_combined.fgb');
console.error('combine by kind …');
await run('gdal', ['vector', 'combine', '--overwrite', '--group-by', 'kind', '-i', merged, '-o', combined]);
await fs.rm(merged, { force: true });

// 3. dissolve the multiparts (union touching same-kind parts, e.g. tile splits)
const dissolved = path.join(dir.work, '_dissolved.fgb');
console.error('dissolve …');
await run('gdal', ['vector', 'dissolve', '--overwrite', '-i', combined, '-o', dissolved]);
await fs.rm(combined, { force: true });

// 4. coverage-simplify: replace the pixel staircase with straight lines
if (SIMPLIFY && SIMPLIFY !== '0') {
	console.error('simplify-coverage (tolerance %s°) …', SIMPLIFY);
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
} else {
	await fs.rename(dissolved, file.geometry);
}
await fs.rm(vrtPath, { force: true });

console.error('Done. Geometry written to %s', file.geometry);
