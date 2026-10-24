// The handover between this container and OSM, as VPL steps for the merge.
//
// The landcover supplies each kind up to its channel's `maxZoom`, wall to wall. OSM's own features of the
// same kind would double-draw over it at those zooms (and OSM's coverage is the sparse one), so a correct
// merge drops them there: OSM keeps every other kind at every zoom, and takes over a landcover kind only
// above its cutoff. A kind with `osmFrom` goes the other way — OSM maps it better — so from that zoom on
// the merge drops the landcover's copy instead and leaves OSM's alone. Generated from `channels`, so the
// merge can never disagree with what was built.
//
//   from_merged_vector [
//     from_container filename="osm.versatiles" | <osmFilter()>,
//     from_container filename="landcover.versatiles" | <landcoverFilter()>
//   ]
//
// `vector_filter_features` exposes the tile's `zoom` to the expression from versatiles 4.15.0 on.

import { channels, type Channel } from '../config.ts';

type Drop = { layer: string; zoom: number; kinds: string[] };

// the kinds per layer that a filter drops, grouped by the zoom `pick` returns (undefined = not dropped)
function drops(pick: (c: Channel) => number | undefined): Drop[] {
	const groups = new Map<string, Drop>();
	for (const c of channels) {
		const zoom = pick(c);
		if (!c.layer || !c.kind || zoom === undefined) continue;
		const key = `${c.layer}@${zoom}`;
		if (!groups.has(key)) groups.set(key, { layer: c.layer, zoom, kinds: [] });
		groups.get(key)!.kinds.push(c.kind);
	}
	return [...groups.values()].sort((a, b) => a.layer.localeCompare(b.layer) || a.zoom - b.zoom);
}

// OSM loses a kind up to the landcover's cutoff; the landcover loses a kind from its `osmFrom` on
const osmDrops = (): Drop[] => drops((c) => (c.osmFrom === undefined ? c.maxZoom : undefined));
const landcoverDrops = (): Drop[] => drops((c) => c.osmFrom);

// CEL: true for a feature that is kept — i.e. not one of `drop`'s kinds at a zoom `cmp` its zoom
function keepExpr(drop: Drop[], layer: string, cmp: '<=' | '>='): string {
	const terms = drop
		.filter((d) => d.layer === layer)
		.map((d) => `zoom ${cmp} ${d.zoom} && kind in [${d.kinds.map((k) => `'${k}'`).join(', ')}]`);
	if (terms.length === 0) return 'true';
	return terms.length === 1 ? `!(${terms[0]})` : `!(${terms.map((t) => `(${t})`).join(' || ')})`;
}

// one `vector_filter_features` step per layer that loses anything, joined into a VPL chain ('' = none)
function steps(drop: Drop[], cmp: '<=' | '>='): string {
	const layers = [...new Set(drop.map((d) => d.layer))];
	return layers.map((l) => `vector_filter_features layer=["${l}"] expr="${keepExpr(drop, l, cmp)}"`).join(' | ');
}

// which OSM features survive: not a kind this container supplies at this zoom
export const osmKeepExpr = (layer: string): string => keepExpr(osmDrops(), layer, '<=');
// which landcover features survive: not a kind OSM supplies at this zoom
export const landcoverKeepExpr = (layer: string): string => keepExpr(landcoverDrops(), layer, '>=');

// the VPL steps that remove OSM's copies of the landcover kinds
export const osmFilter = (): string => steps(osmDrops(), '<=');
// the VPL steps that remove the landcover's copies of the kinds OSM supplies
export const landcoverFilter = (): string => steps(landcoverDrops(), '>=');

// the whole merge as one VPL source: both containers (paths or URLs), each filtered — what `npm run merge`
// converts and what the preview serves for versatiles-style
export function mergePipeline(osm: string, landcover: string): string {
	const filtered = (filename: string, filter: string): string =>
		`from_container filename="${filename}"` + (filter ? ` | ${filter}` : '');
	return `from_merged_vector [ ${filtered(osm, osmFilter())}, ${filtered(landcover, landcoverFilter())} ]`;
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
