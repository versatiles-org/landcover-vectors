// The merge filter decides which OSM features survive next to the landcover: one kind too many and OSM
// loses data it should keep, one too few and two sources double-draw. It is generated from `channels`,
// and the README shows it for hand-made merges — both are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { osmKeepExpr, osmFilter, versionAtLeast, MIN_VERSATILES } from '../lib/handover.ts';
import { channels } from '../config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('each layer drops exactly the kinds the landcover emits there, up to their cutoff', () => {
	for (const layer of ['land', 'water_polygons'] as const) {
		const expr = osmKeepExpr(layer);
		const emitted = channels.filter((c) => c.layer === layer && c.kind);
		for (const c of emitted) {
			assert.ok(expr.includes(`'${c.kind}'`), `${layer} filter misses ${c.kind}`);
			assert.ok(expr.includes(`zoom <= ${c.maxZoom}`), `${layer} filter misses the z${c.maxZoom} cutoff`);
		}
		assert.match(expr, /^!\(/, 'the expression keeps what it does not drop');
	}
	assert.equal(osmKeepExpr('ocean'), 'true', 'a layer the landcover does not touch passes untouched');
	assert.doesNotMatch(osmKeepExpr('water_polygons'), /'river'|'reservoir'/, 'OSM-only kinds stay');
});

test('one VPL step per layer', () => {
	const steps = osmFilter().split(' | ');
	assert.deepEqual(
		steps.map((s) => s.match(/layer=\["(\w+)"\]/)?.[1]),
		['land', 'water_polygons'],
	);
});

test('the README shows the filter the code generates', () => {
	const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
	for (const step of osmFilter().split(' | ')) assert.ok(readme.includes(step), `README is missing: ${step}`);
});

test('the version gate', () => {
	assert.ok(versionAtLeast('versatiles 5.4.0', MIN_VERSATILES));
	assert.ok(versionAtLeast('versatiles 4.15.0', MIN_VERSATILES));
	assert.ok(!versionAtLeast('versatiles 4.14.0', MIN_VERSATILES), '4.14.0 drops the land layer');
	assert.ok(!versionAtLeast('versatiles 3.99.99', MIN_VERSATILES));
	assert.ok(versionAtLeast('4.15.1', MIN_VERSATILES));
	assert.ok(!versionAtLeast('versatiles (unknown)', MIN_VERSATILES), 'no version → refuse');
});
