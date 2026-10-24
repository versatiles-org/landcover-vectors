// The ESA -> Shortbread channel table drives the per-block class index: at every zoom the active channels
// plus the no-data channel must partition all ESA codes exactly once. A gap would drop a class into
// no-data unnoticed; an overlap would add two class indexes into a wrong one silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { channels, MAXLEVEL } from '../config.ts';

test('every ESA code belongs to exactly one channel', () => {
	const seen = new Map<number, number>();
	for (const c of channels) for (const esa of c.esa) seen.set(esa, (seen.get(esa) ?? 0) + 1);
	const duplicated = [...seen].filter(([, n]) => n > 1);
	assert.deepEqual(duplicated, [], 'ESA codes claimed by more than one channel');
});

test('the ESA v200 legend is covered', () => {
	const legend = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
	const mapped = new Set(channels.flatMap((c) => c.esa));
	assert.deepEqual(
		[...mapped].sort((a, b) => a - b),
		legend,
	);
});

test('exactly one channel is the no-data class', () => {
	const nodata = channels.filter((c) => c.layer === null);
	assert.equal(nodata.length, 1);
	assert.deepEqual(nodata[0].esa, [0]);
	assert.equal(nodata[0].kind, null);
});

test('at every zoom, active + no-data covers all codes exactly once', () => {
	const all = channels.flatMap((c) => c.esa).sort((a, b) => a - b);
	for (let z = 0; z <= MAXLEVEL; z++) {
		// mirrors lib/block.ts: a channel above its cutoff folds into the no-data class
		const active = channels.filter((c) => c.layer !== null && c.maxZoom >= z);
		const nodataEsa = channels.filter((c) => c.layer === null || c.maxZoom < z).flatMap((c) => c.esa);
		const union = [...active.flatMap((c) => c.esa), ...nodataEsa].sort((a, b) => a - b);
		assert.deepEqual(union, all, `zoom ${z} does not partition the codes`);
	}
});

test('a kind never appears in both layers', () => {
	const byKind = new Map<string, Set<string>>();
	for (const c of channels) {
		if (!c.kind || !c.layer) continue;
		byKind.set(c.kind, (byKind.get(c.kind) ?? new Set()).add(c.layer));
	}
	for (const [kind, layers] of byKind) assert.equal(layers.size, 1, `${kind} is in ${[...layers]}`);
});

test('every emitting channel has a kind, a layer and a colour, and a sane cutoff', () => {
	for (const c of channels) {
		if (c.layer === null) continue;
		assert.ok(c.kind, `${c.esa} has a layer but no kind`);
		assert.ok(c.color && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c.color), `${c.kind} colour ${c.color}`);
		assert.ok(c.maxZoom >= 0 && c.maxZoom <= MAXLEVEL, `${c.kind} maxZoom ${c.maxZoom}`);
	}
});

test('MAXLEVEL is driven by the deepest per-kind cutoff', () => {
	const deepest = Math.max(...channels.map((c) => c.maxZoom));
	assert.equal(MAXLEVEL, deepest, 'building zooms no kind reaches, or cutting a kind short');
});
