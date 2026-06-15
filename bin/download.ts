// Fetch the ESA WorldCover source mirror into data/0_download.
//
// A one-time, resumable network step, kept separate from the build pipeline
// (bin/build.ts): download the mirror once, then build from it as often as you like.

import { download } from '../lib/download.ts';
import { requireCommands } from '../lib/worldcover.ts';

await requireCommands(['gdal_translate']);
await download();
