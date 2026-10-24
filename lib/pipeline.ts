// Walk a block plan: process every block of a zoom, then tile that zoom.
//
// Extracted from bin/build.ts so the preview (bin/preview.ts) drives the *same* loop over a smaller
// plan — a preview that ran a different pipeline would prove nothing about the build. The directories
// are parameters, not config constants, so two runs can be in flight against different caches.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { pMap } from './worldcover.ts';
import { processBlock, type BlockFragments } from './block.ts';
import { tileZoom } from './assemble.ts';
import { timed } from './timing.ts';
import type { ZoomBlocks } from './plan.ts';
import type { Progress } from './progress.ts';

export type PipelineCtx = {
	src: string; // the EPSG:3857 source raster
	tmpdir: string; // per-block scratch (wiped by the caller)
	resultsdir: string; // cached per-block fragments
	tilesdir: string; // cached per-zoom tilesets
	logFile?: string; // per-block TSV log
	concurrency: number;
	bar?: Progress;
	label?: (z: number) => string; // progress label per zoom
};

// injectable for the tests: the real stages need GDAL, tippecanoe and a 23 GB raster
export type PipelineDeps = { processBlock: typeof processBlock; tileZoom: typeof tileZoom };
const realDeps: PipelineDeps = { processBlock, tileZoom };

// returns the per-zoom mbtiles, in plan order
export async function runZooms(plan: ZoomBlocks[], ctx: PipelineCtx, deps: PipelineDeps = realDeps): Promise<string[]> {
	const zMbtiles: string[] = [];

	for (const { z, blocks } of plan) {
		if (ctx.label) ctx.bar?.setLabel(ctx.label(z));

		// resume: a cached per-zoom tileset means the whole level is done — skip its blocks entirely
		const zMb = path.join(ctx.tilesdir, `z${z}.mbtiles`);
		if (existsSync(zMb)) {
			zMbtiles.push(zMb);
			ctx.bar?.tick(blocks.length);
			continue;
		}

		// the zoom's blocks, then its tiling, each a step of the timing log (lib/timing.ts)
		const mb = await timed(`z${z}`, () => runZoom(z, blocks, ctx, deps));
		if (mb) zMbtiles.push(mb);
	}

	return zMbtiles;
}

// one zoom: process its blocks, then tile them; returns the zoom's tileset, if it has one
async function runZoom(
	z: number,
	blocks: [number, number][],
	ctx: PipelineCtx,
	deps: PipelineDeps,
): Promise<string | null> {
	// collect by block index, not by completion order: this order is the order the fragments are
	// unioned in and handed to tippecanoe, so keeping it stable makes two runs of the same config
	// produce identical tiles
	const collected: (BlockFragments | null)[] = blocks.map(() => null);
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
					const f = await timed('block', block, `z${z}_${bx}_${by}`);
					if (f.land || f.water) collected[i] = f;
				} catch (err) {
					// one bad block must not discard the zoom's other few thousand: every finished block is
					// cached, so a rerun retries just the failures. processBlock already logged a `failed` row.
					failed.push({ id: `z${z}_${bx}_${by}`, err });
				}
				ctx.bar?.tick();
			},
		),
	);

	// a partial zoom must never be tiled — report every failure of this zoom at once and stop here
	if (failed.length) {
		const ids = failed.slice(0, 8).map((f) => f.id);
		throw new AggregateError(
			failed.map((f) => f.err),
			`zoom ${z}: ${failed.length} of ${blocks.length} blocks failed (${ids.join(', ')}` +
				`${failed.length > ids.length ? ', …' : ''})${ctx.logFile ? ` — see ${ctx.logFile}` : ''}; ` +
				`finished blocks are cached, so rerunning retries only the failures`,
		);
	}

	const fragments = collected.filter((f): f is BlockFragments => f !== null);
	return timed('tiling', () => deps.tileZoom(z, fragments, { tmp: ctx.tmpdir, tiles: ctx.tilesdir }));
}
