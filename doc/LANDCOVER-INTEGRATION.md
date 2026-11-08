# Land cover version 4 and its integration

Version 4 of `landcover-vectors` is drawn as a **source of its own under OSM**, instead of being merged into OSM's
tiles. This document describes the data, how a style uses it, and what other repositories have to change.

Status on 2026-11-04: version 4 is published on download.versatiles.org and served on tiles.versatiles.org, the
merged `osm-landcover` is gone, and versatiles-style v8 draws the land cover under OSM in the hosted styles. Left are
tools' server setup (tools#67), and a look at the repositories under [Not checked](#not-checked).

## Decisions

- **One `landcover` layer, with Shortbread's kinds.** The layer is no longer Shortbread's `land` and
  `water_polygons`, so a Shortbread style can't mistake it for OSM, and a style copies its fills from one source
  layer. The `kind` values stay Shortbread's, so versatiles-style's colours apply as they are.
- **The merged `osm-landcover` is retired.** It is deleted from the Storage Box and from R2, and `/tiles/osm/` serves
  plain OSM. This repository no longer has merge tooling.
- **Attribution and licence.** The container is licensed under the ODbL and contains ESA WorldCover data under
  CC BY 4.0. Its `attribution` starts with OSM's attribution exactly as OSM's Shortbread tiles carry it, so that
  MapLibre, which drops an attribution contained in another one, shows OSM's credit once on a map that draws both.
- **`tile_schema` is `versatiles/landcover@1.0`.** versatiles knows it from 5.6.0 on. No other project has a schema
  field like `tile_schema`; where one tileset combines several schemas, Mapbox and OGC's tileset metadata describe
  them per layer, so a joined name like `shortbread@1.1+…` has no precedent. The name follows the spec's
  `<family>[/<subtype>][@<version>]` and keeps VersaTiles' own schemas together.
- **Version 4 replaces version 3 in place**, as `landcover-vectors.versatiles`, without a date in the name. That is
  how it has been published so far, and with `osm-landcover` retired, nothing depends on version 3 staying available.

## The data

| property      | value                                        |
| ------------- | -------------------------------------------- |
| file          | `landcover-vector.versatiles`                |
| size          | 4.45 GB (brotli)                             |
| format        | VersaTiles container with MVT tiles          |
| zooms         | z0–10; a style overzooms z10 above that      |
| `version`     | `4`                                          |
| `tile_schema` | `versatiles/landcover@1.0`                   |
| layers        | one, `landcover`, with one attribute, `kind` |
| built from    | commit 1d360db, on 2026-11-02                |

| ESA WorldCover class     | `kind`        | OSM's layer      | versatiles-style layer |
| ------------------------ | ------------- | ---------------- | ---------------------- |
| Tree cover               | `forest`      | `land`           | `land-forest`          |
| Cropland                 | `farmland`    | `land`           | `land-agriculture`     |
| Built-up                 | `residential` | `land`           | `land-residential`     |
| Bare / sparse vegetation | `bare_rock`   | `land`           | `land-rock`            |
| Moss and lichen          | `heath`       | `land`           | `land-vegetation`      |
| Shrubland                | `scrub`       | `land`           | `land-vegetation`      |
| Grassland                | `grassland`   | `land`           | `land-grass`           |
| Herbaceous wetland       | `marsh`       | `land`           | `land-wetland`         |
| Mangroves                | `swamp`       | `land`           | `land-wetland`         |
| Snow and ice             | `glacier`     | `water_polygons` | `land-glacier`         |
| Permanent water          | `water`       | `water_polygons` | `water-area`           |

"OSM's layer" is where OSM's Shortbread tiles have the kind, and where the versatiles-style layer reads it.

**Sea.** The sea is a hole. The land cover ends at OSM's coastline, and OSM's `ocean` layer fills the rest.

**OSM land use.** OSM's land use is burned into ESA's classes before the tiles are generalized.

**What changed since version 3.** The layer, the outlines are rounder and the patches kept at low zooms are smaller,
z0–2 read a finer raster, and OSM's land use is burned in. Measured results are in [TUNING.md](TUNING.md).

## How a style draws it

The stacked style has two vector sources: plain OSM, **without** merged land cover, and `landcover-vectors`. The draw
order is:

1. `background`
2. the land cover fills, in versatiles-style's `osm.slots.belowFills` (`slot-below-fills`)
3. `water-ocean`
4. the stock OSM layers, unchanged

Each land cover layer is a copy of the stock fill for its kinds, with these changes:

- `source` is the land cover source, and `source-layer` is `landcover`.
- `id` gets a prefix, for example `landcover-land-forest`.
- `filter` keeps only the kinds of the table, for example `["in", ["get", "kind"], ["literal", ["heath", "scrub"]]]`.
- `minzoom` is removed, so it draws from z0.
- `fill-opacity` is replaced by this fade:

```json
["interpolate", ["linear"], ["zoom"], 12, 1, 14, 0.25]
```

So the land cover is opaque up to z12, fades to 25 % by z14, and stays at 25 % above that. It never disappears
completely, so land OSM doesn't map keeps a hint of colour.

No merge and no `vector_filter_features` are needed. Lakes need no special handling either: from z4, OSM's lakes draw
above the land cover's `water`, which still shows where OSM has no lake.

versatiles-style draws it from v8 on, with `features.landcover`: 9 layers, one for each stock fill that draws one of
the kinds, from a source named `versatiles-landcover`. [`lib/style-versatiles.ts`](../lib/style-versatiles.ts) uses
it, and its tests check that it still draws what this section says.

## Changes in other repositories

Findings come from reading each repository's current state. Nothing below has been tried in those repositories.

### versatiles-rs (done)

Released in 5.6.0, which this repository's pack uses through `@versatiles/versatiles-rs`:

- [versatiles-rs#300](https://github.com/versatiles-org/versatiles-rs/issues/300): accept and keep well-formed
  `tile_schema` values versatiles doesn't know.
- [versatiles-rs#301](https://github.com/versatiles-org/versatiles-rs/issues/301): add `versatiles/landcover@1.0`.

### versatiles-docker (done)

[versatiles-docker#60](https://github.com/versatiles-org/versatiles-docker/issues/60): `versatiles-planetiler
--landcover` merged the public `landcover-vectors.versatiles` into Shortbread's layers. The merge is removed, and
`--landcover` now fails with a pointer to the separate source. All images were rebuilt with versatiles 5.6.0 on
2026-11-01.

### download.versatiles.org (done)

[download.versatiles.org#43](https://github.com/versatiles-org/download.versatiles.org/issues/43). Version 4 is
published as `landcover-vectors.versatiles` since 2026-11-02, in place of version 3, credited to OSM under the ODbL
and to ESA, and described as a separate source. The `osm-landcover` entry is gone. The container was built from
1d360db, and its metadata is as written: `versatiles/landcover@1.0`, one layer `landcover` at z0–10.

`osm-landcover.versatiles` is deleted from R2 too: its URL returns 404 since 2026-11-04.

### tiles.versatiles.org (done)

[tiles.versatiles.org#39](https://github.com/versatiles-org/tiles.versatiles.org/issues/39), closed by 7b29204 on
2026-11-02. `landcover-vectors` is served at `/tiles/landcover-vectors/`, version 4 from 1d360db. In the same update,
`osm` was switched to plain `osm.versatiles`, which it serves since 2026-11-02.

**The switch came before the style.** The plan was to switch `osm` only after the stacked style was rolled out. The
hosted styles had no land cover at z0–10 in between, which was accepted. The styles are versatiles-style v8 since
2026-11-02, and the prebuilt ones draw the land cover from `/tiles/landcover-vectors/`.

### tools (open)

[tools#67](https://github.com/versatiles-org/tools/issues/67): the server setup offers OSM, satellite and
elevation, and should offer `landcover-vectors` too. That means a map option, a size index built from the download,
and its checksum in CI's cache key. With four maps, two generated lines get too long for the layout test. Version 4 is
on download.versatiles.org and tiles.versatiles.org, so it can start.

### versatiles-style (done)

[versatiles-style#145](https://github.com/versatiles-org/versatiles-style/issues/145), released in v8.0.0, with the
prebuilt styles drawing the land cover from v8.1.0 on:

- **`urls.landcover`**: the land cover's TileJSON, by default `/tiles/landcover-vectors/tiles.json` on
  tiles.versatiles.org.
- **`features.landcover: true`** adds that source, `versatiles-landcover`, and the 9 layers at
  `osm.slots.belowFills`, with the fade. The stock OSM layers stay unchanged. Before v8, it meant "the tiles are a
  merge".
- `osm.supportsLandcover(tileJSON)` tells whether a tileset is the land cover, or Shortbread with a `landcover` layer.
- `guessSchema` calls a tileset with only a `landcover` layer `'landcover'`.

### versatiles-documentation (done)

[versatiles-documentation#97](https://github.com/versatiles-org/versatiles-documentation/issues/97) gave the
extended TileJSON spec `versatiles/landcover@1.0`, the pattern's characters and how a client treats values it doesn't
know, and `guides/generate_tiles_from_osm.md` no longer documents `--landcover`.
[versatiles-documentation#96](https://github.com/versatiles-org/versatiles-documentation/issues/96) describes
version 4 instead of the merge: the land cover page, `basics/tilesets.md`, the compendium's summaries and the hosted
`osm` tileset.

### Not checked

These may expose `features.landcover`, whose meaning changed in versatiles-style v8, or assume a single vector
source. They need a look now that the API is settled: versatiles-frontend, maplibre-versatiles-styler, editor, maputnik, node-versatiles-svelte,
versatiles-svg-renderer, versatiles-studio, playground and versatiles-org.github.io.

## Suggested order

1. ~~Settle the schema's name, release versatiles-rs#300 and #301, and add the value to the TileJSON spec~~ (5.6.0,
   versatiles-documentation#97).
2. ~~Remove the land cover merge from versatiles-planetiler (versatiles-docker#60).~~
3. ~~Rebuild version 4 with the `landcover` layer and the schema, then upload and publish it with the corrected
   attribution (download.versatiles.org#43).~~
4. ~~Serve `landcover-vectors` and plain OSM on tiles.versatiles.org (tiles.versatiles.org#39).~~ The switch came
   before the style, see [tiles.versatiles.org](#tilesversatilesorg-done).
5. ~~Release versatiles-style with stacking (versatiles-style#145), and roll the new styles out on
   tiles.versatiles.org.~~
6. ~~Update the documentation (versatiles-documentation#96), and delete `osm-landcover` from R2.~~
7. Offer the land cover in tools' server setup (tools#67), and check the repositories under
   [Not checked](#not-checked).
