// The preview style is generated from `channels`, so it is the thing that proves what the browser shows
// is what the pipeline emitted. A missing or mis-scoped layer would make a preview quietly lie.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { maplibreStyle, layerId } from '../lib/style-spec.ts';
import { channels, MAXLEVEL } from '../config.ts';

const kinded = channels.filter((c) => c.layer && c.kind && c.color);
const local = maplibreStyle({ tiles: '/tiles/landcover/tiles.json' });
const withOsm = maplibreStyle({ tiles: '/t.json', osm: '/osm.json', fingerprint: 'abc12345' });
const layers = (style: Record<string, unknown>) => style.layers as { id: string; [k: string]: unknown }[];

describe('maplibreStyle', () => {
	test('is a v8 style with the sources it was given', () => {
		assert.equal(local.version, 8);
		assert.deepEqual(Object.keys(local.sources as object), ['landcover']);
		assert.deepEqual(Object.keys(withOsm.sources as object), ['landcover', 'osm']);
	});

	test('has one landcover fill per emitting channel, and nothing extra', () => {
		const ids = layers(local)
			.filter((l) => l.type === 'fill')
			.map((l) => l.id);
		assert.deepEqual(
			ids,
			kinded.map((c) => layerId('landcover', c)),
		);
	});

	test('each fill is scoped to its Shortbread layer and filtered on its kind', () => {
		for (const c of kinded) {
			const layer = layers(local).find((l) => l.id === layerId('landcover', c));
			assert.ok(layer, `${c.kind} has no layer`);
			assert.equal(layer['source-layer'], c.layer);
			assert.deepEqual(layer.filter, ['==', ['get', 'kind'], c.kind]);
			assert.equal((layer.paint as Record<string, string>)['fill-color'], c.color);
			assert.equal((layer.metadata as Record<string, unknown>).maxZoom, c.maxZoom);
		}
	});

	test('layer ids are unique — a duplicate would silently drop a kind', () => {
		const ids = layers(withOsm).map((l) => l.id);
		assert.equal(new Set(ids).size, ids.length);
	});

	const meta = (l: { [k: string]: unknown }) => (l.metadata ?? {}) as Record<string, unknown>;

	test('the landcover carries no zoom limits, so a kind drawing past its cutoff is visible', () => {
		for (const l of layers(local)) {
			assert.equal(l.minzoom, undefined, `${l.id} has a minzoom`);
			assert.equal(l.maxzoom, undefined, `${l.id} has a maxzoom`);
		}
		for (const l of layers(withOsm).filter((l) => !l.id.startsWith('osm-') && meta(l).osmFrom === undefined)) {
			assert.equal(l.minzoom, undefined, `${l.id} has a minzoom`);
			assert.equal(l.maxzoom, undefined, `${l.id} has a maxzoom`);
		}
	});

	test("OSM's copy of a kind starts above its cutoff, like the merge keeps it", () => {
		for (const l of layers(withOsm).filter((l) => l.id.startsWith('osm-') && meta(l).kind)) {
			const osmFrom = meta(l).osmFrom;
			assert.equal(
				l.minzoom,
				osmFrom === undefined ? (meta(l).maxZoom as number) + 1 : undefined,
				`${l.id} minzoom`,
			);
			assert.equal(l.maxzoom, undefined, `${l.id} has a maxzoom`);
		}
	});

	test("next to OSM, the landcover's copy of a kind OSM supplies stops where OSM's begins", () => {
		for (const [id, maxzoom] of [
			['landcover-water_polygons-water', 4],
			['landcover-land-residential', 10],
		] as const) {
			const layer = layers(withOsm).find((l) => l.id === id);
			assert.ok(layer, id);
			assert.equal(layer.maxzoom, maxzoom, `${id}: MapLibre maxzoom is exclusive, drawn up to z${maxzoom - 1}`);
			assert.equal(layer.minzoom, undefined);
		}
	});

	test('draws OSM over the landcover, with ocean underneath both', () => {
		const ids = layers(withOsm).map((l) => l.id);
		assert.equal(ids[0], 'background');
		assert.equal(ids[1], 'osm-ocean', 'ocean must sit below the landcover to show its holes');
		const firstLandcover = ids.findIndex((id) => id.startsWith('landcover-'));
		const firstOsmFill = ids.findIndex((id) => id.startsWith('osm-land') || id.startsWith('osm-water'));
		assert.ok(firstLandcover < firstOsmFill, 'OSM should be drawn on top at the handover');
		assert.equal(ids.at(-1), 'osm-boundaries');
	});

	test('without an OSM mount there is nothing OSM in the style', () => {
		assert.ok(!layers(local).some((l) => l.id.startsWith('osm-')));
		assert.ok(!JSON.stringify(local).includes('osm.json'));
	});

	test('has no symbol layers, because no glyphs are served', () => {
		assert.ok(!layers(withOsm).some((l) => l.type === 'symbol'));
		assert.equal(withOsm.glyphs, undefined);
	});

	test('metadata carries what the viewer needs for its legend and header', () => {
		const meta = withOsm.metadata as Record<string, unknown>;
		assert.equal(meta['landcover:fingerprint'], 'abc12345');
		assert.equal(meta['landcover:maxLevel'], MAXLEVEL);
		const legend = meta['landcover:kinds'] as { kind: string; color: string; maxZoom: number; drawnTo: number }[];
		assert.equal(legend.length, kinded.length);
		assert.deepEqual(
			legend.map((k) => k.kind),
			kinded.map((c) => c.kind),
		);
		assert.ok(legend.every((k) => /^#[0-9A-Fa-f]{6}$/.test(k.color)));
		// the legend's "≤ z" is where the landcover stops being drawn, which next to OSM is the merge's handover
		const drawnTo = Object.fromEntries(legend.map((k) => [k.kind, k.drawnTo]));
		assert.equal(drawnTo.water, 3);
		assert.equal(drawnTo.residential, 9);
		assert.equal(drawnTo.forest, 10);
		const alone = (local.metadata as Record<string, unknown>)['landcover:kinds'] as typeof legend;
		assert.ok(
			alone.every((k) => k.drawnTo === k.maxZoom),
			'without OSM every kind is drawn to its cutoff',
		);
	});

	test('the tiles URL is passed through verbatim, cache-buster and all', () => {
		const style = maplibreStyle({ tiles: '/tiles/landcover/tiles.json?v=deadbeef' });
		assert.equal(
			(style.sources as Record<string, { url: string }>).landcover.url,
			'/tiles/landcover/tiles.json?v=deadbeef',
		);
	});
});
