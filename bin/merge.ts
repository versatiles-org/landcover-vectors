// Feature-merge the generated landcover container with an OSM-based Shortbread base.
//
// Downloads the latest OSM Shortbread container from download.versatiles.org (once, resumable;
// skipped if it already exists locally), then feature-merges it with the built landcover
// container via the VersaTiles `from_merged_vector` pipeline into data/combined.versatiles.
// The merged tileset has `land`/`water_polygons` populated continuously from z0 — see the
// README "Shortbread compatibility" section. The landcover container is built first by
// `npm run build`; OSM and landcover fill land/water_polygons at disjoint zooms, so nothing
// double-draws in the merged output.

import fs from 'node:fs/promises';

import { run, requireCommands } from '../lib/worldcover.ts';
import { file, OSM_URL } from '../config.ts';

const exists = (p: string): Promise<boolean> =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

await requireCommands(['versatiles', 'curl']);

// the landcover container is the build output — without it there is nothing to merge
if (!(await exists(file.container))) throw new Error(`missing ${file.container} — run "npm run build" first`);

// fetch the OSM base once (~66 GB); resume a partial download rather than restart it, and only
// promote the .part file to its final name after curl exits 0 so an interrupted download is
// never mistaken for a complete one
if (await exists(file.osm)) {
	console.error('OSM base present: %s', file.osm);
} else {
	const part = file.osm + '.part';
	console.error('Downloading OSM base %s → %s (resumable) …', OSM_URL, file.osm);
	await run('curl', '-fL', ['--retry', 5], ['--retry-delay', 2], '-C', '-', ['-o', part], OSM_URL);
	await fs.rename(part, file.osm);
}

// feature-merge: every output tile carries all features from both sources (from_merged_vector)
const pipeline = `[,vpl](from_merged_vector [ from_container filename="${file.osm}", from_container filename="${file.container}" ])`;

console.error('Merging → %s …', file.merged);
await fs.rm(file.merged, { force: true });
await run('versatiles', 'convert', ['-c', 'brotli'], pipeline, file.merged);
console.error('✓ merged: %s', file.merged);
