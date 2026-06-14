// Step 2 — produce the EPSG:3857 world raster for the given zoom level → data/1_reproject/{z}_worldcover.tif.
//
// The top level (MAXLEVEL) is reprojected from the full source mirror: the tiles are
// mosaicked with a VRT and warped covering the standard Mercator square (±MERC m), resampled
// "mode" (dominant class — the only correct choice for categorical data). Lower levels are
// produced by halving the next-higher level's (kept) raster, which is far cheaper than
// re-warping every source tile — so the build runs the levels from MAXLEVEL down to 0. No
// nodata is set, so ESA 0 (the no-data/water channel) is counted in the mode (mode skips nodata).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run, atomic } from '../worldcover.ts';
import { dir, MERC, MAXLEVEL, warpedPath, sizeForLevel } from '../../config.ts';

export async function reproject(level: number): Promise<void> {
	const size = sizeForLevel(level);
	const out = warpedPath(level);
	if (existsSync(out)) return console.error('z%d reproject: cached', level);
	await fs.mkdir(dir.reproject, { recursive: true });

	// lower levels: downscale the next-higher level's raster by 50% (distinct files → no in-place issue)
	if (level < MAXLEVEL) {
		const src = warpedPath(level + 1);
		if (!existsSync(src)) throw new Error(`missing ${src} — reproject level ${level + 1} first`);

		const lastSize = sizeForLevel(level + 1);
		if (lastSize == size) {
			console.error('Copying worldcover → %s', level, size, size, out);
			await atomic(out, async (tmp) => fs.copyFile(src, tmp));
			return;
		}
		if (lastSize === 2 * size) {
			console.error('Downscaling worldcover to z%d (%d×%d, mode) → %s', level, size, size, out);
			await atomic(out, (tmp) =>
				run('gdal_translate', [
					'-r',
					'mode',
					'-outsize',
					String(size),
					String(size),
					'-co',
					'COMPRESS=DEFLATE',
					'-co',
					'TILED=YES',
					'-co',
					'BIGTIFF=YES',
					src,
					tmp,
				]),
			);
			return;
		}
	}

	// top level: reproject the full source mirror
	const tiles = (await fs.readdir(dir.source).catch(() => [] as string[])).filter((f) => f.endsWith('.tif'));
	if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run the download step first`);

	// mosaic via an input-file list (avoids command-line length limits and shell globbing)
	const listPath = path.join(dir.reproject, '_src.txt');
	const vrtPath = path.join(dir.reproject, '_src.vrt');
	await fs.writeFile(listPath, tiles.map((t) => path.join(dir.source, t)).join('\n') + '\n');

	console.error('Mosaicking %d source tiles → %s', tiles.length, vrtPath);
	await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

	console.error('Warping z%d to EPSG:3857 %d×%d → %s', level, size, size, out);
	await atomic(out, (tmp) =>
		run('gdalwarp', [
			'-t_srs',
			'EPSG:3857',
			'-te',
			String(-MERC),
			String(-MERC),
			String(MERC),
			String(MERC),
			'-ts',
			String(size),
			String(size),
			'-r',
			'mode',
			'-ot',
			'Byte',
			'-of',
			'GTiff',
			'-co',
			'COMPRESS=DEFLATE',
			'-co',
			'TILED=YES',
			'-co',
			'BIGTIFF=YES',
			'-multi',
			'-wo',
			'NUM_THREADS=ALL_CPUS',
			'-overwrite',
			vrtPath,
			tmp,
		]),
	);
}
