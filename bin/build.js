// Run the whole landcover build pipeline.
//
// Builds each zoom level 0..MAXLEVEL from its own raster (resolution and simplify
// tolerance scale with the level), then merges the per-level tilesets in the pack step.
// Each step reads the previous step's output from data/ and writes its own. The one-time
// source-mirror fetch is a separate script, bin/download.js (`npm run download`).

import { reproject, channels, blur, argmax, polygonize, tile, pack } from '../lib/steps.js';
import { MAXLEVEL } from '../config.js';

for (let level = 0; level <= MAXLEVEL; level++) {
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
