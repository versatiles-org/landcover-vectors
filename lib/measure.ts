// What a map shows around the handover, measured: for one test region (lib/regions.ts), the merge at z8–10 and
// OSM at z11 are rasterised onto one grid and painted the way versatiles-style draws them (its draw order, and its
// zoom-dependent opacity at mid-zoom), then compared pixel by pixel in coarse categories, since ESA's and OSM's
// kinds do not map one to one. bin/experiment.ts runs this on every variant.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { osm as osmStyle } from '@versatiles/style';

import { decodeTile, rings } from './mvt.ts';
import { majority, pixelsOfPGM } from './inspect.ts';
import { runQuiet } from './worldcover.ts';
import { WINDOW_ZOOM, type Window } from './regions.ts';
import { channels, MERC, SEA_SHARE_MIN } from '../config.ts';

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
	shape: Record<string, Shape | null>; // how smooth the landcover's outlines are, per zoom
	agreement: Record<string, number | null>; // the landcover against its source, per zoom (%); null: no source
	kinds: Record<string, KindCounts>; // per OSM kind, see kindBreakdown
};

const pct = (num: number, den: number): number | null => (den ? Math.round((1000 * num) / den) / 10 : null);

// the comparison, from painted grids: z11 is OSM's, the others the merge's
export function compare(
	painted: Record<number, Uint8Array>,
): Omit<RegionMetrics, 'tiles' | 'shape' | 'agreement' | 'kinds'> {
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

// ---------------------------------------------------------------- shape

// How smooth the landcover's outlines are, in rendered px of their tiles. Polygonize traces pixel edges, and a
// simplify that only drops vertices keeps staircase corners: a jagged outline turns sharply and often, and runs
// along the axes. Tile edges, where every polygon is cut (lib/block.ts step 4), do not count.
export type Shape = {
	vertices: number; // between two counted segments
	segmentPx: number; // mean segment length
	sharpTurns: number; // vertices turning by more than SHARP_TURN° (%)
	turning: number; // degrees turned per px of outline
	axisAligned: number; // outline length within AXIS_ANGLE° of horizontal or vertical (%): a smooth curve has ~7
};
export const SHARP_TURN = 60;
const AXIS_ANGLE = 3;

export type ShapeSums = {
	vertices: number;
	segments: number;
	length: number;
	sharp: number;
	turned: number;
	axis: number;
};
export const shapeSums = (): ShapeSums => ({ vertices: 0, segments: 0, length: 0, sharp: 0, turned: 0, axis: 0 });

// one ring's segments and turns into `s`: its points in the units of a tile `extent` wide, and `inside` whether a
// point (in those units) is in the measured window
export function addRing(
	s: ShapeSums,
	ring: [number, number][],
	extent: number,
	inside: (x: number, y: number) => boolean,
): void {
	const m = ring.length;
	if (m < 3) return;
	const px = 256 / extent;
	const out = (v: number) => v < 0 || v > extent; // the tile's buffer
	// per segment its direction, or null where it does not count: no length, on the tile edge, in the buffer,
	// outside the window
	const dir: (number | null)[] = [];
	for (let i = 0; i < m; i++) {
		const [[ax, ay], [bx, by]] = [ring[i], ring[(i + 1) % m]];
		const len = Math.hypot(bx - ax, by - ay) * px;
		const edge = (ax === bx && (ax === 0 || ax === extent)) || (ay === by && (ay === 0 || ay === extent));
		if (!len || edge || [ax, ay, bx, by].some(out) || !inside((ax + bx) / 2, (ay + by) / 2)) {
			dir.push(null);
			continue;
		}
		const a = Math.atan2(by - ay, bx - ax);
		dir.push(a);
		s.segments++;
		s.length += len;
		const deg = ((((a * 180) / Math.PI) % 90) + 90) % 90;
		if (deg < AXIS_ANGLE || deg > 90 - AXIS_ANGLE) s.axis += len;
	}
	for (let i = 0; i < m; i++) {
		const [a, b] = [dir[(i + m - 1) % m], dir[i]];
		if (a === null || b === null) continue;
		const turn = (Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) * 180) / Math.PI;
		s.vertices++;
		s.turned += turn;
		if (turn > SHARP_TURN) s.sharp++;
	}
}

export function shapeOf(s: ShapeSums): Shape | null {
	if (!s.segments) return null;
	return {
		vertices: s.vertices,
		segmentPx: Math.round((100 * s.length) / s.segments) / 100,
		sharpTurns: pct(s.sharp, s.vertices) ?? 0,
		turning: Math.round((10 * s.turned) / s.length) / 10,
		axisAligned: pct(s.axis, s.length)!,
	};
}

// the outlines of every land and water polygon of `source` at zoom z, within the window
export async function measureShape(source: TileReader, z: number, win: Window): Promise<Shape | null> {
	const f = 2 ** (z - WINDOW_ZOOM);
	const [wx0, wy0, wx1, wy1] = [win.x0 * f, win.y0 * f, (win.x0 + win.side) * f, (win.y0 + win.side) * f];
	const s = shapeSums();
	for (let tx = Math.floor(wx0); tx < Math.ceil(wx1); tx++)
		for (let ty = Math.floor(wy0); ty < Math.ceil(wy1); ty++) {
			const buf = await source.getTile(z, tx, ty);
			if (!buf) continue;
			for (const layer of decodeTile(buf)) {
				if (!LAYERS.includes(layer.name)) continue;
				const e = layer.extent;
				const inside = (x: number, y: number) => {
					const [gx, gy] = [tx + x / e, ty + y / e];
					return gx >= wx0 && gx < wx1 && gy >= wy0 && gy < wy1;
				};
				for (const feature of layer.features)
					if (feature.type === 3) for (const r of rings(feature.geometry)) addRing(s, r, e, inside);
			}
		}
	return shapeOf(s);
}

// ---------------------------------------------------------------- agreement with the source

// the landcover's kinds, as codes of a grid: 1.. in channel order, 0 none
const KIND_CODE = new Map<string, number>(
	channels.filter((c) => c.layer && c.kind).map((c, i) => [`${c.layer}/${c.kind}`, i + 1] as const),
);

// What a block at zoom z reads as each kind, per grid pixel: the classes of the channels drawn at z, sea-masked
// (sea share at SEA_SHARE_MIN or more is none, as in lib/block.ts), the rest none.
export function truthGrid(classes: Uint8Array, share: Uint8Array, z: number): Uint8Array {
	const codeOf = new Uint8Array(256);
	for (const c of channels)
		if (c.layer && c.kind && c.maxZoom >= z)
			for (const esa of c.esa) codeOf[esa] = KIND_CODE.get(`${c.layer}/${c.kind}`)!;
	return classes.map((v, i) => (share[i] >= SEA_SHARE_MIN ? 0 : codeOf[v]));
}

// the rasterised landcover as the same codes
export function kindGrid(masks: Masks, n: number): Uint8Array {
	const out = new Uint8Array(n * n);
	for (const [key, mask] of masks) {
		const code = KIND_CODE.get(key);
		if (code) for (let i = 0; i < mask.length; i++) if (mask[i]) out[i] = code;
	}
	return out;
}

// The share of the zoom's rendered pixels (2^(12−z) grid px a side) where the tiles show what the source has, both
// taken as the pixel's majority: the scale the sieve and the simplify work at (as `npm run inspect`'s @256). At z8
// the block read the source's mode overview instead, a majority of majorities: close, not the same.
export function agreement(truth: Uint8Array, shown: Uint8Array, n: number, z: number): number {
	const factor = 2 ** (WINDOW_ZOOM - z);
	const [a, b] = [majority(truth, n, factor), majority(shown, n, factor)];
	let same = 0;
	for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
	return pct(same, a.length)!;
}

// a window's pixels of a raster on the build's grid (lib/regionsource.ts), which is the measurement's
export async function readWindow(tif: string, win: Window, scratch: string): Promise<Uint8Array> {
	const n = win.side * PX;
	const span = (2 * MERC) / 2 ** WINDOW_ZOOM;
	const [ulx, uly] = [-MERC + win.x0 * span, MERC - win.y0 * span];
	await fs.mkdir(scratch, { recursive: true });
	const pgm = path.join(scratch, `${path.basename(tif, '.tif')}-window.pgm`);
	await runQuiet(
		'gdal_translate',
		'-q',
		['-of', 'PNM'],
		['-projwin', ulx, uly, ulx + win.side * span, uly - win.side * span],
		tif,
		pgm,
	);
	const px = pixelsOfPGM(new Uint8Array(await fs.readFile(pgm)), n);
	await fs.rm(pgm, { force: true });
	return px.slice();
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

// the region's source, which the landcover is compared with: the classes the variant's blocks read, and the sea
// share (both on the build's grid), and a folder for scratch files
export type Truth = { classes: string; seaShare: string; scratch: string };

export async function measureRegion(
	win: Window,
	src: { osm: TileReader; merged: TileReader; landcover: TileReader },
	cache?: string,
	truth?: Truth,
): Promise<RegionMetrics> {
	const n = win.side * PX;
	// above z10 the merge is OSM's alone: the landcover has no tiles there
	const reference = await osmReference(src.osm, win, cache);
	const fills: Record<number, Uint8Array> = { ...reference.fills };
	for (const z of [8, 9, 10]) fills[z] = paintFills((await rasterise(src.merged, z, win)).masks, z, n);
	const painted = Object.fromEntries(Object.entries(fills).map(([z, f]) => [z, f.map((v) => FILL_CATEGORY[v])]));
	const source = truth && {
		classes: await readWindow(truth.classes, win, truth.scratch),
		share: await readWindow(truth.seaShare, win, truth.scratch),
	};
	const [tiles, shape, agree]: [RegionMetrics['tiles'], RegionMetrics['shape'], RegionMetrics['agreement']] = [
		{},
		{},
		{},
	];
	for (const z of [8, 9, 10]) {
		const r = await rasterise(src.landcover, z, win);
		if (z !== 9) tiles[`z${z}`] = { kb: Math.round(r.bytes / 102.4) / 10, features: r.features };
		shape[`z${z}`] = await measureShape(src.landcover, z, win);
		agree[`z${z}`] = source
			? agreement(truthGrid(source.classes, source.share, z), kindGrid(r.masks, n), n, z)
			: null;
	}
	return { ...compare(painted), tiles, shape, agreement: agree, kinds: kindBreakdown(reference.kinds, fills) };
}
