// The preview's versatiles-style view must load the merge this repo serves, not tiles.versatiles.org's
// tiles, and must draw the land cover from z0 — otherwise it shows some other map than the merged one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { versatilesStyle } from '../lib/style-versatiles.ts';

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
