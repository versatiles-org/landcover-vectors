// The preview's debug style (the other one, the real map, is lib/style-versatiles.ts), generated from the
// same `channels` table as the tiles and the QGIS style — so what the browser shows is what the pipeline
// produced, and a recoloured channel needs no second edit anywhere.
//
// Mounting the real OSM Shortbread container alongside stacks OSM's own fills of the same kinds on top, at every
// zoom, as a real map draws them (lib/style-versatiles.ts): where OSM maps a kind, the land cover under it should
// mostly agree. The landcover layers carry no zoom limits, so a kind that keeps drawing past its `maxZoom` is a
// bug you can see rather than infer.

import { channels, LAYER, MAXLEVEL, type Channel } from '../config.ts';

export type StyleOpts = {
	tiles: string; // URL of the landcover TileJSON
	osm?: string; // URL of an OSM Shortbread TileJSON, if one is mounted
	fingerprint?: string; // shown in the viewer header, and used to bust tile caches
};

// a layer's id encodes source and kind, which is what the legend toggles on
export const layerId = (source: 'landcover' | 'osm', c: Channel): string => `${source}-${c.kind}`;

const OCEAN = '#a8cfe0'; // the hole the landcover deliberately leaves for Shortbread's ocean layer

export type StyleLayer = Record<string, unknown> & { id: string };

export function maplibreStyle(opts: StyleOpts): Record<string, unknown> {
	const kinded = channels.filter((c) => c.kind && c.osmLayer && c.color);
	const sources: Record<string, unknown> = { landcover: { type: 'vector', url: opts.tiles } };
	if (opts.osm) sources.osm = { type: 'vector', url: opts.osm };

	// OSM has each kind in its Shortbread layer
	const fill = (source: 'landcover' | 'osm', c: Channel): StyleLayer => ({
		id: layerId(source, c),
		type: 'fill',
		source,
		'source-layer': source === 'landcover' ? LAYER : (c.osmLayer as string),
		filter: ['==', ['get', 'kind'], c.kind],
		paint: { 'fill-color': c.color as string, 'fill-antialias': false },
		metadata: { kind: c.kind, maxZoom: c.maxZoom, source },
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

	// the landcover itself, then OSM's own land/water on top
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
			'landcover:kinds': kinded.map((c) => ({ kind: c.kind, color: c.color, maxZoom: c.maxZoom })),
		},
	};
}
