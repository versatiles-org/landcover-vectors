// Sweep a parameter over one area and report what it costs in tile bytes.
//
//   npm run sweep -- --area hudson-bay --zoom 8-10 --detail 1,2,4
//
// This is the measurement Phase 6 of the plan turns on: raising DETAIL_PX keeps more boundary detail per
// tile, and the only question is whether the worst tile still fits in tippecanoe's 500 000 bytes. Each
// variant is a separate preview build (its own cache directory, because the tolerance is part of the
// fingerprint), measured with the same code `npm run stats` uses, and recorded in doc/size-baseline.json
// as "<area>@detail<value>" so the numbers survive the session.
//
// Guessing is not a substitute: vertex count against tolerance is only roughly 1/x, and
// --coalesce-smallest-as-needed absorbs part of it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveArea, parseZoomRange } from '../lib/areas.ts';
import { readTiles, summarise, budgetFlag, MVT_LIMIT, WARN_LIMIT, type ZoomStats } from '../lib/stats.ts';
import { datadir } from '../config.ts';

const { values: opt } = parseArgs({
	options: {
		area: { type: 'string' },
		zoom: { type: 'string' },
		detail: { type: 'string', default: '1,2,4' },
		help: { type: 'boolean', default: false },
	},
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'doc', 'size-baseline.json');

if (opt.help || !opt.area) {
	console.error(
		[
			'Usage: npm run sweep -- --area <name|w,s,e,n> [--zoom min-max] [--detail 1,2,4]',
			'',
			'Builds the area once per DETAIL_PX value and prints the tile-size cost of each.',
			'Each variant keeps its own cache, so a repeated sweep only rebuilds what is new.',
		].join('\n'),
	);
	process.exit(opt.help ? 0 : 1);
}

resolveArea(opt.area); // fail on a bad area before spending hours
const [minZoom, maxZoom] = parseZoomRange(opt.zoom);
const values = opt.detail.split(',').map((s) => {
	const v = Number(s.trim());
	if (!Number.isFinite(v) || v <= 0) throw new Error(`bad --detail "${s}" — expected positive numbers`);
	return v;
});

type Variant = { detail: number; fingerprint: string; tileset: string; zooms: ZoomStats[] };
const results: Variant[] = [];

for (const detail of values) {
	console.error('\n═══ DETAIL_PX = %s ═══', detail);
	const args = ['bin/preview.ts', '--build-only', '--area', opt.area, '--zoom', `${minZoom}-${maxZoom}`];
	const run = spawnSync(process.execPath, args, {
		cwd: root,
		stdio: ['ignore', 'inherit', 'inherit'],
		env: { ...process.env, LANDCOVER_DETAIL_PX: String(detail) },
	});
	if (run.status !== 0) throw new Error(`build failed for DETAIL_PX=${detail} (exit ${run.status})`);

	const built = JSON.parse(await fs.readFile(path.join(datadir, 'preview', 'last-build.json'), 'utf8')) as {
		fingerprint: string;
		tileset: string;
	};
	results.push({
		detail,
		fingerprint: built.fingerprint,
		tileset: built.tileset,
		zooms: summarise(readTiles(built.tileset)),
	});
}

// ---------------------------------------------------------------- report
const kb = (n: number) => (n / 1024).toFixed(1);
const flag = (bytes: number) => budgetFlag(bytes);
const zooms = [...new Set(results.flatMap((r) => r.zooms.map((z) => z.z)))].sort((a, b) => a - b);

console.error(
	'\n%s, z%d-%d — max KB per tile (! at or over %d bytes, !! at or over the %d-byte MVT limit)',
	opt.area,
	minZoom,
	maxZoom,
	WARN_LIMIT,
	MVT_LIMIT,
);
console.error(
	['  z', ...results.map((r) => `detail ${r.detail}`)].map((s, i) => (i ? s.padStart(12) : s.padStart(3))).join(' '),
);
for (const z of zooms) {
	const cells = results.map((r) => {
		const s = r.zooms.find((x) => x.z === z);
		return s ? kb(s.max) + flag(s.max) : '—';
	});
	console.error([String(z).padStart(3), ...cells.map((c) => c.padStart(12))].join(' '));
}

// the number that decides the sweep: the worst tile anywhere, and what it cost relative to the first variant
const worstOf = (v: Variant) => Math.max(...v.zooms.map((z) => z.max));
const first = worstOf(results[0]);
console.error('');
for (const r of results) {
	const worst = worstOf(r);
	console.error(
		'DETAIL_PX %s: worst tile %s KB (%s× the first variant), %s',
		String(r.detail).padEnd(3),
		kb(worst).padStart(7),
		(worst / first).toFixed(2),
		worst >= MVT_LIMIT ? '✗ over the MVT limit — features would be dropped' : 'within budget',
	);
}

// record every variant so a later session can compare without rebuilding
type Baseline = { entries: Record<string, unknown> };
const baseline: Baseline = await fs
	.readFile(BASELINE, 'utf8')
	.then((s) => JSON.parse(s) as Baseline)
	.catch(() => ({ entries: {} }) as Baseline);
for (const r of results) {
	baseline.entries[`${opt.area}@detail${r.detail}`] = {
		fingerprint: r.fingerprint, // the variant's real config fingerprint, so --baseline compare can name it
		input: path.relative(root, r.tileset),
		written: new Date().toISOString(),
		note: `sweep: DETAIL_PX=${r.detail}, area ${opt.area}, z${minZoom}-${maxZoom}`,
		zooms: r.zooms,
	};
}
await fs.writeFile(BASELINE, JSON.stringify(baseline, null, '\t') + '\n');
console.error('\nrecorded %d variant(s) in %s', results.length, path.relative(root, BASELINE));
