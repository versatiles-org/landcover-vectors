// Run the whole landcover build pipeline.
//
// Calls each step in lib/steps.js, in order. Each reads the previous step's output from
// data/ and writes its own, so re-running is resumable. The one-time source-mirror fetch
// is a separate script, bin/download.js (`npm run download`) — run it once first.

import { reproject, channels, blur, argmax, polygonize, tile, pack } from '../lib/steps.js';

await reproject();
await channels();
await blur();
await argmax();
await polygonize();
await tile();
await pack();

console.error('\n✓ done');
