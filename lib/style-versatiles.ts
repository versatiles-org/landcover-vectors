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
