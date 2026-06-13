// Delete everything under data/ except the download mirror (dir.source), so a build can be
// re-run from scratch without re-downloading the ~124 GB of source tiles. Run: npm run clean.

import fs from 'node:fs/promises';
import path from 'node:path';

import { datadir, dir } from '../config.js';

const keep = path.basename(dir.source);
const entries = (await fs.readdir(datadir).catch(() => [])).filter((name) => name !== keep);

for (const name of entries) {
	await fs.rm(path.join(datadir, name), { recursive: true, force: true });
	console.error('removed %s', path.join(datadir, name));
}

console.error(
	'Cleaned %s — kept %s (%d entr%s removed)',
	datadir,
	keep,
	entries.length,
	entries.length === 1 ? 'y' : 'ies',
);
