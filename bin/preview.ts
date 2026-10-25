// Preview / developer mode: build one small area, serve it, look at it in a browser.
//
//   npm run preview -- --area hudson-bay --zoom 4-10   # build the area, serve it, open the viewer
//   npm run preview -- --bbox 4,58,12,64 --watch       # rebuild whenever config.ts changes
//   npm run preview -- --tiles data/landcover.mbtiles  # just serve an existing tileset
//
// The point is the turnaround: a parameter change in config.ts is worth a few minutes on one area, not
// eleven hours on the planet. Each parameter set builds into data/preview/<fingerprint>/, so flipping
// back and forth between two settings reuses each one's cache instead of rebuilding.
//
// The pipeline used is exactly the build's (lib/pipeline.ts over lib/plan.ts); only the plan is smaller.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { requireCommands, commandExists, runCapture, setGdalThreads } from '../lib/worldcover.ts';
import { requireTools } from '../lib/tools.ts';
import { startTimingLog, timed } from '../lib/timing.ts';
import { requireSeaShare } from '../lib/ocean.ts';
import { buildCoverage } from '../lib/coverage.ts';
import { planBlocks, countBlocks } from '../lib/plan.ts';
import { runZooms } from '../lib/pipeline.ts';
import { joinTilesets } from '../lib/assemble.ts';
import { progress } from '../lib/progress.ts';
import { resolveArea, parseZoomRange, areaSlug, previewPaths, AREAS } from '../lib/areas.ts';
import { maplibreStyle } from '../lib/style-spec.ts';
import { versatilesStyle } from '../lib/style-versatiles.ts';
import { mergePipeline, versionAtLeast, MIN_VERSATILES } from '../lib/handover.ts';
import { cacheValues, fingerprint, writeStamp } from '../lib/fingerprint.ts';
import { blockWindow } from '../config.ts';
import {
	datadir,
	file,
	MAXLEVEL,
	BLOCK_CONCURRENCY,
	TILE_PX,
	BLOCK,
	SIEVE_THRESHOLD,
	MARGIN_PX,
	simplifyForLevel,
	OSM_URL,
} from '../config.ts';

const { values: opt } = parseArgs({
	options: {
		area: { type: 'string' }, // preset name or "west,south,east,north"
		bbox: { type: 'string' }, // alias for --area with an explicit box
		zoom: { type: 'string' }, // "min-max", default 0-MAXLEVEL
		port: { type: 'string', default: '8080' },
		watch: { type: 'boolean', default: false },
		'no-osm': { type: 'boolean', default: false }, // parseArgs has no --no-x negation, so spell them out
		'no-open': { type: 'boolean', default: false },
		tiles: { type: 'string' }, // serve this tileset instead of building one
		'build-only': { type: 'boolean', default: false }, // build, print the path, exit (used by --watch)
		concurrency: { type: 'string' },
		help: { type: 'boolean', default: false },
	},
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewerDir = path.join(root, 'dev', 'viewer');

if (opt.help) {
	console.error(
		[
			'Usage: npm run preview -- [options]',
			`  --area <name|w,s,e,n>  area to build (presets: ${Object.keys(AREAS).join(', ')})`,
			'  --bbox <w,s,e,n>       same thing, spelled out',
			`  --zoom <min-max>       zoom range to build (default 0-${MAXLEVEL})`,
			'  --tiles <mbtiles>      skip building and serve an existing tileset',
			'  --port <n>             default 8080',
			'  --watch                rebuild and reload when config.ts changes',
			'  --no-osm               do not mount the remote OSM Shortbread container',
			'  --no-open              do not open a browser',
			'  --build-only           build, then exit',
			'  --concurrency <n>      blocks at once (default: one per core, or LANDCOVER_CONCURRENCY)',
		].join('\n'),
	);
	process.exit(0);
}

const useOsm = !opt['no-osm']; // mounting the real OSM container is what makes the handover visible
// whether the filtered merge is served too, for the viewer's versatiles-style view (decided before serving)
let serveMerged = false;
const openBrowser = !opt['no-open'];
const spec = opt.bbox ?? opt.area;
const bbox = spec ? resolveArea(spec) : undefined;
const [minZoom, maxZoom] = parseZoomRange(opt.zoom);
const fp = fingerprint(cacheValues());
const previewRoot = path.join(datadir, 'preview');
// where the last build landed. A --watch rebuild runs in a child process (ESM cannot reload config.ts),
// comes out with a different fingerprint, and therefore a different directory and tileset — so the paths
// are state to be re-read after every build, not constants captured at startup.
const LAST_BUILD = path.join(previewRoot, 'last-build.json');
type Current = { fingerprint: string; previewDir: string; genDir: string; tileset: string };
const currentFor = (f: string): Current => {
	const previewDir = path.join(previewRoot, f);
	return {
		fingerprint: f,
		previewDir,
		genDir: path.join(previewDir, 'gen'),
		tileset: opt.tiles
			? path.resolve(opt.tiles)
			: path.join(previewDir, `preview-${areaSlug(spec)}-z${minZoom}-${maxZoom}.mbtiles`),
	};
};
let current = currentFor(fp);

// ---------------------------------------------------------------- build
async function build(): Promise<void> {
	await requireTools(['node', 'gdal', 'gdal_calc', 'tippecanoe']);
	if (!(await exists(file.source))) throw new Error(`missing ${file.source} — run "npm run download" first`);
	await requireSeaShare();

	const dirs = previewPaths(current.previewDir, spec);
	await fs.rm(dirs.tmp, { recursive: true, force: true });
	for (const d of [dirs.tmp, dirs.results, dirs.tiles, current.genDir]) await fs.mkdir(d, { recursive: true });
	await writeStamp(current.previewDir, cacheValues());
	startTimingLog(path.join(current.previewDir, 'timings.jsonl'), 'preview', {
		area: spec ?? 'world',
		zoom: `${minZoom}-${maxZoom}`,
	});

	const coverage = await buildCoverage();
	const plan = planBlocks(coverage, { minZoom, maxZoom, bbox });
	const total = countBlocks(plan);
	if (total === 0) throw new Error(`no blocks with source data in ${spec ?? 'the world'} at z${minZoom}-${maxZoom}`);
	console.error(
		'Preview %s z%d-%d: %d blocks, config %s → %s',
		spec ?? 'world',
		minZoom,
		maxZoom,
		total,
		fp,
		current.previewDir,
	);

	const bar = progress(total, 'blocks');
	setGdalThreads(1); // one block per core, one GDAL thread each — as in the build
	const zooms = await timed('preview', () =>
		runZooms(plan, {
			src: file.source,
			tmpdir: dirs.tmp,
			resultsdir: dirs.results,
			tilesdir: dirs.tiles,
			logFile: dirs.log,
			concurrency: Number(opt.concurrency ?? BLOCK_CONCURRENCY),
			bar,
			label: (z) => `zoom ${z}/${maxZoom}`,
		}),
	);
	bar.done();

	if (!(await joinTilesets(zooms, current.tileset))) throw new Error(`no tiles in ${spec ?? 'the world'}`);
	await fs.rm(dirs.tmp, { recursive: true, force: true });
	// tell whoever spawned us (the --watch parent) which fingerprint this build belongs to
	await fs.writeFile(LAST_BUILD, JSON.stringify({ fingerprint: fp, tileset: current.tileset }) + '\n');
	console.error('✓ %s', current.tileset);
}

// the planned blocks as GeoJSON, so the viewer can draw the real block grid and seams can be attributed
async function writeBlockGrid(): Promise<void> {
	await fs.mkdir(current.genDir, { recursive: true }); // --tiles mode never ran build()
	// no source list (a --tiles run on someone else's tileset) simply means no grid to draw
	const coverage = await buildCoverage().catch(() => null);
	const plan = coverage ? planBlocks(coverage, { minZoom, maxZoom, bbox }) : [];
	const features = plan.flatMap(({ z, blocks }) =>
		blocks.map(([bx, by]) => {
			const { west, south, east, north } = blockWindow(z, bx, by).innerLonLat;
			return {
				type: 'Feature',
				properties: { z, bx, by, id: `z${z}_${bx}_${by}` },
				geometry: {
					type: 'LineString',
					coordinates: [
						[west, south],
						[east, south],
						[east, north],
						[west, north],
						[west, south],
					],
				},
			};
		}),
	);
	await fs.writeFile(
		path.join(current.genDir, 'blocks.geojson'),
		JSON.stringify({ type: 'FeatureCollection', features }),
	);
}

// what the viewer shows in its header, and what it polls to notice a rebuild
async function writeState(): Promise<void> {
	const state = {
		fingerprint: current.fingerprint,
		built: new Date().toISOString(),
		area: spec ?? 'world',
		bbox: bbox ?? null,
		zoom: { min: minZoom, max: maxZoom },
		tileset: path.relative(root, current.tileset),
		osm: useOsm,
		versatilesStyle: serveMerged,
		params: {
			TILE_PX,
			BLOCK,
			SIEVE_THRESHOLD,
			MARGIN_PX,
			MAXLEVEL,
			'simplify(z10) m': Number(simplifyForLevel(10).toFixed(2)),
		},
	};
	await fs.mkdir(current.genDir, { recursive: true });
	await fs.writeFile(path.join(current.genDir, 'state.json'), JSON.stringify(state, null, '\t'));
	const style = maplibreStyle({
		tiles: `/tiles/landcover/tiles.json?v=${current.fingerprint}`,
		osm: useOsm ? '/tiles/osm/tiles.json' : undefined,
		fingerprint: current.fingerprint,
	});
	await fs.writeFile(path.join(current.genDir, 'style.json'), JSON.stringify(style, null, '\t'));
	if (serveMerged) {
		const real = versatilesStyle(`/tiles/merged/tiles.json?v=${current.fingerprint}`);
		await fs.writeFile(path.join(current.genDir, 'style-versatiles.json'), JSON.stringify(real, null, '\t'));
	}
}

const exists = (p: string): Promise<boolean> =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

// ---------------------------------------------------------------- serve
function serve(): ChildProcess {
	const mounts = [`[landcover]${current.tileset}`];
	if (useOsm) mounts.push(`[osm]${OSM_URL}`);
	// the real merge, filtered exactly like `npm run merge`, for the versatiles-style view
	if (serveMerged) mounts.push(`[merged,vpl](${mergePipeline(OSM_URL, current.tileset)})`);
	const args = [
		'serve',
		['-p', String(opt.port)],
		['--cache-control', 'no-cache'], // a preview is rebuilt under the same URLs
		['-s', viewerDir],
		['-s', `[/gen]${current.genDir}`],
		...mounts,
	].flat();
	console.error('$ versatiles %s', args.join(' '));
	const child = spawn('versatiles', args, { stdio: ['ignore', 'inherit', 'inherit'] });
	child.on('exit', (code) => {
		if (!restarting) process.exit(code ?? 0);
	});
	return child;
}

let restarting = false;

// ---------------------------------------------------------------- run
if (!opt.tiles) await build();
if (opt['build-only']) process.exit(0);
if (!(await exists(current.tileset))) throw new Error(`no tileset at ${current.tileset}`);

await requireCommands(['versatiles']);
if (useOsm) {
	const version = (await runCapture('versatiles', '--version')).trim();
	serveMerged = versionAtLeast(version, MIN_VERSATILES);
	if (!serveMerged)
		console.error(
			'! %s: the versatiles-style view needs the merge filter, i.e. versatiles ≥ %s — showing the debug view only',
			version || 'versatiles',
			MIN_VERSATILES,
		);
}
await writeBlockGrid();
await writeState();
let server = serve();

const url = `http://localhost:${opt.port}/`;
console.error('\n→ %s  (area %s, z%d-%d, config %s)', url, spec ?? 'world', minZoom, maxZoom, fp);
if (openBrowser) {
	const opener = (await commandExists('open')) ? 'open' : (await commandExists('xdg-open')) ? 'xdg-open' : null;
	if (opener) spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
}

if (opt.watch && opt.tiles) console.error('(--watch does nothing with --tiles: there is nothing to rebuild)');
if (opt.watch && !opt.tiles) {
	console.error('watching config.ts — edit it and the preview rebuilds');
	let busy = false;
	let again = false;
	const rebuild = async () => {
		if (busy) {
			again = true;
			return;
		}
		busy = true;
		// a child process, because this one has config.ts loaded already and ESM cannot reload a module
		const args = [
			process.argv[1],
			'--build-only',
			...(spec ? [`--area=${spec}`] : []),
			'--zoom',
			`${minZoom}-${maxZoom}`,
		];
		console.error('\n— config changed, rebuilding …');
		const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
		const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 1)));
		if (code === 0) {
			const built = await fs
				.readFile(LAST_BUILD, 'utf8')
				.then((s) => JSON.parse(s) as { fingerprint: string })
				.catch(() => null);
			if (built) current = currentFor(built.fingerprint);
			// the fingerprint moved, so the tileset is a different file: restart the server on it
			restarting = true;
			server.kill();
			await new Promise((r) => setTimeout(r, 300));
			restarting = false;
			await writeBlockGrid();
			await writeState();
			server = serve();
			console.error('✓ rebuilt as %s — the viewer reloads itself', current.fingerprint);
		} else {
			console.error('✗ rebuild failed (exit %d) — the previous preview stays up', code);
		}
		busy = false;
		if (again) {
			again = false;
			void rebuild();
		}
	};

	let timer: NodeJS.Timeout | undefined;
	const watcher = fs.watch(path.join(root, 'config.ts'));
	void (async () => {
		for await (const _event of watcher) {
			clearTimeout(timer);
			timer = setTimeout(() => void rebuild(), 250); // editors save in bursts
		}
	})();
}
