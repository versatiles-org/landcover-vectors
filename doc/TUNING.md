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
variants of a parameter sweep apart. The z0–9 build at the 1.77 px² sieve peaked at **122 KB** (z8, Hudson Bay;
85 KB at z6, 119 KB at z7, 118 KB at z9), which led to the 5 px² sieve below.

## Quality: the raster stage decides

Two stages decide how a tile looks, and they are tuned separately: the raster stage (sieve, `TILE_PX`) decides
**which class ends up where**, the vector stage (`DETAIL_PX`) only how precisely its outlines are traced.

### Why there is no blur

The raster stage used to start with a Gaussian blur (σ 0.75 rendered px) of one mask per class, followed by a
per-pixel argmax. That is a weighted majority vote: it rounded patches into blobs and cut tile bytes, but it moved
area from scattered classes to dominant ones. Measured on the worst tile of the z0–10 build then (9/129/159,
Hudson Bay Lowlands), every step of σ cost accuracy:

| variant       | agreement at 256 px | heath kept | tile KB |
| ------------- | ------------------- | ---------- | ------- |
| blur 0.5      | 79.4 %              | 36 %       | 98.5    |
| blur 0.75     | 74.5 %              | 27 %       | 60.4    |
| blur 1.0      | 69.3 %              | 20 %       | 39.3    |
| `DETAIL_PX` 4 | 77.9 %              | 31 %       | 93.9    |

Switching it off entirely, with the sieve held at 1.77 px² (`hudson-bay`, z8–10, judged on 9/132/160):

|                                   | blur 0.75          | no blur               |
| --------------------------------- | ------------------ | --------------------- |
| worst tile z8 / z9 / z10, KB      | 79.0 / 79.4 / 78.3 | 102.2 / 101.3 / 110.1 |
| features / vertices on 9/132/160  | 3345 / 47 669      | 4088 / 58 204         |
| agreement at 1024 px / at 256 px  | 60.5 % / 73.0 %    | 61.5 % / 71.7 %       |
| heath / marsh kept                | 36.0 % / 66.3 %    | 39.4 % / 70.3 %       |
| average full block, 9 in parallel | 70.4 s             | 46.4 s                |

Without it, scattered classes keep more of their area and the polygons follow ESA's own texture instead of
blobs, for 1.3–1.4× the bytes, well inside the budget. The blur was removed, which also drops masks, blur and
argmax from every block (the slowest raster step) and libvips from the requirements. The sieve is now the only
raster generalization, and with that the knob to turn when tiles grow too big.

### Why the sieve runs in two passes

GDAL's sieve merges a patch smaller than the threshold into its largest neighbour. In a fragmented mosaic most
neighbours of a small patch are small too, so a single pass leaves much of it as it is, and the more, the larger
the threshold. With one pass, the Hudson Bay worst z6 tile (6/16/20, 11 936 features, 133 KB) only grew with the
sieve: 133, 215, 329 and 447 KB at 1.77, 3, 5 and 8 px². Polygons left on that z6 block's raster:

| sieve              | polygons  |
| ------------------ | --------- |
| none               | 2 543 700 |
| one pass, 28 px    | 51 842    |
| one pass, 128 px   | 123 578   |
| 7 → 28 px          | 41 035    |
| 4 → 8 → 16 → 28 px | 41 762    |
| 28 → 28 px         | 30 508    |
| 4 → 8 → … → 128 px | 8 298     |

A small first pass merges the specks into their neighbours, so the full pass finds large ones for what is left.
The build sieves at 7 → 28 px (`SIEVE_STAGES` in `config.ts`), against one pass (`hudson-bay`, sieve 1.77 px²):

|                                         | one pass              | 7 → 28 px            | 28 → 28 px           |
| --------------------------------------- | --------------------- | -------------------- | -------------------- |
| worst tile z6 / z8 / z9 / z10, KB       | 133 / 102 / 101 / 110 | 83 / 116 / 114 / 113 | 67 / 100 / 101 / 110 |
| agreement at 256 px, worst z6 / z8 tile | 69.7 / 74.1 %         | 75.1 / 76.7 %        | 68.6 / 74.1 %        |
| area on the wrong class, z6 / z8        | 17.4 / 7.0 %          | 15.0 / 6.1 %         | 18.0 / 7.0 %         |

The two passes are more accurate at every zoom checked, and take the z6 outlier down by 38 %; z8–10 tiles grow by
up to 14 %. Sieving twice at the full size gives the smallest tiles but is a little less accurate than one pass;
doubling sizes 4 → 8 → 16 → 28 matches 7 → 28 at twice the passes. The extra pass costs about 2.5 s on a
fragmented block (7.0 s against 4.6 s). In passes, the sieve size behaves as expected again: with doubling
sizes, the worst z6 tile shrank to 58, 47 and 38 KB at 3, 5 and 8 px², losing accuracy step by step.

### Why the sieve is 5 px²

The largest tiles are fragmented mosaics: the worst ones of the z0–9 build (Hudson Bay, z6–9) each held about
5400 features, with a median of 3 rendered px² and 60 % under 4 px². Their bytes are the patches, not the outlines.
Measured on the worst z8 tile, 8/67/83, built from the same block at each setting (`npm run sweep`, agreement with
the source at 1024 px):

| sieve     | `DETAIL_PX` | worst tile  | features | agreement  | grassland kept |
| --------- | ----------- | ----------- | -------- | ---------- | -------------- |
| 1.77 px²  | 1           | 118.9 KB    | 5400     | 66.6 %     | 51.8 %         |
| 1.77 px²  | 0.7         | 108.7 KB    | 5398     | 63.5 %     | 47.3 %         |
| 1.77 px²  | 0.5         | 104.3 KB    | 5397     | 61.2 %     | 44.4 %         |
| 3 px²     | 1           | 89.2 KB     | 3482     | 63.6 %     | 46.4 %         |
| **5 px²** | **1**       | **69.4 KB** | **2341** | **60.6 %** | **40.2 %**     |
| 5 px²     | 0.7         | 59.1 KB     | 2340     | 58.4 %     | 37.4 %         |
| 5 px²     | 2           | 103.8 KB    | 2345     | 63.6 %     | 43.8 %         |

The sieve is the efficient lever: a coarser simplify tolerance keeps every patch and only drops vertices, so at
1.77 px² it buys a third of the bytes for the same accuracy. And accuracy is cheaper to keep with a smaller sieve
than to win back with finer outlines: 3 px² at `DETAIL_PX` 1 reaches the 63.6 % of 5 px² at `DETAIL_PX` 2 with
14 % fewer bytes. Grassland, the most scattered kind, loses most. Rivers, the large marsh areas and the lakes stay.

tippecanoe's own size limit is no alternative: `--maximum-tile-bytes` with `--coalesce-smallest-as-needed` merges
a small feature into the one before it in the data, not into a neighbour, so at 100 KB 16 % of the tile's pixels,
and at 80 KB 32 %, ended up on the wrong kind.

## Sweeps and `inspect`

```sh
npm run sweep -- --area hudson-bay --zoom 9 --sieve 0,1.77,4         # the raster stage: size and quality
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
- the overall agreement, both at full resolution (which also counts the pixel-level mosaic the sieve and the
  simplify remove on purpose) and at the 4×4 majority the tolerance is calibrated to (the structural number);
- the errors, split into wrong kind, gap and overdraw;
- the tile's bytes, features and vertices.

It also writes a PNG to `data/inspect/` with the source, the target, and each variant next to a map of its errors.

## Raising `TILE_PX`

Raising `TILE_PX` is the bigger operation: sieve and tolerance are both set in rendered pixels (via
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
- each tileset present, which adds sieve and simplify.

On 9/129/159 the source loses little at 1024 (heath 95 % kept, 92 % agreement through the z9 pyramid) and a
bit less at 2048 (98 %, 96 %); the sieve's and the simplify's loss sit on top of that.
