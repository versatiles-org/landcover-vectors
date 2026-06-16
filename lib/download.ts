// Build the single reprojected source raster for the pipeline, straight from the remote
// ESA WorldCover 2021 (v200) tiles — no local per-tile mirror.
//
// The ~2651 remote GeoTIFFs are read directly over /vsicurl and mosaicked into one virtual
// raster (EPSG:4326). Because every ESA tile carries internal overviews, the VRT exposes
// virtual overviews, so the warp below reads a coarse level instead of the full 10 m data.
// One gdalwarp reprojects the mosaic into a single EPSG:3857 GeoTIFF covering the whole
// Mercator square at the deepest zoom's resolution (FULL_PX²), then gdaladdo adds an overview
// pyramid down to z0 — so a block read at any zoom hits the matching pyramid level. The
// GeoTIFF is tiled with fast DEFLATE, BigTIFF, and sparse (all-nodata ocean blocks aren't
// stored). The remote tile list is recorded next to it for the build's skip-empty step.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run, atomic, listSourceKeys, BUCKET } from './worldcover.ts';
import { dir, file, MERC, FULL_PX } from '../config.ts';

export async function download(): Promise<void> {
	await fs.mkdir(dir.source, { recursive: true });
	await fs.mkdir(dir.tmp, { recursive: true });

	// list the remote tiles and record them (skip-empty reads this list at build time)
	console.error('Listing source tiles from s3://esa-worldcover …');
	const keys = await listSourceKeys();
	console.error('Found %d source tiles', keys.length);
	await fs.writeFile(file.sourceList, keys.join('\n') + '\n');

	// virtual mosaic over the remote tiles, read directly via /vsicurl (EPSG:4326)
	const vrt = path.join(dir.tmp, '_remote.vrt');
	const listFile = path.join(dir.tmp, '_remote.txt');
	await fs.writeFile(listFile, keys.map((k) => `/vsicurl/${BUCKET}/${k}`).join('\n') + '\n');
	await run('gdalbuildvrt', '-overwrite', ['-input_file_list', listFile], vrt);

	// warp into one EPSG:3857 GeoTIFF (whole Mercator square, deepest-zoom resolution) + overviews
	console.error('Warping → %s (%d×%d px, EPSG:3857) …', file.source, FULL_PX, FULL_PX);
	await atomic(file.source, async (tmp) => {
		await run(
			'gdalwarp',
			['-t_srs', 'EPSG:3857'],
			['-te', -MERC, -MERC, MERC, MERC], // full Mercator square
			['-ts', FULL_PX, FULL_PX],
			['-r', 'mode'], // dominant class — the only correct resampling for categorical data
			['-ot', 'Byte'],
			['-dstnodata', 0], // ESA 0 = no data; lets sparse skip all-ocean blocks
			'-multi',
			['-wo', 'NUM_THREADS=ALL_CPUS'],
			['-wm', 1024],
			['-of', 'GTiff'],
			['-co', 'TILED=YES'],
			['-co', 'BLOCKXSIZE=512'],
			['-co', 'BLOCKYSIZE=512'],
			['-co', 'COMPRESS=DEFLATE'],
			['-co', 'ZLEVEL=1'],
			['-co', 'PREDICTOR=1'], // fast deflate
			['-co', 'BIGTIFF=YES'],
			['-co', 'SPARSE_OK=TRUE'],
			['-co', 'NUM_THREADS=ALL_CPUS'],
			'-overwrite',
			vrt,
			tmp,
		);
		console.error('Building overview pyramid (mode) …');
		await run(
			'gdaladdo',
			['-r', 'mode'],
			['--config', 'COMPRESS_OVERVIEW', 'DEFLATE'],
			['--config', 'GDAL_NUM_THREADS', 'ALL_CPUS'],
			tmp,
			[2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
		);
	});

	await fs.rm(vrt, { force: true });
	await fs.rm(listFile, { force: true });
	console.error('✓ source ready: %s', file.source);
}
