// Tile size statistics for a built tileset.
//
// The question a parameter change has to answer is "does the worst tile still fit?" — tippecanoe drops
// or coalesces features once a tile exceeds --maximum-tile-bytes, so the maximum matters more than the
// average, and it is always local (one fragmented wetland decides it). Sizes are read straight from the
// mbtiles: they are the compressed bytes a client downloads, which is what the limit applies to.
//
// `versatiles probe` is not a substitute: its pyramid reports bounding-box extents and an approximate
// coverage, not the stored tiles.

import { DatabaseSync } from 'node:sqlite';

import { runCapture } from './worldcover.ts';
import type { LonLat } from './coverage.ts';
import { overlaps } from './plan.ts';
import { LAT_LIMIT } from './areas.ts';

// tippecanoe's default --maximum-tile-bytes; above this it coalesces or drops features
export const MVT_LIMIT = 500_000;
// a soft budget: staying here keeps room for the OSM features a merged tile also carries
export const WARN_LIMIT = 250_000;

export type TileRow = { z: number; x: number; y: number; bytes: number }; // y counted from the north (XYZ)
export type ZoomStats = {
	z: number;
	tiles: number;
	bytes: number;
	avg: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	worst: TileRow;
};

// nearest-rank percentile of an ascending array (p in 0..100)
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

// the lon/lat rectangle a tile covers
export function tileBounds(z: number, x: number, y: number): LonLat {
	const n = Math.pow(2, z);
	const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
	return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

export function tileCenter(z: number, x: number, y: number): { lon: number; lat: number } {
	const b = tileBounds(z, x, y);
	return { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
}

// read every tile's size. mbtiles rows count y from the south, so flip to XYZ once, here.
export function readTiles(mbtiles: string, bbox?: LonLat): TileRow[] {
	const db = new DatabaseSync(mbtiles, { readOnly: true });
	try {
		const rows = db
			.prepare('SELECT zoom_level AS z, tile_column AS x, tile_row AS row, LENGTH(tile_data) AS bytes FROM tiles')
			.all() as unknown as { z: number; x: number; row: number; bytes: number }[];
		const tiles: TileRow[] = [];
		for (const r of rows) {
			const tile = {
				z: Number(r.z),
				x: Number(r.x),
				y: Math.pow(2, Number(r.z)) - 1 - Number(r.row),
				bytes: Number(r.bytes),
			};
			if (bbox && !overlaps(tileBounds(tile.z, tile.x, tile.y), bbox)) continue;
			tiles.push(tile);
		}
		return tiles;
	} finally {
		db.close();
	}
}

// per-zoom distribution, ascending by zoom; zooms with no tiles are left out
export function summarise(rows: TileRow[]): ZoomStats[] {
	const byZoom = new Map<number, TileRow[]>();
	for (const r of rows) byZoom.set(r.z, (byZoom.get(r.z) ?? []).concat(r));
	return [...byZoom.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([z, list]) => {
			const sizes = list.map((r) => r.bytes).sort((a, b) => a - b);
			const bytes = sizes.reduce((s, n) => s + n, 0);
			return {
				z,
				tiles: list.length,
				bytes,
				avg: bytes / list.length,
				p50: percentile(sizes, 50),
				p95: percentile(sizes, 95),
				p99: percentile(sizes, 99),
				max: sizes[sizes.length - 1],
				worst: list.reduce((a, b) => (b.bytes > a.bytes ? b : a)),
			};
		});
}

export const largest = (rows: TileRow[], n: number): TileRow[] =>
	[...rows].sort((a, b) => b.bytes - a.bytes).slice(0, n);

export type Attribution = { layer: string; kind: string; features: number; vertices: number };

// what is actually inside one tile, per layer and kind, via tippecanoe-decode. Answers *why* a tile is
// big: too many features, or too many vertices per feature.
export async function attributeTile(mbtiles: string, tile: TileRow): Promise<Attribution[]> {
	const json = await runCapture('tippecanoe-decode', mbtiles, tile.z, tile.x, tile.y);
	const decoded = JSON.parse(json) as {
		features?: { properties?: { layer?: string }; features?: GeoFeature[] }[];
	};
	const out = new Map<string, Attribution>();
	for (const layerFc of decoded.features ?? []) {
		const layer = layerFc.properties?.layer ?? '?';
		for (const f of layerFc.features ?? []) {
			const kind = String(f.properties?.kind ?? '-');
			const key = `${layer}/${kind}`;
			const entry = out.get(key) ?? { layer, kind, features: 0, vertices: 0 };
			entry.features += 1;
			entry.vertices += countVertices(f.geometry);
			out.set(key, entry);
		}
	}
	return [...out.values()].sort((a, b) => b.vertices - a.vertices);
}

type GeoFeature = { properties?: Record<string, unknown>; geometry?: GeoGeometry };
export type GeoGeometry = { type: string; coordinates: unknown };

// exported for the tests: the nesting depth differs per geometry type, so this is worth pinning
export function countVertices(geometry: GeoGeometry | undefined): number {
	if (!geometry) return 0;
	// count the deepest arrays of [lon, lat] pairs, whatever the nesting depth is
	const walk = (node: unknown): number => {
		if (!Array.isArray(node)) return 0;
		if (typeof node[0] === 'number') return 1;
		return (node as unknown[]).reduce((sum: number, child) => sum + walk(child), 0);
	};
	return walk(geometry.coordinates);
}

// tiles are clipped to the Mercator range, so an area reaching further can never match beyond it
export const clampToMercator = (b: LonLat): LonLat => ({
	...b,
	south: Math.max(b.south, -LAT_LIMIT),
	north: Math.min(b.north, LAT_LIMIT),
});
