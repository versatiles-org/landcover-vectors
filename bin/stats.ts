// Tile size statistics for a built tileset — the measurement side of a parameter change.
//
//   npm run stats                                  # per-zoom distribution of data/landcover.mbtiles
//   npm run stats -- --worst 10 --attribute        # the biggest tiles, and what fills them
//   npm run stats -- --area hudson-bay             # only the tiles of one area of interest
//   npm run stats -- --baseline write              # remember this run in doc/size-baseline.json
//   npm run stats -- --baseline compare            # diff against the remembered run
//
// Exits non-zero when a tile reaches tippecanoe's --maximum-tile-bytes, so it can gate a build: past
// that limit features are coalesced or dropped and the coverage silently loses detail.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { AREAS, resolveArea, parseZoomRange } from '../lib/areas.ts';
import {
	readTiles,
	summarise,
	largest,
	attributeTile,
	tileCenter,
	clampToMercator,
	MVT_LIMIT,
	WARN_LIMIT,
	budgetFlag,
	type ZoomStats,
} from '../lib/stats.ts';
import { commandExists } from '../lib/worldcover.ts';
import { cacheValues, fingerprint } from '../lib/fingerprint.ts';
import { datadir, file } from '../config.ts';

const { values: opt } = parseArgs({
	options: {
		input: { type: 'string' },
		area: { type: 'string' },
		worst: { type: 'string' },
		attribute: { type: 'boolean', default: false },
		warn: { type: 'string' }, // soft budget in bytes
		json: { type: 'boolean', default: false },
		baseline: { type: 'string' }, // write | compare
		label: { type: 'string' }, // baseline entry name (default: the area), e.g. "hudson-bay@detail2"
		note: { type: 'string' }, // recorded with a written baseline: where these numbers came from
		probe: { type: 'string' }, // build this area at the current config, then measure what came out
		zoom: { type: 'string' }, // zoom range for --probe
		areas: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'doc', 'size-baseline.json');

if (opt.help) {
	console.error(
		[
			'Usage: npm run stats -- [options]',
			'  --input <mbtiles>        tileset to measure (default: data/landcover.mbtiles)',
			'  --area <name|w,s,e,n>    restrict to an area of interest ("--areas" lists the presets)',
			'  --worst <n>              list the n largest tiles',
			'  --attribute              decode those tiles: features and vertices per layer/kind',
			`  --warn <bytes>           soft budget per tile (default ${WARN_LIMIT})`,
			'  --baseline write|compare remember this run, or diff against the remembered one',
			'  --label <name>           baseline entry name (default: the area), for comparing variants',
			'  --note <text>            recorded alongside a written baseline',
			'  --probe <name|w,s,e,n>   preview-build that area at the current config, then measure it',
			'  --zoom <min-max>         zoom range for --probe',
			'  --json                   machine-readable output',
		].join('\n'),
	);
	process.exit(0);
}

if (opt.areas) {
	for (const [name, a] of Object.entries(AREAS)) {
		const { west, south, east, north } = a.bbox;
		console.error('%s\t%s\t%s', name.padEnd(16), `${west},${south},${east},${north}`.padEnd(22), a.why);
	}
	process.exit(0);
}

// --probe: run the preview build for one area, then measure exactly what it produced. The preview
// reports where it landed, because the path carries the config fingerprint.
async function probeBuild(area: string): Promise<string> {
	resolveArea(area); // fail on a bad area before spending minutes on a build
	parseZoomRange(opt.zoom);
	const args = ['bin/preview.ts', '--build-only', `--area=${area}`, ...(opt.zoom ? ['--zoom', opt.zoom] : [])];
	console.error('$ node %s', args.join(' '));
	const r = spawnSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
	if (r.status !== 0) throw new Error(`probe build failed (exit ${r.status})`);
	const built = JSON.parse(await fs.readFile(path.join(datadir, 'preview', 'last-build.json'), 'utf8'));
	return built.tileset as string;
}

const input = opt.probe ? await probeBuild(opt.probe) : opt.input ? path.resolve(opt.input) : file.tiles;
const label = opt.label ?? opt.probe ?? opt.area ?? 'world';
// a probe tileset already covers only its area, so there is nothing left to filter
const bbox = opt.area && !opt.probe ? clampToMercator(resolveArea(opt.area)) : undefined;
const warnBytes = Number(opt.warn ?? WARN_LIMIT);
if (!Number.isInteger(warnBytes) || warnBytes <= 0)
	throw new Error(`bad --warn "${opt.warn}" — expected bytes, e.g. ${WARN_LIMIT}`);
const worstCount = Number(opt.worst ?? (opt.attribute ? 10 : 0));

// the same soft budget as the budget line, so the `!` marks and the count can never disagree
const flag = (bytes: number) => budgetFlag(bytes, warnBytes);

if (
	!(await fs.stat(input).then(
		() => true,
		() => false,
	))
) {
	throw new Error(`no tileset at ${input} — run "npm run build" first, or pass --input`);
}

const rows = readTiles(input, bbox);
if (rows.length === 0) throw new Error(`no tiles in ${input}${bbox ? ` inside ${label}` : ''}`);
const zooms = summarise(rows);
const fp = fingerprint(cacheValues());

const kb = (n: number) => (n / 1024).toFixed(1);
const total = zooms.reduce((s, z) => s + z.bytes, 0);
const worstOverall = zooms.reduce((a, b) => (b.max > a.max ? b : a));

if (opt.json) {
	console.log(JSON.stringify({ input, area: label, fingerprint: fp, zooms }, null, '\t'));
} else {
	console.error('%s — %s, %d tiles, %s MB (config %s)', input, label, rows.length, (total / 1048576).toFixed(1), fp);
	console.error('');
	console.error(
		['  z', 'tiles', 'avg KB', 'p50', 'p95', 'p99', 'max KB', 'total MB', 'worst tile'].map(pad).join(' '),
	);
	for (const z of zooms) {
		console.error(
			[
				String(z.z),
				String(z.tiles),
				kb(z.avg),
				kb(z.p50),
				kb(z.p95),
				kb(z.p99),
				kb(z.max) + flag(z.max),
				(z.bytes / 1048576).toFixed(1),
				`${z.worst.z}/${z.worst.x}/${z.worst.y}`,
			]
				.map(pad)
				.join(' '),
		);
	}
	console.error('');
	const w = worstOverall.worst;
	const c = tileCenter(w.z, w.x, w.y);
	console.error(
		'worst tile: %s KB at z%d %d/%d — lon %s lat %s (#%d/%s/%s in the preview viewer)',
		kb(w.bytes),
		w.z,
		w.x,
		w.y,
		c.lon.toFixed(2),
		c.lat.toFixed(2),
		w.z,
		c.lat.toFixed(4),
		c.lon.toFixed(4),
	);
	console.error(
		'budget: %d tile(s) at or over %d bytes (soft), %d at or over %d bytes (tippecanoe --maximum-tile-bytes)',
		rows.filter((r) => r.bytes >= warnBytes).length,
		warnBytes,
		rows.filter((r) => r.bytes >= MVT_LIMIT).length,
		MVT_LIMIT,
	);
}

function pad(s: string, i: number): string {
	return i === 0 ? s.padStart(3) : i === 8 ? s : s.padStart(9);
}

if (worstCount > 0) {
	const list = largest(rows, worstCount);
	const canDecode = opt.attribute && (await commandExists('tippecanoe-decode'));
	if (opt.attribute && !canDecode) console.error('\n(tippecanoe-decode not on PATH — skipping attribution)');
	console.error('\n%d largest tiles:', list.length);
	for (const t of list) {
		const c = tileCenter(t.z, t.x, t.y);
		console.error(
			'  %s KB  z%d %d/%d  lon %s lat %s',
			kb(t.bytes).padStart(7),
			t.z,
			t.x,
			t.y,
			c.lon.toFixed(2),
			c.lat.toFixed(2),
		);
		if (!canDecode) continue;
		for (const a of await attributeTile(input, t)) {
			console.error(
				'            %s %s: %d features, %d vertices (%s vertices/feature)',
				a.layer,
				a.kind,
				a.features,
				a.vertices,
				(a.vertices / a.features).toFixed(1),
			);
		}
	}
}

// ---------------------------------------------------------------- baseline
type Entry = { fingerprint: string; input: string; written: string; note?: string; zooms: ZoomStats[] };
type Baseline = { entries: Record<string, Entry> };

if (opt.baseline === 'write') {
	const baseline: Baseline = await fs
		.readFile(BASELINE, 'utf8')
		.then((s) => JSON.parse(s) as Baseline)
		.catch(() => ({ entries: {} }));
	baseline.entries[label] = {
		fingerprint: fp,
		input: path.relative(root, input),
		written: new Date().toISOString(),
		...(opt.note ? { note: opt.note } : {}),
		zooms,
	};
	await fs.mkdir(path.dirname(BASELINE), { recursive: true });
	await fs.writeFile(BASELINE, JSON.stringify(baseline, null, '\t') + '\n');
	console.error('\nbaseline "%s" written to %s', label, path.relative(root, BASELINE));
} else if (opt.baseline === 'compare') {
	const baseline = await fs
		.readFile(BASELINE, 'utf8')
		.then((s) => JSON.parse(s) as Baseline)
		.catch(() => null);
	const was = baseline?.entries[label];
	if (!was)
		throw new Error(`no baseline for "${label}" in ${path.relative(root, BASELINE)} — run --baseline write first`);
	console.error('\nvs baseline "%s" (%s, config %s → %s):', label, was.written.slice(0, 10), was.fingerprint, fp);
	if (was.note) console.error('  note: %s', was.note);
	const pct = (now: number, then: number) =>
		then === 0 ? '—' : `${now >= then ? '+' : ''}${(((now - then) / then) * 100).toFixed(0)}%`;
	console.error(
		['  z', 'tiles', 'p99 KB', 'Δp99', 'max KB', 'Δmax']
			.map((s, i) => (i === 0 ? s.padStart(3) : s.padStart(9)))
			.join(' '),
	);
	for (const z of zooms) {
		const old = was.zooms.find((o) => o.z === z.z);
		console.error(
			[
				String(z.z).padStart(3),
				String(z.tiles).padStart(9),
				kb(z.p99).padStart(9),
				(old ? pct(z.p99, old.p99) : 'new').padStart(9),
				(kb(z.max) + flag(z.max)).padStart(9),
				(old ? pct(z.max, old.max) : 'new').padStart(9),
			].join(' '),
		);
	}
}

const over = rows.filter((r) => r.bytes >= MVT_LIMIT);
if (over.length > 0) {
	console.error(
		'\n✗ %d tile(s) at or over %d bytes — tippecanoe drops or coalesces features there',
		over.length,
		MVT_LIMIT,
	);
	process.exit(1);
}
