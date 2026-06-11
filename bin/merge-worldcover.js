// Merge the per-tile polygon geometry into one simplified geometry file.
//
// Reads the per-tile FlatGeobuf produced by the polygonize step, merges them into one
// file (via an OGR VRT union, which handles thousands of inputs without hitting
// command-line length limits), and coverage-simplifies the result: replaces the pixel
// staircase with straight lines, topology-preserving so shared class boundaries stay
// aligned (no slivers/gaps), roughly halving the geometry.
//
// (Grouping the polygons per kind — combine/dissolve — is intentionally skipped: at
// global scale a single per-kind multipolygon exceeds FlatGeobuf's per-feature limit
// ["Too big geometry"], and it gave no real size benefit. tippecanoe merges adjacent
// same-kind features per tile anyway.)
//
// Produces data/landcover.fgb for the tile step. Runs single-threaded on the whole
// dataset, so it's the most memory-intensive step.
//
// Requires GDAL ≥ 3.11 (ogr2ogr, gdal vector simplify-coverage).

import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { dir, file } from '../config.js';

// coverage-simplification tolerance in degrees (EPSG:4326). ~0.0014° ≈ one ~152 m
// pixel; collapses the pixel staircase to straight lines (~2× smaller). '0' disables.
const SIMPLIFY = process.env.POLYGONIZE_SIMPLIFY || '0.0014';

const fgbs = (await fs.readdir(dir.work).catch(() => [])).filter((f) => f.endsWith('.fgb') && !f.startsWith('_'));
if (fgbs.length === 0) throw new Error(`no per-tile geometry in ${dir.work} — run "npm run polygonize" first`);

// merge the per-tile geometry via an OGR VRT union
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

// coverage-simplify: replace the pixel staircase with straight lines (topology-preserving)
if (SIMPLIFY && SIMPLIFY !== '0') {
	console.error('simplify-coverage (tolerance %s°) …', SIMPLIFY);
	await run('gdal', [
		'vector',
		'simplify-coverage',
		'--overwrite',
		'--output-layer',
		'landcover',
		'-i',
		merged,
		'-o',
		file.geometry,
		SIMPLIFY,
	]);
	await fs.rm(merged, { force: true });
} else {
	await fs.rm(file.geometry, { force: true });
	await fs.rename(merged, file.geometry);
}
await fs.rm(vrtPath, { force: true });

console.error('Done. Geometry written to %s', file.geometry);
