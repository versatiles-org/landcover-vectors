// Documentation drift guard. Every derived constant in config.ts and every number the README quotes is
// re-derived here from the modules, because the last BLUR_RADIUS change left five wrong figures behind
// in comments and prose that nothing caught.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	MERC,
	MAXLEVEL,
	TILE_PX,
	BLOCK,
	BLUR_RADIUS,
	SIEVE_THRESHOLD,
	MARGIN_PX,
	FULL_PX,
	channels,
	DETAIL_PX,
	simplifyForLevel,
} from '../config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const config = read('config.ts');
const readme = read('README.md');

// pull the single capture group out of `re`, failing with a useful message if the shape moved
function grab(text: string, re: RegExp, what: string): string {
	const m = text.match(re);
	assert.ok(m, `${what}: nothing matched ${re}`);
	return m[1];
}

describe('config.ts comments state the computed value', () => {
	test('SIEVE_THRESHOLD', () => {
		const documented = grab(config, /Math\.PI \* BLUR_RADIUS \* BLUR_RADIUS\); \/\/ (\d+)/, 'sieve comment');
		assert.equal(Number(documented), SIEVE_THRESHOLD);
	});

	test('MARGIN_PX', () => {
		const documented = grab(config, /Math\.sqrt\(SIEVE_THRESHOLD\)\); \/\/ (\d+)/, 'margin comment');
		assert.equal(Number(documented), MARGIN_PX);
	});

	test('the derived values are internally consistent', () => {
		assert.equal(SIEVE_THRESHOLD, Math.round(Math.PI * BLUR_RADIUS * BLUR_RADIUS));
		assert.equal(MARGIN_PX, Math.ceil(3 * BLUR_RADIUS + 3 * Math.sqrt(SIEVE_THRESHOLD)));
		assert.equal(FULL_PX, TILE_PX * 2 ** MAXLEVEL);
	});
});

describe('README numbers match config.ts', () => {
	test('blur radius', () => {
		assert.equal(Number(grab(readme, /σ = `BLUR_RADIUS` = (\d+) px/, 'README σ')), BLUR_RADIUS);
	});

	test('sieve threshold', () => {
		assert.equal(Number(grab(readme, /round\(π·r²\) =\s*(\d+) px/, 'README sieve')), SIEVE_THRESHOLD);
	});

	test('margin', () => {
		assert.equal(Number(grab(readme, /√`SIEVE_THRESHOLD`\) = (\d+) px/, 'README margin')), MARGIN_PX);
	});

	test('block window size', () => {
		const documented = Number(grab(readme, /≤ ~(\d+)² px window/, 'README window'));
		assert.equal(documented, BLOCK * TILE_PX + 2 * MARGIN_PX);
	});

	test('block geometry', () => {
		const [side, tilePx] = [
			grab(readme, /`BLOCK`×`BLOCK` = (\d+)×\d+ tiles/, 'README block'),
			grab(readme, /`TILE_PX` = (\d+) raw px per tile/, 'README tile px'),
		];
		assert.equal(Number(side), BLOCK);
		assert.equal(Number(tilePx), TILE_PX);
	});

	test('simplify tolerance formula and its meaning', () => {
		// the formula is stated in terms of DETAIL_PX, so it stays true when a sweep changes it
		const denom = Number(grab(readme, /`\(2·MERC\)\/\((\d+)·DETAIL_PX·2\^z\)`/, 'README tolerance'));
		const tilePx = Number(grab(readme, /≈ 1 px at a (\d+)·`DETAIL_PX` px tile/, 'README tolerance tile'));
		assert.equal(simplifyForLevel(0), (2 * MERC) / (denom * DETAIL_PX));
		assert.equal(denom, tilePx, 'the formula and the "1 px at N px tile" claim disagree');
		// ... but the value it quotes as current must match
		assert.equal(Number(grab(readme, /`DETAIL_PX` = (\d+) today/, 'README DETAIL_PX')), DETAIL_PX);
	});

	test('the resolution table quotes the real source resolution', () => {
		const mPerPx = Number(grab(readme, /1024 → (\d+) m\/px at z10/, 'README m/px'));
		assert.equal(mPerPx, Math.round((2 * MERC) / FULL_PX), 'the metres-per-pixel claim drifted');
	});

	test('source raster resolution', () => {
		const px = grab(readme, /= 1 ([\d ]+) px per side/, 'README FULL_PX').replace(/\s/g, '');
		assert.equal(Number('1' + px), FULL_PX);
	});

	test('the built zoom range', () => {
		assert.equal(Number(grab(readme, /for each zoom 0–(\d+)/, 'README zoom range')), MAXLEVEL);
		assert.equal(Number(grab(readme, /A full z0–(\d+) build/, 'README resources')), MAXLEVEL);
	});
});

describe('the README mapping table matches the channel table', () => {
	// rows look like: | Tree cover | `land` | `forest` | z0–6 |
	const rows = readme
		.split('\n')
		.map((line) => line.match(/^\|[^|]+\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*z0–(\d+)\s*\|$/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => ({ layer: m[1], kind: m[2], maxZoom: Number(m[3]) }));

	test('the table lists every emitting channel exactly once', () => {
		const emitting = channels.filter((c) => c.kind && c.layer);
		assert.equal(rows.length, emitting.length, 'table rows vs channels');
		assert.deepEqual(rows.map((r) => r.kind).sort(), emitting.map((c) => c.kind).sort());
	});

	test('each row states the real layer and cutoff', () => {
		for (const row of rows) {
			const channel = channels.find((c) => c.kind === row.kind);
			assert.ok(channel, `${row.kind} is in the README but not in config.ts`);
			assert.equal(row.layer, channel.layer, `${row.kind} layer`);
			assert.equal(row.maxZoom, channel.maxZoom, `${row.kind} cutoff`);
		}
	});
});
