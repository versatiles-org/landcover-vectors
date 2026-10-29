// The merge filters decide which features of each source survive next to the other: one kind too many and
// a source loses data it should keep, one too few and two sources double-draw. They are generated from
// `channels`, and the README shows them for hand-made merges — both are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	osmKeepExpr,
	landcoverKeepExpr,
	osmFilter,
	landcoverFilter,
	mergePipeline,
	versionAtLeast,
	MIN_VERSATILES,
} from '../lib/handover.ts';
import { channels } from '../config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const emitted = channels.filter((c) => c.layer && c.kind);
const layerOf = (step: string) => step.match(/layer=\["(\w+)"\]/)?.[1];

test('OSM drops exactly the kinds the landcover supplies, up to their cutoff', () => {
	for (const layer of ['land', 'water_polygons'] as const) {
		const expr = osmKeepExpr(layer);
		for (const c of emitted.filter((c) => c.layer === layer)) {
			if (c.osmFrom !== undefined) {
				assert.ok(!expr.includes(`'${c.kind}'`), `OSM's ${c.kind} should stay`);
				continue;
			}
			assert.ok(expr.includes(`'${c.kind}'`), `${layer} filter misses ${c.kind}`);
			assert.ok(expr.includes(`zoom <= ${c.maxZoom}`), `${layer} filter misses the z${c.maxZoom} cutoff`);
		}
		assert.match(expr, /^!\(/, 'the expression keeps what it does not drop');
	}
	assert.equal(osmKeepExpr('ocean'), 'true', 'a layer the landcover does not touch passes untouched');
	assert.doesNotMatch(osmKeepExpr('water_polygons'), /'river'|'reservoir'/, 'OSM-only kinds stay');
});

test('the landcover drops exactly the kinds OSM supplies, from where OSM has them', () => {
	assert.equal(landcoverKeepExpr('water_polygons'), "!(zoom >= 4 && kind in ['water'])");
	assert.equal(landcoverKeepExpr('land'), "!(zoom >= 11 && kind in ['residential'])");
	for (const c of emitted.filter((c) => c.osmFrom === undefined))
		assert.ok(!landcoverFilter().includes(`'${c.kind}'`), `the landcover's ${c.kind} should stay`);
});

test('one VPL step per layer that loses anything', () => {
	assert.deepEqual(osmFilter().split(' | ').map(layerOf), ['land', 'water_polygons']);
	assert.deepEqual(landcoverFilter().split(' | ').map(layerOf), ['land', 'water_polygons']);
});

test('the README shows the filters the code generates', () => {
	const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
	for (const step of [...osmFilter().split(' | '), ...landcoverFilter().split(' | ')])
		assert.ok(readme.includes(step), `README is missing: ${step}`);
});

test('the merge pipeline filters each source with its own filter', () => {
	assert.equal(
		mergePipeline('osm.versatiles', 'lc.mbtiles'),
		`from_merged_vector [ from_container filename="osm.versatiles" | ${osmFilter()}, ` +
			`from_container filename="lc.mbtiles" | ${landcoverFilter()} ]`,
	);
});

test('the version gate', () => {
	assert.ok(versionAtLeast('versatiles 5.4.0', MIN_VERSATILES));
	assert.ok(versionAtLeast('versatiles 4.15.0', MIN_VERSATILES));
	assert.ok(!versionAtLeast('versatiles 4.14.0', MIN_VERSATILES), '4.14.0 drops the land layer');
	assert.ok(!versionAtLeast('versatiles 3.99.99', MIN_VERSATILES));
	assert.ok(versionAtLeast('4.15.1', MIN_VERSATILES));
	assert.ok(!versionAtLeast('versatiles (unknown)', MIN_VERSATILES), 'no version → refuse');
});
