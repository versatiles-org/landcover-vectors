// Inspect one tile against what it should show — the quality half of a parameter change, next to the
// size half in lib/stats.ts.
//
// "What it should show" is the *target*: the source resampled to this tile at the pipeline's own
// working resolution (TILE_PX per tile, the same `-r mode` read a block does), with every class that is
// not active at this zoom turned into a hole. That is exactly the raster the blur → argmax → sieve →
// simplify chain sets out to reproduce. The tile is rasterised onto the same grid and the two are
// compared pixel by pixel.
//
// The rasters are read as raw bytes, never through GDAL statistics: gdal_rasterize marks empty pixels as
// no-data and GDAL's histogram then silently leaves them out — which once made a correct tile look as if
// its forest and lakes had been painted over.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runQuiet, runCapture } from './worldcover.ts';
import { countVertices, type GeoGeometry } from './stats.ts';
import type { RGBImage } from './png.ts';
import { channels, MERC, TILE_PX, type Rect } from '../config.ts';

// ---------------------------------------------------------------- classes and colours

// the code a kind this config does not know is rasterised as (e.g. an old tileset's `sand`)
export const UNKNOWN_KIND = 254;

// high-contrast colours for judging boundaries, keyed by ESA code. Deliberately *not* the Shortbread
// fills from config.ts: scrub, marsh and grassland are near-identical pastels there, which is right for a
// map and useless for spotting where one class ate another.
export const PALETTE: Record<number, [number, number, number]> = {
	0: [255, 255, 255], // hole: nothing drawn (open ocean, or a class not active at this zoom)
	10: [27, 120, 55], // tree cover → forest
	20: [230, 171, 2], // shrubland → scrub
	30: [166, 216, 84], // grassland
	40: [253, 208, 162], // cropland → farmland
	50: [228, 26, 28], // built-up → residential
	60: [150, 150, 150], // bare / sparse → bare_rock
	70: [190, 225, 255], // snow & ice → glacier
	80: [33, 113, 181], // permanent water → water
	90: [106, 61, 154], // herbaceous wetland → marsh
	95: [251, 154, 153], // mangroves → swamp
	100: [255, 127, 0], // moss & lichen → heath
	[UNKNOWN_KIND]: [0, 0, 0], // a kind this config does not know
};

export const ERROR_COLORS = {
	right: [232, 232, 232],
	wrongKind: [215, 25, 28], // land drawn, but the wrong kind
	gap: [44, 123, 182], // a hole where the target has land
	overdraw: [208, 28, 139], // land drawn where the target is a hole (forest, water, ocean at this zoom)
} satisfies Record<string, [number, number, number]>;

const kindOfCode = new Map<number, string>();
const codeOfKind = new Map<string, number>();
for (const c of channels) {
	if (!c.kind) continue;
	codeOfKind.set(c.kind, c.esa[0]);
	for (const code of c.esa) kindOfCode.set(code, c.kind);
}

export function className(code: number): string {
	if (code === 0) return '(hole)';
	if (code === UNKNOWN_KIND) return '(unknown kind)';
	return kindOfCode.get(code) ?? `esa ${code}`;
}

// ESA codes drawn at zoom z — mirrors lib/block.ts: a channel above its cutoff folds into no-data
export function activeCodes(z: number): Set<number> {
	return new Set(channels.filter((c) => c.layer !== null && c.maxZoom >= z).flatMap((c) => c.esa));
}

// the source with everything this zoom does not draw turned into a hole
export function targetFor(esa: Uint8Array, z: number): Uint8Array {
	const active = activeCodes(z);
	return esa.map((code) => (active.has(code) ? code : 0));
}

// ---------------------------------------------------------------- comparison

export type ClassRow = { code: number; name: string; target: number; rendered: number; recall: number | null };
export type Comparison = {
	pixels: number;
	agreement: number; // share of pixels where the tile shows what the target says
	areaError: number; // ½·Σ|Δshare|: area on the wrong class in aggregate (≤ 1 − agreement)
	wrongKind: number; // both land, different kinds
	gap: number; // target land, tile draws nothing
	overdraw: number; // target hole, tile draws land
	classes: ClassRow[]; // every class present in either raster, by target share
};

export function compare(target: Uint8Array, rendered: Uint8Array): Comparison {
	if (target.length !== rendered.length) throw new Error(`size mismatch: ${target.length} vs ${rendered.length} px`);
	const n = target.length;
	const inTarget = new Map<number, number>();
	const inRendered = new Map<number, number>();
	const hits = new Map<number, number>();
	let agree = 0;
	let wrongKind = 0;
	let gap = 0;
	let overdraw = 0;

	for (let i = 0; i < n; i++) {
		const t = target[i];
		const r = rendered[i];
		inTarget.set(t, (inTarget.get(t) ?? 0) + 1);
		inRendered.set(r, (inRendered.get(r) ?? 0) + 1);
		if (t === r) {
			agree++;
			hits.set(t, (hits.get(t) ?? 0) + 1);
		} else if (t === 0) overdraw++;
		else if (r === 0) gap++;
		else wrongKind++;
	}

	const codes = [...new Set([...inTarget.keys(), ...inRendered.keys()])];
	const classes = codes
		.map((code) => {
			const t = inTarget.get(code) ?? 0;
			return {
				code,
				name: className(code),
				target: t / n,
				rendered: (inRendered.get(code) ?? 0) / n,
				recall: t > 0 ? (hits.get(code) ?? 0) / t : null,
			};
		})
		.sort((a, b) => b.target - a.target || b.rendered - a.rendered);

	return {
		pixels: n,
		agreement: agree / n,
		areaError: classes.reduce((s, c) => s + Math.abs(c.rendered - c.target), 0) / 2,
		wrongKind: wrongKind / n,
		gap: gap / n,
		overdraw: overdraw / n,
		classes,
	};
}

// Majority class of every factor×factor block. Comparing at full resolution also counts the pixel-level
// mosaic of the source, which the blur removes on purpose; comparing the block majorities as well tells
// structure (the pattern is wrong) apart from texture (the pattern is right, the speckle is gone).
// Ties go to the lowest code, so the result does not depend on scan order.
export function majority(codes: Uint8Array, size: number, factor: number): Uint8Array {
	if (size % factor !== 0) throw new Error(`${size} px is not divisible by ${factor}`);
	const out = size / factor;
	const result = new Uint8Array(out * out);
	const counts = new Uint32Array(256);
	for (let by = 0; by < out; by++) {
		for (let bx = 0; bx < out; bx++) {
			counts.fill(0);
			for (let y = by * factor; y < (by + 1) * factor; y++) {
				for (let x = bx * factor; x < (bx + 1) * factor; x++) counts[codes[y * size + x]]++;
			}
			let best = 0;
			for (let c = 1; c < 256; c++) if (counts[c] > counts[best]) best = c;
			result[by * out + bx] = best;
		}
	}
	return result;
}

// ---------------------------------------------------------------- images

export function colorize(codes: Uint8Array, size: number): RGBImage {
	const data = new Uint8Array(size * size * 3);
	for (let i = 0; i < codes.length; i++) data.set(PALETTE[codes[i]] ?? PALETTE[UNKNOWN_KIND], i * 3);
	return { width: size, height: size, data };
}

export function errorMap(target: Uint8Array, rendered: Uint8Array, size: number): RGBImage {
	const data = new Uint8Array(size * size * 3);
	for (let i = 0; i < target.length; i++) {
		const t = target[i];
		const r = rendered[i];
		const c =
			t === r
				? ERROR_COLORS.right
				: t === 0
					? ERROR_COLORS.overdraw
					: r === 0
						? ERROR_COLORS.gap
						: ERROR_COLORS.wrongKind;
		data.set(c, i * 3);
	}
	return { width: size, height: size, data };
}

// nearest-neighbour resize: categorical colours must not be blended into colours no class has
export function resize(img: RGBImage, size: number): RGBImage {
	const data = new Uint8Array(size * size * 3);
	for (let y = 0; y < size; y++) {
		const sy = Math.floor((y * img.height) / size);
		for (let x = 0; x < size; x++) {
			const sx = Math.floor((x * img.width) / size);
			const from = (sy * img.width + sx) * 3;
			data.set(img.data.subarray(from, from + 3), (y * size + x) * 3);
		}
	}
	return { width: size, height: size, data };
}

// equal-sized panels in a grid, left to right, top to bottom
export function grid(panels: RGBImage[], cols: number, gutter = 8, background = 40): RGBImage {
	if (panels.length === 0) throw new Error('no panels');
	const { width: pw, height: ph } = panels[0];
	if (panels.some((p) => p.width !== pw || p.height !== ph)) throw new Error('panels differ in size');
	const rows = Math.ceil(panels.length / cols);
	const width = cols * pw + (cols + 1) * gutter;
	const height = rows * ph + (rows + 1) * gutter;
	const data = new Uint8Array(width * height * 3).fill(background);
	panels.forEach((p, k) => {
		const ox = gutter + (k % cols) * (pw + gutter);
		const oy = gutter + Math.floor(k / cols) * (ph + gutter);
		for (let y = 0; y < ph; y++) data.set(p.data.subarray(y * pw * 3, (y + 1) * pw * 3), ((oy + y) * width + ox) * 3);
	});
	return { width, height, data };
}

// ---------------------------------------------------------------- geometry

export function tileBounds3857(z: number, x: number, y: number): Rect {
	const span = (2 * MERC) / Math.pow(2, z);
	return { minx: -MERC + x * span, maxx: -MERC + (x + 1) * span, maxy: MERC - y * span, miny: MERC - (y + 1) * span };
}

export function to3857([lon, lat]: number[]): [number, number] {
	const clamped = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
	return [(lon * MERC) / 180, (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) * MERC) / Math.PI];
}

// ---------------------------------------------------------------- GDAL / tippecanoe

// A px×px single-band Byte raster as raw bytes, via PGM: a short text header, then the pixels.
//
// Not ENVI, although that is headerless: its pixels depend on a sidecar .hdr, which the pipeline's GDAL
// environment (GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR, needed for the remote source) breaks — the export
// then silently comes out as 2 bytes. And the header is not parsed by splitting on whitespace: it ends in
// exactly one whitespace byte, and ESA 10 (tree cover) *is* 0x0A, so a forest pixel in the first
// position would be eaten. The size is ours, so the pixels are simply the last px² bytes.
export async function readBytes(tif: string, dir: string, px: number): Promise<Uint8Array> {
	const pgm = path.join(dir, path.basename(tif) + '.pgm');
	await runQuiet('gdal_translate', '-q', ['-of', 'PNM'], ['-ot', 'Byte'], tif, pgm);
	return pixelsOfPGM(new Uint8Array(await fs.readFile(pgm)), px);
}

export function pixelsOfPGM(file: Uint8Array, px: number): Uint8Array {
	if (file[0] !== 0x50 || file[1] !== 0x35) throw new Error('not a binary PGM (P5)');
	if (file.length < px * px + 11) throw new Error(`PGM too short for ${px}×${px}: ${file.length} bytes`);
	return file.subarray(file.length - px * px);
}

export type Rendered = { codes: Uint8Array; features: number; vertices: number; unknownKinds: string[] };

// the source's ESA classes over one tile, read the way a block reads its window
export async function renderSource(source: string, z: number, x: number, y: number, px = TILE_PX): Promise<Uint8Array> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-inspect-'));
	try {
		const b = tileBounds3857(z, x, y);
		const out = path.join(dir, 'source.tif');
		await runQuiet(
			'gdalwarp',
			'-q',
			['-te', b.minx, b.miny, b.maxx, b.maxy],
			['-ts', px, px],
			['-r', 'mode'],
			['-ot', 'Byte'],
			source,
			out,
		);
		return await readBytes(out, dir, px);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

// one vector tile, rasterised onto the same grid as the target, as ESA codes
export async function renderTile(mbtiles: string, z: number, x: number, y: number, px = TILE_PX): Promise<Rendered> {
	const decoded = JSON.parse(await runCapture('tippecanoe-decode', mbtiles, z, x, y)) as {
		features?: { features?: { properties?: { kind?: string }; geometry?: GeoGeometry }[] }[];
	};
	const unknown = new Set<string>();
	let vertices = 0;
	const features = (decoded.features ?? []).flatMap((layer) =>
		(layer.features ?? []).flatMap((f) => {
			if (!f.geometry) return [];
			const kind = String(f.properties?.kind ?? '');
			const code = codeOfKind.get(kind);
			if (code === undefined) unknown.add(kind);
			vertices += countVertices(f.geometry);
			return [{ type: 'Feature', properties: { esa: code ?? UNKNOWN_KIND }, geometry: project(f.geometry) }];
		}),
	);

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-inspect-'));
	try {
		const gj = path.join(dir, 'tile.geojson');
		await fs.writeFile(
			gj,
			JSON.stringify({
				type: 'FeatureCollection',
				crs: { type: 'name', properties: { name: 'EPSG:3857' } },
				features,
			}),
		);
		const b = tileBounds3857(z, x, y);
		const out = path.join(dir, 'tile.tif');
		await runQuiet(
			'gdal_rasterize',
			'-q',
			['-a', 'esa'],
			['-te', b.minx, b.miny, b.maxx, b.maxy],
			['-ts', px, px],
			['-ot', 'Byte'],
			['-init', 0],
			gj,
			out,
		);
		return { codes: await readBytes(out, dir, px), features: features.length, vertices, unknownKinds: [...unknown] };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function project(g: GeoGeometry): GeoGeometry {
	const walk = (node: unknown): unknown =>
		Array.isArray(node) && typeof node[0] === 'number' ? to3857(node as number[]) : (node as unknown[]).map(walk);
	return { type: g.type, coordinates: walk(g.coordinates) };
}
