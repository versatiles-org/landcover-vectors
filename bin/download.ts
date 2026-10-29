// Build the EPSG:3857 source raster from the remote ESA WorldCover tiles, and fetch and rasterize the ocean mask.
//
// A one-time step, kept separate from the build pipeline (bin/build.ts): build the source
// raster once, then build tiles from it as often as you like. What is already there is kept.
//
//   npm run download                 # the source raster, the ocean mask and the sea share
//   npm run download -- --landuse    # only OSM's land use, cut from the planet (lib/osmland.ts): for experiments

import { parseArgs } from 'node:util';

import { download } from '../lib/download.ts';
import { downloadLanduse } from '../lib/osmland.ts';
import { requireTools } from '../lib/tools.ts';
import { startTimingLog, timed } from '../lib/timing.ts';
import { file, CPU_CORES } from '../config.ts';

const { values: opt } = parseArgs({ options: { landuse: { type: 'boolean', default: false } } });

await requireTools(opt.landuse ? ['node', 'curl', 'osmium'] : ['node', 'gdal', 'curl', 'osmium']);
startTimingLog(file.timings, 'download', { cores: CPU_CORES });
await timed('download', async () => {
	if (opt.landuse) await downloadLanduse();
	else await download();
});
