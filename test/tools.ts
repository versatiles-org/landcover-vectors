// Tests that run the real GDAL or tippecanoe skip themselves where those are not installed — except where
// LANDCOVER_REQUIRE_TOOLS is set, as in the CI job that installs them: there a missing tool fails, so a broken
// install cannot pass with every such test skipped.

import { commandExists } from '../lib/worldcover.ts';

// the reason to skip, or false when every command is on PATH
export async function skipWithout(...cmds: string[]): Promise<string | false> {
	const missing: string[] = [];
	for (const cmd of cmds) if (!(await commandExists(cmd))) missing.push(cmd);
	if (missing.length === 0) return false;
	const reason = `${missing.join(', ')} not on PATH`;
	if (process.env.LANDCOVER_REQUIRE_TOOLS) throw new Error(`${reason}, but LANDCOVER_REQUIRE_TOOLS is set`);
	return reason;
}
