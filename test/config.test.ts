// The block grid is the load-bearing part of the whole design: if two neighbouring blocks disagree
// about their shared edge by even one pixel, the output gets seams or slivers that no later stage can
// repair. These tests pin the invariants the README claims.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	MERC,
	MAXLEVEL,
	TILE_PX,
	BLOCK,
	MARGIN_PX,
	FULL_PX,
	OVERSAMPLE,
	SIEVE_RENDERED,
	SIEVE_THRESHOLD,
	DETAIL_PX,
	blockWindow,
	blocksPerAxis,
	simplifyForLevel,
} from '../config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
		// lib/block.ts marks the margin by whole pixels (innerPx), so a fractional offset would shift the grid
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

	test('innerPx is the inner rectangle in window pixels, and tiles are its XYZ tiles', () => {
		const inner = blockWindow(5, 1, 1);
		assert.deepEqual(inner.innerPx, { x: MARGIN_PX, y: MARGIN_PX, width: BLOCK * TILE_PX, height: BLOCK * TILE_PX });
		assert.deepEqual(inner.tiles, { x0: BLOCK, y0: BLOCK, x1: 2 * BLOCK, y1: 2 * BLOCK });
		// a corner block has no margin towards the world's edge
		const corner = blockWindow(5, 0, 0);
		assert.deepEqual([corner.innerPx.x, corner.innerPx.y], [0, 0]);
		assert.equal(corner.windowPx.width, corner.innerPx.width + MARGIN_PX);
		// a zoom smaller than a block has fewer tiles than BLOCK
		assert.deepEqual(blockWindow(2, 0, 0).tiles, { x0: 0, y0: 0, x1: 4, y1: 4 });
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

describe('the resolution knobs', () => {
	test('the sieve is anchored to rendered pixels, so TILE_PX cannot change it by accident', () => {
		assert.equal(OVERSAMPLE, TILE_PX / 256);
		assert.equal(SIEVE_RENDERED, 5, 'the committed default; a sweep overrides it per run');
		// the raw-pixel values are derived from it, so they scale along
		assert.equal(SIEVE_THRESHOLD, Math.round(SIEVE_RENDERED * OVERSAMPLE * OVERSAMPLE));
		assert.equal(MARGIN_PX, Math.ceil(3 * Math.sqrt(SIEVE_THRESHOLD)));
	});

	test('LANDCOVER_SIEVE_RENDERED overrides the raster stage', () => {
		const read = (env: Record<string, string>) => {
			const r = spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					"import('./config.ts').then((c) => console.log(JSON.stringify([c.SIEVE_THRESHOLD, c.MARGIN_PX, c.SIEVE_STAGES])))",
				],
				{ cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } },
			);
			return { status: r.status, stderr: r.stderr, values: r.status === 0 ? JSON.parse(r.stdout) : null };
		};

		// two passes: a quarter of the threshold, then the threshold
		assert.deepEqual(read({}).values, [80, 27, [20, 80]]);
		// a sieve override moves the threshold and its passes, and the margin grows to cover it
		assert.deepEqual(read({ LANDCOVER_SIEVE_RENDERED: '4' }).values, [64, 24, [16, 64]]);
		// a threshold too small to split runs once
		assert.deepEqual(read({ LANDCOVER_SIEVE_RENDERED: '0.25' }).values, [4, 6, [4]]);
		// 0 switches the sieve off, and with it the margin
		assert.deepEqual(read({ LANDCOVER_SIEVE_RENDERED: '0' }).values, [0, 0, []]);
		// empty means unset
		assert.deepEqual(read({ LANDCOVER_SIEVE_RENDERED: '' }).values, [80, 27, [20, 80]]);

		for (const [name, bad] of [
			['LANDCOVER_SIEVE_RENDERED', '-1'],
			['LANDCOVER_SIEVE_RENDERED', 'abc'],
		]) {
			const r = read({ [name]: bad });
			assert.equal(r.status, 1, `${name}=${bad} was accepted`);
			assert.match(r.stderr, new RegExp(`bad ${name} "${bad}"`));
		}
	});

	test('LANDCOVER_CONCURRENCY sets the blocks at once, one per core by default', () => {
		const read = (env: Record<string, string>) =>
			spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					"import('./config.ts').then((c) => console.log(c.BLOCK_CONCURRENCY, c.CPU_CORES))",
				],
				{ cwd: repoRoot, encoding: 'utf8', env: { ...process.env, LANDCOVER_CONCURRENCY: '', ...env } },
			);
		const [blocks, cores] = read({}).stdout.trim().split(' ').map(Number);
		assert.equal(blocks, cores);
		assert.equal(read({ LANDCOVER_CONCURRENCY: '4' }).stdout.trim().split(' ')[0], '4');
		assert.equal(read({ LANDCOVER_CONCURRENCY: '2.7' }).stdout.trim().split(' ')[0], '2');
		for (const bad of ['0', 'abc']) {
			const r = read({ LANDCOVER_CONCURRENCY: bad });
			assert.equal(r.status, 1, `LANDCOVER_CONCURRENCY=${bad} was accepted`);
			assert.match(r.stderr, new RegExp(`bad LANDCOVER_CONCURRENCY "${bad}"`));
		}
	});

	test('DETAIL_PX scales the tolerance inversely', () => {
		assert.equal(DETAIL_PX, 1, 'the committed default; a sweep overrides it per run');
		for (let z = 0; z <= MAXLEVEL; z++) {
			assert.equal(simplifyForLevel(z), (2 * MERC) / (256 * DETAIL_PX * Math.pow(2, z)), `z${z}`);
		}
	});

	test('LANDCOVER_DETAIL_PX overrides it, and a bad value is refused', () => {
		const read = (value: string) =>
			spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					"import('./config.ts').then((c) => console.log(c.DETAIL_PX, c.simplifyForLevel(10)))",
				],
				{ cwd: repoRoot, encoding: 'utf8', env: { ...process.env, LANDCOVER_DETAIL_PX: value } },
			);

		const two = read('2');
		assert.equal(two.status, 0, two.stderr);
		const [detail, tolerance] = two.stdout.trim().split(' ').map(Number);
		assert.equal(detail, 2);
		assert.equal(tolerance, simplifyForLevel(10) / 2, 'twice the detail is half the tolerance');

		for (const bad of ['0', '-3', 'nonsense']) {
			const r = read(bad);
			assert.equal(r.status, 1, `"${bad}" was accepted`);
			assert.match(r.stderr, /bad LANDCOVER_DETAIL_PX/);
		}
	});
});

describe('simplifyForLevel', () => {
	test('is one pixel of a (256 · DETAIL_PX)-px tile', () => {
		for (let z = 0; z <= MAXLEVEL; z++) {
			assert.equal(simplifyForLevel(z), (2 * MERC) / (256 * DETAIL_PX * Math.pow(2, z)), `z${z}`);
		}
	});

	test('halves with every zoom', () => {
		for (let z = 1; z <= MAXLEVEL; z++) {
			assert.ok(Math.abs(simplifyForLevel(z - 1) / simplifyForLevel(z) - 2) < 1e-12, `z${z}`);
		}
	});
});
