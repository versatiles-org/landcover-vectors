// Check every external tool the pipeline runs: present, new enough, and able to do what is asked of it
// (lib/tools.ts). Run: npm run doctor (or pixi run doctor). Exits non-zero if any tool cannot be used.

import { TOOLS, type ToolName } from '../lib/tools.ts';

let failed = 0;
for (const [name, tool] of Object.entries(TOOLS) as [ToolName, (typeof TOOLS)[ToolName]][]) {
	const r = await tool.check();
	const mark = r.problem ? '✗' : r.warning ? '!' : '✓';
	const note = r.problem ?? r.warning;
	console.log(
		`${mark} ${name.padEnd(18)} ${(r.version ?? '').padEnd(8)} ${note ? note + ' — ' : ''}for ${tool.neededBy}`,
	);
	if (r.problem) {
		console.log(`  → ${tool.hint}`);
		failed++;
	}
}
console.log(failed ? `\n${failed} tool(s) missing or unusable` : '\nall tools ready');
process.exit(failed ? 1 : 0);
