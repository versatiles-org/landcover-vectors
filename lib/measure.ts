// What a map shows around the handover, measured: for one test region (lib/regions.ts), the merge at z8–10 and
// OSM at z11 are rasterised onto one grid and painted the way versatiles-style draws them (its draw order, and its
// zoom-dependent opacity at mid-zoom), then compared pixel by pixel in coarse categories, since ESA's and OSM's
// kinds do not map one to one. bin/experiment.ts runs this on every variant.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

import { osm as osmStyle } from '@versatiles/style';

import { decodeTile, rings } from './mvt.ts';
import { WINDOW_ZOOM, type Window } from './regions.ts';

export type TileReader = { getTile(z: number, x: number, y: number): Promise<Uint8Array | null | undefined> };

export const CATEGORIES = ['none', 'urban', 'forest', 'green', 'agri', 'water', 'bare'] as const;
export type Category = (typeof CATEGORIES)[number];
const code = (c: Category) => CATEGORIES.indexOf(c);

// versatiles-style's land and water fills → category
const CATEGORY: Record<string, Category> = {
	'land-residential': 'urban',
	'land-commercial': 'urban',
	'land-industrial': 'urban',
	'land-waste': 'urban',
	'land-forest': 'forest',
	'land-grass': 'green',
	'land-park': 'green',
	'land-garden': 'green',
	'land-leisure': 'green',
	'land-burial': 'green',
	'land-vegetation': 'green',
	'land-wetland': 'green',
	'land-agriculture': 'agri',
	'water-area': 'water',
	'water-area-river': 'water',
	'water-area-small': 'water',
	'land-rock': 'bare',
	'land-sand': 'bare',
	'land-glacier': 'bare',
};

export const PX = 256; // grid pixels per z12 tile: ~24 m at 52°N
const LAYERS = ['land', 'water_polygons'];

// ---------------------------------------------------------------- rasterising

export type Masks = Map<string, Uint8Array>; // "layer/kind" → 1 where a polygon of it covers the pixel
export type Raster = { masks: Masks; bytes: number; features: number; tiles: number };

// every land and water polygon of `source` at zoom z over the window, on its grid (side × PX pixels per side)
export async function rasterise(source: TileReader, z: number, win: Window): Promise<Raster> {
	const n = win.side * PX;
	const masks: Masks = new Map();
	const f = 2 ** (z - WINDOW_ZOOM);
	const [tx0, ty0] = [Math.floor(win.x0 * f), Math.floor(win.y0 * f)];
	const [tx1, ty1] = [Math.ceil((win.x0 + win.side) * f), Math.ceil((win.y0 + win.side) * f)];
	const jobs: [number, number][] = [];
	for (let tx = tx0; tx < tx1; tx++) for (let ty = ty0; ty < ty1; ty++) jobs.push([tx, ty]);
	let [bytes, features] = [0, 0];
	await Promise.all(
		jobs.map(async ([tx, ty]) => {
			const buf = await source.getTile(z, tx, ty);
			if (!buf) return;
			bytes += buf.length;
			for (const layer of decodeTile(buf)) {
				if (!LAYERS.includes(layer.name)) continue;
				// tile units → grid pixels
				const scale = (PX * 2 ** (WINDOW_ZOOM - z)) / layer.extent;
				const ox = (tx / f - win.x0) * PX;
				const oy = (ty / f - win.y0) * PX;
				for (const feature of layer.features) {
					if (feature.type !== 3) continue; // polygons only
					features++;
					const key = `${layer.name}/${feature.kind}`;
					let mask = masks.get(key);
					if (!mask) masks.set(key, (mask = new Uint8Array(n * n)));
					fill(mask, n, rings(feature.geometry), scale, ox, oy);
				}
			}
		}),
	);
	return { masks, bytes, features, tiles: jobs.length };
}

// even-odd scanline fill at pixel centres
function fill(mask: Uint8Array, n: number, rs: [number, number][][], scale: number, ox: number, oy: number): void {
	const edges: [number, number, number, number][] = [];
	let [ymin, ymax] = [Infinity, -Infinity];
	for (const r of rs)
		for (let i = 0; i < r.length; i++) {
			const [a, b] = [r[i], r[(i + 1) % r.length]];
			const e: [number, number, number, number] = [
				ox + a[0] * scale,
				oy + a[1] * scale,
				ox + b[0] * scale,
				oy + b[1] * scale,
			];
			edges.push(e);
			ymin = Math.min(ymin, e[1], e[3]);
			ymax = Math.max(ymax, e[1], e[3]);
		}
	for (let py = Math.max(0, Math.floor(ymin)); py < Math.min(n, Math.ceil(ymax)); py++) {
		const yc = py + 0.5;
		const xs: number[] = [];
		for (const [ax, ay, bx, by] of edges)
			if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
		xs.sort((a, b) => a - b);
		for (let i = 0; i + 1 < xs.length; i += 2) {
			const [a, b] = [Math.max(0, Math.round(xs[i])), Math.min(n, Math.round(xs[i + 1]))];
			mask.fill(1, py * n + a, Math.max(py * n + a, py * n + b));
		}
	}
}

// ---------------------------------------------------------------- painting

type FillLayer = { id: string; layer: string; minzoom?: number; maxzoom?: number; filter?: unknown; opacity: unknown };

// versatiles-style's land and water fills, bottom to top, as the merge is drawn (its landcover feature on)
const FILLS: FillLayer[] = osmStyle({ features: { landcover: true } })
	.layers.filter((l) => l.type === 'fill' && 'source-layer' in l && LAYERS.includes(l['source-layer'] as string))
	.map((l) => ({
		id: l.id,
		layer: (l as { 'source-layer': string })['source-layer'],
		minzoom: l.minzoom,
		maxzoom: l.maxzoom,
		filter: 'filter' in l ? l.filter : undefined,
		opacity: (l.paint as Record<string, unknown> | undefined)?.['fill-opacity'],
	}));

// a fill's opacity at zoom z: a number, or a linear zoom interpolation
export function opacityAt(opacity: unknown, z: number): number {
	if (opacity === undefined) return 1;
	if (typeof opacity === 'number') return opacity;
	if (Array.isArray(opacity) && opacity[0] === 'interpolate') {
		const stops = opacity.slice(3) as number[];
		if (z <= stops[0]) return stops[1];
		for (let i = 2; i < stops.length; i += 2)
			if (z <= stops[i])
				return stops[i - 1] + ((stops[i + 1] - stops[i - 1]) * (z - stops[i - 2])) / (stops[i] - stops[i - 2]);
		return stops[stops.length - 1];
	}
	return 1;
}

// the kinds a fill's filter selects: ["in", ["get","kind"], ["literal", […]]] or ["==", ["get","kind"], "…"]
export function kindsOf(filter: unknown): string[] {
	if (!Array.isArray(filter)) return [];
	const [op, , arg] = filter;
	if (op === 'in' && Array.isArray(arg) && arg[0] === 'literal') return arg[1] as string[];
	if (op === '==' && typeof arg === 'string') return [arg];
	return [];
}

// Which fill is on top at tile zoom z, per pixel: its index in FILLS + 1 (0 = none). The map is seen between z and
// z+1, so a fill counts when it is at least half opaque at z+0.5: at z10, commercial and industrial (fading in from
// z10 to z11) do, parks do not; at z11, parks (fading in from z11 to z12) just do.
export function paintFills(masks: Masks, z: number, n: number): Uint8Array {
	const top = new Uint8Array(n * n);
	for (const [f, l] of FILLS.entries()) {
		if ((l.minzoom ?? 0) > z || (l.maxzoom ?? 99) <= z || opacityAt(l.opacity, z + 0.5) < 0.5) continue;
		for (const kind of kindsOf(l.filter)) {
			const mask = masks.get(`${l.layer}/${kind}`);
			if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) top[i] = f + 1;
		}
	}
	return top;
}

const FILL_CATEGORY = Uint8Array.from([0, ...FILLS.map((l) => code(CATEGORY[l.id] ?? 'none'))]);
const fillName = (f: number) => (f ? FILLS[f - 1].id : 'none');

// which category is on top at tile zoom z, per pixel (see paintFills)
export function paint(masks: Masks, z: number, n: number): Uint8Array {
	return paintFills(masks, z, n).map((f) => FILL_CATEGORY[f]);
}

// ---------------------------------------------------------------- metrics

export type RegionMetrics = {
	osmMapped: number; // share of the window OSM paints at z11
	osmUrban: number; // … as urban
	handover: number | null; // where OSM paints at z11: z10 shows the same category
	holes: number | null; // where OSM paints at z11: z10 shows nothing
	towns: Record<string, number | null>; // OSM's z11 urban shown as urban, per zoom
	overreach: number | null; // of z10's urban: what z11 does not call urban
	forestKept: number | null; // OSM's z11 forest shown as forest at z10
	unmapped: Record<string, number | null>; // where OSM paints nothing at z11: what z10 shows
	tiles: Record<string, { kb: number; features: number }>; // the landcover's own tiles over the window
	kinds: Record<string, KindCounts>; // per OSM kind, see kindBreakdown
};

const pct = (num: number, den: number): number | null => (den ? Math.round((1000 * num) / den) / 10 : null);

// the comparison, from painted grids: z11 is OSM's, the others the merge's
export function compare(painted: Record<number, Uint8Array>): Omit<RegionMetrics, 'tiles' | 'kinds'> {
	const osm = painted[11];
	const n = osm.length;
	const [URBAN, FOREST] = [code('urban'), code('forest')];
	let [mapped, urban, forest, same, holes, z10Urban, z10UrbanElsewhere, forestKept] = [0, 0, 0, 0, 0, 0, 0, 0];
	const townsAt: Record<number, number> = { 8: 0, 9: 0, 10: 0 };
	const unmapped = new Array(CATEGORIES.length).fill(0);
	const z10 = painted[10];
	for (let i = 0; i < n; i++) {
		const o = osm[i];
		if (z10[i] === URBAN) {
			z10Urban++;
			if (o !== URBAN) z10UrbanElsewhere++;
		}
		if (o === 0) {
			unmapped[z10[i]]++;
			continue;
		}
		mapped++;
		if (z10[i] === o) same++;
		if (z10[i] === 0) holes++;
		if (o === URBAN) {
			urban++;
			for (const z of [8, 9, 10]) if (painted[z][i] === URBAN) townsAt[z]++;
		}
		if (o === FOREST) {
			forest++;
			if (z10[i] === FOREST) forestKept++;
		}
	}
	const unmappedTotal = n - mapped;
	return {
		osmMapped: pct(mapped, n)!,
		osmUrban: pct(urban, n)!,
		handover: pct(same, mapped),
		holes: pct(holes, mapped),
		towns: Object.fromEntries([8, 9, 10].map((z) => [`z${z}`, pct(townsAt[z], urban)])),
		overreach: pct(z10UrbanElsewhere, z10Urban),
		forestKept: pct(forestKept, forest),
		unmapped: Object.fromEntries(
			CATEGORIES.map((c, i) => [c, pct(unmapped[i], unmappedTotal)] as const).filter(([, v]) => v),
		),
	};
}

// ---------------------------------------------------------------- per kind

// Shortbread 1.1's polygon kinds of `land` and `water_polygons` (https://shortbread-tiles.org/schema/1.1/)
export const KINDS = [
	...[
		...['forest', 'grass', 'meadow', 'orchard', 'vineyard', 'allotments', 'cemetery', 'grave_yard'],
		...['village_green', 'recreation_ground', 'greenhouse_horticulture', 'plant_nursery', 'sand', 'beach'],
		...['heath', 'scrub', 'grassland', 'bare_rock', 'scree', 'shingle', 'swamp', 'bog', 'string_bog'],
		...['wet_meadow', 'marsh', 'golf_course', 'park', 'garden', 'playground', 'miniature_golf', 'residential'],
		...['industrial', 'commercial', 'garages', 'retail', 'railway', 'landfill', 'quarry', 'brownfield'],
		...['greenfield', 'farmyard', 'farmland'],
	].map((k) => `land/${k}`),
	...['glacier', 'water', 'river', 'reservoir', 'basin', 'dock', 'canal'].map((k) => `water_polygons/${k}`),
];
export const KIND_ZOOMS = [8, 9, 10, 11, 12, 13];

// each kind's own fill (index + 1, 0 = versatiles-style does not draw it)
const OWN_FILL = KINDS.map((key) => {
	const [layer, kind] = key.split('/');
	return FILLS.findIndex((l) => l.layer === layer && kindsOf(l.filter).includes(kind)) + 1;
});

// Where OSM has each kind, from its z14 tiles (the full detail): per pixel, the index in KINDS + 1, the kind one sees
// at z14 where two overlap — the kinds versatiles-style does not draw first, then in its draw order.
export function kindRaster(masks: Masks, n: number): Uint8Array {
	const out = new Uint8Array(n * n);
	const order = KINDS.map((_, k) => k).sort((a, b) => OWN_FILL[a] - OWN_FILL[b]);
	for (const k of order) {
		const mask = masks.get(KINDS[k]);
		if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) out[i] = k + 1;
	}
	return out;
}

// per kind, in pixels: its area, how much of it each zoom paints with the kind's own fill, and in the kind's
// category, how much z10 paints in z11's category there (the jump at the handover), and what z10 paints there by
// fill. Pixels, not shares, so regions add up.
export type KindCounts = {
	px: number;
	handover: number;
	own: Record<string, number>;
	same: Record<string, number>;
	z10: Record<string, number>;
};

export function kindBreakdown(kinds: Uint8Array, fills: Record<number, Uint8Array>): Record<string, KindCounts> {
	const out: Record<string, KindCounts> = {};
	const zero = () => Object.fromEntries(KIND_ZOOMS.map((z) => [`z${z}`, 0]));
	for (let i = 0; i < kinds.length; i++) {
		const k = kinds[i] - 1;
		if (k < 0) continue;
		const c = (out[KINDS[k]] ??= { px: 0, handover: 0, own: zero(), same: zero(), z10: {} });
		c.px++;
		if (FILL_CATEGORY[fills[10][i]] === FILL_CATEGORY[fills[11][i]]) c.handover++;
		const own = OWN_FILL[k];
		for (const z of KIND_ZOOMS) {
			const f = fills[z][i];
			if (own && f === own) c.own[`z${z}`]++;
			if (own && FILL_CATEGORY[f] === FILL_CATEGORY[own]) c.same[`z${z}`]++;
		}
		const at10 = fillName(fills[10][i]);
		c.z10[at10] = (c.z10[at10] ?? 0) + 1;
	}
	return out;
}

// OSM's side of a region, which no variant changes: the kinds at z14 and the fills at z11–13. It reads ~350 tiles,
// so it is cached in `cache` (gzip); delete the file to take a newer OSM.
async function osmReference(osm: TileReader, win: Window, cache?: string) {
	const n = win.side * PX;
	const zooms = [11, 12, 13];
	if (cache && existsSync(cache)) {
		const all = gunzipSync(await fs.readFile(cache));
		if (all.length === (zooms.length + 1) * n * n) {
			const part = (i: number) => new Uint8Array(all.buffer, all.byteOffset + i * n * n, n * n);
			return { kinds: part(0), fills: Object.fromEntries(zooms.map((z, i) => [z, part(i + 1)])) };
		}
	}
	const kinds = kindRaster((await rasterise(osm, 14, win)).masks, n);
	const fills: Record<number, Uint8Array> = {};
	for (const z of zooms) fills[z] = paintFills((await rasterise(osm, z, win)).masks, z, n);
	if (cache) await fs.writeFile(cache, gzipSync(Buffer.concat([kinds, ...zooms.map((z) => fills[z])])));
	return { kinds, fills };
}

export async function measureRegion(
	win: Window,
	src: { osm: TileReader; merged: TileReader; landcover: TileReader },
	cache?: string,
): Promise<RegionMetrics> {
	const n = win.side * PX;
	// above z10 the merge is OSM's alone: the landcover has no tiles there
	const reference = await osmReference(src.osm, win, cache);
	const fills: Record<number, Uint8Array> = { ...reference.fills };
	for (const z of [8, 9, 10]) fills[z] = paintFills((await rasterise(src.merged, z, win)).masks, z, n);
	const painted = Object.fromEntries(Object.entries(fills).map(([z, f]) => [z, f.map((v) => FILL_CATEGORY[v])]));
	const tiles: RegionMetrics['tiles'] = {};
	for (const z of [8, 10]) {
		const r = await rasterise(src.landcover, z, win);
		tiles[`z${z}`] = { kb: Math.round(r.bytes / 102.4) / 10, features: r.features };
	}
	return { ...compare(painted), tiles, kinds: kindBreakdown(reference.kinds, fills) };
}
