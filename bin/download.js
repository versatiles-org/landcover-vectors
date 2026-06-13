// Fetch the ESA WorldCover source mirror into data/esa-worldcover-src.
//
// A one-time, resumable network step, kept separate from the build pipeline
// (bin/build.js): download the mirror once, then build from it as often as you like.

import { download } from '../lib/steps/index.js';
import { requireCommands } from '../lib/worldcover.js';

await requireCommands(['gdal_translate']);
await download();
