// The real-map view must load the tiles this repo serves, not tiles.versatiles.org's, and must draw the land cover
// as versatiles-style will: from z0, under OSM, in the stock colours — otherwise it shows some other map.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { osm } from '@versatiles/style';

import { FADE, landcoverLayers, stackedStyle, versatilesStyle } from '../lib/style-versatiles.ts';
import { channels, LAYER } from '../config.ts';

describe('versatilesStyle', () => {
	const style = versatilesStyle('/tiles/osm/tiles.json?v=abc');

	test('reads every vector layer from the served tiles', () => {
		const vector = Object.values(style.sources).filter((s) => s.type === 'vector');
		assert.ok(vector.length > 0);
		for (const s of vector) assert.equal('url' in s && s.url, '/tiles/osm/tiles.json?v=abc');
	});

	test('keeps glyphs and sprites on tiles.versatiles.org', () => {
		assert.match(String(style.glyphs), /^https:\/\/tiles\.versatiles\.org\//);
	});
});

describe('landcoverLayers', () => {
	const layers = landcoverLayers();
	const kindsOf = (l: (typeof layers)[number]) =>
		('filter' in l ? (l.filter as [string, unknown, [string, string[]]])[2][1] : []) as string[];

	test('covers every kind exactly once, and nothing else', () => {
		const kinds = layers.flatMap(kindsOf).sort();
		assert.deepEqual(kinds, channels.flatMap((c) => (c.kind ? [c.kind] : [])).sort());
	});

	test('is one copy of each stock fill that draws a kind, reading the landcover layer from z0, faded', () => {
		const stock = versatilesStyle('/osm.json').layers;
		for (const l of layers) {
			const original = stock.find((s) => `landcover-${s.id}` === l.id);
			assert.ok(original && original.type === 'fill', l.id);
			assert.equal(l.type, 'fill');
			if (l.type !== 'fill') continue;
			assert.equal(l.source, 'landcover');
			assert.equal(l['source-layer'], LAYER);
			assert.equal(l.minzoom, undefined, l.id);
			assert.equal(l.paint?.['fill-color'], original.paint?.['fill-color'], l.id);
			assert.deepEqual(l.paint?.['fill-opacity'], FADE);
		}
		assert.ok(layers.some((l) => l.id === 'landcover-land-forest'));
	});
});

// the land cover as a source of its own, under OSM's fills and over nothing but the background
describe('stackedStyle', () => {
	const style = stackedStyle('/osm.json', '/landcover.json');
	const ids = style.layers.map((l) => l.id);
	const under = style.layers.filter((l) => 'source' in l && l.source === 'landcover');

	test('reads the land cover from its own source, and the rest from OSM', () => {
		assert.deepEqual(style.sources.landcover, { type: 'vector', url: '/landcover.json' });
		assert.deepEqual(
			under.map((l) => l.id),
			landcoverLayers().map((l) => l.id),
		);
		assert.ok(style.layers.some((l) => 'source' in l && l.source !== 'landcover'));
	});

	test("draws it right above the background, in versatiles-style's slot below every fill", () => {
		assert.equal(ids[0], 'background');
		assert.deepEqual(
			ids.slice(1, under.length + 1),
			under.map((l) => l.id),
		);
		assert.equal(ids[under.length + 1], osm.slots.belowFills);
		assert.ok(ids.indexOf('water-ocean') > under.length + 1);
	});
});
