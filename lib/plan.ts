// Which blocks actually have work, per zoom.
//
// Shared by the full build (bin/build.ts) and the preview, so both walk exactly the same grid: the
// preview is only useful if it exercises the real pipeline. Determined up front so a progress total
// reflects real work rather than the mostly-empty ocean blocks — at z10 most of the grid is ocean.

import { MAXLEVEL, blocksPerAxis, blockWindow } from '../config.ts';
import type { Coverage, LonLat } from './coverage.ts';

export type ZoomBlocks = { z: number; blocks: [number, number][] };
export type PlanOpts = {
	minZoom?: number; // default 0
	maxZoom?: number; // default MAXLEVEL
	bbox?: LonLat; // keep only blocks overlapping this lon/lat rectangle (preview / probe runs)
};

// do two lon/lat rectangles overlap? (merely touching edges do not)
export function overlaps(a: LonLat, b: LonLat): boolean {
	return a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
}

// blocks are listed row-major (by, then bx) — a stable order, which is what keeps two runs of the
// same config producing identical tiles (bin/build.ts collects fragments by this index)
export function planBlocks(coverage: Coverage, opts: PlanOpts = {}): ZoomBlocks[] {
	const minZoom = Math.max(0, opts.minZoom ?? 0);
	const maxZoom = Math.min(MAXLEVEL, opts.maxZoom ?? MAXLEVEL);
	const plan: ZoomBlocks[] = [];
	for (let z = minZoom; z <= maxZoom; z++) {
		const n = blocksPerAxis(z);
		const blocks: [number, number][] = [];
		for (let by = 0; by < n; by++) {
			for (let bx = 0; bx < n; bx++) {
				const inner = blockWindow(z, bx, by).innerLonLat;
				if (coverage.isEmpty(inner)) continue; // no source data at all → nothing to produce
				if (opts.bbox && !overlaps(inner, opts.bbox)) continue;
				blocks.push([bx, by]);
			}
		}
		plan.push({ z, blocks });
	}
	return plan;
}

export const countBlocks = (plan: ZoomBlocks[]): number => plan.reduce((sum, p) => sum + p.blocks.length, 0);
