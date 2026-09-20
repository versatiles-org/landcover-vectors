// Named areas of interest, for size probes (bin/stats.ts) and previews.
//
// The list is not arbitrary: `hudson-bay` is where the largest tiles of the z0–10 build actually sit
// (the world's most fragmented wetland mosaic — a 60.5 KB z9 tile), and the rest are the shapes that
// stress the pipeline differently. A parameter change is judged on these, because the global maximum is
// what decides whether tiles stay under tippecanoe's limit.

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
