// The real map, as users will see it: versatiles-style's own `colorful` style — its draw order, OSM's other
// kinds, labels and roads — with the land cover as a source of its own under OSM. bin/dev.ts and bin/preview.ts
// show it, the preview next to the debug style of lib/style-spec.ts, which colours the land cover for telling
// kinds apart.
//
// OSM paints over the land cover wherever it has data, and the land cover shows wherever OSM has none. Its tiles
// end at z10, and MapLibre overzooms a source past its maxzoom, so it stays under OSM at any zoom. versatiles-style
// draws it with `features.landcover` from v8 on; this only points the style at the tiles this repo serves.

import { osm, type StyleSpecification } from '@versatiles/style';

import { LAYER } from '../config.ts';

type LayerSpecification = StyleSpecification['layers'][number];

// whether a layer draws the land cover: OSM's tiles have no layer of that name
export const isLandcover = (l: LayerSpecification): boolean => 'source-layer' in l && l['source-layer'] === LAYER;

// osm() points its vector sources at tiles.versatiles.org, where the glyphs and sprites stay; the tiles are ours
function serve(style: StyleSpecification, osmTiles: string, landcoverTiles = osmTiles): StyleSpecification {
	const landcover = new Set(style.layers.flatMap((l) => (isLandcover(l) && 'source' in l ? [l.source] : [])));
	for (const [id, source] of Object.entries(style.sources))
		if (source.type === 'vector') source.url = landcover.has(id) ? landcoverTiles : osmTiles;
	return style;
}

// the stock style, i.e. OSM as it is drawn without this container, reading its vector tiles from `tiles`
export function versatilesStyle(tiles: string): StyleSpecification {
	return serve(osm(), tiles);
}

// the stock style with the land cover under OSM: its fills go into versatiles-style's slot below all fills, right
// above the background and below `water-ocean` (the sea is a hole in the land cover) and everything else
export function stackedStyle(osmTiles: string, landcoverTiles: string): StyleSpecification {
	return serve(osm({ features: { landcover: true } }), osmTiles, landcoverTiles);
}

// The land cover's fills: a copy of each stock fill that draws one of its kinds in OSM's tiles, with that fill's
// colour, reading those kinds from the land cover's source from z0, and faded.
export function landcoverLayers(): LayerSpecification[] {
	return stackedStyle('', '').layers.filter(isLandcover);
}
