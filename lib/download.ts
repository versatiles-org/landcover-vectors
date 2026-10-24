// Build the single reprojected source raster for the pipeline, straight from the remote
// ESA WorldCover 2021 (v200) tiles — no local per-tile mirror.
//
// The ~2651 remote GeoTIFFs are read directly over /vsicurl and mosaicked into one virtual
// raster (EPSG:4326). Because every ESA tile carries internal overviews, the VRT exposes
// virtual overviews, so the warp below reads a coarse level instead of the full 10 m data.
// One gdalwarp reprojects the mosaic into a single EPSG:3857 GeoTIFF covering the whole
// Mercator square at the deepest zoom's resolution (FULL_PX²), then gdaladdo adds an overview
// pyramid down to z0 — so a block read at any zoom hits the matching pyramid level. The
// GeoTIFF is tiled with ZSTD, BigTIFF, and sparse (all-nodata ocean blocks aren't
// stored). The remote tile list is recorded next to it for the build's skip-empty step.
//
// Next to it go the ocean mask (lib/ocean.ts): OSM's sea polygons, and the sea-share pyramid rasterized from
// them onto the source's grid, which the blocks read. Each is only built when it is missing or stamped for
// other inputs (the raster for another FULL_PX, the sea share for other polygons), so adding or refreshing
// the mask costs the polygons and their rasterization, not a re-warp.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run, atomic, listSourceKeys, BUCKET } from './worldcover.ts';
import { writeStamp, readStamp, stampMismatch, sourceValues, fingerprint, type Values } from './fingerprint.ts';
import { downloadOcean, buildSeaShare, seaShareValues, SEA_SHARE_STAMP } from './ocean.ts';
import { dir, file, MERC, FULL_PX } from '../config.ts';

const exists = (p: string): Promise<boolean> =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

export async function download(): Promise<void> {
	await fs.mkdir(dir.source, { recursive: true });
	await fs.mkdir(dir.tmp, { recursive: true });

	// a raster from before stamping counts as current, like the build treats it
	const stamp = await readStamp(dir.source);
	const current = (await exists(file.source)) && !(stamp && stampMismatch(stamp, sourceValues()));
	if (current) console.error('Source raster present: %s (delete it to rebuild)', file.source);
	else await downloadSource();

	if (await exists(file.ocean)) console.error('Ocean mask present: %s (delete it to refresh)', file.ocean);
	else await downloadOcean();

	// the sea share follows the polygons: a refreshed polygon file no longer matches its stamp
	const share = await seaShareValues();
	const shareStamp = await readStamp(dir.source, SEA_SHARE_STAMP);
	if ((await exists(file.seaShare)) && shareStamp && !stampMismatch(shareStamp, share))
		console.error('Sea share present: %s', file.seaShare);
	else await downloadSeaShare(share);
}

async function downloadSeaShare(values: Values): Promise<void> {
	console.error("Rasterizing OSM's sea → %s (%d×%d px, average overviews) …", file.seaShare, FULL_PX, FULL_PX);
	// per-tile rasters resume an interrupted run, but only one for the same inputs
	const tilesDir = path.join(dir.tmp, `seashare-${fingerprint(values)}`);
	await buildSeaShare(file.seaShare, { tilesDir });
	await writeStamp(dir.source, values, SEA_SHARE_STAMP);
	console.error('✓ sea share ready: %s', file.seaShare);
}

async function downloadSource(): Promise<void> {
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
			// ZSTD 9: about a third smaller than DEFLATE 1 on ESA classes, at the same read and write speed
			// (LZW is as small; ZSTD 19 saves another ~15 % but writes ~40× slower). No predictor: class
			// codes are categories, so differencing neighbours only adds entropy.
			['-co', 'COMPRESS=ZSTD'],
			['-co', 'ZSTD_LEVEL=9'],
			['-co', 'PREDICTOR=1'],
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
			['--config', 'COMPRESS_OVERVIEW', 'ZSTD'],
			['--config', 'ZSTD_LEVEL_OVERVIEW', 9],
			['--config', 'GDAL_NUM_THREADS', 'ALL_CPUS'],
			tmp,
			[2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
		);
	});

	await fs.rm(vrt, { force: true });
	await fs.rm(listFile, { force: true });
	// record what this raster was built for, so a later build notices a FULL_PX change
	await writeStamp(dir.source, sourceValues());
	console.error('✓ source ready: %s', file.source);
}
