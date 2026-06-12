// Run the whole landcover build pipeline.
//
// Builds the zoom levels from MAXLEVEL down to 0: the top level is reprojected from the
// source mirror, and each lower level is a 50% mode-downscale of the previous one (much
// faster than re-warping the source every level). Resolution and simplify tolerance scale
// with the level; the per-level tilesets are merged in the pack step. The one-time
// source-mirror fetch is a separate script, bin/download.js (`npm run download`).

import { reproject, channels, blur, argmax, polygonize, tile, pack } from '../lib/steps.js';
import { requireCommands } from '../lib/worldcover.js';
import { MAXLEVEL } from '../config.js';

// fail fast (before the long build) if any external tool is missing: GDAL (reproject /
// downscale / channels / argmax / polygonize), vips (blur), tippecanoe + tile-join (tile /
// merge), versatiles (pack)
await requireCommands([
	'gdal',
	'gdalbuildvrt',
	'gdalwarp',
	'gdal_translate',
	'gdal_calc.py',
	'ogr2ogr',
	'vips',
	'tippecanoe',
	'tile-join',
	'versatiles',
]);

// top level reprojects from source; each lower level downscales the previous one
for (let level = MAXLEVEL; level >= 0; level--) {
	console.error('\n══════ level %d / %d ══════', level, MAXLEVEL);
	await reproject(level);
	await channels();
	await blur();
	await argmax();
	await polygonize(level);
	await tile(level);
}

await pack();
console.error('\n✓ done');
