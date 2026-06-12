// shared configuration for the landcover-vectors pipeline

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CPU_CORES = 4;

// base directory for everything the pipeline downloads and generates
export const datadir = path.resolve(__dirname, 'data');

// the world raster is rendered in EPSG:3857 (Web Mercator) at SIZE×SIZE pixels covering
// the standard Mercator square (±MERC metres ≈ ±85.0511°). SIZE = 2^15 = 32768 is exactly
// zoom-7 tile resolution (128 tiles × 256 px), so the grid aligns to tile boundaries and
// the pixels are square.
export const MERC = 20037508.342789244;

// build zoom levels 0..MAXLEVEL. Each level is rendered from its own raster and simplified
// at its own tolerance (see sizeForLevel / simplifyForLevel below), then the per-level
// tilesets are merged in the pack step.
export const MAXLEVEL = 6;

// directories within the data folder, used across the pipeline
export const dir = {
	source: path.join(datadir, 'esa-worldcover-src'), // reduced-resolution raster mirror (download)
	channels: path.join(datadir, 'channels'), // per-class membership masks (channels step)
	blurred: path.join(datadir, 'blurred'), // blurred per-class masks (blur step)
};

// paths of the per-class masks (channel index i, 0-based): the raw 0/255 membership
// mask (channels step) and its blurred version (blur step), in their own folders.
// Defined here so the steps share them without importing one another (each step
// script runs work on import).
export function maskPath(i) {
	return path.join(dir.channels, `ch${String(i + 1).padStart(2, '0')}.tif`);
}
export function blurPath(i) {
	return path.join(dir.blurred, `ch${String(i + 1).padStart(2, '0')}.tif`);
}

// Gaussian blur radius (σ in pixels) applied to each mask before the argmax. The argmax
// step also derives its sieve threshold from it.
export const BLUR_RADIUS = 4;

// files within the data folder
export const file = {
	warped: path.join(datadir, 'worldcover-3857.tif'), // reprojected world raster (reproject → channels)
	code: path.join(datadir, 'landcover-code.tif'), // single-band argmax codes 10..100 (argmax → polygonize)
	geometry: path.join(datadir, 'landcover.fgb'), // polygon geometry, EPSG:4326 (polygonize → tile)
	tiles: path.join(datadir, 'landcover.mbtiles'), // merged tile pyramid z0..z6 (pack → versatiles)
};

// per-zoom-level parameters. The raster halves and the simplify tolerance doubles each
// level below MAXLEVEL, so both stay constant in pixels across levels (as does the blur
// radius). At MAXLEVEL they equal the base values (SIZE px, 2000 m).
export function sizeForLevel(z) {
	return 65536 >> (MAXLEVEL - z); // px, square: 512 (z0) … 32768 (z6)
}
export function simplifyForLevel(z) {
	return 1000 << (MAXLEVEL - z); // metres (EPSG:3857): 2000 (z6) … 128000 (z0)
}
export function tilesForLevel(z) {
	return path.join(datadir, `landcover-z${z}.mbtiles`); // per-level tiles, merged in pack
}

// The 10 channels of the blur/argmax stage, in order. Channel i (1-based) carries
// code i*10; after blurring all ten masks, each pixel is assigned the code of the
// channel with the highest value (argmax). `calc` is the gdal_calc.py expression over
// band A of the reprojected ESA raster that builds the 0/255 membership mask, and
// `kind` is the Shortbread landcover kind the code maps to in the final tiles.
//
// Several ESA classes merge (moss → bare, mangroves → wetland). The last channel is
// "no data / no landcover" (ESA 0); its code 100 is dropped before tiling.
// Legend: https://esa-worldcover.org/en/data-access
export const channels = [
	{ code: 0, kind: null, calc: '255*((A==0)|(A==80))' }, // no data / no landcover (dropped before tiling)
	{ code: 10, kind: 'forest', color: '#66AA44', calc: '255*(A==10)' }, // tree cover
	{ code: 20, kind: 'scrub', color: '#E0E4E5', calc: '255*(A==20)' }, // shrubland
	{ code: 30, kind: 'grass', color: '#D8E8C8', calc: '255*(A==30)' }, // grassland
	{ code: 40, kind: 'farmland', color: '#F0E7D1', calc: '255*(A==40)' }, // cropland
	{ code: 50, kind: 'urban', color: '#EAE6E133', calc: '255*(A==50)' }, // built-up
	{ code: 60, kind: 'bare', color: '#FAFAED', calc: '255*((A==60)|(A==100))' }, // bare/sparse vegetation + moss and lichen
	{ code: 70, kind: 'snow', color: '#FFFFFF', calc: '255*(A==70)' }, // snow and ice
	{ code: 80, kind: 'wetland', color: '#D3E6DB', calc: '255*((A==90)|(A==95))' }, // herbaceous wetland + mangroves
];

// metadata embedded in the generated tileset
export const meta = {
	layer: 'landcover-vectors',
	name: 'Versatiles Landcover',
	attribution:
		'<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a>',
	description:
		'Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
};
