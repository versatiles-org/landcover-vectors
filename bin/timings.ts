// Where the time went: summarise the timing log a download or build wrote (lib/timing.ts).
//
//   npm run timings                                      # the last run in data/timings.jsonl
//   npm run timings -- --runs                            # list the runs in the log
//   npm run timings -- --run build-2026-10-25            # one run, by the start of its id
//   npm run timings -- --zooms                           # keep the zooms apart instead of adding them up
//   npm run timings -- --input data/preview/<fp>/timings.jsonl   # a preview's log
//
// Three tables: the named steps, the external commands per step, and the slowest single commands with the
// block (or sea-share tile) they ran for. Times are wall times; `par` is how many commands ran at once on
// average when these started, which is what to keep in mind when comparing them.

import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { parseLog, runOf, group, anyZoom, type Entry, type Group } from '../lib/timing.ts';
import { fmtTime } from '../lib/progress.ts';
import { file } from '../config.ts';

const { values: opt } = parseArgs({
	options: {
		input: { type: 'string' },
		run: { type: 'string' },
		runs: { type: 'boolean', default: false },
		zooms: { type: 'boolean', default: false },
		top: { type: 'string', default: '10' },
		help: { type: 'boolean', default: false },
	},
});

if (opt.help) {
	console.error(
		[
			'Usage: npm run timings -- [--input <timings.jsonl>] [--run <id prefix> | --runs] [--zooms] [--top <n>]',
			'',
			`  --input <file>   the log to read (default ${file.timings})`,
			'  --run <prefix>   the run whose id starts with this (default: the last one)',
			'  --runs           list the runs in the log and exit',
			'  --zooms          keep zooms apart (build/z7/…, build/z8/…) instead of adding them up',
			'  --top <n>        how many of the slowest single commands to list (default 10)',
		].join('\n'),
	);
	process.exit(0);
}

const input = opt.input ?? file.timings;
const text = await fs.readFile(input, 'utf8').catch(() => null);
if (text === null) throw new Error(`no timing log at ${input} — run "npm run download" or "npm run build" first`);
const entries = parseLog(text);

const dur = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : fmtTime(ms / 1000));

if (opt.runs) {
	for (const id of [...new Set(entries.map((e) => e.run))]) {
		const rows = entries.filter((e) => e.run === id);
		const top = rows.filter((e) => e.kind === 'span' && !e.path?.includes('/'));
		const spent = top.reduce((s, e) => s + (e.ms ?? 0), 0);
		console.log(`${id}  ${rows.length} entries, ${dur(spent)} in top-level steps`);
	}
	process.exit(0);
}

const rows = runOf(entries, opt.run);
if (rows.length === 0) throw new Error(`no run ${opt.run ? `starting with "${opt.run}" ` : ''}in ${input}`);
const head = rows.find((e) => e.kind === 'run') as (Entry & Record<string, unknown>) | undefined;
const where = (p = '') => (opt.zooms ? p : anyZoom(p)) || '(outside any step)';

console.log(
	`${rows[0].run}${head ? '  ' + JSON.stringify(Object.fromEntries(Object.entries(head).filter(([k]) => !['kind', 'run', 't', 'what'].includes(k)))) : ''}`,
);

function table(title: string, groups: Group[], extra?: (g: Group) => string): void {
	if (groups.length === 0) return;
	const width = Math.max(...groups.map((g) => g.key.length), 4);
	console.log(`\n${title}`);
	console.log(
		`  ${'step'.padEnd(width)} ${'n'.padStart(7)} ${'total'.padStart(9)} ${'mean'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)}` +
			(extra ? '    par' : ''),
	);
	for (const g of groups)
		console.log(
			`  ${g.key.padEnd(width)} ${String(g.n).padStart(7)} ${dur(g.ms).padStart(9)} ${dur(g.mean).padStart(9)} ` +
				`${dur(g.p95).padStart(9)} ${dur(g.max).padStart(9)}` +
				(extra ? extra(g) : '') +
				(g.failed ? `  (${g.failed} failed)` : ''),
		);
}

const spans = rows.filter((e) => e.kind === 'span');
const cmds = rows.filter((e) => e.kind === 'cmd');
table(
	'Steps (summed wall time; parallel steps add up to more than the clock)',
	group(spans, (e) => where(e.path)),
);

const cmdKey = (e: Entry) => `${where(e.path)}  ${e.cmd}`;
const meanPar = new Map<string, number>();
for (const [k, list] of Map.groupBy(cmds, cmdKey))
	meanPar.set(k, list.reduce((s, e) => s + (e.par ?? 0), 0) / list.length);
table('Commands', group(cmds, cmdKey), (g) => (meanPar.get(g.key) ?? 0).toFixed(1).padStart(7));

const top = [...cmds].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, Number(opt.top));
if (top.length) {
	console.log(`\nSlowest commands`);
	for (const e of top)
		console.log(
			`  ${dur(e.ms ?? 0).padStart(9)}  ${(e.block ?? '').padEnd(12)} ${e.path}  ${e.cmd}${e.ok === false ? '  (failed)' : ''}`,
		);
}
