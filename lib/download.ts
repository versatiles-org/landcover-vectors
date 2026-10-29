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
//
// Last, OSM's land use (lib/osmland.ts): the newest planet, cut to its land use and imported once, and burned into
// the source as the classes the blocks read (lib/landburn.ts). They follow the source, the import and the burn
// table, so a refreshed land use (delete the osm-landuse-* files) costs the import and the burn, not a re-warp.

import fs from 'node:fs/promises';
import path from 'node:path';

import { runProgress, atomic, listSourceKeys, BUCKET } from './worldcover.ts';
import { writeStamp, readStamp, stampMismatch, sourceValues, fingerprint, type Values } from './fingerprint.ts';
import { downloadOcean, buildSeaShare, seaShareValues, SEA_SHARE_STAMP } from './ocean.ts';
import { downloadLanduse, importLand, landuseImport } from './osmland.ts';
import { buildClasses, CLASSES_CO, CLASSES_OVERVIEWS, CLASSES_STAMP } from './landburn.ts';
import { timed } from './timing.ts';
import { dir, file, MERC, FULL_PX, OSM_BURNS } from '../config.ts';

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
	else await timed('source', downloadSource);

	if (await exists(file.ocean)) console.error('Ocean mask present: %s (delete it to refresh)', file.ocean);
	else await timed('ocean', downloadOcean);

	// the sea share follows the polygons: a refreshed polygon file no longer matches its stamp
	const share = await seaShareValues();
	const shareStamp = await readStamp(dir.source, SEA_SHARE_STAMP);
	if ((await exists(file.seaShare)) && shareStamp && !stampMismatch(shareStamp, share))
		console.error('Sea share present: %s', file.seaShare);
	else await timed('seashare', () => downloadSeaShare(share));

	const landuse = await timed('landuse', downloadLanduse);
	const land = landuseImport(landuse.date);
	if (await exists(land)) console.error('OSM land use imported: %s', land);
	else
		await timed('import', async () => {
			console.error('Importing OSM land use → %s …', land);
			await importLand(landuse.file, land, path.join(dir.tmp, 'osm-import'), { progress: true });
		});

	// the classes follow the source, the land use and the burn table
	const classes = await classesValues(land);
	const classesStamp = await readStamp(dir.source, CLASSES_STAMP);
	if ((await exists(file.classes)) && classesStamp && !stampMismatch(classesStamp, classes))
		console.error('Classes present: %s', file.classes);
	else await timed('classes', () => downloadClasses(land, classes));
}

// what the classes were built from: a rebuilt source or a refreshed import rebuilds them
export async function classesValues(land: string): Promise<Values> {
	const at = async (f: string) => {
		const s = await fs.stat(f);
		return { bytes: s.size, modified: s.mtime.toISOString() };
	};
	return {
		fullPx: FULL_PX,
		source: await at(file.source),
		land: { file: path.basename(land), ...(await at(land)) },
		burns: OSM_BURNS,
	};
}

async function downloadClasses(land: string, values: Values): Promise<void> {
	console.error("Burning OSM's land use into the source → %s …", file.classes);
	const tilesDir = path.join(dir.tmp, `classes-${fingerprint(values)}`);
	await buildClasses(file.classes, { source: file.source, land, burns: OSM_BURNS, tilesDir });
	await writeStamp(dir.source, values, CLASSES_STAMP);
	console.error('✓ classes ready: %s', file.classes);
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
	const keys = await timed('list', listSourceKeys);
	console.error('Found %d source tiles', keys.length);
	await fs.writeFile(file.sourceList, keys.join('\n') + '\n');

	// virtual mosaic over the remote tiles, read directly via /vsicurl (EPSG:4326)
	const vrt = path.join(dir.tmp, '_remote.vrt');
	const listFile = path.join(dir.tmp, '_remote.txt');
	await fs.writeFile(listFile, keys.map((k) => `/vsicurl/${BUCKET}/${k}`).join('\n') + '\n');
	await runProgress('ESA tiles', 'gdalbuildvrt', '-overwrite', ['-input_file_list', listFile], vrt);

	// warp into one EPSG:3857 GeoTIFF (whole Mercator square, deepest-zoom resolution) + overviews
	console.error('Warping → %s (%d×%d px, EPSG:3857) …', file.source, FULL_PX, FULL_PX);
	await atomic(file.source, async (tmp) => {
		await runProgress(
			'warp',
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
			CLASSES_CO,
			'-overwrite',
			vrt,
			tmp,
		);
		console.error('Building overview pyramid (mode) …');
		await runProgress('overviews', 'gdaladdo', CLASSES_OVERVIEWS, tmp, [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]);
	});

	await fs.rm(vrt, { force: true });
	await fs.rm(listFile, { force: true });
	// record what this raster was built for, so a later build notices a FULL_PX change
	await writeStamp(dir.source, sourceValues());
	console.error('✓ source ready: %s', file.source);
}
