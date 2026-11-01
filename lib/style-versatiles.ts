// The preview's second style: versatiles-style's own `colorful` map over the real merge, so the viewer can
// show what users will actually see — versatiles-style's draw order, OSM's other kinds, labels and roads —
// next to the debug style of lib/style-spec.ts, which colours the land cover for telling kinds apart.
//
// The tiles are the filtered merge (lib/handover.ts mergePipeline) that bin/preview.ts serves as `merged`.
// `features.landcover` is versatiles-style's switch for a merge with this container: it drops the zoom
// limits its land fills otherwise have, so the land cover draws from z0.

import { osm, type StyleSpecification } from '@versatiles/style';

// `landcover: false` is the stock style, i.e. OSM as it is drawn without this container (bin/dev.ts)
export function versatilesStyle(tiles: string, landcover = true): StyleSpecification {
	const style = osm({ features: { landcover } });
	// osm() points its vector source at tiles.versatiles.org, where the glyphs and sprites stay; the tiles are ours
	for (const source of Object.values(style.sources)) if (source.type === 'vector') source.url = tiles;
	return style;
}

// A test of another way to combine the two (bin/dev.ts): OSM as it is, over the land cover as a source of its own. That
// source ends at z10, and MapLibre overzooms a source past its maxzoom, so the land cover stays under OSM at any zoom.
// Its colours are versatiles-style's for the same kinds. `fade` thins it out at the zooms where its outlines grow coarse.
export function stackedStyle(osmTiles: string, landcoverTiles: string, fade = false): StyleSpecification {
	const style = versatilesStyle(osmTiles, false);
	const opacity = fade ? ['interpolate', ['linear'], ['zoom'], 12, 1, 15, 0.3] : 1;
	const under = versatilesStyle(osmTiles, true).layers.flatMap((l) =>
		l.type === 'fill' && (l['source-layer'] === 'land' || l['source-layer'] === 'water_polygons')
			? [
					{
						...l,
						id: `landcover-${l.id}`,
						source: 'landcover',
						minzoom: undefined,
						paint: { ...l.paint, 'fill-opacity': opacity },
					} as typeof l,
				]
			: [],
	);
	style.sources.landcover = { type: 'vector', url: landcoverTiles };
	const at = style.layers.findIndex((l) => l.id === 'water-ocean');
	if (at < 0) throw new Error('versatiles-style has no water-ocean layer to put the land cover under');
	style.layers.splice(at, 0, ...under);
	return style;
}
