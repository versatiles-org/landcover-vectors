// The external tools, and a check of each: present, new enough, and able to do what the pipeline asks of it.
// `npm run doctor` shows them all; every command checks its own before starting (requireTools), so a missing
// or outdated tool fails in a second instead of hours into a build.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { gdalEnv, commandExists } from './worldcover.ts';
import { versionAtLeast } from './handover.ts';

export type ToolName = 'node' | 'gdal' | 'gdal_calc' | 'tippecanoe' | 'tippecanoe-decode' | 'versatiles' | 'curl';

// version: what was found; problem: why it cannot be used; warning: usable, but not as tested
export type CheckResult = { version?: string; problem?: string; warning?: string };
type Tool = { neededBy: string; hint: string; check: () => Promise<CheckResult> };

const PIXI = 'run "pixi install" (see pixi.toml)';

// build and merge stamp the shortbread@1.1 schema, which versatiles knows from 5.0.0 on; older ones refuse it,
// which a build would only find out in its final step. (The merge filter alone needs 4.15, see lib/handover.ts.)
export const MIN_VERSATILES_SCHEMA = '5.0.0';
const VERSATILES_HINT =
	'brew install versatiles-org/versatiles/versatiles (or brew upgrade versatiles), or see ' +
	'https://github.com/versatiles-org/versatiles-rs/blob/main/versatiles/README.md#install';

// run a command and return what it printed on stdout and stderr (tippecanoe reports its version on stderr);
// null if it is not on PATH or fails
function output(cmd: string, ...args: string[]): Promise<string | null> {
	return new Promise((resolve) =>
		execFile(cmd, args, { env: gdalEnv }, (err, stdout, stderr) => resolve(err ? null : `${stdout}${stderr}`.trim())),
	);
}

const version = (out: string) => out.match(/\d+\.\d+\.\d+/)?.[0];

// A note when a pixi environment is installed here but this process does not run in it (pixi sets
// PIXI_ENVIRONMENT_NAME in `pixi run` and `pixi shell`): the tools found are the system's, not the pinned ones.
export function outsidePixi(env: NodeJS.ProcessEnv = process.env): string | null {
	const root = path.resolve(import.meta.dirname, '..');
	if (env.PIXI_ENVIRONMENT_NAME || !existsSync(path.join(root, '.pixi', 'envs'))) return null;
	return 'this runs outside the pixi environment installed here — use "pixi run <task>" or "pixi shell"';
}

// a tool whose `--version` (or `args`) must run, and print at least `min`, or else warn below `tested`
function versioned(
	cmd: string,
	opts: { min?: string; tested?: string; args?: string[] } = {},
): () => Promise<CheckResult> {
	return async () => {
		const out = await output(cmd, ...(opts.args ?? ['--version']));
		if (out === null) return { problem: `${cmd} is not on PATH` };
		const v = version(out);
		if (opts.min && !versionAtLeast(out, opts.min)) return { version: v, problem: `needs ≥ ${opts.min}` };
		if (opts.tested && !versionAtLeast(out, opts.tested))
			return { version: v, warning: `tested with ${opts.tested}` };
		return { version: v };
	};
}

export const TOOLS: Record<ToolName, Tool> = {
	node: {
		neededBy: 'everything',
		hint: `${PIXI}, or https://nodejs.org`,
		check: async () => {
			const v = process.versions.node;
			return versionAtLeast(v, '22.18.0') ? { version: v } : { version: v, problem: 'needs ≥ 22.18.0' };
		},
	},
	gdal: {
		neededBy: 'download, build, preview, inspect',
		hint: PIXI,
		check: async () => {
			const found = await versioned('gdal', { min: '3.13.0' })();
			if (found.problem && !found.version) {
				// no `gdal` command: GDAL before 3.11 has none, but may well be installed
				const older = await output('gdalinfo', '--version');
				if (older !== null)
					return { version: version(older), problem: 'needs ≥ 3.13.0 (no gdal command before 3.11)' };
			}
			if (found.problem) return found;
			const utilities = ['gdalbuildvrt', 'gdalwarp', 'gdaladdo', 'gdal_translate', 'gdal_rasterize', 'gdalinfo'];
			const missing: string[] = [];
			for (const u of [...utilities, 'ogr2ogr', 'ogrinfo'])
				if ((await output(u, '--version')) === null) missing.push(u);
			// simplify-coverage also needs GDAL built against GEOS ≥ 3.12
			for (const sub of [
				['raster', 'sieve'],
				['raster', 'polygonize'],
				['vector', 'simplify-coverage'],
			])
				if ((await output('gdal', ...sub, '--help')) === null) missing.push(`gdal ${sub.join(' ')}`);
			return missing.length ? { ...found, problem: `lacks ${missing.join(', ')}` } : found;
		},
	},
	gdal_calc: {
		neededBy: 'build, preview',
		hint: `${PIXI} (gdal_calc.py comes with GDAL's Python bindings and needs numpy)`,
		check: async () =>
			(await output('gdal_calc.py', '--help')) === null
				? { problem: 'gdal_calc.py does not run (not on PATH, or numpy missing)' }
				: {},
	},
	tippecanoe: {
		neededBy: 'build, preview',
		hint: `${PIXI}, or brew install tippecanoe`,
		check: versioned('tippecanoe', { tested: '2.79.0' }),
	},
	'tippecanoe-decode': {
		neededBy: 'inspect, stats --attribute',
		hint: 'comes with tippecanoe',
		// it has no --version and exits non-zero without a file: being there is all there is to check
		check: async () => ((await commandExists('tippecanoe-decode')) ? {} : { problem: 'not on PATH' }),
	},
	versatiles: {
		neededBy: 'build, merge',
		hint: VERSATILES_HINT,
		check: versioned('versatiles', { min: MIN_VERSATILES_SCHEMA }),
	},
	curl: {
		neededBy: 'download, merge',
		hint: PIXI,
		check: versioned('curl'),
	},
};

// check `names`, warn about what is usable but untested, and fail with every problem and its fix at once
export async function requireTools(names: ToolName[]): Promise<void> {
	const results = await Promise.all(names.map(async (name) => ({ name, ...(await TOOLS[name].check()) })));
	for (const r of results) if (r.warning) console.error(`! ${r.name} ${r.version ?? ''}: ${r.warning}`);
	const failed = results.filter((r) => r.problem);
	if (failed.length)
		throw new Error(
			'missing or unusable tools:\n' +
				failed
					.map((r) => `  ${r.name}${r.version ? ` ${r.version}` : ''}: ${r.problem} — ${TOOLS[r.name].hint}`)
					.join('\n') +
				(outsidePixi() ? `\n${outsidePixi()}` : '') +
				'\n(npm run doctor checks them all)',
		);
}
