// Named areas of interest, for size probes (bin/stats.ts) and previews.
//
// The list is not arbitrary: `hudson-bay` is where the largest tiles of the z0–10 build actually sit
// (the world's most fragmented wetland mosaic — a 110 KB z10 tile), and the rest are the shapes that
// stress the pipeline differently. A parameter change is judged on these, because the global maximum is
// what decides whether tiles stay under tippecanoe's limit.

import path from 'node:path';

import { MAXLEVEL } from '../config.ts';
import type { LonLat } from './coverage.ts';

export type Area = { bbox: LonLat; why: string };

const area = (west: number, south: number, east: number, north: number, why: string): Area => ({
	bbox: { west, south, east, north },
	why,
});

export const AREAS: Record<string, Area> = {
	'hudson-bay': area(-92, 52, -84, 58, 'measured worst case: fragmented marsh/swamp/forest mosaic'),
	indonesia: area(114, -9, 124, -4, 'archipelago — coastline density'),
	norway: area(4, 58, 12, 64, 'fjords — long convoluted boundaries'),
	'nile-delta': area(29, 29, 33, 32, 'farmland/residential/water interleaving'),
	sahara: area(0, 20, 8, 26, 'best case, and a check on the uniform short-circuit'),
	'greenland-coast': area(-55, 64, -45, 70, 'glacier and bare_rock at low zoom'),
};

// the Mercator limit: tiles do not exist beyond it, so an area outside it can never match anything
export const LAT_LIMIT = 85.0511287798066;

// "min-max", "min" for a single level, or nothing for the whole range this config builds
export function parseZoomRange(spec: string | undefined, maxLevel: number = MAXLEVEL): [number, number] {
	if (!spec) return [0, maxLevel];
	const m = spec.match(/^(\d+)(?:-(\d+))?$/);
	if (!m) throw new Error(`bad zoom range "${spec}" — expected "min-max", e.g. 4-10`);
	const lo = Number(m[1]);
	const hi = m[2] === undefined ? lo : Number(m[2]);
	if (lo > hi) throw new Error(`bad zoom range "${spec}" — min (${lo}) is above max (${hi})`);
	if (hi > maxLevel) throw new Error(`bad zoom range "${spec}" — this config only builds up to z${maxLevel}`);
	return [lo, hi];
}

// A filename-safe tag for an area. It is a cache key — bin/preview.ts keeps an area's scratch and its
// tileset under it — so it has to be collision-free. A preset keeps its name (so existing tilesets keep theirs).
// An explicit box is keyed by its *resolved* numbers with sign and decimal point spelled out: stripping
// them would put "-5,10,20,30" and "5,10,20,30" — two different areas — into one cache.
export function areaSlug(spec: string | undefined): string {
	if (!spec) return 'world';
	if (AREAS[spec]) return spec.replace(/[^a-zA-Z0-9]+/g, '_');
	const { west, south, east, north } = resolveArea(spec);
	const n = (v: number) => String(v).replace(/-/g, 'm').replace(/\./g, 'p');
	return `bbox_${[west, south, east, north].map(n).join('_')}`;
}

// The cache layout of one preview build, under a config-fingerprinted directory.
//
// Block tilesets depend only on the block (and the config the directory is keyed on), so every area
// shares them — which is what makes a second area cheap. Scratch is per area, because a build starts by
// wiping it.
export function previewPaths(previewDir: string, spec: string | undefined) {
	const slug = areaSlug(spec);
	return {
		results: path.join(previewDir, '1_results'),
		tmp: path.join(previewDir, 'tmp', slug),
		log: path.join(previewDir, 'blocks.log'),
	};
}

// a preset name, or an explicit "west,south,east,north" in degrees
export function resolveArea(spec: string): LonLat {
	const preset = AREAS[spec];
	if (preset) return preset.bbox;
	if (!spec.includes(',')) {
		throw new Error(`unknown area "${spec}" — known: ${Object.keys(AREAS).join(', ')}, or "west,south,east,north"`);
	}
	const parts = spec.split(',').map((s) => Number(s.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		throw new Error(`bad bbox "${spec}" — expected four numbers: west,south,east,north`);
	}
	const [west, south, east, north] = parts as [number, number, number, number];
	if (west >= east) throw new Error(`bad bbox "${spec}" — west (${west}) must be less than east (${east})`);
	if (south >= north) throw new Error(`bad bbox "${spec}" — south (${south}) must be less than north (${north})`);
	if (west < -180 || east > 180) throw new Error(`bad bbox "${spec}" — longitude outside ±180`);
	if (south > LAT_LIMIT || north < -LAT_LIMIT)
		throw new Error(`bad bbox "${spec}" — entirely outside the Mercator range`);
	return { west, south, east, north };
}
