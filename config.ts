// shared configuration for the landcover-vectors pipeline
//
// The pipeline builds, per zoom level, a set of vector tiles that populate Shortbread's
// `land` and `water_polygons` layers up to z10, where OSM is still sparse or absent; a merge drops OSM's
// own features of those kinds there (lib/handover.ts), so OSM takes over from z11. `water` and
// `residential` are the exceptions: OSM's lakes and urban land use are the better source wherever OSM
// has them, so the merge keeps those instead.
// Each zoom is processed in BLOCK×BLOCK-tile blocks (with a pixel margin for blur/sieve) so
// memory stays bounded; see lib/block.ts and the README "Merging with OSM" section.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// number of logical CPU cores available to this process (respects CPU affinity)
export const CPU_CORES = os.availableParallelism();

// Base directory for everything the pipeline downloads and generates. LANDCOVER_DATA_DIR relocates
// the whole cache — a preview or a parameter experiment wants its own, so it neither pollutes nor is
// polluted by the production build. LANDCOVER_SOURCE_DIR points the download mirror somewhere else,
// so several data dirs can share the one ~23 GB source raster instead of copying it.
const fromEnv = (name: string, fallback: string): string => {
	const v = process.env[name];
	return v ? path.resolve(v) : fallback;
};

export const datadir = fromEnv('LANDCOVER_DATA_DIR', path.resolve(__dirname, 'data'));
const sourcedir = fromEnv('LANDCOVER_SOURCE_DIR', path.join(datadir, '0_download'));

export const dir = {
	source: sourcedir, // holds the reprojected source raster + its tile list (download)
	results: path.join(datadir, '1_results'), // per-block land/water fragments (cached → builds resume)
	tiles: path.join(datadir, '2_tiles'), // per-zoom mbtiles (cached → builds resume)
	tmp: path.join(datadir, 'tmp'), // per-block / per-zoom scratch (not cached between runs)
};

export const file = {
	source: path.join(sourcedir, 'worldcover-3857.tif'), // single EPSG:3857 source + overviews (download)
	sourceList: path.join(sourcedir, '_source-tiles.txt'), // remote tile list, read for skip-empty (download)
	log: path.join(datadir, 'blocks.log'), // per-block processing log (TSV), one row per block (build)
	tiles: path.join(datadir, 'landcover.mbtiles'), // merged tile pyramid (pack)
	container: path.join(datadir, 'landcover.versatiles'), // brotli versatiles (pack)
	osm: path.join(datadir, 'osm.versatiles'), // OSM Shortbread base, downloaded on demand (merge)
	merged: path.join(datadir, 'combined.versatiles'), // OSM + landcover feature-merge (merge)
};

// upstream OSM-based Shortbread container the landcover is feature-merged into (bin/merge.ts)
export const OSM_URL = 'https://download.versatiles.org/osm.versatiles';

// EPSG:3857 (Web Mercator) world half-extent in metres (±MERC ≈ ±85.0511°)
export const MERC = 20037508.342789244;
const WORLD = 2 * MERC; // full extent (= circumference) in metres

// build zoom levels 0..MAXLEVEL (driven by the highest per-kind cutoff below)
export const MAXLEVEL = 10;

// block-processing geometry.
//
// TILE_PX is the quality/cost dial for the *raster* side: the source is classified at TILE_PX raw pixels
// per 256-px output tile, so 1024 means 4× oversampling (38 m/px at z10, against ESA's native 10 m). The
// per-block window is BLOCK × TILE_PX pixels, so halve BLOCK when doubling TILE_PX to keep the window —
// and therefore the memory per block — where it is. Everything downstream is expressed in *rendered*
// pixels and derived from OVERSAMPLE, so changing TILE_PX does not silently change the smoothing too.
export const TILE_PX = 1024; // raw raster pixels per output tile
export const BLOCK = 8; // tiles per block side
export const OVERSAMPLE = TILE_PX / 256; // raw pixels per rendered pixel (4)

// Gaussian σ, in rendered pixels: how much of the pixel staircase is smoothed away before the argmax.
// Below ~0.5 the boundaries turn blocky again; above ~1 small features start dissolving. Because the
// argmax is a per-pixel majority vote, blurring also moves area from scattered classes to dominant ones
// (in the Hudson Bay worst tile, heath loses half its area in this one step) — this is the main lever
// on *which class ends up where*, where DETAIL_PX only changes how precisely the result is outlined.
export const BLUR_RENDERED = numberFromEnv('LANDCOVER_BLUR_RENDERED', 0.75, { above: 0 });
export const BLUR_RADIUS = BLUR_RENDERED * OVERSAMPLE; // Gaussian σ in raw pixels (3)

// Smallest patch kept, in rendered px²; smaller regions are merged into their largest neighbour. It
// defaults to a circle of the blur radius (π·σ² ≈ 1.77 px²) and so follows a blur override;
// LANDCOVER_SIEVE_RENDERED decouples the two (less smoothing, still no speckle), and 0 turns it off.
// It is the main lever on feature count, and with that on tile bytes.
export const SIEVE_RENDERED = numberFromEnv('LANDCOVER_SIEVE_RENDERED', Math.PI * BLUR_RENDERED * BLUR_RENDERED, {
	atLeast: 0,
});

// full-world raster size at the deepest zoom (TILE_PX × 2^MAXLEVEL). The single EPSG:3857
// source GeoTIFF is built at this resolution and carries an overview pyramid down to z0, so a
// block at any zoom reads the matching pyramid level.
export const FULL_PX = TILE_PX * Math.pow(2, MAXLEVEL);

// sieve threshold in raw pixels (see SIEVE_RENDERED)
export const SIEVE_THRESHOLD = Math.round(SIEVE_RENDERED * OVERSAMPLE * OVERSAMPLE); // 28
// processing margin (px) around a block so blur+sieve at the inner edge match neighbours
export const MARGIN_PX = Math.ceil(3 * BLUR_RADIUS + 3 * Math.sqrt(SIEVE_THRESHOLD)); // 25

// Vector detail: the simplify tolerance is one pixel of a (256 · DETAIL_PX)-px tile, so DETAIL_PX = 2
// keeps twice as much boundary detail per tile — and costs roughly twice the bytes. This, not TILE_PX, is
// what decides how much detail survives into the tiles: raising the raster resolution alone changes
// almost nothing, because the tolerance dominates. Measure a change with
// `npm run stats -- --probe <area>` (or `npm run sweep`) before adopting it; the budget is tippecanoe's
// 500 000 bytes per tile, and the z0–10 build's worst tile sits at ~60 KB.
//
// Beyond DETAIL_PX ≈ 16 the MVT grid quantises the extra precision away: tippecanoe's default
// `--detail 12` gives 4096 units per tile, i.e. 16 units per rendered pixel.
//
// LANDCOVER_DETAIL_PX overrides it for a sweep. That is safe rather than sloppy: the tolerance is part of
// the cache fingerprint, so an override builds into its own directory and is stamped there.
export const DETAIL_PX = numberFromEnv('LANDCOVER_DETAIL_PX', 1, { above: 0 });

// A numeric setting a sweep may override through the environment (LANDCOVER_DETAIL_PX,
// LANDCOVER_BLUR_RENDERED, LANDCOVER_SIEVE_RENDERED). An unparsable or out-of-range value is an error,
// never a silent fallback, because it changes the output. Empty counts as unset.
function numberFromEnv(name: string, fallback: number, bound: { above?: number; atLeast?: number }): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	const inRange =
		Number.isFinite(value) &&
		(bound.above === undefined || value > bound.above) &&
		(bound.atLeast === undefined || value >= bound.atLeast);
	if (!inRange) {
		const want =
			bound.above === 0
				? 'a positive number'
				: bound.above !== undefined
					? `a number above ${bound.above}`
					: `a number of at least ${bound.atLeast}`;
		throw new Error(`bad ${name} "${raw}" — expected ${want}`);
	}
	return value;
}

// coverage-simplification tolerance (metres, EPSG:3857): 1-px accuracy at a (256 · DETAIL_PX)-px tile
export function simplifyForLevel(z: number): number {
	return WORLD / (256 * DETAIL_PX * Math.pow(2, z));
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
// is the highest zoom this pipeline emits the kind — up to there the merge drops OSM's features of
// that kind, above it OSM owns it (lib/handover.ts); `osmFrom`, if set, turns that around for a kind
// OSM maps better: from that zoom on the merge keeps OSM's features and drops this container's instead;
// `color` is the fill used by the generated QGIS styles.
// At a given zoom z, channels with maxZoom < z are folded into the no-data class (lib/block.ts).
export type Channel = {
	esa: number[];
	layer: 'land' | 'water_polygons' | null;
	kind: string | null;
	maxZoom: number;
	osmFrom?: number;
	color?: string;
};

// ESA WorldCover → Shortbread mapping. Order is the argmax channel order; the no-data class is
// first. Legend: https://esa-worldcover.org/en/data-access
export const channels: Channel[] = [
	{ esa: [0], layer: null, kind: null, maxZoom: -1 }, // no data / open ocean (dropped)
	{ esa: [10], layer: 'land', kind: 'forest', maxZoom: 10, color: '#66AA44' }, // tree cover
	{ esa: [40], layer: 'land', kind: 'farmland', maxZoom: 10, color: '#F0E7D1' }, // cropland
	{ esa: [50], layer: 'land', kind: 'residential', maxZoom: 10, osmFrom: 10, color: '#EAE6E1' }, // built-up (OSM's from z10, where Shortbread starts every urban kind)
	{ esa: [60], layer: 'land', kind: 'bare_rock', maxZoom: 10, color: '#D9D5CE' }, // bare / sparse vegetation
	{ esa: [100], layer: 'land', kind: 'heath', maxZoom: 10, color: '#CFD3B0' }, // moss & lichen (tundra)
	{ esa: [20], layer: 'land', kind: 'scrub', maxZoom: 10, color: '#E0E4E5' }, // shrubland
	{ esa: [30], layer: 'land', kind: 'grassland', maxZoom: 10, color: '#D8E8C8' }, // grassland
	{ esa: [90], layer: 'land', kind: 'marsh', maxZoom: 10, color: '#D3E6DB' }, // herbaceous wetland
	{ esa: [95], layer: 'land', kind: 'swamp', maxZoom: 10, color: '#C6DCC6' }, // mangroves
	{ esa: [70], layer: 'water_polygons', kind: 'glacier', maxZoom: 10, color: '#FFFFFF' }, // snow & ice
	{ esa: [80], layer: 'water_polygons', kind: 'water', maxZoom: 10, osmFrom: 4, color: '#B3D9E6' }, // permanent water (OSM's from z4, where Shortbread starts it)
];

// the tile schema the output conforms to: Shortbread's own layer names and `kind` values (see the README
// section "What's in the tiles"). Stamped into the container by lib/assemble.ts and bin/merge.ts.
export const SCHEMA = 'shortbread@1.1';

// metadata embedded in the generated tilesets
export const meta = {
	name: 'Versatiles Landcover',
	attribution:
		'<a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a> (<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)',
	description:
		'Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
};
