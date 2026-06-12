// Single entry point for the landcover pipeline.
//
// Usage:
//   node bin/build.js                      run the whole build pipeline (reproject … pack)
//   node bin/build.js blur argmax tile     run only the named steps (in pipeline order)
//
// Build steps: reproject → channels → blur → argmax → polygonize → tile → pack. Each reads
// the previous step's output from data/ and writes its own, so re-running is resumable. The
// step logic lives in lib/steps.js. The one-time source-mirror fetch is a separate script,
// bin/download.js (`npm run download`) — run it once before the first build.

import { steps } from '../lib/steps.js';

const names = process.argv.slice(2);
const known = steps.map((s) => s.name);
for (const n of names) {
	if (!known.includes(n)) throw new Error(`unknown step "${n}" — choose from: ${known.join(', ')}`);
}

// no args → the whole build pipeline; otherwise the named subset
const todo = names.length ? steps.filter((s) => names.includes(s.name)) : steps;

for (const step of todo) {
	console.error('\n▶ %s', step.name);
	await step.run();
}
console.error('\n✓ done (%s)', todo.map((s) => s.name).join(' → '));
