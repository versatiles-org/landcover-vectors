// minimal dependency-free progress bar with ETA, rendered to stderr.
//
// usage:
//   const bar = progress(total, 'Downloading');
//   for (...) { ...; bar.tick(); }
//   bar.done();
//
// On a TTY it draws an in-place bar (~10 fps); when stderr is redirected it prints
// one line per whole percent instead of spamming carriage returns.

const BAR_WIDTH = 24;

function fmtTime(s) {
	if (!isFinite(s) || s < 0) return '--';
	s = Math.round(s);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h) return `${h}h${String(m).padStart(2, '0')}m`;
	if (m) return `${m}m${String(sec).padStart(2, '0')}s`;
	return `${sec}s`;
}

export function progress(total, label = '') {
	const start = Date.now();
	const tty = !!process.stderr.isTTY;
	const lbl = label ? label + ' ' : '';
	let current = 0;
	let lastMs = 0;
	let lastPct = -1;

	function draw(force) {
		const now = Date.now();
		const frac = total > 0 ? current / total : 1;
		const pct = Math.floor(frac * 100);

		if (!force) {
			if (tty && now - lastMs < 100) return; // throttle to ~10 fps
			if (!tty && pct === lastPct) return; // one line per whole percent
		}
		lastMs = now;
		lastPct = pct;

		const elapsed = (now - start) / 1000;
		const rate = elapsed > 0 ? current / elapsed : 0;
		const eta = rate > 0 && current < total ? (total - current) / rate : Infinity;
		const stats = `${String(pct).padStart(3)}% ${current}/${total} (${rate.toFixed(1)}/s, ETA ${fmtTime(eta)})`;

		if (tty) {
			const filled = Math.round(frac * BAR_WIDTH);
			const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
			process.stderr.write(`\r${lbl}[${bar}] ${stats}\x1b[K`);
		} else {
			process.stderr.write(`${lbl}${stats}\n`);
		}
	}

	return {
		tick(n = 1) {
			current += n;
			draw(false);
		},
		done() {
			current = total;
			draw(true);
			if (tty) process.stderr.write('\n');
		},
	};
}
