// shared configuration for the landcover-vectors pipeline
//
// The pipeline builds, per zoom level, a set of vector tiles that populate Shortbread's
// `land` and `water_polygons` layers at the low zooms where OSM doesn't yet provide them.
// Each zoom is processed in BLOCK×BLOCK-tile blocks (with a pixel margin for blur/sieve) so
// memory stays bounded; see lib/block.ts and the README "Shortbread compatibility" section.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// number of logical CPU cores available to this process (respects CPU affinity)
export const CPU_CORES = os.availableParallelism();

// base directory for everything the pipeline downloads and generates
export const datadir = path.resolve(__dirname, 'data');

export const dir = {
	source: path.join(datadir, '0_download'), // holds the reprojected source raster + its tile list (download)
	results: path.join(datadir, '1_results'), // per-block land/water fragments (cached → builds resume)
	tiles: path.join(datadir, '2_tiles'), // per-zoom mbtiles (cached → builds resume)
	tmp: path.join(datadir, 'tmp'), // per-block / per-zoom scratch (not cached between runs)
};

export const file = {
	source: path.join(datadir, '0_download', 'worldcover-3857.tif'), // single EPSG:3857 source + overviews (download)
	sourceList: path.join(datadir, '0_download', '_source-tiles.txt'), // remote tile list, read for skip-empty (download)
	tiles: path.join(datadir, 'landcover.mbtiles'), // merged tile pyramid (pack)
	container: path.resolve(__dirname, 'landcover.versatiles'), // brotli versatiles (pack)
};

// EPSG:3857 (Web Mercator) world half-extent in metres (±MERC ≈ ±85.0511°)
export const MERC = 20037508.342789244;
const WORLD = 2 * MERC; // full extent (= circumference) in metres

// build zoom levels 0..MAXLEVEL (driven by the highest per-kind cutoff below)
export const MAXLEVEL = 10;

// block-processing geometry
export const TILE_PX = 1024; // raw raster pixels per output tile
export const BLOCK = 8; // tiles per block side
export const BLUR_RADIUS = 2; // Gaussian σ in pixels (constant across levels)

// full-world raster size at the deepest zoom (TILE_PX × 2^MAXLEVEL). The single EPSG:3857
// source GeoTIFF is built at this resolution and carries an overview pyramid down to z0, so a
// block at any zoom reads the matching pyramid level.
export const FULL_PX = TILE_PX * Math.pow(2, MAXLEVEL);

// sieve threshold (px): drop regions smaller than a circle of the blur radius
export const SIEVE_THRESHOLD = Math.round(Math.PI * BLUR_RADIUS * BLUR_RADIUS); // 13
// processing margin (px) around a block so blur+sieve at the inner edge match neighbours
export const MARGIN_PX = Math.ceil(3 * BLUR_RADIUS + 3 * Math.sqrt(SIEVE_THRESHOLD)); // 17

// coverage-simplification tolerance (metres, EPSG:3857): 1-px accuracy at a 128-px tile
export function simplifyForLevel(z: number): number {
	return WORLD / (128 * Math.pow(2, z));
}

// number of BLOCK×BLOCK blocks per axis at zoom z
export function blocksPerAxis(z: number): number {
	return Math.ceil(Math.pow(2, z) / BLOCK);
}

// inverse Web Mercator: northing (metres) → latitude (degrees)
function merc2lat(y: number): number {
	return (Math.atan(Math.sinh((y / MERC) * Math.PI)) * 180) / Math.PI;
}

export type Rect = { minx: number; miny: number; maxx: number; maxy: number };
export type BlockWindow = {
	inner3857: Rect; // exact BLOCK×BLOCK tile rectangle (the clip / seam boundary)
	window3857: Rect; // inner + MARGIN_PX, clamped to the world square (the warp extent)
	windowPx: { width: number; height: number };
	innerLonLat: { west: number; south: number; east: number; north: number }; // for skip-empty
};

// extents and pixel size for block (bx,by) at zoom z. Edge blocks are clamped to the grid
// / world square. All exact tile-aligned 3857 metres, so neighbouring blocks share an
// identical inner edge (no seam gaps after clip + simplify --preserve-boundary).
export function blockWindow(z: number, bx: number, by: number): BlockWindow {
	const tiles = Math.pow(2, z);
	const tileSpan = WORLD / tiles; // metres per tile
	const pxSize = tileSpan / TILE_PX; // metres per raster pixel

	const x0 = bx * BLOCK;
	const y0 = by * BLOCK;
	const x1 = Math.min(x0 + BLOCK, tiles);
	const y1 = Math.min(y0 + BLOCK, tiles);

	// 3857: x increases east from -MERC; tile row 0 is the top (+MERC), increasing south
	const inner3857: Rect = {
		minx: -MERC + x0 * tileSpan,
		maxx: -MERC + x1 * tileSpan,
		maxy: MERC - y0 * tileSpan,
		miny: MERC - y1 * tileSpan,
	};

	const m = MARGIN_PX * pxSize;
	const window3857: Rect = {
		minx: Math.max(-MERC, inner3857.minx - m),
		miny: Math.max(-MERC, inner3857.miny - m),
		maxx: Math.min(MERC, inner3857.maxx + m),
		maxy: Math.min(MERC, inner3857.maxy + m),
	};
	const windowPx = {
		width: Math.round((window3857.maxx - window3857.minx) / pxSize),
		height: Math.round((window3857.maxy - window3857.miny) / pxSize),
	};

	const innerLonLat = {
		west: (inner3857.minx / MERC) * 180,
		east: (inner3857.maxx / MERC) * 180,
		south: merc2lat(inner3857.miny),
		north: merc2lat(inner3857.maxy),
	};

	return { inner3857, window3857, windowPx, innerLonLat };
}

// One channel of the blur/argmax stage. `esa` are the ESA WorldCover class codes that map to
// it; `layer`/`kind` are the Shortbread target (null = the dropped no-data class); `maxZoom`
// is the highest zoom this pipeline emits the kind (one below Shortbread's min-zoom for that
// value, so OSM owns it above); `color` is the fill used by the generated QGIS styles.
// At a given zoom z, channels with maxZoom < z are folded into the no-data class (lib/block.ts).
export type Channel = {
	esa: number[];
	layer: 'land' | 'water_polygons' | null;
	kind: string | null;
	maxZoom: number;
	color?: string;
};

// ESA WorldCover → Shortbread mapping. Order is the argmax channel order; the no-data class is
// first. Legend: https://esa-worldcover.org/en/data-access
export const channels: Channel[] = [
	{ esa: [0], layer: null, kind: null, maxZoom: -1 }, // no data / open ocean (dropped)
	{ esa: [10], layer: 'land', kind: 'forest', maxZoom: 6, color: '#66AA44' }, // tree cover
	{ esa: [40], layer: 'land', kind: 'farmland', maxZoom: 9, color: '#F0E7D1' }, // cropland
	{ esa: [50], layer: 'land', kind: 'residential', maxZoom: 9, color: '#EAE6E1' }, // built-up
	{ esa: [60, 100], layer: 'land', kind: 'sand', maxZoom: 9, color: '#FAFAED' }, // bare/sparse + moss & lichen
	{ esa: [20], layer: 'land', kind: 'scrub', maxZoom: 10, color: '#E0E4E5' }, // shrubland
	{ esa: [30], layer: 'land', kind: 'grassland', maxZoom: 10, color: '#D8E8C8' }, // grassland
	{ esa: [90], layer: 'land', kind: 'marsh', maxZoom: 10, color: '#D3E6DB' }, // herbaceous wetland
	{ esa: [95], layer: 'land', kind: 'swamp', maxZoom: 10, color: '#C6DCC6' }, // mangroves
	{ esa: [70], layer: 'water_polygons', kind: 'glacier', maxZoom: 3, color: '#FFFFFF' }, // snow & ice
	{ esa: [80], layer: 'water_polygons', kind: 'water', maxZoom: 3, color: '#B3D9E6' }, // permanent water
];

// metadata embedded in the generated tilesets
export const meta = {
	name: 'Versatiles Landcover',
	attribution:
		'<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a>',
	description:
		'Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
};
