// The ocean mask: OSM's sea, blanked out of every ESA window as it is classified.
//
// ESA classifies the sea inside its coastal 3° tiles as permanent water (class 80), so without a mask the
// container's `water` reaches out to the tile edge, and ESA's land runs past OSM's coastline wherever the two
// disagree. Shortbread's `ocean` layer is built from OSM's water polygons (OCEAN_URL), so burning those very
// polygons into the window as ESA's no-data (0) makes the land cover end where the OSM base's sea begins.
// Lakes are not in those polygons and stay; ESA sea inside OSM's land (a harbour, reclaimed coast) stays too.
//
// The download rasterizes the polygons once into a sea-share pyramid (buildSeaShare, below), and a block reads
// its window of that (seaShareWindow). maskOcean burns the polygons into one raster directly: an exact burn,
// for references that are not on the pyramid's grid (lib/native.ts).

import fs from 'node:fs/promises';
import path from 'node:path';

import { existsSync } from 'node:fs';

import { run, runQuiet, runProgress, atomic, pMap } from './worldcover.ts';
import { progress } from './progress.ts';
import { timed } from './timing.ts';
import { windowVrt } from './window.ts';
import { readStamp, type Values } from './fingerprint.ts';
import { dir, file, OCEAN_URL, MERC, FULL_PX, MAXLEVEL, CPU_CORES, type Rect } from '../config.ts';

const LAYER = 'ocean';

// fetch OSM's water polygons once (~930 MB) and convert them to a FlatGeobuf with a spatial index (~1.3 GB),
// which is what lets a block read only the few polygons that touch its window
export async function downloadOcean(): Promise<void> {
	const zip = path.join(dir.tmp, path.basename(OCEAN_URL));
	console.error('Downloading OSM water polygons %s …', OCEAN_URL);
	await fs.mkdir(dir.tmp, { recursive: true });
	await fs.rm(zip, { force: true }); // a few minutes to fetch again, so no resume logic for a leftover
	await run('curl', '-fL', ['--retry', 5], ['--retry-delay', 2], ['-o', zip], OCEAN_URL);
	const shp = `/vsizip/${zip}/${path.basename(OCEAN_URL, '.zip')}/water_polygons.shp`;
	console.error('Converting → %s …', file.ocean);
	await atomic(file.ocean, (out) =>
		runProgress(
			'water polygons',
			'ogr2ogr',
			'-progress',
			['-f', 'FlatGeobuf'],
			['-nln', LAYER],
			['-nlt', 'PROMOTE_TO_MULTI'],
			out,
			shp,
		),
	);
	await fs.rm(zip, { force: true });
	console.error('✓ ocean mask ready: %s', file.ocean);
}

// Burn OSM's sea into `tif` (an EPSG:3857 Byte raster covering `extent` with `widthPx` columns) as no-data,
// in place — the way every block did before the sea-share pyramid. Two steps on purpose: gdal_rasterize straight from the full file costs ~1.5 GB of memory per call
// even when nothing touches the window, while clipping first with ogr2ogr (through the spatial index) keeps
// both under ~150 MB. The clip is simplified to half a raster pixel, which changes almost no pixel centre
// (0.002 % of the sea pixels of a z10 block) but turns a world-sized low-zoom window from minutes of
// rasterizing full-detail coastline into seconds. `scratch` is the caller's temp path for the clip.
export async function maskOcean(tif: string, extent: Rect, widthPx: number, scratch: string): Promise<void> {
	const tolerance = (extent.maxx - extent.minx) / widthPx / 2;
	await fs.rm(scratch, { force: true });
	await runQuiet(
		'ogr2ogr',
		['-spat', extent.minx, extent.miny, extent.maxx, extent.maxy],
		['-simplify', tolerance],
		['-f', 'FlatGeobuf'],
		['-lco', 'SPATIAL_INDEX=NO'], // read once, sequentially
		['-nln', LAYER],
		['-nlt', 'PROMOTE_TO_MULTI'], // simplifying can turn a MultiPolygon into a Polygon, which the layer type would refuse
		scratch,
		file.ocean,
		LAYER,
	);
	await runQuiet('gdal_rasterize', '-q', ['-burn', 0], ['-l', LAYER], scratch, tif);
}

// fail early, before a long run, when the mask is missing
export async function requireOcean(): Promise<void> {
	const ok = await fs.stat(file.ocean).then(
		() => true,
		() => false,
	);
	if (!ok)
		throw new Error(
			`missing ${file.ocean} — run "npm run download" (it keeps a source raster that is already there)`,
		);
}

// ---------------------------------------------------------------- the sea-share pyramid
//
// OSM's sea rasterized once, onto the source raster's own grid (FULL_PX², EPSG:3857), as the share of each
// pixel that is sea: SEA (100) or 0 at the base, and average overviews down to z0, so every level holds the
// exact sea share of its pixels. A block reads its window at its own zoom from this pyramid like it reads
// the classes from the source, instead of clipping, simplifying and burning the polygons itself — which cost
// up to a minute per block on a complex coast below z10, and is now paid once per download.
//
// The base is burned exactly the way a z10 block burned its window: the polygons simplified to half a
// pixel, pixel centres inside → sea. Each coarser level is the average of the one below, so a zoom-z
// pixel's value is its true sea share at z10 resolution, which a block thresholds (lib/block.ts).

export const SEA = 100; // the base value of a sea pixel: the share is in percent
const SHARE_TILES = 64; // tiles per axis for the rasterization: 16384² px each at TILE_PX 1024
const CLIP_ATTEMPTS = 3;
export const SEA_SHARE_STAMP = '.fingerprint-seashare'; // its stamp, next to the source raster's own

// what the sea share was built from and how: a changed polygon file (a refreshed download) rebuilds it
export async function seaShareValues(polygons = file.ocean): Promise<Values> {
	const s = await fs.stat(polygons);
	return {
		fullPx: FULL_PX,
		levels: MAXLEVEL,
		method: `burn ${SEA} at half-pixel simplify, average overviews`,
		polygons: { bytes: s.size, modified: s.mtime.toISOString() },
	};
}

export type SeaShareOpts = {
	tilesDir: string; // per-tile rasters; kept across an interrupted run, so a rerun resumes
	polygons?: string; // the sea polygons (default: the downloaded mask)
	fullPx?: number; // side of the base level (default: the source raster's)
	tiles?: number; // tiles per axis for the rasterization
	levels?: number; // overview levels (default: down to z0)
	concurrency?: number;
};

// build the sea-share pyramid into `out` (atomically): rasterize tile by tile in parallel, mosaic, overviews
export async function buildSeaShare(out: string, opts: SeaShareOpts): Promise<void> {
	const { tilesDir, polygons = file.ocean, fullPx = FULL_PX, tiles = SHARE_TILES, levels = MAXLEVEL } = opts;
	if (fullPx % tiles !== 0) throw new Error(`sea share: ${fullPx} px do not split into ${tiles} tiles`);
	const tilePx = fullPx / tiles;
	const span = (2 * MERC) / tiles; // metres per tile
	const tolerance = (2 * MERC) / fullPx / 2; // half a base pixel, as a z10 block simplified its clip
	await fs.mkdir(tilesDir, { recursive: true });

	const jobs: [number, number][] = [];
	for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) jobs.push([x, y]);
	const tilePath = ([x, y]: [number, number]) => path.join(tilesDir, `${x}_${y}.tif`);
	const bar = progress(jobs.length, 'sea share');
	// One GDAL thread per tile: the tiles already run one per core, and GDAL_NUM_THREADS=ALL_CPUS (set for every
	// GDAL call, see gdalEnv) gives each of them its own compression threads on top. On 320 tiles that took 3.6×
	// the wall time and CPU (68 s / 790 CPU-s against 19 s / 219 CPU-s).
	const oneThread = ['--config', 'GDAL_NUM_THREADS', 1];
	await timed('tiles', () =>
		pMap(jobs, opts.concurrency ?? CPU_CORES, async (job) => {
			const tif = tilePath(job);
			if (!existsSync(tif))
				await timed(
					'tile',
					async () => {
						const [x, y] = job;
						const r: Rect = {
							minx: -MERC + x * span,
							maxx: -MERC + (x + 1) * span,
							maxy: MERC - y * span,
							miny: MERC - (y + 1) * span,
						};
						const clip = tif + '.fgb';
						// GEOS's topology-preserving simplify (ogr2ogr -simplify) has segfaulted once in ~1700 tiles under full
						// load, and never again on the same tile, alone or 14 at a time. A clip that succeeds is deterministic,
						// so a failed one is retried rather than ending a two-hour run.
						for (let attempt = 1; ; attempt++) {
							await fs.rm(clip, { force: true });
							try {
								await runQuiet(
									'ogr2ogr',
									oneThread,
									['-spat', r.minx, r.miny, r.maxx, r.maxy],
									['-simplify', tolerance],
									['-f', 'FlatGeobuf'],
									['-lco', 'SPATIAL_INDEX=NO'], // read once, sequentially
									['-nln', LAYER],
									['-nlt', 'PROMOTE_TO_MULTI'],
									clip,
									polygons,
									LAYER,
								);
								break;
							} catch (err) {
								if (attempt >= CLIP_ATTEMPTS) throw err;
								console.error(
									'! sea share tile %d_%d: %s — retrying',
									x,
									y,
									err instanceof Error ? err.message : err,
								);
							}
						}
						await atomic(tif, (tmp) =>
							runQuiet(
								'gdal_rasterize',
								'-q',
								oneThread,
								['-burn', SEA],
								['-init', 0],
								['-l', LAYER],
								['-a_srs', 'EPSG:3857'],
								['-te', r.minx, r.miny, r.maxx, r.maxy],
								['-ts', tilePx, tilePx],
								['-ot', 'Byte'],
								['-co', 'TILED=YES'],
								['-co', 'COMPRESS=ZSTD'],
								clip,
								tmp,
							),
						);
						await fs.rm(clip, { force: true });
					},
					`${job[0]}_${job[1]}`,
				);
			bar.tick();
		}),
	);
	bar.done();

	const list = path.join(tilesDir, 'tiles.txt');
	const vrt = path.join(tilesDir, 'mosaic.vrt');
	await fs.writeFile(list, jobs.map(tilePath).join('\n') + '\n');
	// gdal_rasterize marks 0 as no-data on what it creates; here 0 is land and has to count in the averages
	await runQuiet(
		'gdalbuildvrt',
		'-q',
		'-overwrite',
		['-srcnodata', 'None'],
		['-vrtnodata', 'None'],
		['-input_file_list', list],
		vrt,
	);
	await atomic(out, async (tmp) => {
		await runProgress(
			'mosaic',
			'gdal_translate',
			['-a_nodata', 'none'],
			['-co', 'TILED=YES'],
			['-co', 'BLOCKXSIZE=512'],
			['-co', 'BLOCKYSIZE=512'],
			['-co', 'COMPRESS=ZSTD'],
			['-co', 'BIGTIFF=YES'],
			['-co', 'SPARSE_OK=TRUE'], // land (0) blocks are not stored
			['-co', 'NUM_THREADS=ALL_CPUS'],
			vrt,
			tmp,
		);
		await runProgress(
			'overviews',
			'gdaladdo',
			['-r', 'average'], // every level holds the true sea share of its pixels
			['--config', 'COMPRESS_OVERVIEW', 'ZSTD'],
			['--config', 'SPARSE_OK_OVERVIEW', 'ON'],
			['--config', 'GDAL_NUM_THREADS', 'ALL_CPUS'],
			tmp,
			Array.from({ length: levels }, (_, i) => 2 ** (i + 1)),
		);
	});
	await fs.rm(tilesDir, { recursive: true, force: true });
}

// fail early, before a long run, when the sea share is missing or was built for another grid
export async function requireSeaShare(): Promise<void> {
	if (!existsSync(file.seaShare))
		throw new Error(
			`missing ${file.seaShare} — run "npm run download" (it keeps a source raster and polygons that are already there)`,
		);
	const stamp = await readStamp(dir.source, SEA_SHARE_STAMP);
	const builtFor = stamp?.values?.fullPx;
	if (builtFor !== undefined && builtFor !== FULL_PX)
		throw new Error(`${file.seaShare} was built for FULL_PX ${builtFor}, not ${FULL_PX} — re-run "npm run download"`);
}

// Write a VRT that reads a window straight out of the sea-share pyramid, at its own level (lib/window.ts).
// gdal_calc reads it as a second input next to the class window (lib/block.ts).
export function seaShareWindow(
	out: string,
	rect: Rect,
	width: number,
	height: number,
	src = file.seaShare,
	fullPx = FULL_PX,
): Promise<void> {
	return windowVrt(out, src, rect, width, height, { fullPx });
}
