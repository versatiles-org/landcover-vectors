// The preview's versatiles-style view must load the merge this repo serves, not tiles.versatiles.org's
// tiles, and must draw the land cover from z0 — otherwise it shows some other map than the merged one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stackedStyle, versatilesStyle } from '../lib/style-versatiles.ts';

const style = versatilesStyle('/tiles/merged/tiles.json?v=abc');

describe('versatilesStyle', () => {
	test('reads every vector layer from the served merge', () => {
		const vector = Object.values(style.sources).filter((s) => s.type === 'vector');
		assert.ok(vector.length > 0);
		for (const s of vector) assert.equal('url' in s && s.url, '/tiles/merged/tiles.json?v=abc');
	});

	test('keeps glyphs and sprites on tiles.versatiles.org', () => {
		assert.match(String(style.glyphs), /^https:\/\/tiles\.versatiles\.org\//);
	});

	test('draws the land cover kinds from z0', () => {
		// versatiles-style's land fills for what this container emits (forest, farmland, residential, …)
		for (const id of ['land-forest', 'land-agriculture', 'land-residential', 'land-rock', 'land-glacier']) {
			const layer = style.layers.find((l) => l.id === id);
			assert.ok(layer, `${id} is missing`);
			assert.equal(layer.minzoom ?? 0, 0, `${id} starts at z${layer.minzoom}`);
		}
	});
});

// the land cover as a source of its own, under OSM's fills and over nothing but the background
describe('stackedStyle', () => {
	const style = stackedStyle('/osm.json', '/landcover.json');
	const ids = style.layers.map((l) => l.id);
	const under = style.layers.filter((l) => 'source' in l && l.source === 'landcover');

	test('reads the land cover from its own source, and the rest from OSM', () => {
		assert.deepEqual(style.sources.landcover, { type: 'vector', url: '/landcover.json' });
		assert.ok(under.length > 0);
		assert.ok(style.layers.some((l) => 'source' in l && l.source !== 'landcover'));
	});

	test('draws it below every OSM layer, from z0', () => {
		const first = ids.indexOf('water-ocean');
		for (const l of under) {
			assert.ok(ids.indexOf(l.id) < first, l.id);
			assert.equal(l.minzoom, undefined, l.id);
		}
	});

	test('covers the kinds it has, in the stock colours', () => {
		for (const id of ['landcover-land-forest', 'landcover-land-glacier', 'landcover-water-area'])
			assert.ok(ids.includes(id), id);
	});

	test('fades only when asked', () => {
		const opacity = (s: typeof style) =>
			(s.layers.find((l) => l.id === 'landcover-land-forest') as { paint: Record<string, unknown> }).paint[
				'fill-opacity'
			];
		assert.equal(opacity(style), 1);
		assert.ok(Array.isArray(opacity(stackedStyle('/osm.json', '/landcover.json', true))));
	});
});
