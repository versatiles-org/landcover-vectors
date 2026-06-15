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

import { channels, datadir, type Channel } from '../config.ts';

// "#RRGGBB" or "#RRGGBBAA" → QGIS "R,G,B,A,rgb:r,g,b,a" (0-255 ints plus 0-1 floats)
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

// channels that end up in the output: those with a target layer, kind and colour (no-data is dropped)
type Styled = Channel & { layer: 'land' | 'water_polygons'; kind: string; color: string };
const kinded = channels.filter((c): c is Styled => Boolean(c.layer && c.kind && c.color));

// vector-tiles renderer (native mbtiles/versatiles "Vector Tiles" layer): one fill style per
// kind, scoped to its sub-layer and filtered on `kind`. Schema matches what QGIS 3.40 writes.
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
		) => `      <style geometry="2" min-zoom="-1" max-zoom="-1" layer="${c.layer}" enabled="1" name="${c.kind}" expression="&quot;kind&quot; = '${c.kind}'">
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
const vtStyle = path.join(root, 'landcover.qml');
await fs.writeFile(vtStyle, vectorTiles);

console.error('Wrote %s (vector tiles) — %d kinds across land + water_polygons', vtStyle, kinded.length);
