// The variants an experiment compares (bin/experiment.ts): each is today's pipeline with one or more changes, built
// over the test regions (lib/regions.ts) and measured the same way (lib/measure.ts).
//
// A variant changes the source before the blocks see it, and/or the outlines:
//   burn     OSM's land use burned into ESA's classes before the overviews (lib/landburn.ts), instead of the
//            pipeline's own table (config.ts OSM_BURNS); [] burns nothing, which is ESA alone.
//            `close` first closes the gaps between the polygons (streets, mostly) by that many source pixels.
//            `keep` lists kinds under which ESA's class stays: what OSM draws on top of the burned kinds anyway.
//   sieve, detail, smooth, outline, tippecanoe, tilePx   BlockParams (lib/block.ts): the outlines, instead of config.ts's.
//   zooms    any of these for one zoom, over the variant's own.

import { LANDCOVER_URL, OSM_BURNS, type Burn } from '../config.ts';
import type { BlockParams } from './block.ts';

export type Variant = BlockParams & {
	why: string;
	container?: string; // measure this container as it is, build nothing
	burn?: Burn[];
	zooms?: Record<number, BlockParams>;
};

// what the blocks of zoom z do differently from config.ts
export function paramsFor(v: Variant, z: number): BlockParams {
	const { sieve, detail, smooth, outline, tippecanoe, tilePx } = v;
	return { sieve, detail, smooth, outline, tippecanoe, tilePx, ...v.zooms?.[z] };
}

// the same for the build's fingerprint: left out when unset, so a variant without any keeps its build
export const paramValues = ({ sieve, detail, smooth, outline, tippecanoe, tilePx, zooms }: Variant) => ({
	sieve,
	detail,
	smooth,
	outline,
	tippecanoe,
	tilePx,
	zooms,
});

// OSM's urban land use (Shortbread `land` kinds that versatiles-style draws as residential, commercial, industrial
// or waste), except quarry, which is no town
export const URBAN = ['residential', 'garages', 'commercial', 'retail', 'industrial', 'railway', 'landfill'];

// the non-urban kinds versatiles-style draws above residential at z11: OSM's woods, parks and fields inside a town
export const ABOVE_URBAN = [
	...['farmland', 'farmyard', 'greenhouse_horticulture', 'orchard', 'plant_nursery', 'vineyard'],
	...[
		'park',
		'village_green',
		'recreation_ground',
		'allotments',
		'garden',
		'miniature_golf',
		'playground',
		'golf_course',
	],
	...['bare_rock', 'scree', 'shingle', 'forest', 'grass', 'grassland', 'meadow', 'wet_meadow', 'heath', 'scrub'],
	...['beach', 'sand', 'bog', 'marsh', 'string_bog', 'swamp'],
];

const burnUrban = (close?: number, keep?: string[]): Burn[] => [
	{ kinds: URBAN, esa: 50, ...(close ? { close } : {}), ...(keep ? { keep } : {}) },
];

// OSM's green land use that versatiles-style draws as park, garden or leisure (from z11), burned as grassland
export const GREEN = [
	...['park', 'village_green', 'recreation_ground', 'allotments', 'garden'],
	...['golf_course', 'playground', 'miniature_golf'],
];

const lowZooms = (tilePx: number): Record<number, BlockParams> =>
	Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((z) => [z, { tilePx }]));

export const VARIANTS: Record<string, Variant> = {
	published: {
		why: 'the published container: a check that the regional builds match it',
		container: LANDCOVER_URL,
	},
	esa: { why: 'ESA alone: the pipeline before the burn (published up to version 3)', burn: [] },
	baseline: { why: "today's pipeline: every OSM land kind burned in (OSM_BURNS)" },
	burn: { why: "OSM's urban land use burned in as built-up", burn: burnUrban() },
	'burn-keep': {
		why: "burn, but ESA's class stays where OSM draws woods, parks or fields on top of the town",
		burn: burnUrban(undefined, ABOVE_URBAN),
	},
	'burn-green': {
		why: "burn, and OSM's parks, allotments, gardens and leisure grounds as grassland",
		burn: [...burnUrban(), { kinds: GREEN, esa: 30, keep: ['forest'] }],
	},
	'burn-close1': {
		why: 'burn, with gaps up to 2 source px (76 m) between urban polygons closed',
		burn: burnUrban(1),
	},
	'burn-close2': {
		why: 'burn, with gaps up to 4 source px (153 m) between urban polygons closed',
		burn: burnUrban(2),
	},
	// the sieve of 5 px² at every zoom, the rest as configured
	'flat-sieve': { why: 'a sieve of 5 px² at every zoom, no ramp', sieve: 5 },
	previous: {
		why: 'the pipeline before the outline changes: no filter, no rounding, one feature per polygon, detail 1, sieve 5',
		sieve: 5,
		detail: 1,
		smooth: 0,
		outline: null,
		tippecanoe: [],
	},
	// z8 read at a finer level of the pyramid, instead of its majority of majorities
	'z8-2048': { why: 'z8 from the z9 level of the pyramid, 2048 px per tile', zooms: { 8: { tilePx: 2048 } } },
	'z8-4096': { why: 'z8 from the z10 level of the pyramid, 4096 px per tile', zooms: { 8: { tilePx: 4096 } } },
	// the zooms below z8 read at a finer level of the pyramid
	'low-2048': { why: 'z0–7 at 2048 px per tile', zooms: lowZooms(2048) },
	'low-4096': { why: 'z0–7 at 4096 px per tile', zooms: lowZooms(4096) },
};

// the variant's burns: its own, or the pipeline's
export const burnsOf = (v: Variant): Burn[] => v.burn ?? OSM_BURNS;
