// minimal dependency-free progress bar with ETA, rendered to stderr.
//
// usage:
//   const bar = progress(total, 'Downloading');
//   for (...) { ...; bar.tick(); }   // or bar.skip() for an item that was already done (cached)
//   bar.done();
//
// On a TTY it draws an in-place bar (~10 fps); when stderr is redirected it prints
// one line per whole percent instead of spamming carriage returns. The speed/ETA are based
// on a sliding window of the most recent completions (throughput over that window), not the
// lifetime average — so when per-item cost changes sharply (e.g. walking up zoom levels) the
// estimate tracks the current pace within a few items instead of lagging behind history.
//
// Skipped items (a resumed build's cached blocks) advance the bar but never enter the rate: they take no
// time, and counted as work they would make a resumed build look many times faster than it is.

const BAR_WIDTH = 24;
const WINDOW = 64; // number of recent ticks the rate/ETA are averaged over

export function fmtTime(s: number): string {
	if (!isFinite(s) || s < 0) return '--';
	s = Math.round(s);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h) return `${h}h${String(m).padStart(2, '0')}m`;
	if (m) return `${m}m${String(sec).padStart(2, '0')}s`;
	return `${sec}s`;
}

export type Progress = {
	tick: (n?: number) => void; // n items done
	skip: (n?: number) => void; // n items that were done already
	setLabel: (s: string) => void;
	done: () => void;
};

export function progress(total: number, label = ''): Progress {
	const start = Date.now();
	const tty = !!process.stderr.isTTY;
	let lbl = label ? label + ' ' : '';
	let current = 0; // items done or skipped
	let skipped = 0;
	let lastMs = 0;
	let lastPct = -1;
	// ring of recent {time, cumulative count of items done} samples; the rate is measured across this window.
	// Storing the cumulative count means a single tick(n) with n>1 is absorbed without special-casing.
	const samples: { t: number; c: number }[] = [{ t: start, c: 0 }];

	draw(true);

	function draw(force: boolean): void {
		const now = Date.now();
		const frac = total > 0 ? current / total : 1;
		const pct = Math.floor(frac * 100);

		if (!force) {
			if (tty && now - lastMs < 100) return; // throttle to ~10 fps
			if (!tty && pct === lastPct) return; // one line per whole percent
		}
		lastMs = now;
		lastPct = pct;

		// rate = throughput across the sliding window (oldest → newest sample); fall back to the
		// lifetime average while the window holds < 2 samples
		const oldest = samples[0];
		const newest = samples[samples.length - 1];
		const windowSpan = (newest.t - oldest.t) / 1000;
		const elapsed = (now - oldest.t) / 1000;
		const rate = windowSpan > 0 ? (newest.c - oldest.c) / windowSpan : elapsed > 0 ? newest.c / elapsed : 0;
		const eta = rate > 0 && current < total ? (total - current) / rate : Infinity;
		const cached = skipped ? `, ${skipped} cached` : '';
		const stats = `${String(pct).padStart(3)}% ${current}/${total}${cached} (${rate.toFixed(rate < 1 ? 2 : 1)}/s, ETA ${fmtTime(eta)})`;

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
			samples.push({ t: Date.now(), c: current - skipped });
			if (samples.length > WINDOW) samples.shift();
			draw(false);
		},
		skip(n = 1) {
			current += n;
			skipped += n;
			// before the first item done, the time spent skipping is no part of the pace either
			if (samples.length === 1) samples[0].t = Date.now();
			draw(false);
		},
		setLabel(s: string) {
			lbl = s ? s + ' ' : '';
		},
		done() {
			current = total;
			draw(true);
			if (tty) process.stderr.write('\n');
		},
	};
}
