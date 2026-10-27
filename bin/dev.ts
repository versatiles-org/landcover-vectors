// Dev mode: look at the result — OSM, the land cover, and the two merged — in versatiles-style, side by side.
//
//   npm run dev                # the published landcover container
//   npm run dev -- --local     # the local build, data/landcover-vectors.versatiles
//
// Serves three sources from one in-process server (@versatiles/versatiles-rs, nothing downloaded): OSM's
// Shortbread container, the landcover container, and their merge, filtered exactly like `npm run merge`
// (lib/handover.ts). The map (dev/map/) switches between them, each drawn with versatiles-style's colorful
// style: `osm` without its landcover feature, as OSM looks today; `landcover` and `merged` with it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { TileServer, TileSource } from '@versatiles/versatiles-rs';

import { commandExists } from '../lib/worldcover.ts';
import { mergePipeline } from '../lib/handover.ts';
import { versatilesStyle } from '../lib/style-versatiles.ts';
import { datadir, file, OSM_URL, LANDCOVER_URL } from '../config.ts';

const { values: opt } = parseArgs({
	options: {
		local: { type: 'boolean', default: false },
		port: { type: 'string', default: '8080' },
		'no-open': { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

if (opt.help) {
	console.log(
		[
			'Usage: npm run dev -- [options]',
			`  --local      use the local build (${path.relative(process.cwd(), file.container)}) instead of`,
			`               the published container (${LANDCOVER_URL})`,
			'  --port <n>   port to serve on (default 8080)',
			'  --no-open    do not open a browser',
		].join('\n'),
	);
	process.exit(0);
}

const landcover = opt.local ? file.container : LANDCOVER_URL;
if (opt.local && !(await fs.stat(landcover).catch(() => null)))
	throw new Error(`missing ${landcover} — run "npm run build" first, or leave out --local`);

const sources = {
	osm: await TileSource.fromPath(OSM_URL),
	landcover: await TileSource.fromPath(landcover),
	merged: await TileSource.fromVpl(mergePipeline(OSM_URL, landcover)),
};

// the map page, and what it reads: one style per view, and which landcover is shown
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const genDir = path.join(datadir, 'dev');
await fs.mkdir(genDir, { recursive: true });
for (const [name, source] of Object.entries(sources)) {
	const style = versatilesStyle(`/tiles/${name}/tiles.json`, name !== 'osm');
	// only the layers the tiles have: the landcover alone has two, and MapLibre logs every style layer
	// whose source layer is missing
	const layers = new Set(source.tileJson().vectorLayers?.map((l) => l.id));
	style.layers = style.layers.filter((l) => !('source-layer' in l) || layers.has(l['source-layer']!));
	await fs.writeFile(path.join(genDir, `style-${name}.json`), JSON.stringify(style));
}
await fs.writeFile(
	path.join(genDir, 'state.json'),
	JSON.stringify({ landcover: opt.local ? 'local' : 'remote', source: landcover, osm: OSM_URL }),
);

// no-cache: --local and remote serve different tiles under the same URLs
const server = new TileServer({ ip: '127.0.0.1', port: Number(opt.port), cacheControl: 'no-cache' });
for (const [name, source] of Object.entries(sources)) await server.addTileSource(name, source);
await server.addStaticSource(path.join(root, 'dev', 'map'), '/');
await server.addStaticSource(genDir, '/gen');
await server.start();

const url = `http://localhost:${server.port}/`;
console.error('→ %s  (landcover: %s %s)', url, opt.local ? 'local' : 'remote', landcover);
if (!opt['no-open']) {
	const opener = (await commandExists('open')) ? 'open' : (await commandExists('xdg-open')) ? 'xdg-open' : null;
	if (opener) spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
}

// the native server holds no handle on Node's event loop, so without this Node would exit right here
const keepAlive = setInterval(() => {}, 2 ** 30);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, () => {
		clearInterval(keepAlive);
		void server.stop().then(() => process.exit(0));
	});
