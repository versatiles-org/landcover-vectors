// Walk a block plan: process (and tile) every block of a zoom, then join the zoom's tiles, zoom by zoom.
//
// Extracted from bin/build.ts so the preview (bin/preview.ts) drives the *same* loop over a smaller
// plan — a preview that ran a different pipeline would prove nothing about the build. The directories
// are parameters, not config constants, so two runs can be in flight against different caches.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { pMap } from './worldcover.ts';
import { processBlock } from './block.ts';
import { joinTilesets } from './assemble.ts';
import { timed } from './timing.ts';
import type { ZoomBlocks } from './plan.ts';
import type { Progress } from './progress.ts';

export type PipelineCtx = {
	src: string; // the EPSG:3857 source raster
	seaShare?: string; // its sea-share pyramid (default: the downloaded one)
	tmpdir: string; // per-block scratch (wiped by the caller)
	resultsdir: string; // cached per-block tilesets
	tilesdir: string; // cached per-zoom tilesets
	logFile?: string; // per-block TSV log
	concurrency: number;
	bar?: Progress;
	label?: (z: number) => string; // progress label per zoom
};

// injectable for the tests: the real stages need GDAL, tippecanoe and a 23 GB raster
export type PipelineDeps = { processBlock: typeof processBlock; joinTilesets: typeof joinTilesets };
const realDeps: PipelineDeps = { processBlock, joinTilesets };

// returns the per-zoom tilesets, in plan order
export async function runZooms(plan: ZoomBlocks[], ctx: PipelineCtx, deps: PipelineDeps = realDeps): Promise<string[]> {
	const zooms: string[] = [];
	for (const { z, blocks } of plan) {
		if (ctx.label) ctx.bar?.setLabel(ctx.label(z));

		// resume: a zoom's tileset is joined only once all its blocks are done, so if it exists, skip them all
		const zMb = path.join(ctx.tilesdir, `z${z}.mbtiles`);
		if (existsSync(zMb)) {
			zooms.push(zMb);
			ctx.bar?.skip(blocks.length);
			continue;
		}

		// the zoom's blocks, then its join, each a step of the timing log (lib/timing.ts)
		if (await timed(`z${z}`, () => runZoom(z, blocks, zMb, ctx, deps))) zooms.push(zMb);
	}
	return zooms;
}

// One zoom: process its blocks, then join their tiles into `out` — a tileset of the whole zoom to watch and
// inspect while the build goes on, and the input of the final pack. False if the zoom has no tiles at all.
async function runZoom(
	z: number,
	blocks: [number, number][],
	out: string,
	ctx: PipelineCtx,
	deps: PipelineDeps,
): Promise<boolean> {
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
							seaShare: ctx.seaShare,
							tmpdir: ctx.tmpdir,
							resultsdir: ctx.resultsdir,
							logFile: ctx.logFile,
						});
					const { tileset, cached } = await timed('block', block, `z${z}_${bx}_${by}`);
					collected[i] = tileset;
					// a cached block took no time, and must not count towards the pace
					if (cached) ctx.bar?.skip();
					else ctx.bar?.tick();
				} catch (err) {
					// one bad block must not discard the zoom's other few thousand: every finished block is
					// cached, so a rerun retries just the failures. processBlock already logged a `failed` row.
					failed.push({ id: `z${z}_${bx}_${by}`, err });
					ctx.bar?.tick();
				}
			},
		),
	);

	// a partial zoom must never be joined — report every failure of this zoom at once and stop here
	if (failed.length) {
		const ids = failed.slice(0, 8).map((f) => f.id);
		throw new AggregateError(
			failed.map((f) => f.err),
			`zoom ${z}: ${failed.length} of ${blocks.length} blocks failed (${ids.join(', ')}` +
				`${failed.length > ids.length ? ', …' : ''})${ctx.logFile ? ` — see ${ctx.logFile}` : ''}; ` +
				`finished blocks are cached, so rerunning retries only the failures`,
		);
	}
	return timed('join', () => deps.joinTilesets(collected, out));
}
