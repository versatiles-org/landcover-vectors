// Walk a block plan: process (and tile) every block of a zoom, zoom by zoom.
//
// Extracted from bin/build.ts so the preview (bin/preview.ts) drives the *same* loop over a smaller
// plan — a preview that ran a different pipeline would prove nothing about the build. The directories
// are parameters, not config constants, so two runs can be in flight against different caches.

import { pMap } from './worldcover.ts';
import { processBlock } from './block.ts';
import { timed } from './timing.ts';
import type { ZoomBlocks } from './plan.ts';
import type { Progress } from './progress.ts';

export type PipelineCtx = {
	src: string; // the EPSG:3857 source raster
	tmpdir: string; // per-block scratch (wiped by the caller)
	resultsdir: string; // cached per-block tilesets
	logFile?: string; // per-block TSV log
	concurrency: number;
	bar?: Progress;
	label?: (z: number) => string; // progress label per zoom
};

// injectable for the tests: the real stage needs GDAL, tippecanoe and a 23 GB raster
export type PipelineDeps = { processBlock: typeof processBlock };
const realDeps: PipelineDeps = { processBlock };

// returns every block's tileset, in plan order
export async function runZooms(plan: ZoomBlocks[], ctx: PipelineCtx, deps: PipelineDeps = realDeps): Promise<string[]> {
	const tilesets: string[] = [];
	for (const { z, blocks } of plan) {
		if (ctx.label) ctx.bar?.setLabel(ctx.label(z));
		// the zoom's blocks, a step of the timing log (lib/timing.ts)
		tilesets.push(...(await timed(`z${z}`, () => runZoom(z, blocks, ctx, deps))));
	}
	return tilesets;
}

// one zoom: process its blocks; returns their tilesets
async function runZoom(z: number, blocks: [number, number][], ctx: PipelineCtx, deps: PipelineDeps): Promise<string[]> {
	// collect by block index, not by completion order: this is the order the tiles are joined in, so keeping
	// it stable makes two runs of the same config produce identical tilesets
	const collected: string[] = blocks.map(() => '');
	const failed: { id: string; err: unknown }[] = [];
	await timed('blocks', () =>
		pMap(
			blocks.map((_, i) => i),
			ctx.concurrency,
			async (i) => {
				const [bx, by] = blocks[i];
				try {
					const block = () =>
						deps.processBlock(z, bx, by, {
							src: ctx.src,
							tmpdir: ctx.tmpdir,
							resultsdir: ctx.resultsdir,
							logFile: ctx.logFile,
						});
					collected[i] = await timed('block', block, `z${z}_${bx}_${by}`);
				} catch (err) {
					// one bad block must not discard the zoom's other few thousand: every finished block is
					// cached, so a rerun retries just the failures. processBlock already logged a `failed` row.
					failed.push({ id: `z${z}_${bx}_${by}`, err });
				}
				ctx.bar?.tick();
			},
		),
	);

	// a partial build must never be packed — report every failure of this zoom at once and stop here
	if (failed.length) {
		const ids = failed.slice(0, 8).map((f) => f.id);
		throw new AggregateError(
			failed.map((f) => f.err),
			`zoom ${z}: ${failed.length} of ${blocks.length} blocks failed (${ids.join(', ')}` +
				`${failed.length > ids.length ? ', …' : ''})${ctx.logFile ? ` — see ${ctx.logFile}` : ''}; ` +
				`finished blocks are cached, so rerunning retries only the failures`,
		);
	}
	return collected;
}
