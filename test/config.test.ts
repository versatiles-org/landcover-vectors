// The block grid is the load-bearing part of the whole design: if two neighbouring blocks disagree
// about their shared edge by even one pixel, the output gets seams or slivers that no later stage can
// repair. These tests pin the invariants the README claims.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	MERC,
	MAXLEVEL,
	TILE_PX,
	BLOCK,
	MARGIN_PX,
	FULL_PX,
	blockWindow,
	blocksPerAxis,
	simplifyForLevel,
} from '../config.ts';

// metres per raster pixel at zoom z (the grid every block is aligned to)
const pxSize = (z: number) => (2 * MERC) / Math.pow(2, z) / TILE_PX;

describe('blocksPerAxis', () => {
	test('one block covers the world while 2^z <= BLOCK', () => {
		for (let z = 0; z <= 3; z++) assert.equal(blocksPerAxis(z), 1, `z${z}`);
	});

	test('quadruples with each zoom beyond that', () => {
		assert.equal(blocksPerAxis(4), 2);
		assert.equal(blocksPerAxis(7), 16);
		assert.equal(blocksPerAxis(10), 128);
	});
});

describe('blockWindow', () => {
	test('neighbours share an identical inner edge — no gaps, no overlap', () => {
		for (const z of [4, 5, 7, 10]) {
			const n = blocksPerAxis(z);
			for (const [bx, by] of [
				[0, 0],
				[1, 1],
				[n - 2, n - 2],
			] as [number, number][]) {
				if (bx < 0 || by < 0) continue;
				const here = blockWindow(z, bx, by).inner3857;
				const east = blockWindow(z, bx + 1, by).inner3857;
				const south = blockWindow(z, bx, by + 1).inner3857;
				assert.equal(here.maxx, east.minx, `z${z} ${bx},${by} east seam`);
				assert.equal(here.miny, south.maxy, `z${z} ${bx},${by} south seam`);
			}
		}
	});

	test('the inner rectangle sits a whole number of pixels inside the window', () => {
		// the crop in lib/block.ts step 6 is a raster crop, so a fractional offset would shift the grid
		for (const z of [4, 6, 10]) {
			const px = pxSize(z);
			const n = blocksPerAxis(z);
			for (const [bx, by] of [
				[0, 0],
				[1, 1],
				[n - 1, n - 1],
			] as [number, number][]) {
				const { inner3857: i, window3857: w } = blockWindow(z, bx, by);
				for (const [what, offset] of [
					['left', i.minx - w.minx],
					['right', w.maxx - i.maxx],
					['bottom', i.miny - w.miny],
					['top', w.maxy - i.maxy],
				] as [string, number][]) {
					const inPx = offset / px;
					assert.ok(
						Math.abs(inPx - Math.round(inPx)) < 1e-6,
						`z${z} ${bx},${by} ${what} offset is ${inPx} px, not whole`,
					);
					// an inner block gets the full margin; an edge block is clamped to the world square
					assert.ok(Math.round(inPx) === MARGIN_PX || Math.round(inPx) === 0, `z${z} ${bx},${by} ${what}`);
				}
			}
		}
	});

	test('edge blocks clamp to the world square', () => {
		const z = 5;
		const n = blocksPerAxis(z);
		const first = blockWindow(z, 0, 0);
		const last = blockWindow(z, n - 1, n - 1);
		assert.equal(first.window3857.minx, -MERC);
		assert.equal(first.window3857.maxy, MERC);
		assert.equal(last.window3857.maxx, MERC);
		assert.equal(last.window3857.miny, -MERC);
	});

	test('an interior window is the block plus a margin on every side', () => {
		const { windowPx } = blockWindow(5, 1, 1); // z5 has 4x4 blocks, so (1,1) touches no edge
		assert.equal(windowPx.width, BLOCK * TILE_PX + 2 * MARGIN_PX);
		assert.equal(windowPx.height, BLOCK * TILE_PX + 2 * MARGIN_PX);
	});

	test('a single-block zoom covers the world at exactly 2^z tiles', () => {
		for (const z of [0, 2, 3]) {
			const { windowPx, inner3857 } = blockWindow(z, 0, 0);
			assert.equal(windowPx.width, Math.pow(2, z) * TILE_PX, `z${z} width`);
			assert.equal(inner3857.minx, -MERC, `z${z} minx`);
			assert.equal(inner3857.maxx, MERC, `z${z} maxx`);
		}
	});

	test('the deepest zoom matches the source raster size', () => {
		assert.equal(FULL_PX, TILE_PX * Math.pow(2, MAXLEVEL));
		assert.equal(blocksPerAxis(MAXLEVEL) * BLOCK * TILE_PX, FULL_PX);
	});

	test('innerLonLat spans the full world at the edges', () => {
		const z = 6;
		const n = blocksPerAxis(z);
		assert.equal(blockWindow(z, 0, 0).innerLonLat.west, -180);
		assert.equal(blockWindow(z, n - 1, 0).innerLonLat.east, 180);
		// the Mercator poles, to within a rounding error
		assert.ok(Math.abs(blockWindow(z, 0, 0).innerLonLat.north - 85.0511287798066) < 1e-9);
		assert.ok(Math.abs(blockWindow(z, 0, n - 1).innerLonLat.south + 85.0511287798066) < 1e-9);
	});

	test('north/south are symmetric about the equator', () => {
		const z = 4;
		const n = blocksPerAxis(z);
		for (let by = 0; by < n; by++) {
			const top = blockWindow(z, 0, by).innerLonLat;
			const mirrored = blockWindow(z, 0, n - 1 - by).innerLonLat;
			assert.ok(Math.abs(top.north + mirrored.south) < 1e-9, `row ${by}`);
		}
	});
});

describe('simplifyForLevel', () => {
	test('is one pixel of a 256-px tile', () => {
		for (let z = 0; z <= MAXLEVEL; z++) {
			assert.equal(simplifyForLevel(z), (2 * MERC) / (256 * Math.pow(2, z)), `z${z}`);
		}
	});

	test('halves with every zoom', () => {
		for (let z = 1; z <= MAXLEVEL; z++) {
			assert.ok(Math.abs(simplifyForLevel(z - 1) / simplifyForLevel(z) - 2) < 1e-12, `z${z}`);
		}
	});
});
