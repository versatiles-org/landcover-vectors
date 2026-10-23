// The --native numbers decide whether a TILE_PX change is worth a re-download, so the pieces that pick what
// is read and how it is scored are pinned: which ESA tiles a map tile needs, the sample and replay grid
// sizes, and the grid-independent share comparison.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { esaKeysFor, nativePx, replayPx, shares, shareError, NATIVE_CAP, REPLAY_CAP } from '../lib/native.ts';
import { tileBounds } from '../lib/stats.ts';
import { MAXLEVEL } from '../config.ts';

const key = (corner: string) => `v200/2021/map/ESA_WorldCover_10m_2021_v200_${corner}_Map.tif`;
const u8 = (...v: number[]) => new Uint8Array(v);

describe('esaKeysFor', () => {
	const keys = [key('N54W090'), key('N54W087'), key('N51W090'), key('N57W090'), 'not an ESA tile'];

	test('picks the 3° cells a tile intersects', () => {
		// 9/129/159 lies within 54..57°N, 90..87°W
		assert.deepEqual(esaKeysFor(keys, tileBounds(9, 129, 159)), [key('N54W090')]);
	});

	test('a box on a cell edge needs the cells on both sides, a box touching one does not', () => {
		const across = esaKeysFor(keys, { west: -88, south: 55, east: -86, north: 56 });
		assert.deepEqual(across, [key('N54W090'), key('N54W087')]);
		const touching = esaKeysFor(keys, { west: -90, south: 54, east: -89, north: 57 });
		assert.deepEqual(touching, [key('N54W090')]);
	});

	test('open ocean has no ESA tile', () => {
		assert.deepEqual(esaKeysFor(keys, { west: -30, south: 40, east: -29, north: 41 }), []);
	});
});

describe('grid sizes', () => {
	test("the native grid is ESA's spacing, in multiples of 256, capped", () => {
		assert.equal(nativePx(10), 4352); // 39 136 m / 9.3 m = 4219 → 17 × 256
		assert.equal(nativePx(9), NATIVE_CAP); // 8438 → capped
		for (let z = 0; z <= MAXLEVEL; z++) assert.equal(nativePx(z) % 256, 0, `z${z}`);
	});

	test('the replayed source is TILE_PX per deepest-zoom tile, and refuses windows above the cap', () => {
		assert.equal(replayPx(MAXLEVEL, 1024), 1024);
		assert.equal(replayPx(MAXLEVEL - 1, 2048), 4096);
		assert.throws(() => replayPx(MAXLEVEL - 5, 1024), /pick a higher zoom/);
		assert.throws(() => replayPx(MAXLEVEL + 1, 1024), /above MAXLEVEL/);
		assert.ok(replayPx(MAXLEVEL - 4, 1024) <= REPLAY_CAP);
	});
});

describe('shares', () => {
	test('per code, as a fraction of all pixels', () => {
		assert.deepEqual(
			shares(u8(90, 90, 20, 0)),
			new Map([
				[0, 0.25],
				[20, 0.25],
				[90, 0.5],
			]),
		);
	});

	test('the error is half the summed difference, and compares grids of different size', () => {
		const native = shares(u8(90, 90, 90, 20, 20, 20, 0, 0));
		assert.equal(shareError(native, shares(u8(90, 90, 90, 20, 20, 20, 0, 0))), 0);
		assert.equal(shareError(native, shares(u8(90, 20, 20, 0))), 0.125); // marsh −⅛, scrub +⅛
		assert.equal(shareError(shares(u8(90)), shares(u8(20))), 1);
	});
});
