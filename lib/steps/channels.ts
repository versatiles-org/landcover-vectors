// Step 3 — split the level's world raster into one per-class membership mask per channel.
//
// For each entry in config.channels, gdal_calc.py writes a single Byte mask: 255 where the
// pixel belongs to that class, 0 elsewhere. The classes partition the legend, so across all
// masks every pixel is 255 in exactly one channel. Each mask is skipped if it already exists.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';

import { runQuiet, pMap, atomic } from '../worldcover.ts';
import { progress } from '../progress.ts';
import { dir, channels as channelDefs, warpedPath, maskPath } from '../../config.ts';

export async function channels(level: number): Promise<void> {
	if (channelDefs.every((_, i) => existsSync(maskPath(level, i)))) return console.error('z%d channels: cached', level);
	const CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism() - 1));
	const src = warpedPath(level);
	if (!existsSync(src)) throw new Error(`missing ${src} — run the reproject step first`);
	await fs.mkdir(dir.channels, { recursive: true });

	console.error('Building %d class masks for z%d (%d workers)', channelDefs.length, level, CONCURRENCY);
	const bar = progress(channelDefs.length, 'Channels');
	await pMap(
		channelDefs.map((c, i) => ({ c, i })),
		CONCURRENCY,
		async ({ c, i }) => {
			const out = maskPath(level, i);
			if (!existsSync(out)) {
				await atomic(out, (tmp) =>
					runQuiet('gdal_calc.py', [
						'-A',
						src,
						'--calc',
						c.calc,
						'--type',
						'Byte',
						'--hideNoData', // 0 means "not this class", not nodata — keep it a real value for the blur
						'--co',
						'COMPRESS=DEFLATE',
						'--co',
						'TILED=YES',
						'--overwrite',
						'--quiet',
						'--outfile',
						tmp,
					]),
				);
			}
			bar.tick();
		},
	);
	bar.done();
}
