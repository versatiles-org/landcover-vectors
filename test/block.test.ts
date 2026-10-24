// Which way a block goes, decided on its window's histograms. The sea is no longer burned into the window,
// so these decisions are the only thing standing between ESA's own coastal sea (class 80) and a block-sized
// water rectangle in the middle of OSM's ocean.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fastPath, type WindowContent } from '../lib/block.ts';
import { channels } from '../config.ts';

const active = channels.filter((c) => c.layer !== null);
const kind = (esa: number) => active.find((c) => c.esa.includes(esa))?.kind;
const PIXELS = 100;
const window = (over: Partial<WindowContent>): WindowContent => ({
	present: new Set([10]),
	counted: PIXELS,
	pixels: PIXELS,
	sea: 0,
	...over,
});

describe('fastPath', () => {
	test('an inland block of one kind is uniform', () => {
		const r = fastPath(window({}), active);
		assert.equal(r.branch, 'uniform');
		assert.equal(r.branch === 'uniform' && r.kind.kind, kind(10));
	});

	test('open sea that ESA calls water is empty, not a water rectangle', () => {
		assert.deepEqual(fastPath(window({ present: new Set([80]), sea: PIXELS }), active), { branch: 'empty' });
	});

	test('a coast of one land kind is never uniform', () => {
		const r = fastPath(window({ sea: 30 }), active);
		assert.equal(r.branch, 'full');
		assert.deepEqual(r.branch === 'full' && r.classes.map((c) => c.kind), [kind(10)]);
	});

	test('ESA no-data in the window rules out uniform too', () => {
		assert.equal(fastPath(window({ counted: 70 }), active).branch, 'full');
	});

	test('nothing but no-data is empty', () => {
		assert.deepEqual(fastPath(window({ present: new Set(), counted: 0 }), active), { branch: 'empty' });
	});

	test('only the kinds present get a class, in channel order', () => {
		const r = fastPath(window({ present: new Set([30, 10, 80]) }), active);
		assert.deepEqual(
			r.branch === 'full' && r.classes.map((c) => c.kind),
			active.filter((c) => [30, 10, 80].some((v) => c.esa.includes(v))).map((c) => c.kind),
		);
	});

	test('a kind past its cutoff counts as no-data', () => {
		const withoutForest = active.filter((c) => !c.esa.includes(10));
		assert.deepEqual(fastPath(window({}), withoutForest), { branch: 'empty' });
	});
});
