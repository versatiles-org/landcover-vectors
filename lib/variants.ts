// The variants an experiment compares (bin/experiment.ts): each is today's pipeline with one or more changes, built
// over the test regions (lib/regions.ts) and measured the same way (lib/measure.ts).
//
// A variant changes the source before the blocks see it, and/or the handover:
//   burn     OSM's land use burned into ESA's classes before the overviews (lib/landburn.ts), instead of the
//            pipeline's own table (config.ts OSM_BURNS); [] burns nothing, which is ESA alone.
//            `close` first closes the gaps between the polygons (streets, mostly) by that many source pixels.
//            `keep` lists kinds under which ESA's class stays: what OSM draws on top of the burned kinds anyway.
//   osmFrom  the zoom from which the merge takes a kind from OSM instead (config.ts `channels`); null = never.
//   smooth   a round majority filter after the sieve (lib/block.ts), its radius in rendered px: rounds the
//            outlines before they are traced, against the staircase the simplify leaves.

import { channels, LANDCOVER_URL, OSM_BURNS, type Burn, type Channel } from '../config.ts';

export type Variant = {
	why: string;
	container?: string; // measure this container as it is, build nothing
	burn?: Burn[];
	osmFrom?: Record<string, number | null>;
	smooth?: number;
};

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

export const VARIANTS: Record<string, Variant> = {
	// merged the way it was published (version 3): residential OSM's from z10
	published: {
		why: 'the published container: a check that the regional builds match it',
		container: LANDCOVER_URL,
		osmFrom: { residential: 10 },
	},
	esa: {
		why: "ESA alone, residential OSM's from z10: the pipeline before the burn (published up to version 3)",
		burn: [],
		osmFrom: { residential: 10 },
	},
	baseline: { why: "today's pipeline: every OSM land kind burned in (OSM_BURNS), residential OSM's from z11" },
	'handover-z11': { why: 'ESA alone, residential ours at z10, OSM takes over at z11', burn: [] },
	burn: { why: "OSM's urban land use burned in as built-up", burn: burnUrban(), osmFrom: { residential: 10 } },
	'burn-z11': { why: 'burn, and residential stays ours at z10', burn: burnUrban() },
	'burn-z11-keep': {
		why: "burn-z11, but ESA's class stays where OSM draws woods, parks or fields on top of the town",
		burn: burnUrban(undefined, ABOVE_URBAN),
	},
	'burn-green-z11': {
		why: "burn-z11, and OSM's parks, allotments, gardens and leisure grounds as grassland",
		burn: [...burnUrban(), { kinds: GREEN, esa: 30, keep: ['forest'] }],
	},
	'burn-z11-close1': {
		why: 'burn-z11, with gaps up to 2 source px (76 m) between urban polygons closed',
		burn: burnUrban(1),
	},
	'burn-z11-close2': {
		why: 'burn-z11, with gaps up to 4 source px (153 m) between urban polygons closed',
		burn: burnUrban(2),
	},
	'smooth-0.5': {
		why: 'baseline, with a round majority filter of 0.5 rendered px radius after the sieve',
		smooth: 0.5,
	},
	'smooth-1': { why: 'baseline, with a round majority filter of 1 rendered px radius after the sieve', smooth: 1 },
	'smooth-1.5': {
		why: 'baseline, with a round majority filter of 1.5 rendered px radius after the sieve',
		smooth: 1.5,
	},
};

// the variant's burns: its own, or the pipeline's
export const burnsOf = (v: Variant): Burn[] => v.burn ?? OSM_BURNS;

// the channel table with the variant's handover
export function channelsFor(v: Variant): Channel[] {
	return channels.map((c) => {
		if (!c.kind || !v.osmFrom || !(c.kind in v.osmFrom)) return c;
		const from = v.osmFrom[c.kind];
		const { osmFrom: _, ...rest } = c;
		return from === null ? rest : { ...rest, osmFrom: from };
	});
}
