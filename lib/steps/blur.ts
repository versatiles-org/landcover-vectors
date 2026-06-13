// Step 4 — Gaussian-blur each class mask with libvips (GDAL has no Gaussian filter).
//
// Blurring turns the hard masks into smooth fields so the next step's argmax yields curved
// class boundaries with shared borders staying exact. vips streams and works in 8-bit;
// `approximate` precision is fastest. The blur only feeds an argmax, so the approximation is
// fine. vips strips the GeoTIFF georeferencing; the argmax step re-attaches it. Skip if present.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { runQuiet, pMap, commandExists, atomic } from '../worldcover.ts';
import { progress } from '../progress.ts';
import { dir, channels as channelDefs, maskPath, blurPath, BLUR_RADIUS, CPU_CORES } from '../../config.ts';

export async function blur(level: number): Promise<void> {
	if (channelDefs.every((_, i) => existsSync(blurPath(level, i)))) return console.error('z%d blur: cached', level);
	const CONCURRENCY = CPU_CORES;
	const PRECISION = 'approximate'; // vips gaussblur precision (fastest)
	if (!(await commandExists('vips'))) throw new Error('need libvips (vips) on PATH');
	for (let i = 0; i < channelDefs.length; i++) {
		if (!existsSync(maskPath(level, i)))
			throw new Error(`missing ${maskPath(level, i)} — run the channels step first`);
	}
	await fs.mkdir(dir.blur, { recursive: true });

	console.error(
		'Blurring %d masks for z%d (σ=%s px, %d workers)',
		channelDefs.length,
		level,
		BLUR_RADIUS,
		CONCURRENCY,
	);
	const bar = progress(channelDefs.length, 'Blur');
	await pMap(
		channelDefs.map((_, i) => i),
		CONCURRENCY,
		async (i) => {
			const out = blurPath(level, i);
			if (!existsSync(out)) {
				await atomic(out, (tmp) =>
					runQuiet('vips', [
						'gaussblur',
						maskPath(level, i),
						`${tmp}[compression=deflate,predictor=horizontal]`,
						String(BLUR_RADIUS),
						'--precision',
						PRECISION,
					]),
				);
			}
			bar.tick();
		},
	);
	bar.done();
}
