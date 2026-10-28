// Test regions for experiments (bin/experiment.ts): small windows, each picked for one way the land cover and OSM
// can disagree at the handover. lib/areas.ts holds the large boxes for tile-size probes; these are for measuring
// what a map shows, so each is a window of z12 tiles that lib/measure.ts rasterises, and around it an extent of
// whole z10 tiles that an experiment builds its own source for (lib/regionsource.ts).

import { MERC } from '../config.ts';
import type { LonLat } from './coverage.ts';

export const WINDOW_ZOOM = 12;
const WINDOW_TILES = 4; // z12 tiles per window side: ~24 km at 52°N, ~39 km at the equator
// z10 tiles of source around the window on each side, so the sieve at the window's edge sees what it would in the
// full build: its margin is 27 raw pixels, 4 km at z8, and a z10 tile is 39 km (in Mercator metres)
const EXTENT_PAD = 1;

export type Window = { x0: number; y0: number; side: number }; // z12 tiles, x0/y0 the top-left one
export type Region = { center: [number, number]; why: string; window: Window };

// the window of z12 tiles centred on a point
export function windowAt(lon: number, lat: number, side = WINDOW_TILES): Window {
	const n = 2 ** WINDOW_ZOOM;
	const r = (lat * Math.PI) / 180;
	const x = ((lon + 180) / 360) * n;
	const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
	return { x0: Math.round(x - side / 2), y0: Math.round(y - side / 2), side };
}

const region = (lon: number, lat: number, why: string): Region => ({
	center: [lon, lat],
	why,
	window: windowAt(lon, lat),
});

// Picked from a baseline measurement of the published container, so between them they span the cases: how much of
// the window OSM maps at all, how much of that is urban, and how well z10 agrees with z11 there.
export const REGIONS: Record<string, Region> = {
	'berlin-zehlendorf': region(13.25, 52.43, 'leafy suburb: ESA sees tree cover in OSM residential; well mapped'),
	'berlin-britz': region(13.44, 52.45, 'inner-city green: allotments, cemeteries, parks, drawn only from z11 or z13'),
	uckermark: region(13.86, 53.31, 'rural: villages, farmland, forest; well mapped'),
	ruhr: region(7.05, 51.5, 'industry, commerce and dense towns'),
	atlanta: region(-84.35, 33.9, 'tree-canopy suburbs, mapped as residential: the largest jump at the handover'),
	'nile-delta': region(31.0, 30.79, 'dense villages in farmland; OSM maps a tenth of it'),
	lagos: region(3.35, 6.55, 'tropical sprawl, partly mapped; already agrees well'),
	tokyo: region(139.55, 35.7, 'dense city with little land use mapped: z10 is blank where our residential is dropped'),
	alps: region(8.0, 46.65, 'mountains, glacier, valley villages'),
	'hudson-bay': region(-88, 55, 'no OSM land use: a control, and the largest tiles'),
};

// the z10 tiles a region's source covers: its window's, padded (x1/y1 exclusive)
export function extentTiles(w: Window): { x0: number; y0: number; x1: number; y1: number } {
	const f = 2 ** (WINDOW_ZOOM - 10);
	const max = 2 ** 10;
	return {
		x0: Math.max(0, Math.floor(w.x0 / f) - EXTENT_PAD),
		y0: Math.max(0, Math.floor(w.y0 / f) - EXTENT_PAD),
		x1: Math.min(max, Math.ceil((w.x0 + w.side) / f) + EXTENT_PAD),
		y1: Math.min(max, Math.ceil((w.y0 + w.side) / f) + EXTENT_PAD),
	};
}

// the same extent in EPSG:3857 metres, and in degrees (for planning blocks and cutting the OSM extract)
export function extent3857(w: Window) {
	const t = extentTiles(w);
	const span = (2 * MERC) / 2 ** 10;
	return { minx: -MERC + t.x0 * span, maxx: -MERC + t.x1 * span, maxy: MERC - t.y0 * span, miny: MERC - t.y1 * span };
}
export function extentLonLat(w: Window): LonLat {
	const e = extent3857(w);
	const lat = (y: number) => (Math.atan(Math.sinh((y / MERC) * Math.PI)) * 180) / Math.PI;
	return { west: (e.minx / MERC) * 180, east: (e.maxx / MERC) * 180, south: lat(e.miny), north: lat(e.maxy) };
}
