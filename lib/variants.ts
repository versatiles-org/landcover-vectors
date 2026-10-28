// The variants an experiment compares (bin/experiment.ts): each is today's pipeline with one or more changes, built
// over the test regions (lib/regions.ts) and measured the same way (lib/measure.ts).
//
// A variant changes the source before the blocks see it, and/or the handover:
//   burn     OSM land use, from the OSM container's z11 tiles, burned into ESA's classes as one ESA code, before
//            the overviews are built — so it is resampled, sieved and simplified exactly like ESA's own pixels.
//            `close` first closes the gaps between the polygons (streets, mostly) by that many source pixels.
//            `keep` lists kinds under which ESA's class stays: what OSM draws on top of the burned kinds anyway.
//   osmFrom  the zoom from which the merge takes a kind from OSM instead (config.ts `channels`); null = never.

import { channels, LANDCOVER_URL, type Channel } from '../config.ts';

export type Burn = { kinds: string[]; esa: number; close?: number; keep?: string[] };
export type Variant = {
	why: string;
	container?: string; // measure this container as it is, build nothing
	burn?: Burn[];
	osmFrom?: Record<string, number | null>;
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

// Every OSM kind that has an ESA class of its category, in versatiles-style's draw order, so where two overlap the
// one drawn on top wins, as at z11. Left out: cemeteries and grave yards (drawn only from z13), brownfield and
// greenfield (not drawn), and water (OSM's from z4 anyway).
const BURN_ALL: Burn[] = [
	{ kinds: ['commercial', 'retail', 'industrial', 'quarry', 'railway', 'residential', 'garages'], esa: 50 },
	{ kinds: ['farmland', 'farmyard', 'greenhouse_horticulture', 'orchard', 'plant_nursery', 'vineyard'], esa: 40 },
	{ kinds: ['landfill'], esa: 50 },
	{ kinds: GREEN, esa: 30 },
	{ kinds: ['bare_rock', 'scree', 'shingle'], esa: 60 },
	{ kinds: ['forest'], esa: 10 },
	{ kinds: ['grass', 'grassland', 'meadow', 'wet_meadow'], esa: 30 },
	{ kinds: ['heath', 'scrub'], esa: 20 },
	{ kinds: ['beach', 'sand'], esa: 60 },
	{ kinds: ['bog', 'marsh', 'string_bog', 'swamp'], esa: 90 },
];

export const VARIANTS: Record<string, Variant> = {
	published: { why: 'the published container: a check that the regional builds match it', container: LANDCOVER_URL },
	baseline: { why: "today's pipeline, on the regional sources" },
	'handover-z11': { why: 'residential stays ours at z10, OSM takes over at z11', osmFrom: { residential: 11 } },
	burn: { why: "OSM's urban land use burned in as built-up", burn: burnUrban() },
	'burn-z11': { why: 'burn, and residential stays ours at z10', burn: burnUrban(), osmFrom: { residential: 11 } },
	'burn-z11-keep': {
		why: "burn-z11, but ESA's class stays where OSM draws woods, parks or fields on top of the town",
		burn: burnUrban(undefined, ABOVE_URBAN),
		osmFrom: { residential: 11 },
	},
	'burn-green-z11': {
		why: "burn-z11, and OSM's parks, allotments, gardens and leisure grounds as grassland",
		burn: [...burnUrban(), { kinds: GREEN, esa: 30, keep: ['forest'] }],
		osmFrom: { residential: 11 },
	},
	'burn-all-z11': {
		why: 'every OSM land kind with an ESA class of its category, in draw order, and residential ours at z10',
		burn: BURN_ALL,
		osmFrom: { residential: 11 },
	},
	'burn-z11-close1': {
		why: 'burn-z11, with gaps up to 2 source px (76 m) between urban polygons closed',
		burn: burnUrban(1),
		osmFrom: { residential: 11 },
	},
	'burn-z11-close2': {
		why: 'burn-z11, with gaps up to 4 source px (153 m) between urban polygons closed',
		burn: burnUrban(2),
		osmFrom: { residential: 11 },
	},
};

// the channel table with the variant's handover
export function channelsFor(v: Variant): Channel[] {
	return channels.map((c) => {
		if (!c.kind || !v.osmFrom || !(c.kind in v.osmFrom)) return c;
		const from = v.osmFrom[c.kind];
		const { osmFrom: _, ...rest } = c;
		return from === null ? rest : { ...rest, osmFrom: from };
	});
}
