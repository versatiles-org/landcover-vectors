// How long every step and every external command takes, logged so a slow stage can be found from data rather
// than guessed. Download and build each append to `data/timings.jsonl`; `npm run timings` summarises it.
//
// One JSON object per line:
//   { kind: 'run',  run, t, what, cores, ...meta }                  a download or build started
//   { kind: 'span', run, t, path, ms, ok, block? }                  a named step finished (timed())
//   { kind: 'cmd',  run, t, path, cmd, ms, ok, par, block? }        an external command finished (lib/worldcover.ts)
// `path` is where it ran: the names of the enclosing steps, e.g. "build/z10/blocks/block/sieve". `block` is the
// block's id, carried along so the slowest commands can be traced to a place. `par` counts the commands running
// at the moment this one started: wall times measured under contention read differently from those alone.
//
// The enclosing steps travel with the async call chain (AsyncLocalStorage), so a command run deep inside a block
// knows its step without anything being passed down. Without startTimingLog nothing is written, so the tests and
// tools that do not log pay nothing.

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type Context = { path: string[]; block?: string };
const context = new AsyncLocalStorage<Context>();
let sink: string | null = null;
let run = '';
let running = 0; // external commands in flight right now

// start appending to `file` for this process; `what` names the run (download, build, preview)
export function startTimingLog(file: string, what: string, meta: Record<string, unknown> = {}): void {
	mkdirSync(path.dirname(file), { recursive: true });
	sink = file;
	run = `${what}-${new Date().toISOString()}`;
	write({ kind: 'run', what, ...meta });
}

// for the tests: stop logging
export function stopTimingLog(): void {
	sink = null;
}

function write(entry: Record<string, unknown>): void {
	if (!sink) return;
	appendFileSync(sink, JSON.stringify({ ...entry, run, t: new Date().toISOString() }) + '\n');
}

// Run `fn` as the named step `name` (nested inside the current one) and log how long it took, also when it
// fails. `block` tags this step and everything inside it with a block id.
export async function timed<T>(name: string, fn: () => Promise<T>, block?: string): Promise<T> {
	const parent = context.getStore();
	const ctx: Context = { path: [...(parent?.path ?? []), name], block: block ?? parent?.block };
	const t0 = performance.now();
	let ok = false;
	try {
		const result = await context.run(ctx, fn);
		ok = true;
		return result;
	} finally {
		write({ kind: 'span', path: ctx.path.join('/'), ms: Math.round(performance.now() - t0), ok, block: ctx.block });
	}
}

// Called by the command runners as a command starts; the returned function logs it when it ends. The command is
// named by its tool, and for `gdal` by its subcommand too ("gdal raster sieve"), which is what tells steps apart.
export function commandStarted(cmd: string, argv: string[]): (ok: boolean) => void {
	const ctx = context.getStore();
	const name = cmd === 'gdal' ? ['gdal', ...argv.slice(0, 2)].join(' ') : cmd;
	const par = running++;
	const t0 = performance.now();
	return (ok) => {
		running--;
		write({
			kind: 'cmd',
			path: ctx?.path.join('/') ?? '',
			cmd: name,
			ms: Math.round(performance.now() - t0),
			ok,
			par,
			block: ctx?.block,
		});
	};
}

// ---------------------------------------------------------------- reading the log back

export type Entry = {
	kind: 'run' | 'span' | 'cmd';
	run: string;
	t: string;
	path?: string;
	cmd?: string;
	ms?: number;
	ok?: boolean;
	par?: number;
	block?: string;
	what?: string;
};

export type Group = { key: string; n: number; ms: number; mean: number; p95: number; max: number; failed: number };

// parse a log, skipping lines that do not parse (a run killed mid-write leaves at most one)
export function parseLog(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as Entry);
		} catch {
			// a truncated last line
		}
	}
	return entries;
}

// The entries of one run: the last one by default, or the one whose id starts with `id`
export function runOf(entries: Entry[], id?: string): Entry[] {
	const runs = [...new Set(entries.map((e) => e.run))];
	const wanted = id ? runs.find((r) => r.startsWith(id)) : runs.at(-1);
	return wanted ? entries.filter((e) => e.run === wanted) : [];
}

// group timed entries by `key`, slowest total first
export function group(entries: Entry[], key: (e: Entry) => string): Group[] {
	const byKey = new Map<string, number[]>();
	const failed = new Map<string, number>();
	for (const e of entries) {
		if (e.ms === undefined) continue;
		const k = key(e);
		const list = byKey.get(k);
		if (list) list.push(e.ms);
		else byKey.set(k, [e.ms]);
		if (e.ok === false) failed.set(k, (failed.get(k) ?? 0) + 1);
	}
	return [...byKey.entries()]
		.map(([k, ms]) => {
			const sorted = ms.sort((a, b) => a - b);
			const total = sorted.reduce((s, v) => s + v, 0);
			return {
				key: k,
				n: sorted.length,
				ms: total,
				mean: total / sorted.length,
				p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
				max: sorted[sorted.length - 1],
				failed: failed.get(k) ?? 0,
			};
		})
		.sort((a, b) => b.ms - a.ms);
}

// a step path with the zoom folded out ("build/z10/blocks/block/sieve" → "build/z*/blocks/block/sieve"), so the
// same step across all zooms adds up to one row
export const anyZoom = (p: string): string => p.replace(/\/z\d+(?=\/|$)/g, '/z*');
