// Generate QGIS styles (.qml) that colour the landcover polygons by `kind`, using the
// per-channel colours from config.ts. Each kind is filled with its colour and the stroke
// is disabled (outline_style = no). Keyed on `kind`, which both outputs carry.
//
// Two files are written to the repo root, because QGIS styles a plain vector layer and a
// vector-tile layer with different renderers:
//   - landcover.qml      categorized renderer — for data/landcover.fgb (and the mbtiles
//                        when opened as an OGR/“MVT” vector layer)
//   - landcover-vt.qml   vector-tiles renderer — for data/landcover.mbtiles opened as a
//                        native “Vector Tiles” layer
//
// Run with: node bin/style.ts (or `npm run style`).

import fs from 'node:fs/promises';
import path from 'node:path';

import { channels, datadir, type Channel } from '../config.ts';

// "#RRGGBB" or "#RRGGBBAA" → QGIS "r,g,b,a" (alpha defaults to fully opaque)
function rgba(hex: string): string {
	const h = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
	return `${r},${g},${b},${a}`;
}

// a solid fill with no outline (stroke disabled), named `name`
function fillSymbol(name: string, color: string): string {
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

// channels that end up in the output: those with a kind and a colour (no-data is dropped)
const kinded = channels.filter((c): c is Channel & { kind: string; color: string } => Boolean(c.kind && c.color));

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

// QGIS "R,G,B,A,rgb:r,g,b,a" colour (0-255 ints plus 0-1 floats), the form QGIS writes
function qgisColor(hex: string): string {
	const h = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
	return `${r},${g},${b},${a},rgb:${r / 255},${g / 255},${b / 255},${a / 255}`;
}

// a SimpleFill in QGIS' modern <Option type="Map"> form: fill = color, stroke disabled
function mapFillSymbol(color: string): string {
	return `          <symbol alpha="1" is_animated="0" type="fill" clip_to_extent="1" force_rhr="0" name="0" frame_rate="10">
            <data_defined_properties>
              <Option type="Map">
                <Option value="" type="QString" name="name"/>
                <Option name="properties"/>
                <Option value="collection" type="QString" name="type"/>
              </Option>
            </data_defined_properties>
            <layer pass="0" class="SimpleFill" locked="0" enabled="1">
              <Option type="Map">
                <Option value="3x:0,0,0,0,0,0" type="QString" name="border_width_map_unit_scale"/>
                <Option value="${color}" type="QString" name="color"/>
                <Option value="bevel" type="QString" name="joinstyle"/>
                <Option value="0,0" type="QString" name="offset"/>
                <Option value="3x:0,0,0,0,0,0" type="QString" name="offset_map_unit_scale"/>
                <Option value="MM" type="QString" name="offset_unit"/>
                <Option value="0,0,0,0,rgb:0,0,0,0" type="QString" name="outline_color"/>
                <Option value="no" type="QString" name="outline_style"/>
                <Option value="0" type="QString" name="outline_width"/>
                <Option value="MM" type="QString" name="outline_width_unit"/>
                <Option value="solid" type="QString" name="style"/>
              </Option>
              <data_defined_properties>
                <Option type="Map">
                  <Option value="" type="QString" name="name"/>
                  <Option name="properties"/>
                  <Option value="collection" type="QString" name="type"/>
                </Option>
              </data_defined_properties>
            </layer>
          </symbol>`;
}

// 2. vector-tiles renderer (native mbtiles “Vector Tiles” layer): one fill style per kind,
// filtered on the `kind` attribute. Schema matches what QGIS 3.40 writes for such a layer.
const vectorTiles = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis minScale="1e+08" hasScaleBasedVisibilityFlag="0" styleCategories="AllStyleCategories" maxScale="0" version="3.40.3-Bratislava" autoRefreshTime="0" autoRefreshMode="Disabled">
  <flags>
    <Identifiable>1</Identifiable>
    <Removable>1</Removable>
    <Searchable>1</Searchable>
    <Private>0</Private>
  </flags>
  <customproperties>
    <Option/>
  </customproperties>
  <renderer type="basic">
    <styles>
${kinded
	.map(
		(
			c,
		) => `      <style geometry="2" min-zoom="-1" max-zoom="-1" layer="" enabled="1" name="${c.kind}" expression="&quot;kind&quot; = '${c.kind}'">
        <symbols>
${mapFillSymbol(qgisColor(c.color))}
        </symbols>
      </style>`,
	)
	.join('\n')}
    </styles>
  </renderer>
  <labeling labelsEnabled="1" type="basic">
    <styles/>
  </labeling>
  <blendMode>0</blendMode>
  <layerOpacity>1</layerOpacity>
</qgis>
`;

const root = path.dirname(datadir);
const fgbStyle = path.join(root, 'landcover.qml');
const vtStyle = path.join(root, 'landcover-vt.qml');
await fs.writeFile(fgbStyle, categorized);
await fs.writeFile(vtStyle, vectorTiles);

console.error('Wrote %s (vector / FGB) and %s (vector tiles / mbtiles) — %d kinds', fgbStyle, vtStyle, kinded.length);
