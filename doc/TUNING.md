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

## Outlines

The pipeline adopted the variant in bold below: `config.ts` now sets `SMOOTH_RENDERED`, `OUTLINE`, `TIPPECANOE_COMPACT`
and `DETAIL_PX` 1.5, and the `previous` variant of `lib/variants.ts` turns them off. The others were variants of
`lib/variants.ts` up to commit 1f28f21, measured against the pipeline before (baseline here).

Outlines looked too jagged for their size, so `npm run experiment` compared variants that change them (means over the
ten regions). Size is the change in gzipped bytes, weighted by each zoom's share of the planet. Turning
is the outlines' turning per length, sharp the share of sharp corners, axis the share of length along the pixel grid.

| variant                           | size % | turning z10 | sharp z10 % | axis z10 % | agreement z10 % | agreement z8 % | forest % |
| --------------------------------- | ------ | ----------- | ----------- | ---------- | --------------- | -------------- | -------- |
| baseline                          | 0      | 29.9        | 62.9        | 16.6       | 91.3            | 86.8           | 76.4     |
| `coalesce`                        | −11.3  | 29.9        | 62.9        | 16.6       | 91.3            | 86.8           | 76.4     |
| `outline-0`: noding only          | −7.4   | 27.1        | 63.5        | 13.6       | 91.2            | 86.8           | 76.4     |
| `outline-1`: corners cut          | −1.2   | 26.3        | 61.1        | 6.3        | 91.1            | 86.8           | 76.3     |
| `spend-base`: coalesce, outline-1 | −10.9  | 26.3        | 61.1        | 6.3        | 91.1            | 86.8           | 76.3     |
| `spend-sieve-4`                   | −3.4   | 27.2        | 62.2        | 6.3        | 91.5            | 87.4           | 77.0     |
| `spend-sieve-2.5`                 | +15.4  | 29.5        | 64.7        | 6.3        | 92.2            | 88.6           | 78.1     |
| `spend-detail-1.5`                | +17.7  | 34.7        | 55.9        | 5.9        | 92.2            | 87.8           | 78.1     |
| `spend-smooth-0.5`                | −25.8  | 24.0        | 55.4        | 6.9        | 90.4            | 86.2           | 74.2     |
| `spend-sieve-2-smooth-0.5`        | +1.0   | 28.9        | 61.9        | 7.1        | 91.6            | 88.0           | 76.1     |
| **`spend-detail-1.5-smooth-0.5`** | −8.2   | 28.1        | 43.5        | 6.7        | 91.3            | 87.0           | 75.5     |

- `--coalesce --reorder` saves bytes for free: the same shapes in fewer features, with at most 0.17 % of pixels changed.
- Polygonize leaves T-junctions without a node, so its output is no valid coverage (14,712 invalid rows in
  `check-coverage` on Hudson Bay). Noding them (`lib/outline.ts`) fixes that, and saves bytes by itself.
- Cutting corners before the simplify removes the alignment to the pixel grid, but turning falls only 12 % and sharp
  corners barely move. It helps; it does not cure the jaggedness.
- Raising `detail` alone adds accuracy and wiggle. Lowering the sieve adds accuracy, but 2.5 px² draws visible specks
  that no metric here counts.
- The round majority filter combined with a finer simplify is what changes the shape: sharp corners fall by a third
  and thin slivers go, at the baseline's agreement. It costs 0.9 points of forest, in thin strips.

The regions read about 3 points low against a planet build, so `--planet` decides. `spend-sieve-4` over the planet,
against the build: z8 +1.1 %, z9 +0.3 %, z10 −0.8 %, and the largest tile fell from 70.3 to 66.2 KB at z8.
`spend-detail-1.5-smooth-0.5` over the planet: z8 −6.8 %, z9 −6.1 %, z10 −4.1 %, which is 4.7 % less over z8–10.

The full z0–10 build with it (8538 blocks, 101 core-hours, 3.4 h on 32 cores) has 4525 MB of gzipped tiles against 4748 MB
before (−4.7 %), and its largest tile is 62.6 KB against 71.3 KB. Its tiles at z8–10 are byte for byte those of the
variant's planet build. 85 of the 313,000 tiles drop out, none above 158 bytes.

The container gains less: it is brotli-compressed, and 4385 MB against 4458 MB is −1.6 %. One feature per kind removes
repetition brotli already compresses well, so a tile sample shows raw bytes −20 %, gzip −4 % and brotli −0.2 % at z10, and
−22 %, −7 % and −3.5 % at z7. Size in `npm run experiment` is gzip, so it overstates what a variant saves in the container.

### Per zoom: a lower sieve, a finer raster

Variants against the adopted pipeline at z8, means over the regions. `agreement` is against the source's finest level,
so it does not favour the raster the pipeline already reads. Blocks of `z8-4096` took 21 min instead of 0.3 min.

| variant         | z8 bytes % | agreement z8 % | turning z8 | sharp z8 % | axis z8 % |
| --------------- | ---------- | -------------- | ---------- | ---------- | --------- |
| baseline        | 0          | 87.0           | 30.1       | 47.4       | 6.4       |
| `sieve-3-to-z8` | +21.8      | 88.6           | 33.3       | 52.6       | 6.7       |
| `sieve-2-to-z8` | +42.6      | 89.3           | 36.2       | 55.8       | 6.6       |
| `z8-2048`       | +14.8      | 87.1           | 30.9       | 49.0       | 7.1       |
| `z8-4096`       | +19.7      | 86.9           | 31.9       | 51.0       | 7.6       |

The finer raster costs bytes and gains no agreement, though forest along rivers stays connected in the Hudson Bay render.
The lower sieve gains agreement, at more turning. At z0 it matters most: land agreement against the source's fine level
rises from 81.8 % at 5 px² to 83.4 % at 3, 84.9 % at 1 and 85.4 % at 0.5, and Arctic islands come back, with the tile
growing from 6.8 to 10.6 KB at 1 px². The pipeline therefore adopted `SIEVE_RAMP`, from 1 px² at z0 to 3 px² at z8. Over the planet it
adds 72 MB, 1.6 % of the build, nearly all of it at z7 and z8. The largest tile rises to 72.2 KB, at z7 and z8.

The full build confirms it: 4597 MB of gzipped tiles against 4525 MB before the ramp and 4748 MB before the outlines,
3.2 % less. Its tiles are byte-identical to the planet run at z0–8 and to the previous build at z9–10. Its container
is 4453 MB, against 4458 MB before the outlines.

At z0, unlike z8, a finer raster gains too: at 1 px², 84.9 % at 1024 px, 86.9 % at 2048 and 87.7 % at 4096, for 3, 5 and
25 s. It also shrinks what the pyramid inflates: south of about −55°, land covers 0.49 % in the fine source, 2.2 % at
1024 px and 0.24 % at 4096. Forest stays overdrawn at every setting (31 % in the source, 37–39 % at z0).

Over the planet (variants `low-2048`, `low-4096`), agreement with the source's fine level over up to 40 tiles per zoom:

| zoom | 1024 px | 2048 px | 4096 px | bytes 2048 | bytes 4096 |
| ---- | ------- | ------- | ------- | ---------- | ---------- |
| 0    | 84.9    | 86.9    | 87.7    | +11.0 %    | +11.7 %    |
| 1    | 88.2    | 89.7    | 90.2    | +11.5 %    | +12.9 %    |
| 2    | 90.8    | 91.4    | 91.5    | +12.3 %    | +13.5 %    |
| 3    | 91.9    | 92.4    | 92.3    | +12.2 %    | +15.5 %    |
| 4    | 92.2    | 92.5    | 92.4    | +12.7 %    | +16.5 %    |
| 5    | 90.1    | 90.5    | 90.4    | +14.2 %    | +18.6 %    |
| 6    | 90.2    | 90.6    | –       | +14.7 %    | –          |
| 7    | 91.0    | 91.3    | –       | +15.2 %    | –          |

Turning rises by about 1 degree per px at 2048 and 2 at 4096. z0–7 took 38 min at 2048 and z0–5 alone 76 min at 4096,
on 30 cores. A finer raster pays at z0–2 and hardly from z3 on, so the pipeline adopted `TILE_PX_LOW`: 4096 px at z0–1
and 2048 at z2, for 22 KB.

Forest and water at z0 shift step by step, in shares of the land drawn, in Mercator pixels:

| stage                                   | forest % | water % | KB    |
| --------------------------------------- | -------- | ------- | ----- |
| the source at 262144 px                 | 29.6     | 3.5     |       |
| its pyramid at 4096 px                  | 32.1     | 2.5     |       |
| the tile, without sieve or filter       | 33.9     | 1.7     | 457.9 |
| the tile, with the sieve only (1 px²)   | 37.7     | 0.5     | 16.1  |
| the tile, with the filter only (0.5 px) | 37.0     | 0.4     | 24.3  |
| the tile as built                       | 38.6     | 0.4     | 11.9  |

Most of it is generalization, not the pyramid: what is removed goes to its largest neighbour, mostly forest, and lakes
below the sieve's size cannot stay. Weaker settings buy little: a sieve of 0.1 px² without the filter is 36.1 % and 0.7 %
at 62.9 KB, and a filter of 0.125 px without the sieve 35.5 % and 0.8 % at 109.5 KB.

## Consistency between zooms

Bytes and agreement do not say how well neighbouring zooms fit together, and a map shows that directly: crossing an
integer zoom swaps one zoom's tiles for the next. The **zoom step** of zoom z is the share of z's rendered pixels where
the tiles of z − 1 and of z show a different kind (`zoomSteps` in `lib/measure.ts`). It needs no renderer and no style.
Lower is better, but only if agreement and bytes hold: a blank tileset scores 0, and each zoom is meant to show more than
the last, so it does not reach 0. No target is set yet.

`npm run experiment` reports it per region and in its summary, and `npm run sweep` for the zooms it builds together with
the one below. Means over the regions, with `published` being the container and `baseline` the regional build:

| variant     | step z10 % | step z9 % | step z8 % | agreement z10 % | agreement z8 % |
| ----------- | ---------- | --------- | --------- | --------------- | -------------- |
| `published` | 8.6        | 8.4       | 9.7       | –               | –              |
| `baseline`  | 8.5        | 8.4       | 9.5       | 91.3            | 88.5           |

The published container, per region:

| region            | z8     | z9     | z10    |
| ----------------- | ------ | ------ | ------ |
| berlin-zehlendorf | 11.4 % | 8.3 %  | 8.8 %  |
| berlin-britz      | 10.4 % | 8.1 %  | 8.4 %  |
| uckermark         | 4.6 %  | 5.4 %  | 5.8 %  |
| ruhr              | 13.5 % | 11.7 % | 13.7 % |
| atlanta           | 6.0 %  | 5.2 %  | 6.4 %  |
| nile-delta        | 5.4 %  | 4.8 %  | 4.0 %  |
| lagos             | 8.0 %  | 6.9 %  | 6.4 %  |
| tokyo             | 2.5 %  | 4.2 %  | 5.2 %  |
| alps              | 12.5 % | 9.6 %  | 8.7 %  |
| hudson-bay        | 22.7 % | 19.4 % | 18.3 % |

Reading these numbers:

- A zoom needs the one below it. An experiment therefore also builds z7, so a build from before that has no z8 step.
- The regions are 64 rendered px across at z8, too few to go lower. A sweep measures up to 16 × 16 z12 tiles in the middle
  of its area, not all of it, and only zooms where that window is at least 64 rendered px across, so z6 and up.
- Every pixel in the window counts, sea included, so values compare better between variants of one region than between
  regions.
- All kinds count equally: forest to water weighs the same as grassland to scrub, although the second looks much
  milder on a map.

## Sweeps and `inspect`

```sh
npm run sweep -- --area hudson-bay --zoom 9 --sieve 0,1.77,4         # the raster stage: size and quality
npm run sweep -- --area hudson-bay --zoom 8-10 --detail 1,2,4        # the vector stage
npm run inspect -- 9/129/159 --preview hudson-bay                    # one tile, every variant built for the area
```

A sweep builds the area once per value, prints the worst tile and the [zoom step](#consistency-between-zooms) per zoom
per variant, records each in `doc/size-baseline.json` as `<area>@<knob><value>`, and ends with `npm run inspect` on a reference tile
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
