// Merge the per-tile polygon geometry into one file for the tile step.
//
// The per-tile FlatGeobuf from the polygonize step are already downsampled, sieved
// and coverage-simplified, so this just concatenates them into data/landcover.fgb via
// an OGR VRT union (which handles thousands of inputs without hitting command-line
// length limits). Simplification is done per tile, not here, because a global
// coverage simplify needs the whole dataset in RAM and OOMs on large extents.
//
// Requires GDAL (ogr2ogr) on PATH.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { dir, file } from '../config.js';

const fgbs = (await fs.readdir(dir.work).catch(() => [])).filter((f) => f.endsWith('.fgb') && !f.startsWith('_'));
if (fgbs.length === 0) throw new Error(`no per-tile geometry in ${dir.work} — run "npm run polygonize" first`);

// merge the per-tile geometry via an OGR VRT union
const vrtPath = path.join(dir.work, '_merged.vrt');
const vrtXml =
	`<OGRVRTDataSource>\n\t<OGRVRTUnionLayer name="landcover">\n` +
	fgbs
		.map(
			(f) =>
				`\t\t<OGRVRTLayer name="landcover"><SrcDataSource>${path.join(dir.work, f)}</SrcDataSource></OGRVRTLayer>`,
		)
		.join('\n') +
	`\n\t</OGRVRTUnionLayer>\n</OGRVRTDataSource>\n`;
await fs.writeFile(vrtPath, vrtXml);

console.error('Merging %d tiles → %s', fgbs.length, file.geometry);
// ogr2ogr can't overwrite a FlatGeobuf in place, so remove any stale target first
await fs.rm(file.geometry, { force: true });
await run('ogr2ogr', ['-progress', '-f', 'FlatGeobuf', '-nln', 'landcover', file.geometry, vrtPath]);
await fs.rm(vrtPath, { force: true });

console.error('Done. Geometry written to %s', file.geometry);
