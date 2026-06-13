// Step 1 — download a reduced-resolution local mirror of ESA WorldCover 2021 (v200).
//
// Each of the ~2651 source GeoTIFFs is downsampled by FACTOR on the way in (reading its
// matching internal overview, so only a fraction of the full 10 m data is transferred)
// into data/0_esa-worldcover-src in its native EPSG:4326. Downloads run in parallel, are
// retried, written atomically, and skipped if already present — robust and resumable.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { runQuiet, pMap, listSourceKeys, BUCKET, PREFIX } from '../worldcover.js';
import { progress } from '../progress.js';
import { dir } from '../../config.js';

export async function download() {
	const FACTOR = 4; // downsample each source tile by this factor on download
	const PERCENT = `${100 / FACTOR}%`;
	const CONCURRENCY = 8;
	const RETRIES = 3;
	const srcdir = dir.source;

	// fetch one source tile to the local mirror at reduced resolution, skipping if
	// already present; reads only the matching overview and writes atomically
	async function fetchTile(key) {
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
	}

	await fs.mkdir(srcdir, { recursive: true });
	console.error('Listing source tiles from s3://esa-worldcover/%s …', PREFIX);
	const keys = await listSourceKeys();
	console.error('Found %d source tiles', keys.length);

	let fetched = 0;
	const bar = progress(keys.length, 'Downloading');
	await pMap(keys, CONCURRENCY, async (key) => {
		if (await fetchTile(key)) fetched++;
		bar.tick();
	});
	bar.done();
	console.error('%d downloaded, %d already cached. Mirror in %s', fetched, keys.length - fetched, srcdir);
}
