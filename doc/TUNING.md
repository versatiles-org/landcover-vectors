# Tuning quality and size

How to measure a parameter change before adopting it, and what the measurements so far say. The knobs
themselves are listed in the README under [Development](../README.md#tuning); they all live in `config.ts`.

## Size: the worst tile decides

```sh
npm run stats                                              # per-zoom distribution of data/landcover.mbtiles
npm run stats -- --area hudson-bay --worst 5 --attribute   # the biggest tiles, and what fills them
npm run stats -- --baseline write                          # remember the numbers in doc/size-baseline.json
npm run stats -- --baseline compare                        # diff a later build against them
npm run stats -- --probe hudson-bay --zoom 8-10            # preview-build the area at the current config, then measure it
```

`bin/stats.ts` reads tile sizes straight out of the mbtiles (`node:sqlite`, no external tool): those are the
compressed bytes a client downloads, which is what tippecanoe's `--maximum-tile-bytes` (500 000) applies to. For a
parameter change the **maximum** is what matters, not the average — past the limit tippecanoe coalesces or drops
features and the coverage quietly loses detail, so the command exits non-zero when any tile reaches it.

The maximum is always local: one fragmented landscape decides it. `--area` therefore restricts the measurement to
an area of interest (`--areas` lists the presets, or pass `west,south,east,north`). The presets are the shapes
that stress the pipeline differently — `hudson-bay` is where the largest tiles of the z0–10 build actually sit,
plus archipelago, fjord, delta, desert and glacier cases. `--worst N --attribute` decodes those tiles with
`tippecanoe-decode` and reports features and vertices per layer and `kind`, which answers _why_ a tile is big.

`doc/size-baseline.json` holds the numbers of a build so a later one can be diffed against it; `--label` keeps
variants of a parameter sweep apart. For the z0–10 build the worst tile is **60.5 KB at z9** (Hudson Bay
Lowlands, 2273 features / 36 k vertices), with an average of 6–10 KB per tile — roughly **8× headroom** to the
500 000-byte limit, which is the budget available for more detail.

## Quality: the raster stage decides

Two stages decide how a tile looks, and they are tuned separately: the raster stage (blur, sieve, `TILE_PX`)
decides **which class ends up where**, the vector stage (`DETAIL_PX`) only how precisely its outlines are
traced. Measured on the worst tile of the z0–10 build (9/129/159, Hudson Bay Lowlands), against what it should
show:

| variant           | agreement at 256 px | heath kept | tile KB |
| ----------------- | ------------------- | ---------- | ------- |
| blur 0.5          | 79.4 %              | 36 %       | 98.5    |
| blur 0.75 (today) | 74.5 %              | 27 %       | 60.4    |
| blur 1.0          | 69.3 %              | 20 %       | 39.3    |
| `DETAIL_PX` 4     | 77.9 %              | 31 %       | 93.9    |

At about the same size, a smaller blur beats a finer tolerance on every measure: the blur is where scattered
classes are voted away (heath loses half its area in that one step), and no outline precision brings them
back. `DETAIL_PX` 4 costs 1.56× the bytes of `DETAIL_PX` 1, far less than 4×, because MVT delta-encodes
dense vertices; beyond `DETAIL_PX` ≈ 16 the MVT grid quantises the extra precision away (tippecanoe's default
`--detail 12` is 4096 units per tile, i.e. 16 per rendered pixel).

## Sweeps and `inspect`

```sh
npm run sweep -- --area hudson-bay --zoom 9 --blur 0.5,0.75,1        # the raster stage: size and quality
LANDCOVER_SIEVE_RENDERED=1.77 npm run sweep -- --area hudson-bay --zoom 9 --blur 0.5,0.75,1   # sieve held fixed
npm run sweep -- --area hudson-bay --zoom 8-10 --detail 1,2,4        # the vector stage
npm run inspect -- 9/129/159 --preview hudson-bay                    # one tile, every variant built for the area
```

A sweep builds the area once per value, prints the worst tile per zoom per variant, records each in
`doc/size-baseline.json` as `<area>@<knob><value>`, and ends with `npm run inspect` on a reference tile
(`--tile`, or the largest tile of the first variant).

`inspect` rasterises the tile onto the pipeline's own grid and compares it pixel by pixel with its **target**:
the source read at `TILE_PX` and sea-masked like a block reads it, with every class the zoom does not draw turned
into a hole.
It reports:

- each class's area and how much of it was kept;
- the overall agreement, both at full resolution (which also counts the pixel-level mosaic the blur removes on
  purpose) and at the 4×4 majority the tolerance is calibrated to (the structural number);
- the errors, split into wrong kind, gap and overdraw;
- the tile's bytes, features and vertices.

It also writes a PNG to `data/inspect/` with the source, the target, and each variant next to a map of its errors.

## Raising `TILE_PX`

Raising `TILE_PX` is the bigger operation: blur, sieve and tolerance are all set in rendered pixels (via
`OVERSAMPLE`), so it refines the grid they operate on without changing them. `FULL_PX` changes, so the source
raster has to be rebuilt (`npm run download` — the stamp in `data/0_download` makes a stale one an error rather
than a surprise), and the per-block window is `BLOCK`×`TILE_PX` pixels, so **halve `BLOCK` when doubling
`TILE_PX`** to keep memory per block where it is. Each doubling costs 4× source raster and CPU.

The `inspect` target cannot judge that change: it _is_ the source at `TILE_PX`, so whatever the download's
`-r mode` throws away is missing from the target too, and a new `TILE_PX` moves the target along with the tile.
`--native` measures against ESA's own 10 m pixels instead, read straight from the remote COGs (no source raster
needed), and replays the source's resampling for this one tile at each `--tile-px`:

```sh
npm run inspect -- 9/129/159 --native --tile-px 1024,2048            # ~10 s; tilesets present are added last
```

Each stage is scored by its area share per class against the native share (grid-independent) and by the
agreement of the 256-px majorities. The stages are:

- `10 m mode` — the download's warp forced onto ESA's base level;
- `download` — the warp as it runs, on whichever ESA overview GDAL picks (the difference to `10 m mode` is
  what ESA's overviews cost);
- `pyramid` — our mode overview read like a block, below z10 (the cascaded majority vote);
- each tileset present, which adds blur, sieve and simplify.

On 9/129/159 the source loses little at 1024 (heath 95 % kept, 92 % agreement through the z9 pyramid) and a
bit less at 2048 (98 %, 96 %); the blur's loss sits on top of that.
