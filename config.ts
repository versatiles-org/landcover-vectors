// shared configuration for the landcover-vectors pipeline
//
// The pipeline builds, per zoom level, a set of vector tiles that populate Shortbread's
// `land` and `water_polygons` layers up to z10, where OSM is still sparse or absent; a merge drops OSM's
// own features of those kinds there (lib/handover.ts), so OSM takes over from z11. `water` and
// `residential` are the exceptions: OSM's lakes and urban land use are the better source wherever OSM
// has them, so the merge keeps those instead.
// Each zoom is processed in BLOCK×BLOCK-tile blocks (with a pixel margin for the sieve) so
// memory stays bounded; see lib/block.ts and the README "Merging with OSM" section.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// number of logical CPU cores available to this process (respects CPU affinity)
export const CPU_CORES = os.availableParallelism();

// blocks the build and the preview process at once: one per core, each with one GDAL thread (setGdalThreads in
// lib/worldcover.ts). Every block holds its ~8246² px window and its polygons in memory, so LANDCOVER_CONCURRENCY
// lowers it where memory, not CPU, is the limit. Not part of the fingerprint: it never changes the output.
export const BLOCK_CONCURRENCY = Math.floor(numberFromEnv('LANDCOVER_CONCURRENCY', CPU_CORES, { atLeast: 1 }));

// Base directory for everything the pipeline downloads and generates. LANDCOVER_DATA_DIR relocates
// the whole cache — a preview or a parameter experiment wants its own, so it neither pollutes nor is
// polluted by the production build. LANDCOVER_SOURCE_DIR points the download mirror somewhere else,
// so several data dirs can share the one ~19 GB source raster instead of copying it.
const fromEnv = (name: string, fallback: string): string => {
	const v = process.env[name];
	return v ? path.resolve(v) : fallback;
};

export const datadir = fromEnv('LANDCOVER_DATA_DIR', path.resolve(__dirname, 'data'));
const sourcedir = fromEnv('LANDCOVER_SOURCE_DIR', path.join(datadir, '0_download'));

export const dir = {
	source: sourcedir, // holds the reprojected source raster, its tile list and the ocean mask (download)
	results: path.join(datadir, '1_results'), // per-block tilesets (cached → builds resume)
	tiles: path.join(datadir, '2_tiles'), // per-zoom tilesets, joined once a zoom's blocks are done (cached)
	tmp: path.join(datadir, 'tmp'), // per-block scratch (not cached between runs)
};

export const file = {
	source: path.join(sourcedir, 'worldcover-3857.tif'), // single EPSG:3857 source + overviews (download)
	seaShare: path.join(sourcedir, 'seashare-3857.tif'), // OSM's sea share on the source's grid + overviews (download)
	sourceList: path.join(sourcedir, '_source-tiles.txt'), // remote tile list, read for skip-empty (download)
	ocean: path.join(sourcedir, 'water-polygons-3857.fgb'), // OSM's sea polygons, rasterized into seaShare (download)
	log: path.join(datadir, 'blocks.log'), // per-block processing log (TSV), one row per block (build)
	timings: path.join(datadir, 'timings.jsonl'), // how long every step and command took (download, build)
	tiles: path.join(datadir, 'landcover.mbtiles'), // every block's tiles in one tileset (pack)
	container: path.join(datadir, 'landcover-vectors.versatiles'), // brotli versatiles, named as published (pack)
	osm: path.join(datadir, 'osm.versatiles'), // OSM Shortbread base, downloaded on demand (merge)
	merged: path.join(datadir, 'combined.versatiles'), // OSM + landcover feature-merge (merge)
};

// upstream OSM-based Shortbread container the landcover is feature-merged into (bin/merge.ts)
export const OSM_URL = 'https://download.versatiles.org/osm.versatiles';
// this container as published, what `npm run verify-merge` checks by default
export const LANDCOVER_URL = 'https://download.versatiles.org/landcover-vectors.versatiles';

// OSM's sea, computed from its coastline: the polygons Shortbread's `ocean` layer is built from (planetiler-shortbread
// reads this very file). Every block blanks them out of the ESA window as it classifies it (lib/ocean.ts), so the
// land cover ends at OSM's coastline instead of ESA's, and ESA's class-80 sea inside coastal 3° tiles never becomes `water`.
export const OCEAN_URL = 'https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip';

// where OSM's weekly planet files are (planet-YYMMDD.osm.pbf, and an .md5 each): OSM's land use is imported from
// the newest one (lib/osmland.ts)
export const PLANET_DIR_URL = 'https://planet.openstreetmap.org/pbf/';

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
// pixels and derived from OVERSAMPLE, so changing TILE_PX does not silently change the sieve too.
export const TILE_PX = 1024; // raw raster pixels per output tile
export const BLOCK = 8; // tiles per block side
export const OVERSAMPLE = TILE_PX / 256; // raw pixels per rendered pixel (4)

// Smallest patch kept, in rendered px²; smaller regions are merged into their largest neighbour. This is
// the only raster generalization: each pixel otherwise keeps its own ESA class. (A Gaussian blur before a
// per-pixel majority vote used to round the patches as well, but it moved area from scattered classes to
// dominant ones and cost accuracy for smaller tiles — see doc/TUNING.md.) LANDCOVER_SIEVE_RENDERED overrides it,
// and 0 turns it off. It is the main lever on feature count, and with that on tile bytes: the largest tiles are
// fragmented mosaics of patches only a few px² large. 5 px² against the 1.77 used before shrinks the worst
// Hudson Bay z8 tile by 42 % (118.9 → 69.4 KB, 5400 → 2341 features) for 6 points of pixel agreement with the
// source (66.6 → 60.6 %); a coarser simplify tolerance costs as much accuracy for a third of the bytes.
export const SIEVE_RENDERED = numberFromEnv('LANDCOVER_SIEVE_RENDERED', 5, { atLeast: 0 });

// full-world raster size at the deepest zoom (TILE_PX × 2^MAXLEVEL). The single EPSG:3857
// source GeoTIFF is built at this resolution and carries an overview pyramid down to z0, so a
// block at any zoom reads the matching pyramid level.
export const FULL_PX = TILE_PX * Math.pow(2, MAXLEVEL);

// sieve threshold in raw pixels (see SIEVE_RENDERED)
export const SIEVE_THRESHOLD = Math.round(SIEVE_RENDERED * OVERSAMPLE * OVERSAMPLE); // 80
// The sieve's passes, in raw pixels: a quarter of the threshold first, then the threshold. GDAL's sieve merges a
// small patch into a neighbour, but in a fragmented mosaic most neighbours are small too, so a single pass leaves
// much of it as it is — and the more, the larger the size. The small first pass merges the specks into their
// neighbours, so the full pass finds large ones for what is left. Measured at a 28 px sieve, on the Hudson Bay
// worst z6 tile: 132.9 → 82.5 KB, with better agreement at every zoom (z8: 64.5 → 66.6 %). A second pass at the
// full size instead shrinks the tiles more but is less accurate; doubling sizes 4→8→16→28 matches this one at
// twice the passes. See doc/TUNING.md.
export const SIEVE_STAGES =
	SIEVE_THRESHOLD >= 8
		? [Math.round(SIEVE_THRESHOLD / 4), SIEVE_THRESHOLD]
		: SIEVE_THRESHOLD > 0
			? [SIEVE_THRESHOLD]
			: [];

// processing margin (px) around a block so the sieve at the inner edge matches neighbours
export const MARGIN_PX = Math.ceil(3 * Math.sqrt(SIEVE_THRESHOLD)); // 27

// tippecanoe's tile buffer, in rendered pixels: each block tiles itself, so the buffer of a tile on the block's
// edge is filled from the block's own margin, and must not reach past it
export const TILE_BUFFER = Math.floor(MARGIN_PX / OVERSAMPLE); // 6

// How tippecanoe tiles a block (lib/assemble.ts). Part of the cache fingerprint: the block tilesets are cached.
export const TIPPECANOE_ARGS = [
	['--projection', 'EPSG:3857'], // the polygons stay in Web Mercator (lib/block.ts)
	['--buffer', String(TILE_BUFFER)],
	['--attribute-type', 'kind:string'],
	['--include', 'kind'], // keep only `kind` in the tiles
	'--coalesce-smallest-as-needed', // keep coverage complete instead of dropping features
];

// Vector detail: the simplify tolerance is one pixel of a (256 · DETAIL_PX)-px tile, so DETAIL_PX = 2
// keeps twice as much boundary detail per tile — and costs roughly twice the bytes. This, not TILE_PX, is
// what decides how much detail survives into the tiles: raising the raster resolution alone changes
// almost nothing, because the tolerance dominates. Measure a change with
// `npm run stats -- --probe <area>` (or `npm run sweep`) before adopting it; the budget is tippecanoe's
// 500 000 bytes per tile. At the 5 px² sieve, 2 instead of 1 costs 50 % more bytes for 3 points of agreement, and
// 0.7 saves 15 % for 2 points (worst Hudson Bay z8 tile, doc/TUNING.md).
//
// Beyond DETAIL_PX ≈ 16 the MVT grid quantises the extra precision away: tippecanoe's default
// `--detail 12` gives 4096 units per tile, i.e. 16 units per rendered pixel.
//
// LANDCOVER_DETAIL_PX overrides it for a sweep. That is safe rather than sloppy: the tolerance is part of
// the cache fingerprint, so an override builds into its own directory and is stamped there.
export const DETAIL_PX = numberFromEnv('LANDCOVER_DETAIL_PX', 1, { above: 0 });

// A numeric setting a sweep may override through the environment (LANDCOVER_DETAIL_PX,
// LANDCOVER_SIEVE_RENDERED, and LANDCOVER_CONCURRENCY, which is no output setting). An unparsable or out-of-range value is an error,
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
export type LonLatBox = { west: number; south: number; east: number; north: number };
export type BlockWindow = {
	inner3857: Rect; // exact BLOCK×BLOCK tile rectangle (the clip / seam boundary)
	window3857: Rect; // inner + MARGIN_PX, clamped to the world square (the extent read)
	windowPx: { width: number; height: number };
	innerPx: { x: number; y: number; width: number; height: number }; // the inner rectangle in window pixels
	innerLonLat: LonLatBox; // for skip-empty
	tiles: { x0: number; y0: number; x1: number; y1: number }; // the block's tiles, XYZ, x1/y1 exclusive
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

	const innerPx = {
		x: Math.round((inner3857.minx - window3857.minx) / pxSize),
		y: Math.round((window3857.maxy - inner3857.maxy) / pxSize),
		width: (x1 - x0) * TILE_PX,
		height: (y1 - y0) * TILE_PX,
	};

	const lonLat = (r: Rect): LonLatBox => ({
		west: (r.minx / MERC) * 180,
		east: (r.maxx / MERC) * 180,
		south: merc2lat(r.miny),
		north: merc2lat(r.maxy),
	});

	return {
		inner3857,
		window3857,
		windowPx,
		innerPx,
		innerLonLat: lonLat(inner3857),
		tiles: { x0, y0, x1, y1 },
	};
}

// One output class of the classification. `esa` are the ESA WorldCover class codes that map to
// it; `layer`/`kind` are the Shortbread target (null = the dropped no-data class); `maxZoom`
// is the highest zoom this pipeline emits the kind — up to there the merge drops OSM's features of
// that kind, above it OSM owns it (lib/handover.ts); `osmFrom`, if set, turns that around for a kind
// OSM maps better: from that zoom on the merge keeps OSM's features and drops this container's instead;
// `color` is the kind's fill in the preview's debug style, picked to tell kinds apart (the QGIS style uses
// versatiles-style's colours instead, lib/style-qgis.ts).
// At a given zoom z, channels with maxZoom < z are folded into the no-data class (lib/block.ts).
export type Channel = {
	esa: number[];
	layer: 'land' | 'water_polygons' | null;
	kind: string | null;
	maxZoom: number;
	osmFrom?: number;
	color?: string;
};

// ESA WorldCover → Shortbread mapping. Order is the class index order in a block; the no-data class is
// first. Legend: https://esa-worldcover.org/en/data-access
export const channels: Channel[] = [
	{ esa: [0], layer: null, kind: null, maxZoom: -1 }, // no data / OSM's sea (dropped)
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

// A pixel is sea, and so no-data, when at least this share of it (in percent) is OSM's sea: the sea-share
// pyramid (lib/ocean.ts) holds the true share at every zoom. 50 keeps the sea's area within ±0.2 % of an exact
// burn at each zoom and moves the coastline by single pixels (0.1–0.2 % of a coastal block's pixels).
export const SEA_SHARE_MIN = 50;

// the tile schema the output conforms to: Shortbread's own layer names and `kind` values (see the README
// section "What's in the tiles"). Stamped into the container by lib/assemble.ts and bin/merge.ts.
export const SCHEMA = 'shortbread@1.1';

// metadata embedded in the generated tilesets; `description` carries ESA's required credit word for word
export const meta = {
	name: 'VersaTiles Landcover Vectors',
	attribution:
		'<a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a> (<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>), coastline <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
	description: `Global land cover for zoom levels 0-${MAXLEVEL} from ESA WorldCover 2021 (v200), in Shortbread's land and water_polygons layers. © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium`,
	// the tileset's revision (MBTiles `version`): raise it with every published build whose tiles differ
	version: '3',
	// where a viewer opens the container: [lon, lat, zoom]
	center: [10, 30, 2] as [number, number, number],
	layers: {
		land: 'ESA WorldCover classes as Shortbread land kinds',
		water_polygons: "Permanent water and glaciers from ESA WorldCover; the sea is left to Shortbread's ocean layer",
	} as Record<string, string>,
};
