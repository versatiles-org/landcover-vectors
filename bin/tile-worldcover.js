// Build the vector tile pyramid from the merged polygon geometry, using tippecanoe.
//
// tippecanoe simplifies the geometry per zoom level and tiles it seamlessly in one
// pass: --detect-shared-borders keeps boundaries between adjacent classes coincident
// while simplifying (no slivers/gaps), and --coalesce-smallest-as-needed merges the
// tile-boundary fragments left by per-tile polygonization rather than dropping them,
// so coverage stays complete.
//
// Requires tippecanoe on PATH (e.g. `brew install tippecanoe`).

import { existsSync } from 'node:fs';

import { run } from '../lib/worldcover.js';
import { file, meta } from '../config.js';

const zoom = process.argv[2] || '0-6';
const [minZoom, maxZoom] = zoom.includes('-') ? zoom.split('-') : [zoom, zoom];

if (!existsSync(file.geometry)) {
	throw new Error(`missing ${file.geometry} — run "npm run polygonize" first`);
}

await run('tippecanoe', [
	'-o',
	file.tiles,
	'--force', // overwrite existing output
	'--minimum-zoom',
	minZoom,
	'--maximum-zoom',
	maxZoom,
	'--layer',
	meta.layer,
	'--attribute-type',
	'kind:string',
	'--include',
	'kind', // keep only the kind attribute
	'--detect-shared-borders', // coverage-aware simplification (no slivers between classes)
	'--coalesce-smallest-as-needed', // merge tile-boundary fragments instead of dropping
	'--name',
	meta.name,
	'--attribution',
	meta.attribution,
	'--description',
	meta.description,
	file.geometry,
]);

console.error('Done. Tiles written to %s', file.tiles);
