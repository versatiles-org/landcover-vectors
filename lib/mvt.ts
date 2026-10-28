// A minimal Mapbox Vector Tile reader: layers, their features' `kind`, and polygon rings in tile units. Enough to
// rasterise a tile (lib/measure.ts); bin/verify-merge.ts only counts features and has its own, smaller reader.

export type Feature = { type: number; kind: string; geometry: number[] };
export type Layer = { name: string; extent: number; features: Feature[] };

export function decodeTile(buf: Uint8Array): Layer[] {
	let pos = 0;
	const varint = (): number => {
		let v = 0;
		for (let shift = 0; ; shift += 7) {
			const b = buf[pos++];
			v += (b & 0x7f) * 2 ** shift;
			if (b < 0x80) return v;
		}
	};
	// calls `field` for each length-delimited field up to `end`, or `scalar` for a varint; others are skipped
	const fields = (
		end: number,
		field: (tag: number, end: number) => void,
		scalar?: (tag: number, v: number) => void,
	) => {
		while (pos < end) {
			const key = varint();
			const [tag, wire] = [key >>> 3, key & 7];
			if (wire === 2) {
				const fieldEnd = varint() + pos;
				field(tag, fieldEnd);
				pos = fieldEnd;
			} else if (wire === 0) {
				const v = varint();
				scalar?.(tag, v);
			} else if (wire === 1) pos += 8;
			else if (wire === 5) pos += 4;
			else throw new Error(`unexpected wire type ${wire}`);
		}
	};
	const text = (end: number) => new TextDecoder().decode(buf.subarray(pos, end));
	const packed = (end: number) => {
		const out: number[] = [];
		while (pos < end) out.push(varint());
		return out;
	};

	const layers: Layer[] = [];
	fields(buf.length, (tag, end) => {
		if (tag !== 3) return; // Tile.layers
		const layer: Layer = { name: '', extent: 4096, features: [] };
		const keys: string[] = [];
		const values: (string | undefined)[] = [];
		const raw: { type: number; tags: number[]; geometry: number[] }[] = [];
		fields(
			end,
			(tag, end) => {
				if (tag === 1) layer.name = text(end);
				else if (tag === 3) keys.push(text(end));
				else if (tag === 4) {
					let v: string | undefined;
					fields(end, (t, e) => {
						if (t === 1) v = text(e); // only string values: `kind` is one
					});
					values.push(v);
				} else if (tag === 2) {
					const f = { type: 0, tags: [] as number[], geometry: [] as number[] };
					fields(
						end,
						(t, e) => {
							if (t === 2) f.tags = packed(e);
							else if (t === 4) f.geometry = packed(e);
						},
						(t, v) => {
							if (t === 3) f.type = v;
						},
					);
					raw.push(f);
				}
			},
			(tag, v) => {
				if (tag === 5) layer.extent = v;
			},
		);
		const kindKey = keys.indexOf('kind');
		for (const f of raw) {
			let kind = '';
			for (let i = 0; i < f.tags.length; i += 2) if (f.tags[i] === kindKey) kind = values[f.tags[i + 1]] ?? '';
			layer.features.push({ type: f.type, kind, geometry: f.geometry });
		}
		layers.push(layer);
	});
	return layers;
}

// a feature's rings, in tile units (polygons: outer rings and holes alike, for an even-odd fill)
export function rings(geometry: number[]): [number, number][][] {
	const zigzag = (n: number) => (n >>> 1) ^ -(n & 1);
	const out: [number, number][][] = [];
	let [x, y] = [0, 0];
	let ring: [number, number][] | null = null;
	for (let i = 0; i < geometry.length;) {
		const cmd = geometry[i] & 7;
		const count = geometry[i] >>> 3;
		i++;
		if (cmd === 7) {
			if (ring) out.push(ring);
			ring = null;
			continue;
		}
		for (let k = 0; k < count; k++) {
			x += zigzag(geometry[i++]);
			y += zigzag(geometry[i++]);
			if (cmd === 1) {
				if (ring) out.push(ring);
				ring = [[x, y]];
			} else ring?.push([x, y]);
		}
	}
	if (ring) out.push(ring);
	return out;
}
