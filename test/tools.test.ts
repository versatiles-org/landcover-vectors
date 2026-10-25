// The tool checks stand between a fresh machine and an hours-long build that fails at its last step, so they
// must read each tool's version right and name every problem at once. The checks of real tools run where the
// tools are installed (the CI tools job, a pixi environment), and are skipped elsewhere.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, requireTools } from '../lib/tools.ts';
import { versionAtLeast } from '../lib/handover.ts';
import { gdalEnv } from '../lib/worldcover.ts';
import { skipWithout } from './tools.ts';

const noGdal = await skipWithout('gdal');
const noTippecanoe = await skipWithout('tippecanoe');

describe('tool checks', () => {
	test('node is checked against the engines floor', async () => {
		const r = await TOOLS.node.check();
		assert.equal(r.version, process.versions.node);
		assert.equal(r.problem, undefined);
		await requireTools(['node']);
	});

	test('GDAL is found with its version, utilities and subcommands', { skip: noGdal }, async () => {
		const r = await TOOLS.gdal.check();
		assert.equal(r.problem, undefined, r.problem ?? '');
		assert.ok(r.version && versionAtLeast(r.version, '3.13.0'), r.version ?? '');
	});

	test('tippecanoe reports its version on stderr, and it is read', { skip: noTippecanoe }, async () => {
		const r = await TOOLS.tippecanoe.check();
		assert.equal(r.problem, undefined, r.problem ?? '');
		assert.match(r.version ?? '', /^\d+\.\d+\.\d+$/);
	});

	test('a missing tool fails with its fix, naming every problem at once', async () => {
		const path = gdalEnv.PATH; // every tool runs with gdalEnv (lib/worldcover.ts)
		gdalEnv.PATH = '/nonexistent';
		try {
			await assert.rejects(requireTools(['tippecanoe', 'curl']), (err: Error) => {
				assert.match(err.message, /tippecanoe: tippecanoe is not on PATH — .*pixi install/);
				assert.match(err.message, /curl: curl is not on PATH/);
				return true;
			});
		} finally {
			gdalEnv.PATH = path;
		}
	});
});
