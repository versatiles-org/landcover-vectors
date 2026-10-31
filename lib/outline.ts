// Round a polygonized coverage's outlines before the simplify (lib/block.ts): the simplify only drops vertices, so
// what polygonize traces as a right angle stays a right angle. Each segment's midpoint becomes a vertex and each old
// corner goes, which cuts every corner; a long segment keeps its middle, cut only `cap` from either end.
//
// The polygons must stay a coverage, so both polygons along a border must get the same points. The rings are therefore
// cut at their nodes, the grid points where anything but two unit edges meet, which stay where they are, and the
// result of a chain between two nodes depends only on its points, not on its direction. A ring without a node has no
// start to depend on either. The window's edge counts as nodes throughout, so the coverage's boundary stays. Tile
// edges need nothing special: they are straight, and cutting no corner leaves them so.

export type Grid = { width: number; height: number }; // the raster's size, in pixels
export type Point = [number, number];
export type OutlineParams = { cap: number; passes: number }; // cap in raster px

const [E, W, S, N] = [1, 2, 4, 8];
const BITS = Uint8Array.from({ length: 16 }, (_, m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));

// One byte per grid point: which of its four unit edges exist, over every ring. Rings' points are whole grid points.
export function edgeMask(rings: Iterable<Point[]>, { width, height }: Grid): Uint8Array {
	const stride = width + 1;
	const mask = new Uint8Array(stride * (height + 1));
	for (const ring of rings)
		for (let i = 0; i + 1 < ring.length; i++) {
			let [x, y] = ring[i];
			const [bx, by] = ring[i + 1];
			if (x !== bx && y !== by) throw new Error(`a diagonal edge at ${x},${y}: not a polygonized ring`);
			const [out, back, dx, dy] =
				bx > x ? [E, W, 1, 0] : bx < x ? [W, E, -1, 0] : by > y ? [S, N, 0, 1] : [N, S, 0, -1];
			while (x !== bx || y !== by) {
				mask[y * stride + x] |= out;
				x += dx;
				y += dy;
				mask[y * stride + x] |= back;
			}
		}
	return mask;
}

const isNode = (mask: Uint8Array, { width, height }: Grid, x: number, y: number) =>
	x === 0 || y === 0 || x === width || y === height || BITS[mask[y * (width + 1) + x]] !== 2;

// A closed ring's corners, with every node on it, in ring order: the chains between nodes, and whether it has nodes.
// The first and last point of each chain are nodes; a ring without any is one closed chain of corners.
function chainsOf(ring: Point[], mask: Uint8Array, grid: Grid): { chains: Point[][]; closed: boolean } {
	const points: { p: Point; node: boolean }[] = [];
	const n = ring.length - 1; // the ring repeats its first point
	for (let i = 0; i < n; i++) {
		let [x, y] = ring[i];
		const [bx, by] = ring[i + 1];
		const [dx, dy] = [Math.sign(bx - x), Math.sign(by - y)];
		const [ax, ay] = ring[(i + n - 1) % n];
		const straight = Math.sign(x - ax) === dx && Math.sign(y - ay) === dy;
		const node = isNode(mask, grid, x, y);
		if (node || !straight) points.push({ p: [x, y], node });
		x += dx;
		y += dy;
		for (; x !== bx || y !== by; x += dx, y += dy)
			if (isNode(mask, grid, x, y)) points.push({ p: [x, y], node: true });
	}
	const first = points.findIndex((v) => v.node);
	if (first < 0) return { chains: [points.map((v) => v.p)], closed: true };
	const chains: Point[][] = [];
	let chain: Point[] = [points[first].p];
	for (let k = 1; k <= points.length; k++) {
		const v = points[(first + k) % points.length];
		chain.push(v.p);
		if (v.node) {
			chains.push(chain);
			chain = [v.p];
		}
	}
	return { chains, closed: false };
}

// the points replacing segment a→b: its midpoint, or, on a long one, a point `cap` from either end
function cut(a: Point, b: Point, cap: number, out: Point[]): void {
	const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
	if (length <= 2 * cap) {
		out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
		return;
	}
	const t = cap / length;
	out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	out.push([b[0] - (b[0] - a[0]) * t, b[1] - (b[1] - a[1]) * t]);
}

// one pass over a chain with fixed ends
function passOpen(chain: Point[], cap: number): Point[] {
	if (chain.length < 3) return chain; // no corner to cut, and a straight chain is best left two points
	const out: Point[] = [chain[0]];
	for (let i = 0; i + 1 < chain.length; i++) cut(chain[i], chain[i + 1], cap, out);
	out.push(chain[chain.length - 1]);
	return out;
}

// one pass over a closed chain
function passClosed(chain: Point[], cap: number): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < chain.length; i++) cut(chain[i], chain[(i + 1) % chain.length], cap, out);
	return out;
}

// a polygonized ring (closed: its last point repeats the first), its outline rounded; same for its neighbours
export function roundRing(ring: Point[], mask: Uint8Array, grid: Grid, { cap, passes }: OutlineParams): Point[] {
	const { chains, closed } = chainsOf(ring, mask, grid);
	if (closed) {
		let c = chains[0];
		for (let i = 0; i < passes; i++) c = passClosed(c, cap);
		return [...c, c[0]];
	}
	const out: Point[] = [];
	for (const chain of chains) {
		let c = chain;
		for (let i = 0; i < passes; i++) c = passOpen(c, cap);
		for (let i = 0; i + 1 < c.length; i++) out.push(c[i]);
	}
	out.push(out[0]);
	return out;
}

// ---------------------------------------------------------------- the file

// `POLYGON ((x y,x y),(x y,…))`, as ogr2ogr's CSV writes it, into rings
export function parseWkt(wkt: string): number[][][] {
	const open = wkt.indexOf('((');
	if (open < 0) return [];
	return wkt
		.slice(open + 2, wkt.lastIndexOf('))'))
		.split('),(')
		.map((r) => r.split(',').map((p) => p.trim().split(' ').map(Number)));
}
