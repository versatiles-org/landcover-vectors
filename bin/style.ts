// Generate a QGIS vector-tiles style (.qml) for the generated tileset, colouring each
// Shortbread `kind` with its per-channel colour from config.ts (solid fill, no stroke).
//
// The output tileset has two sub-layers — `land` and `water_polygons` — so each channel
// emits one rule scoped to its layer and filtered on `kind`. Open data/landcover.mbtiles
// (or the .versatiles) in QGIS as a native "Vector Tiles" layer and apply landcover.qml.
//
// Run with: node bin/style.ts (or `npm run style`).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { qgisVectorTileStyle, styledChannels } from '../lib/style-qgis.ts';

const styled = styledChannels();

// the repo root, resolved from this file — not from datadir, which LANDCOVER_DATA_DIR can move away
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vtStyle = path.join(root, 'landcover.qml');
await fs.writeFile(vtStyle, qgisVectorTileStyle(styled));

console.error('Wrote %s (vector tiles) — %d kinds across land + water_polygons', vtStyle, styled.length);
