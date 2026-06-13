// Step 5 — reduce the blurred masks to a single-band code raster via per-pixel argmax.
//
// Stock `gdal raster` commands, streaming block by block: calc `--calc argmax` (1-based index
// of the strongest channel, ties to lowest index) → sieve (drop regions smaller than a circle
// of the blur radius) → reclassify index → code → edit (re-attach the EPSG:3857 georeferencing
// the blur stripped). The index/sieved rasters are kept alongside the result. Skip if present.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run, atomic } from '../worldcover.ts';
import { dir, MERC, channels as channelDefs, blurPath, codePath, BLUR_RADIUS } from '../../config.ts';

export async function argmax(level: number): Promise<void> {
	const out = codePath(level);
	if (existsSync(out)) return console.error('z%d argmax: cached', level);
	const inputs = channelDefs.map((_, i) => blurPath(level, i));
	for (const p of inputs) if (!existsSync(p)) throw new Error(`missing ${p} — run the blur step first`);
	await fs.mkdir(dir.argmax, { recursive: true });

	// name the inputs A, B, C … in channel order; argmax's index follows input order
	const named = inputs.flatMap((p, i) => ['-i', `${String.fromCharCode(65 + i)}=${p}`]);
	const mapping = channelDefs.map((c, i) => `${i + 1}=${c.code}`).join(';'); // index → code
	const sieveThreshold = 4 * Math.round(Math.PI * BLUR_RADIUS * BLUR_RADIUS);
	const indexTif = path.join(dir.argmax, `${level}_index.tif`);
	const sievedTif = path.join(dir.argmax, `${level}_sieved.tif`);

	console.error('argmax over %d channels → %s', inputs.length, indexTif);
	await run('gdal', [
		'raster',
		'calc',
		'--dialect',
		'builtin',
		...named,
		'--calc',
		'argmax',
		'--ot',
		'UInt8',
		'--no-check-crs', // the blurred masks carry no CRS (the blur stripped it) — that's expected
		'--co',
		'COMPRESS=DEFLATE',
		'--co',
		'TILED=YES',
		'--overwrite',
		'-o',
		indexTif,
	]);
	let toReclassify = indexTif;
	if (sieveThreshold >= 1) {
		console.error('Sieving regions < %d px (circle of r=%s) → %s', sieveThreshold, BLUR_RADIUS, sievedTif);
		await run('gdal', [
			'raster',
			'sieve',
			'--size-threshold',
			String(sieveThreshold),
			'--co',
			'COMPRESS=DEFLATE',
			'--co',
			'TILED=YES',
			'--overwrite',
			'-i',
			indexTif,
			'-o',
			sievedTif,
		]);
		toReclassify = sievedTif;
	}

	console.error('Reclassifying index → code → %s', out);
	await atomic(out, async (tmp) => {
		await run('gdal', [
			'raster',
			'reclassify',
			'-m',
			mapping,
			'--ot',
			'UInt8',
			'--co',
			'COMPRESS=DEFLATE',
			'--co',
			'TILED=YES',
			'--overwrite',
			'-i',
			toReclassify,
			'-o',
			tmp,
		]);
		console.error('Re-attaching EPSG:3857 georeferencing');
		await run('gdal', ['raster', 'edit', '--crs', 'EPSG:3857', '--bbox', `${-MERC},${-MERC},${MERC},${MERC}`, tmp]);
	});
}
