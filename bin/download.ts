// Build the EPSG:3857 source raster from the remote ESA WorldCover tiles, and fetch and rasterize the ocean mask.
//
// A one-time step, kept separate from the build pipeline (bin/build.ts): build the source
// raster once, then build tiles from it as often as you like. What is already there is kept.

import { download } from '../lib/download.ts';
import { requireTools } from '../lib/tools.ts';
import { startTimingLog, timed } from '../lib/timing.ts';
import { file, CPU_CORES } from '../config.ts';

await requireTools(['node', 'gdal', 'curl']);
startTimingLog(file.timings, 'download', { cores: CPU_CORES });
await timed('download', download);
