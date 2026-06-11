// Download a reduced-resolution local mirror of ESA WorldCover 2021 (v200).
//
// Each of the 2651 source GeoTIFFs is downsampled by FACTOR on the way in (reading
// its matching internal overview, so only a small fraction of the full 10 m data is
// transferred) and written to tiles/esa-worldcover-src in its native EPSG:4326.
// FACTOR=8 (~74 m/px) keeps full detail for zoom 0-6, with headroom for zoom 7; the
// whole mirror is a few hundred MB instead of the full ~124 GB.
//
// Downloads run in parallel, are retried, written atomically, and skipped if already
// present — so the step is robust against network errors and resumable.
//
// Requires GDAL (gdal_translate) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { BUCKET, PREFIX, srcdir, runQuiet, pMap, listSourceKeys } from '../lib/worldcover.js';

const FACTOR = 8; // downsample each source tile by this factor on download
const PERCENT = `${100 / FACTOR}%`; // gdal_translate -outsize argument
const CONCURRENCY = 8;
const RETRIES = 3;

// download one source tile to the local mirror at reduced resolution, skipping if
// already present. Reads only the matching overview (small transfer), keeps the
// native projection and class codes (-r nearest), and writes atomically.
const download = async (key) => {
	const dest = path.join(srcdir, path.basename(key));
	if (existsSync(dest)) return false; // an existing file is complete (atomic rename below)

	const tmp = dest + '.part';
	const src = `/vsicurl/${BUCKET}/${key}`;
	for (let attempt = 1; ; attempt++) {
		try {
			await runQuiet('gdal_translate', [
				'-q',
				'-r',
				'nearest',
				'-outsize',
				PERCENT,
				PERCENT,
				'-of',
				'GTiff',
				'-co',
				'COMPRESS=DEFLATE',
				'-co',
				'TILED=YES',
				src,
				tmp,
			]);
			await fs.rename(tmp, dest); // atomic: only a complete file appears as dest
			return true;
		} catch (err) {
			await fs.rm(tmp, { force: true }); // never leave a partial file behind
			if (attempt >= RETRIES) throw new Error(`download ${key} failed: ${err.message}`);
			await sleep(attempt * 1000);
		}
	}
};

(async () => {
	await fs.mkdir(srcdir, { recursive: true });

	console.error('Listing source tiles from s3://esa-worldcover/%s …', PREFIX);
	const keys = await listSourceKeys();
	console.error('Found %d source tiles', keys.length);

	let done = 0;
	let fetched = 0;
	await pMap(keys, CONCURRENCY, async (key) => {
		if (await download(key)) fetched++;
		done++;
		if (done % 25 === 0 || done === keys.length) {
			process.stderr.write(`  ${done}/${keys.length} tiles (${fetched} downloaded, ${done - fetched} cached)\r`);
		}
	});
	process.stderr.write('\n');

	console.error('Done. Reduced-resolution mirror in %s', srcdir);
})();
