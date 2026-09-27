// The fingerprint is what stops a 55-core-hour cache from being silently reused after a parameter
// change, so it has to move for every value that changes the output — and stay put for the ones that
// do not (colours), or every restyle would trigger a rebuild.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	fingerprint,
	cacheValues,
	sourceValues,
	readStamp,
	writeStamp,
	stampMismatch,
	type Stamp,
} from '../lib/fingerprint.ts';
import { FULL_PX } from '../config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stampFor = (values: Record<string, unknown>): Stamp => ({
	fingerprint: fingerprint(values),
	written: '2026-01-01T00:00:00.000Z',
	values,
});

describe('fingerprint', () => {
	test('is stable and short', () => {
		assert.equal(fingerprint(cacheValues()), fingerprint(cacheValues()));
		assert.match(fingerprint(cacheValues()), /^[0-9a-f]{8}$/);
	});

	test('moves when any cached-output value changes', () => {
		const base = cacheValues();
		for (const key of Object.keys(base)) {
			const changed = { ...base, [key]: 'CHANGED' };
			assert.notEqual(fingerprint(changed), fingerprint(base), `${key} does not affect the fingerprint`);
		}
	});

	test('ignores colours and metadata, which do not affect the tiles', () => {
		const values = cacheValues();
		const json = JSON.stringify(values);
		assert.ok(!json.includes('#'), 'a colour leaked into the fingerprint');
		assert.ok(!/attribution|description/i.test(json), 'metadata leaked into the fingerprint');
	});

	test('each sweep override builds into its own cache, and the committed default stays put', () => {
		const fp = (env: Record<string, string>) =>
			spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					"import('./lib/fingerprint.ts').then((f) => console.log(f.fingerprint(f.cacheValues())))",
				],
				{ cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } },
			).stdout.trim();
		const base = fp({});
		const variants = (
			[
				{ LANDCOVER_DETAIL_PX: '2' },
				{ LANDCOVER_BLUR_RENDERED: '0.5' },
				{ LANDCOVER_SIEVE_RENDERED: '4' },
				{ LANDCOVER_SIEVE_RENDERED: '0' },
			] as Record<string, string>[]
		).map(fp);
		assert.equal(new Set([base, ...variants]).size, 5, 'every override must move the fingerprint');
	});

	test('the source stamp tracks the raster resolution', () => {
		assert.deepEqual(sourceValues(), { fullPx: FULL_PX });
		assert.notEqual(fingerprint({ fullPx: FULL_PX }), fingerprint({ fullPx: FULL_PX * 2 }));
	});
});

describe('stampMismatch', () => {
	const values = cacheValues();

	test('passes an identical stamp', () => {
		assert.equal(stampMismatch(stampFor(values), values), null);
	});

	test('names every changed key, old before new', () => {
		const report = stampMismatch(stampFor({ ...values, blurRadius: 4, tilePx: 2048 }), values);
		assert.ok(report);
		assert.match(report, /blurRadius: 4 → 3/);
		assert.match(report, /tilePx: 2048 → 1024/);
		assert.equal(report.split('\n').length, 2);
	});

	test('summarises long values instead of truncating them to look identical', () => {
		const short = { ...values, channels: (values.channels as unknown[]).slice(0, 3) };
		const report = stampMismatch(stampFor(short), values);
		assert.ok(report);
		assert.match(report, /channels: 3 entries, hash [0-9a-f]{8} → 12 entries, hash [0-9a-f]{8}/);
	});

	test('reports a key that is new or gone', () => {
		const { blurRadius: _dropped, ...without } = values as Record<string, unknown>;
		const report = stampMismatch(stampFor(without), values);
		assert.match(String(report), /blurRadius: \(absent\) → 3/);
	});

	test('does not trust a stamp whose fingerprint contradicts its values', () => {
		const tampered: Stamp = { ...stampFor(values), fingerprint: 'deadbeef' };
		assert.match(String(stampMismatch(tampered, values)), /deadbeef → [0-9a-f]{8}/);
	});

	test('falls back to the fingerprint when a stamp records no values', () => {
		assert.equal(stampMismatch({ fingerprint: fingerprint(values), written: 'x' }, values), null);
		assert.match(String(stampMismatch({ fingerprint: 'deadbeef', written: 'x' }, values)), /lists no values/);
	});
});

describe('stamp files', () => {
	test('round-trip through a directory, creating it if needed', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-stamp-'));
		try {
			const nested = path.join(dir, 'does', 'not', 'exist');
			assert.equal(await readStamp(nested), null, 'no stamp yet');

			const fp = await writeStamp(nested, cacheValues());
			const stamp = await readStamp(nested);
			assert.equal(stamp?.fingerprint, fp);
			assert.equal(stampMismatch(stamp!, cacheValues()), null);
			assert.ok(Date.parse(stamp!.written) > 0, 'written is a timestamp');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('unreadable or corrupt stamps read as absent, not as a crash', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-stamp-'));
		try {
			await fs.writeFile(path.join(dir, '.fingerprint'), 'not json{');
			assert.equal(await readStamp(dir), null);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
