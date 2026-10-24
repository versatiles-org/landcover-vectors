// The inspect numbers are what a parameter decision rests on, so the pieces that produce them are pinned:
// which classes a zoom draws, the pixel comparison, the block majority, and the raw-byte reader that has
// already been wrong once (ENVI + the pipeline's GDAL env) and has one trap left (ESA 10 is a newline).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	activeCodes,
	targetFor,
	compare,
	majority,
	pixelsOfPGM,
	resize,
	grid,
	errorMap,
	colorize,
	className,
	to3857,
	tileBounds3857,
	PALETTE,
	ERROR_COLORS,
	UNKNOWN_KIND,
} from '../lib/inspect.ts';
import { MERC, MAXLEVEL, blockWindow } from '../config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u8 = (...v: number[]) => new Uint8Array(v);

describe('what a zoom draws', () => {
	test('mirrors the channel cutoffs', () => {
		// every kind runs to MAXLEVEL (one handover for all, see lib/handover.ts); no-data is never drawn
		for (const z of [0, 3, 9, MAXLEVEL]) {
			for (const code of [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100])
				assert.ok(activeCodes(z).has(code), `z${z} should draw ${code}`);
			assert.ok(!activeCodes(z).has(0), `z${z} must not draw no-data`);
		}
		assert.equal(activeCodes(MAXLEVEL + 1).size, 0);
	});

	test('targetFor turns everything a zoom does not draw into a hole', () => {
		assert.deepEqual([...targetFor(u8(0, 10, 20, 80, 90, 100), 9)], [0, 10, 20, 80, 90, 100]);
		assert.deepEqual([...targetFor(u8(10, 80), MAXLEVEL + 1)], [0, 0]);
	});

	test('class names', () => {
		assert.equal(className(0), '(hole)');
		assert.equal(className(90), 'marsh');
		assert.equal(className(100), 'heath');
		assert.equal(className(UNKNOWN_KIND), '(unknown kind)');
	});
});

describe('compare', () => {
	// target:   marsh marsh scrub hole
	// rendered: marsh scrub hole  marsh
	const cmp = compare(u8(90, 90, 20, 0), u8(90, 20, 0, 90));

	test('agreement, and the three ways to be wrong, partition the pixels', () => {
		assert.equal(cmp.agreement, 0.25);
		assert.equal(cmp.wrongKind, 0.25); // marsh drawn as scrub
		assert.equal(cmp.gap, 0.25); // scrub left as a hole
		assert.equal(cmp.overdraw, 0.25); // a hole drawn as marsh
		assert.equal(cmp.agreement + cmp.wrongKind + cmp.gap + cmp.overdraw, 1);
	});

	test('per class: target share, rendered share, and how much of it was kept', () => {
		const marsh = cmp.classes.find((c) => c.name === 'marsh')!;
		assert.equal(marsh.target, 0.5);
		assert.equal(marsh.rendered, 0.5);
		assert.equal(marsh.recall, 0.5);
		const scrub = cmp.classes.find((c) => c.name === 'scrub')!;
		assert.equal(scrub.recall, 0, 'the one scrub pixel became a hole');
		assert.equal(cmp.classes[0].name, 'marsh', 'sorted by target share');
	});

	test('area error is half the summed share difference — equal areas can still be all wrong', () => {
		const swapped = compare(u8(90, 20), u8(20, 90));
		assert.equal(swapped.areaError, 0, 'same area per class ...');
		assert.equal(swapped.agreement, 0, '... every pixel wrong');
		assert.equal(compare(u8(90, 90), u8(20, 20)).areaError, 1);
	});

	test('a class only the tile has gets no recall', () => {
		const c = compare(u8(90), u8(UNKNOWN_KIND)).classes.find((k) => k.code === UNKNOWN_KIND)!;
		assert.equal(c.recall, null);
		assert.equal(c.target, 0);
	});

	test('refuses rasters of different sizes', () => {
		assert.throws(() => compare(u8(1, 2), u8(1)), /size mismatch/);
	});
});

describe('majority', () => {
	test('takes the most frequent code of each block', () => {
		// 4×4 → 2×2
		const codes = u8(90, 90, 20, 20, 90, 20, 20, 20, 0, 0, 30, 30, 0, 30, 30, 30);
		assert.deepEqual([...majority(codes, 4, 2)], [90, 20, 0, 30]);
	});

	test('breaks ties towards the lowest code, so the scan order cannot matter', () => {
		assert.deepEqual([...majority(u8(90, 20, 20, 90), 2, 2)], [20]);
		assert.deepEqual([...majority(u8(0, 90, 90, 0), 2, 2)], [0]);
	});

	test('refuses a factor that does not divide the size', () => {
		assert.throws(() => majority(new Uint8Array(9), 3, 2), /not divisible/);
	});
});

describe('pixelsOfPGM', () => {
	const pgm = (header: string, pixels: number[]) => new Uint8Array([...Buffer.from(header, 'ascii'), ...pixels]);

	test('returns exactly the pixels, even when the first one is a forest pixel (0x0A)', () => {
		// a whitespace-splitting parser would take this 0x0A for the end of the header and drop it
		const file = pgm('P5\n2 2\n255\n', [10, 90, 20, 10]);
		assert.deepEqual([...pixelsOfPGM(file, 2)], [10, 90, 20, 10]);
	});

	test('refuses anything that is not a binary PGM of the expected size', () => {
		assert.throws(() => pixelsOfPGM(pgm('P2\n2 2\n255\n', [1, 2, 3, 4]), 2), /not a binary PGM/);
		assert.throws(() => pixelsOfPGM(pgm('P5\n', [1, 2]), 2), /too short/);
	});
});

describe('images', () => {
	test('colorize uses the analysis palette, and an unknown kind is black', () => {
		const img = colorize(u8(90, UNKNOWN_KIND, 0, 200), 2);
		assert.deepEqual([...img.data.subarray(0, 3)], PALETTE[90]);
		assert.deepEqual([...img.data.subarray(3, 6)], [0, 0, 0]);
		assert.deepEqual([...img.data.subarray(6, 9)], [255, 255, 255]);
		assert.deepEqual([...img.data.subarray(9, 12)], [0, 0, 0], 'a code without a colour falls back to unknown');
	});

	test('errorMap colours each kind of error', () => {
		const img = errorMap(u8(90, 90, 20, 0), u8(90, 20, 0, 90), 2);
		const px = (i: number) => [...img.data.subarray(i * 3, i * 3 + 3)];
		assert.deepEqual(px(0), ERROR_COLORS.right);
		assert.deepEqual(px(1), ERROR_COLORS.wrongKind);
		assert.deepEqual(px(2), ERROR_COLORS.gap);
		assert.deepEqual(px(3), ERROR_COLORS.overdraw);
	});

	test('resize is nearest-neighbour: no colour that no class has', () => {
		const img = resize({ width: 2, height: 1, data: u8(255, 0, 0, 0, 0, 255) }, 4);
		const colours = new Set<string>();
		for (let i = 0; i < img.data.length; i += 3) colours.add(img.data.subarray(i, i + 3).join(','));
		assert.deepEqual([...colours].sort(), ['0,0,255', '255,0,0']);
	});

	test('grid places equal panels with gutters, and refuses unequal ones', () => {
		const red = { width: 2, height: 2, data: new Uint8Array(12).fill(200) };
		const g = grid([red, red, red], 2, 1, 0);
		assert.equal(g.width, 2 * 2 + 3);
		assert.equal(g.height, 2 * 2 + 3);
		assert.equal(g.data[(1 * g.width + 1) * 3], 200, 'first panel starts after the gutter');
		assert.equal(g.data[0], 0, 'the gutter keeps the background');
		assert.throws(() => grid([red, { width: 1, height: 1, data: u8(0, 0, 0) }], 2), /differ/);
		assert.throws(() => grid([], 2), /no panels/);
	});
});

describe('geometry', () => {
	test('to3857 maps the corners of the Mercator square', () => {
		const [x0, y0] = to3857([0, 0]);
		assert.ok(
			Math.abs(x0) < 1e-6 && Math.abs(y0) < 1e-6,
			'the origin, to floating-point precision (ln(tan(π/4)) is -1e-16)',
		);
		assert.ok(Math.abs(to3857([180, 0])[0] - MERC) < 1e-6);
		assert.ok(Math.abs(to3857([0, 85.0511287798066])[1] - MERC) < 1e-3);
		assert.equal(to3857([0, 89])[1], to3857([0, 85.0511287798066])[1], 'beyond the limit it clamps');
	});

	test('tile bounds agree with the block grid and with their neighbours', () => {
		assert.deepEqual(tileBounds3857(0, 0, 0), blockWindow(0, 0, 0).inner3857);
		assert.equal(tileBounds3857(9, 129, 159).maxx, tileBounds3857(9, 130, 159).minx);
		assert.equal(tileBounds3857(9, 129, 159).miny, tileBounds3857(9, 129, 160).maxy);
	});
});

describe('bin/inspect.ts and bin/sweep.ts argument handling', () => {
	// only paths that exit before any GDAL work or build
	const run = (script: string, args: string[]) =>
		spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
			cwd: root,
			encoding: 'utf8',
		});

	test('inspect: --help, and a missing or malformed tile', () => {
		assert.equal(run('bin/inspect.ts', ['--help']).status, 0);
		assert.equal(run('bin/inspect.ts', []).status, 1);
		assert.match(run('bin/inspect.ts', ['9-129-159']).stderr, /expected z\/x\/y/);
		assert.match(run('bin/inspect.ts', ['2/5/0']).stderr, /does not exist/);
		assert.match(run('bin/inspect.ts', [`${MAXLEVEL + 1}/0/0`]).stderr, /above this config's MAXLEVEL/);
	});

	test('sweep: one knob at a time, and values each knob can take', () => {
		assert.match(
			run('bin/sweep.ts', ['--area', 'sahara', '--sieve', '1', '--detail', '2']).stderr,
			/one knob at a time/,
		);
		assert.match(
			run('bin/sweep.ts', ['--area', 'sahara', '--sieve=-1']).stderr,
			/bad --sieve "-1" — expected numbers ≥ 0/,
		);
		assert.match(run('bin/sweep.ts', ['--area', 'sahara', '--tile', '9-1-1']).stderr, /bad --tile/);
		assert.match(run('bin/sweep.ts', ['--area', 'atlantis']).stderr, /unknown area/);
	});
});
