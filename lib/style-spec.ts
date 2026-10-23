// MapLibre style for the preview, generated from the same `channels` table as the tiles and the QGIS
// style — so what the browser shows is what the pipeline produced, and a recoloured channel needs no
// second edit anywhere.
//
// The interesting thing to look at is the handover: each kind stops at its `maxZoom` and OSM takes over
// above it. Mounting the real OSM Shortbread container alongside makes that visible. The OSM fills start
// above the cutoff, exactly like the merge drops them below it (lib/handover.ts), so the viewer shows the
// merged result; the landcover layers carry no zoom limits, so a kind that keeps drawing past its cutoff
// is a bug you can see rather than infer.

import { channels, MAXLEVEL, type Channel } from '../config.ts';

export type StyleOpts = {
	tiles: string; // URL of the landcover TileJSON
	osm?: string; // URL of an OSM Shortbread TileJSON, if one is mounted
	fingerprint?: string; // shown in the viewer header, and used to bust tile caches
};

// a landcover layer's id encodes source, layer and kind, which is what the legend toggles on
export const layerId = (source: 'landcover' | 'osm', c: Channel): string => `${source}-${c.layer}-${c.kind}`;

const OCEAN = '#a8cfe0'; // the hole the landcover deliberately leaves for Shortbread's ocean layer

export type StyleLayer = Record<string, unknown> & { id: string };

export function maplibreStyle(opts: StyleOpts): Record<string, unknown> {
	const kinded = channels.filter((c) => c.layer && c.kind && c.color);
	const sources: Record<string, unknown> = { landcover: { type: 'vector', url: opts.tiles } };
	if (opts.osm) sources.osm = { type: 'vector', url: opts.osm };

	const fill = (source: 'landcover' | 'osm', c: Channel): StyleLayer => ({
		id: layerId(source, c),
		// OSM's copy of a kind only above the landcover's cutoff — what the merge keeps
		...(source === 'osm' ? { minzoom: c.maxZoom + 1 } : {}),
		type: 'fill',
		source,
		'source-layer': c.layer as string,
		filter: ['==', ['get', 'kind'], c.kind],
		paint: { 'fill-color': c.color as string, 'fill-antialias': false },
		metadata: { kind: c.kind, layer: c.layer, maxZoom: c.maxZoom, source },
	});

	const layers: StyleLayer[] = [{ id: 'background', type: 'background', paint: { 'background-color': '#f6f4f0' } }];

	// OSM's ocean first: the landcover's no-data areas are meant to be holes, and a distinct ocean
	// colour under them shows immediately whether they line up
	if (opts.osm) {
		layers.push({
			id: 'osm-ocean',
			type: 'fill',
			source: 'osm',
			'source-layer': 'ocean',
			paint: { 'fill-color': OCEAN, 'fill-antialias': false },
			metadata: { group: 'ocean' },
		});
	}

	// the landcover itself, then OSM's own land/water on top from each cutoff up, so the handover reads as a takeover
	for (const c of kinded) layers.push(fill('landcover', c));
	if (opts.osm) {
		for (const c of kinded) layers.push(fill('osm', c));
		layers.push({
			id: 'osm-boundaries',
			type: 'line',
			source: 'osm',
			'source-layer': 'boundaries',
			paint: { 'line-color': '#9a86a8', 'line-width': 0.8, 'line-dasharray': [3, 2] },
			metadata: { group: 'boundaries' },
		});
	}

	return {
		version: 8,
		name: 'landcover preview',
		// no glyphs are served here, so the style deliberately carries no symbol layers
		sources,
		layers,
		metadata: {
			'landcover:fingerprint': opts.fingerprint ?? null,
			'landcover:maxLevel': MAXLEVEL,
			'landcover:kinds': kinded.map((c) => ({ kind: c.kind, layer: c.layer, color: c.color, maxZoom: c.maxZoom })),
		},
	};
}
