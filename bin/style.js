// Generate QGIS styles (.qml) that colour the landcover polygons by `kind`, using the
// per-channel colours from config.js. Each kind is filled with its colour and the stroke
// is disabled (outline_style = no). Keyed on `kind`, which both outputs carry.
//
// Two files are written to the repo root, because QGIS styles a plain vector layer and a
// vector-tile layer with different renderers:
//   - landcover.qml      categorized renderer — for data/landcover.fgb (and the mbtiles
//                        when opened as an OGR/“MVT” vector layer)
//   - landcover-vt.qml   vector-tiles renderer — for data/landcover.mbtiles opened as a
//                        native “Vector Tiles” layer
//
// Run with: node bin/style.js (or `npm run style`).

import fs from 'node:fs/promises';
import path from 'node:path';

import { channels, datadir } from '../config.js';

// "#RRGGBB" or "#RRGGBBAA" → QGIS "r,g,b,a" (alpha defaults to fully opaque)
function rgba(hex) {
	const h = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
	return `${r},${g},${b},${a}`;
}

// a solid fill with no outline (stroke disabled), named `name`
function fillSymbol(name, color) {
	return `    <symbol type="fill" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0">
      <layer class="SimpleFill" enabled="1" locked="0" pass="0">
        <prop k="color" v="${color}"/>
        <prop k="style" v="solid"/>
        <prop k="outline_style" v="no"/>
        <prop k="outline_color" v="0,0,0,0"/>
        <prop k="outline_width" v="0"/>
        <prop k="outline_width_unit" v="MM"/>
        <prop k="border_width_map_unit_scale" v="3x:0,0,0,0,0,0"/>
        <prop k="joinstyle" v="bevel"/>
        <prop k="offset" v="0,0"/>
        <prop k="offset_unit" v="MM"/>
        <prop k="offset_map_unit_scale" v="3x:0,0,0,0,0,0"/>
      </layer>
    </symbol>`;
}

// channels that end up in the output: those with a kind (the no-data channel is dropped)
const kinded = channels.filter((c) => c.kind && c.color);

// 1. categorized renderer (plain vector layer: the FGB)
const categorized = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="categorizedSymbol" attr="kind" forceraster="0" enableorderby="0" symbollevels="0" referencescale="-1">
    <categories>
${kinded.map((c, i) => `      <category render="true" value="${c.kind}" symbol="${i}" label="${c.kind}" type="QString"/>`).join('\n')}
    </categories>
    <symbols>
${kinded.map((c, i) => fillSymbol(String(i), rgba(c.color))).join('\n')}
    </symbols>
    <rotation/>
    <sizescale/>
  </renderer-v2>
  <blendMode>0</blendMode>
  <featureBlendMode>0</featureBlendMode>
  <layerGeometryType>2</layerGeometryType>
</qgis>
`;

// 2. vector-tiles renderer (native mbtiles “Vector Tiles” layer): one fill rule per kind
const vectorTiles = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34" styleCategories="Symbology">
  <renderer-v2 type="vectortilebasic">
    <rules>
${kinded
	.map(
		(
			c,
		) => `    <rule geometry="2" enabled="1" name="${c.kind}" filter="&quot;kind&quot; = '${c.kind}'" min-zoom="-1" max-zoom="-1">
${fillSymbol('0', rgba(c.color))}
    </rule>`,
	)
	.join('\n')}
    </rules>
  </renderer-v2>
</qgis>
`;

const root = path.dirname(datadir);
const fgbStyle = path.join(root, 'landcover.qml');
const vtStyle = path.join(root, 'landcover-vt.qml');
await fs.writeFile(fgbStyle, categorized);
await fs.writeFile(vtStyle, vectorTiles);

console.error('Wrote %s (vector / FGB) and %s (vector tiles / mbtiles) — %d kinds', fgbStyle, vtStyle, kinded.length);
