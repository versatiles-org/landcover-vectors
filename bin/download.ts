// Build the EPSG:3857 source raster from the remote ESA WorldCover tiles, and fetch and rasterize the ocean mask.
//
// A one-time step, kept separate from the build pipeline (bin/build.ts): build the source
// raster once, then build tiles from it as often as you like. What is already there is kept.

import { download } from '../lib/download.ts';
import { requireCommands } from '../lib/worldcover.ts';

await requireCommands(['gdalbuildvrt', 'gdalwarp', 'gdaladdo', 'gdal_translate', 'gdal_rasterize', 'ogr2ogr', 'curl']);
await download();
