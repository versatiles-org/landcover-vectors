// Turn the per-block TSV log into the tally a finished build prints: which branch every block took, and
// what each zoom cost in CPU. This used to be an ad-hoc awk one-liner over data/blocks.log, which meant
// nobody looked — and the `uniform` fast path silently never firing is exactly the kind of thing the
// numbers show and prose does not.

import fs from 'node:fs/promises';

import { LOG_HEADER } from './block.ts';

export type ZoomSummary = { z: number; blocks: number; ms: number; branches: Record<string, number> };
export type LogSummary = { zooms: ZoomSummary[]; blocks: number; ms: number; branches: Record<string, number> };

// Only the rows of the most recent run: bin/build.ts appends the header once per run, so the last header
// marks where this run started. Rows that do not parse are skipped rather than breaking the summary.
export function summariseLog(text: string): LogSummary {
	const lines = text.split('\n');
	const start = lines.lastIndexOf(LOG_HEADER) + 1; // 0 if there is no header at all
	const byZoom = new Map<number, ZoomSummary>();
	const branches: Record<string, number> = {};
	let blocks = 0;
	let ms = 0;

	for (const line of lines.slice(start)) {
		const col = line.split('\t');
		if (col.length < 4) continue;
		const z = Number(/^z(\d+)_/.exec(col[1])?.[1]);
		const branch = col[2];
		const rowMs = Number(col[3]);
		if (!Number.isInteger(z) || !branch || !Number.isFinite(rowMs)) continue;

		const zoom = byZoom.get(z) ?? { z, blocks: 0, ms: 0, branches: {} };
		zoom.blocks += 1;
		zoom.ms += rowMs;
		zoom.branches[branch] = (zoom.branches[branch] ?? 0) + 1;
		byZoom.set(z, zoom);
		branches[branch] = (branches[branch] ?? 0) + 1;
		blocks += 1;
		ms += rowMs;
	}

	return { zooms: [...byZoom.values()].sort((a, b) => a.z - b.z), blocks, ms, branches };
}

export async function readRunSummary(logFile: string): Promise<LogSummary | null> {
	const text = await fs.readFile(logFile, 'utf8').catch(() => null);
	if (text === null) return null;
	const summary = summariseLog(text);
	return summary.blocks > 0 ? summary : null;
}

const hours = (ms: number) => (ms / 3_600_000).toFixed(2);
const tally = (branches: Record<string, number>) =>
	Object.entries(branches)
		.sort((a, b) => b[1] - a[1])
		.map(([branch, n]) => `${branch} ${n}`)
		.join(', ');

// one line per zoom, plus the totals. `core-h` is summed per-block time, so it exceeds the wall clock:
// that ratio is how much the block-level parallelism actually bought.
export function formatSummary(summary: LogSummary, wallMs?: number): string {
	const rows = summary.zooms.map(
		(z) =>
			`  ${String(z.z).padStart(3)} ${String(z.blocks).padStart(8)} ${hours(z.ms).padStart(8)}  ${tally(z.branches)}`,
	);
	const total =
		`total ${summary.blocks} blocks, ${hours(summary.ms)} core-h` +
		(wallMs === undefined ? '' : `, ${hours(wallMs)} h wall (×${(summary.ms / wallMs).toFixed(1)} parallel)`);
	return [
		'Blocks processed this run (a zoom restored from cache contributes none):',
		`  ${'z'.padStart(3)} ${'blocks'.padStart(8)} ${'core-h'.padStart(8)}  branches`,
		...rows,
		`  ${tally(summary.branches)}`,
		`  ${total}`,
	].join('\n');
}
