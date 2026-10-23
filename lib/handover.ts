// The handover between this container and OSM, as a VPL step for the merge.
//
// The landcover supplies each kind up to its channel's `maxZoom`, wall to wall. OSM's own features of the
// same kind would double-draw over it at those zooms (and OSM's coverage is the sparse one), so a correct
// merge drops them there: OSM keeps every other kind at every zoom, and takes over a landcover kind only
// above its cutoff. Generated from `channels`, so the merge can never disagree with what was built.
//
//   from_merged_vector [ from_container filename="osm.versatiles" | <osmFilter()>, from_container filename="landcover.versatiles" ]
//
// `vector_filter_features` exposes the tile's `zoom` to the expression from versatiles 4.15.0 on.

import { channels } from '../config.ts';

// the emitted kinds per layer, grouped by cutoff
function cutoffs(): { layer: string; maxZoom: number; kinds: string[] }[] {
	const groups = new Map<string, { layer: string; maxZoom: number; kinds: string[] }>();
	for (const c of channels) {
		if (!c.layer || !c.kind) continue;
		const key = `${c.layer}@${c.maxZoom}`;
		if (!groups.has(key)) groups.set(key, { layer: c.layer, maxZoom: c.maxZoom, kinds: [] });
		groups.get(key)!.kinds.push(c.kind);
	}
	return [...groups.values()].sort((a, b) => a.layer.localeCompare(b.layer) || a.maxZoom - b.maxZoom);
}

// CEL: true for an OSM feature that is kept — i.e. not a kind this container supplies at this zoom
export function osmKeepExpr(layer: string): string {
	const drop = cutoffs()
		.filter((g) => g.layer === layer)
		.map((g) => `zoom <= ${g.maxZoom} && kind in [${g.kinds.map((k) => `'${k}'`).join(', ')}]`);
	if (drop.length === 0) return 'true';
	return drop.length === 1 ? `!(${drop[0]})` : `!(${drop.map((d) => `(${d})`).join(' || ')})`;
}

// the VPL steps that remove OSM's copies of the landcover kinds, one per layer
export function osmFilter(): string {
	const layers = [...new Set(cutoffs().map((g) => g.layer))];
	return layers.map((l) => `vector_filter_features layer=["${l}"] expr="${osmKeepExpr(l)}"`).join(' | ');
}

// Older versatiles do not fail on `zoom`: 4.14.0 silently drops every feature of a filtered layer, at
// every zoom. So the merge refuses to run below this instead of shipping tiles without land cover.
export const MIN_VERSATILES = '4.15.0';

// "versatiles 5.4.0" (or a bare "5.4.0") → true when it is at least `min`
export function versionAtLeast(output: string, min: string): boolean {
	const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return false;
	const have = m.slice(1, 4).map(Number);
	const want = min.split('.').map(Number);
	for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
	return true;
}
