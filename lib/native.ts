// The native reference for `npm run inspect -- <z/x/y> --native`: what a tile should show, measured
// against ESA's own 10 m pixels instead of against our source raster, and how much area each resampling
// step of that source loses on the way.
//
// The default inspect target is our source read at TILE_PX. It already contains whatever the download's
// `-r mode` threw away, so that loss can never show up as an error, and a TILE_PX change moves the target
// along with the tile. This module reads the remote ESA COGs directly instead, and replays the source's
// resampling steps for one tile at any TILE_PX — so the loss per step and per resolution is measured
// without downloading or rebuilding the 19 GB source raster. Every stage, the reference included, has OSM's
// sea masked out — burned from the polygons, since these grids are not the sea-share pyramid's, which agrees
// with a block's mask to single coast pixels — so the comparison is about land cover, not about the coastline:
//
//   native    ESA's base level, point-sampled (nearest, overviews off): unbiased area shares
//   10 m mode the download's warp, but forced onto ESA's base level (-ovr NONE)
//   download  the download's warp as it runs, on whichever ESA overview GDAL picks for it
//   pyramid   our gdaladdo mode pyramid, read the way a block reads its window (z < MAXLEVEL only)
//
// "download" minus "10 m mode" is what ESA's own overviews cost; "10 m mode" minus "native" is what the
// majority vote at TILE_PX costs; "pyramid" minus "download" is what the cascaded mode below z10 costs.

import fs from 'node:fs/promises';
import path from 'node:path';

import { runQuiet, BUCKET, type Arg } from './worldcover.ts';
import { parseCorner, CELL, type LonLat } from './coverage.ts';
import { readBytes, tileBounds3857 } from './inspect.ts';
import { maskOcean } from './ocean.ts';
import { MERC, MAXLEVEL } from '../config.ts';

// ESA WorldCover pixel: 3° per 36 000 px
export const ESA_DEG = CELL / 36000;
// its spacing in EPSG:3857 x — the same at every latitude, because Mercator x is linear in longitude.
// (In y a degree stretches with latitude, so sampling at this spacing only ever oversamples there.)
const NATIVE_M = (ESA_DEG * MERC) / 180; // ≈ 9.3 m

// largest native sample grid: 8192² is ESA's own spacing at z9 and a 64 MB raster
export const NATIVE_CAP = 8192;
// largest replayed source window: 16384² is z6 at TILE_PX 1024, z7 at 2048 — a 256 MB raster
export const REPLAY_CAP = 16384;

// the ESA tiles (3° cells, named by their SW corner) that intersect a lon/lat box
export function esaKeysFor(keys: Iterable<string>, b: LonLat): string[] {
	const out: string[] = [];
	for (const key of keys) {
		const c = parseCorner(key);
		if (c && c.lon < b.east && c.lon + CELL > b.west && c.lat < b.north && c.lat + CELL > b.south) out.push(key);
	}
	return out;
}

// side of the native sample grid for a zoom-z tile: ESA's spacing, rounded up to a multiple of 256 so the
// 256-px majority divides evenly, and capped. Below the cap it is a point sample, which is still unbiased.
export function nativePx(z: number, cap = NATIVE_CAP): number {
	const span = (2 * MERC) / Math.pow(2, z);
	return Math.min(cap, Math.ceil(span / NATIVE_M / 256) * 256);
}

// side of the source raster under a zoom-z tile: the download warps the world at the deepest zoom's
// resolution, i.e. tilePx per z(MAXLEVEL) tile
export function replayPx(z: number, tilePx: number): number {
	if (z > MAXLEVEL) throw new Error(`z${z} is above MAXLEVEL (${MAXLEVEL})`);
	const px = tilePx * Math.pow(2, MAXLEVEL - z);
	if (px > REPLAY_CAP)
		throw new Error(
			`replaying the source under a z${z} tile at TILE_PX ${tilePx} needs ${px}² px (cap ${REPLAY_CAP}²) — pick a higher zoom`,
		);
	return px;
}

// share of the pixels per code
export function shares(codes: Uint8Array): Map<number, number> {
	const counts = new Float64Array(256);
	for (let i = 0; i < codes.length; i++) counts[codes[i]]++;
	const out = new Map<number, number>();
	for (let c = 0; c < 256; c++) if (counts[c] > 0) out.set(c, counts[c] / codes.length);
	return out;
}

// ½·Σ|Δshare|: area on the wrong class in aggregate. Grid-independent, so rasters of different sizes compare.
export function shareError(a: Map<number, number>, b: Map<number, number>): number {
	let sum = 0;
	for (const code of new Set([...a.keys(), ...b.keys()])) sum += Math.abs((a.get(code) ?? 0) - (b.get(code) ?? 0));
	return sum / 2;
}

// ---------------------------------------------------------------- GDAL

// a virtual mosaic of the given ESA tiles, read over /vsicurl exactly like the download reads them
export async function esaMosaic(keys: string[], dir: string): Promise<string> {
	if (keys.length === 0) throw new Error('no ESA tile covers this tile (open ocean?)');
	const list = path.join(dir, 'esa.txt');
	const vrt = path.join(dir, 'esa.vrt');
	await fs.writeFile(list, keys.map((k) => `/vsicurl/${BUCKET}/${k}`).join('\n') + '\n');
	await runQuiet('gdalbuildvrt', '-q', '-overwrite', ['-input_file_list', list], vrt);
	return vrt;
}

// warp `src` onto the px×px EPSG:3857 grid of tile z/x/y, with OSM's sea burned out of it
async function warpTile(src: string, out: string, z: number, x: number, y: number, px: number, ...args: Arg[]) {
	const b = tileBounds3857(z, x, y);
	await runQuiet(
		'gdalwarp',
		'-q',
		['-t_srs', 'EPSG:3857'],
		['-te', b.minx, b.miny, b.maxx, b.maxy],
		['-ts', px, px],
		['-ot', 'Byte'],
		'-multi',
		['-wo', 'NUM_THREADS=ALL_CPUS'],
		...args,
		'-overwrite',
		src,
		out,
	);
	await maskOcean(out, b, px, out + '.sea.fgb');
}

// ESA's base level under the tile, point-sampled
export async function readNative(vrt: string, dir: string, z: number, x: number, y: number): Promise<Uint8Array> {
	const px = nativePx(z);
	const out = path.join(dir, 'native.tif');
	await warpTile(vrt, out, z, x, y, px, ['-r', 'near'], ['-ovr', 'NONE']);
	return readBytes(out, dir, px);
}

export type Replay = { tenMetre: Uint8Array; download: Uint8Array; pyramid: Uint8Array | null; px: number };

// the source raster under the tile at a given TILE_PX, the way lib/download.ts builds it and a block reads it
export async function replaySource(
	vrt: string,
	dir: string,
	z: number,
	x: number,
	y: number,
	tilePx: number,
): Promise<Replay> {
	const px = replayPx(z, tilePx);
	// the download's warp: -r mode, ESA no-data → 0, which is also our no-data (so later mode reads skip it)
	const download = ['-r', 'mode', '-dstnodata', 0];

	const tenMetre = path.join(dir, `ten-${tilePx}.tif`);
	await warpTile(vrt, tenMetre, z, x, y, px, download, ['-ovr', 'NONE']);
	const source = path.join(dir, `download-${tilePx}.tif`);
	await warpTile(vrt, source, z, x, y, px, download, ['-co', 'TILED=YES']);

	let pyramid: Uint8Array | null = null;
	if (z < MAXLEVEL) {
		// the download's gdaladdo, down to this zoom, then the block's read (-r mode at tilePx per tile)
		const factors = Array.from({ length: MAXLEVEL - z }, (_, i) => Math.pow(2, i + 1));
		await runQuiet('gdaladdo', '-q', ['-r', 'mode'], source, factors);
		const read = path.join(dir, `pyramid-${tilePx}.tif`);
		await warpTile(source, read, z, x, y, tilePx, ['-r', 'mode']);
		pyramid = await readBytes(read, dir, tilePx);
	}
	return { tenMetre: await readBytes(tenMetre, dir, px), download: await readBytes(source, dir, px), pyramid, px };
}
