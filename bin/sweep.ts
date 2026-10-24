// Sweep one parameter over one area and report what it costs in bytes and what it buys in quality.
//
//   npm run sweep -- --area hudson-bay --zoom 9 --sieve 0,1.77,4        # the raster stage: smallest patch kept
//   npm run sweep -- --area hudson-bay --zoom 8-10 --detail 1,2,4       # the vector stage: outline precision
//
// Each value is a separate preview build — its own cache directory, because every one of these knobs is
// part of the config fingerprint — measured with the same code `npm run stats` uses and recorded in
// doc/size-baseline.json as "<area>@<knob><value>". Then one reference tile (--tile, or the largest tile
// of the first variant) is compared against its target with `npm run inspect`, for every variant side by
// side, so size and quality come out of one run.
//
// Guessing is not a substitute: bytes against tolerance are far from 1/x (the Hudson Bay worst tile grew
// 1.56×, not 4×, at DETAIL_PX 4), and the sieve trades texture against speckle in ways only the numbers show.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveArea, parseZoomRange, areaSlug } from '../lib/areas.ts';
import { readTiles, summarise, largest, budgetFlag, MVT_LIMIT, WARN_LIMIT, type ZoomStats } from '../lib/stats.ts';
import { datadir } from '../config.ts';

// the knobs a sweep can turn, and the environment variable config.ts reads each one from
const KNOBS = {
	detail: {
		env: 'LANDCOVER_DETAIL_PX',
		zeroOk: false,
		what: 'DETAIL_PX — simplify tolerance, 1 px of a (256·x)-px tile',
	},
	sieve: { env: 'LANDCOVER_SIEVE_RENDERED', zeroOk: true, what: 'SIEVE_RENDERED — smallest patch kept, rendered px²' },
} as const;
type Knob = keyof typeof KNOBS;

const { values: opt } = parseArgs({
	options: {
		area: { type: 'string' },
		zoom: { type: 'string' },
		detail: { type: 'string' },
		sieve: { type: 'string' },
		tile: { type: 'string' }, // z/x/y to judge quality on
		'no-inspect': { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'doc', 'size-baseline.json');

if (opt.help || !opt.area) {
	console.error(
		[
			'Usage: npm run sweep -- --area <name|w,s,e,n> [--zoom min-max] (--detail | --sieve) <v1,v2,…>',
			'',
			...Object.entries(KNOBS).map(([k, v]) => `  --${k.padEnd(7)} ${v.what}`),
			'  --tile z/x/y     the tile to judge quality on (default: the largest tile of the first variant)',
			'  --no-inspect     sizes only',
			'',
			'One knob per sweep; the others come from config.ts or the environment.',
			'Without a knob, it sweeps --detail 1,2,4. Each variant keeps its own cache, so repeats are cheap.',
		].join('\n'),
	);
	process.exit(opt.help ? 0 : 1);
}

resolveArea(opt.area); // fail on a bad area before spending hours
const [minZoom, maxZoom] = parseZoomRange(opt.zoom);

const given = (Object.keys(KNOBS) as Knob[]).filter((k) => opt[k] !== undefined);
if (given.length > 1) throw new Error(`sweep one knob at a time — got ${given.map((k) => '--' + k).join(' and ')}`);
const knob: Knob = given[0] ?? 'detail';
const spec = opt[knob] ?? '1,2,4';
const values = spec.split(',').map((s) => {
	const v = Number(s.trim());
	const ok = Number.isFinite(v) && (KNOBS[knob].zeroOk ? v >= 0 : v > 0);
	if (!ok)
		throw new Error(`bad --${knob} "${s}" — expected ${KNOBS[knob].zeroOk ? 'numbers ≥ 0' : 'positive numbers'}`);
	return v;
});
if (opt.tile && !/^\d+\/\d+\/\d+$/.test(opt.tile)) throw new Error(`bad --tile "${opt.tile}" — expected z/x/y`);

type Variant = { value: number; fingerprint: string; tileset: string; zooms: ZoomStats[] };
const results: Variant[] = [];

for (const value of values) {
	console.error('\n═══ %s = %s ═══', KNOBS[knob].env, value);
	const args = ['bin/preview.ts', '--build-only', '--area', opt.area, '--zoom', `${minZoom}-${maxZoom}`];
	const run = spawnSync(process.execPath, args, {
		cwd: root,
		stdio: ['ignore', 'inherit', 'inherit'],
		env: { ...process.env, [KNOBS[knob].env]: String(value) },
	});
	if (run.status !== 0) throw new Error(`build failed for ${knob}=${value} (exit ${run.status})`);

	const built = JSON.parse(await fs.readFile(path.join(datadir, 'preview', 'last-build.json'), 'utf8')) as {
		fingerprint: string;
		tileset: string;
	};
	results.push({
		value,
		fingerprint: built.fingerprint,
		tileset: built.tileset,
		zooms: summarise(readTiles(built.tileset)),
	});
}

// ---------------------------------------------------------------- size report
const kb = (n: number) => (n / 1024).toFixed(1);
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
	['  z', ...results.map((r) => `${knob} ${r.value}`)].map((s, i) => (i ? s.padStart(12) : s.padStart(3))).join(' '),
);
for (const z of zooms) {
	const cells = results.map((r) => {
		const s = r.zooms.find((x) => x.z === z);
		return s ? kb(s.max) + budgetFlag(s.max) : '—';
	});
	console.error([String(z).padStart(3), ...cells.map((c) => c.padStart(12))].join(' '));
}

// the number that decides whether a variant fits: the worst tile anywhere, relative to the first variant
const worstOf = (v: Variant) => Math.max(...v.zooms.map((z) => z.max));
const first = worstOf(results[0]);
console.error('');
for (const r of results) {
	const worst = worstOf(r);
	console.error(
		'%s %s: worst tile %s KB (%s× the first variant), %s',
		knob,
		String(r.value).padEnd(5),
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
	baseline.entries[`${opt.area}@${knob}${r.value}`] = {
		fingerprint: r.fingerprint, // the variant's real config fingerprint, so --baseline compare can name it
		input: path.relative(root, r.tileset),
		written: new Date().toISOString(),
		note: `sweep: ${KNOBS[knob].env}=${r.value}, area ${opt.area}, z${minZoom}-${maxZoom}`,
		zooms: r.zooms,
	};
}
await fs.writeFile(BASELINE, JSON.stringify(baseline, null, '\t') + '\n');
console.error('\nrecorded %d variant(s) in %s', results.length, path.relative(root, BASELINE));

// ---------------------------------------------------------------- quality on one reference tile
if (!opt['no-inspect']) {
	const [t] = largest(readTiles(results[0].tileset), 1);
	const tile = opt.tile ?? `${t.z}/${t.x}/${t.y}`;
	const out = path.join(datadir, 'inspect', `sweep-${areaSlug(opt.area)}-${knob}-${tile.replaceAll('/', '_')}.png`);
	console.error(
		'\n═══ quality on %s (%s) ═══',
		tile,
		opt.tile ? 'as requested' : `the largest tile of ${knob} ${results[0].value}`,
	);
	const inspect = spawnSync(
		process.execPath,
		[
			'--disable-warning=ExperimentalWarning',
			'bin/inspect.ts',
			tile,
			...results.flatMap((r) => ['--input', r.tileset]),
			'--out',
			out,
		],
		{ cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
	);
	// sizes are recorded already, so a failed comparison is reported rather than fatal
	if (inspect.status !== 0) console.error('✗ inspect failed (exit %d) — the size results above stand', inspect.status);
}
