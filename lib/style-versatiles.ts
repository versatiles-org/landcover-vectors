// The real map, as users will see it: versatiles-style's own `colorful` style — its draw order, OSM's other
// kinds, labels and roads — with the land cover as a source of its own under OSM. bin/dev.ts and bin/preview.ts
// show it, the preview next to the debug style of lib/style-spec.ts, which colours the land cover for telling
// kinds apart.
//
// OSM paints over the land cover wherever it has data, and the land cover shows wherever OSM has none. Its tiles
// end at z10, and MapLibre overzooms a source past its maxzoom, so it stays under OSM at any zoom. This is the
// reference for versatiles-style (doc/LANDCOVER-INTEGRATION.md).

import { osm, type StyleSpecification } from '@versatiles/style';

import { filterKinds } from './style-qgis.ts';
import { channels, LAYER } from '../config.ts';

type LayerSpecification = StyleSpecification['layers'][number];
type FillOpacity = NonNullable<Extract<LayerSpecification, { type: 'fill' }>['paint']>['fill-opacity'];

// the stock style, i.e. OSM as it is drawn without this container, reading its vector tiles from `tiles`
export function versatilesStyle(tiles: string): StyleSpecification {
	const style = osm();
	// osm() points its vector source at tiles.versatiles.org, where the glyphs and sprites stay; the tiles are ours
	for (const source of Object.values(style.sources)) if (source.type === 'vector') source.url = tiles;
	return style;
}

// the land cover's opacity: opaque up to z12, where its overzoomed outlines grow coarse, then thinner up to z14,
// and 25 % above that, so land that OSM does not map keeps a hint of colour
export const FADE: FillOpacity = ['interpolate', ['linear'], ['zoom'], 12, 1, 14, 0.25];

// The land cover's fills: a copy of each stock fill that draws one of its kinds in OSM's tiles, with that fill's
// colour, reading those kinds from the `landcover` source from z0, and faded.
export function landcoverLayers(source = 'landcover'): LayerSpecification[] {
	return osm().layers.flatMap((l) => {
		if (l.type !== 'fill' || !l['source-layer']) return [];
		const fills = filterKinds(l.filter);
		const kinds = channels.flatMap((c) =>
			c.kind && c.osmLayer === l['source-layer'] && fills.includes(c.kind) ? [c.kind] : [],
		);
		if (kinds.length === 0) return [];
		const { minzoom: _, ...rest } = l;
		return [
			{
				...rest,
				id: `landcover-${l.id}`,
				source,
				'source-layer': LAYER,
				filter: ['in', ['get', 'kind'], ['literal', kinds]],
				paint: { ...l.paint, 'fill-opacity': FADE },
			} as typeof l,
		];
	});
}

// the stock style with the land cover under OSM: its fills go into versatiles-style's slot below all fills, right
// above the background and below `water-ocean` (the sea is a hole in the land cover) and everything else
export function stackedStyle(osmTiles: string, landcoverTiles: string): StyleSpecification {
	const style = versatilesStyle(osmTiles);
	style.sources.landcover = { type: 'vector', url: landcoverTiles };
	const at = style.layers.findIndex((l) => l.id === osm.slots.belowFills);
	if (at < 0) throw new Error(`versatiles-style has no ${osm.slots.belowFills} layer to put the land cover under`);
	style.layers.splice(at, 0, ...landcoverLayers());
	return style;
}
