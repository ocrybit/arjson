# weavepack-geo — 00: Overview

**Status:** Draft. Phase GE of the weavepack v0.8 roadmap.

## What weavepack-geo is

weavepack-geo is a profile of the weavepack universal protocol for encoding
**GeoJSON-compatible geographic feature collections** — points, lines, polygons,
multi-geometries, and heterogeneous geometry collections, each with typed
property columns and optional feature IDs.

It targets the same problem space as GeoJSON, WKB, GeoPackage, and
Flatbuffers/GeoArrow, but adds three capabilities those formats lack:

- **Native delta chains**: a delta frame records only which features were
  inserted, deleted, or modified. Streaming map updates (GPS tracks, live
  sensor overlays, incremental batch imports) transmit O(changed features)
  bytes, not O(collection size).

- **Bit-packed typed property columns**: features with the same geometry type
  and the same property schema are organized into blocks where each property
  occupies one typed column. Boolean properties cost 1 bit per feature. Integer
  and float properties are stored in their exact native width with no JSON text
  overhead.

- **Columnar coordinate storage**: x and y (and optionally z) are stored as
  separate float64 (or float32) columns, giving compressors a homogeneous
  stream of floating-point values per dimension instead of the interleaved
  `[x, y]` pairs of GeoJSON.

Profile identifier: `weavepack-geo` (profile id byte 0x08 in the wire envelope).

## Why it exists

| Format | Binary | Schema | Deltas | Column-enc | Self-desc |
|---|---|---|---|---|---|
| GeoJSON | ✗ | ✗ | ✗ | ✗ | ✓ |
| WKB | ✓ | ✗ | ✗ | ✗ | ✗ |
| GeoPackage | ✓ | ✓ | ✗ | ✗ | ~ |
| GeoArrow/Flatbuffers | ✓ | ✓ | ✗ | ✓ | ✗ |
| MVT (Mapbox Vector Tile) | ✓ | ~ | ✗ | ✗ | ✗ |
| **weavepack-geo** | **✓** | **✓** | **✓** | **✓** | **✓** |

The strategic gap is **incremental geographic updates with typed properties**:

- A ride-share or logistics platform receives continuous position updates for
  thousands of vehicles (each a POINT feature with typed property columns for
  speed, heading, battery level). Every existing format requires re-encoding
  the full feature collection per update tick. weavepack-geo emits
  `prop_set` and `geometry_replace` delta frames touching only changed features.

- A weather radar pipeline emits polygon feature collections for precipitation
  cells, updating cell boundaries and intensity values every 60 seconds.
  weavepack-geo's `feature_insert` / `feature_delete` / `geometry_replace`
  ops cover the full lifecycle without re-encoding unchanged cells.

- A city boundary dataset receives administrative boundary corrections (polygon
  vertex edits, property reclassifications). A `geometry_replace` op for one
  polygon is O(changed vertices); re-encoding the full FeatureCollection is
  O(total vertices).

## Geographic model

weavepack-geo is faithful to the GeoJSON data model (RFC 7946):

- Coordinates are WGS 84 longitude, latitude, optional altitude: (lon, lat[, alt]).
- All geometry types from GeoJSON §3.1–§3.3 are supported:
  Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon,
  GeometryCollection.
- Features carry a geometry (any geometry type, or null), optional typed
  properties, and an optional feature ID (string or integer, matching GeoJSON §3.2).
- FeatureCollections are the primary document unit (matching GeoJSON §3.3).

Deviations from GeoJSON:

1. **Properties are typed and schematized per block.** GeoJSON properties are
   arbitrary JSON objects with no declared schema. weavepack-geo properties are
   declared per feature_block: each property has a name (string), a ctype (one
   of the 16 standard ctypes), and a nullability flag. A decoder can materialize
   a GeoJSON-compatible `properties` object from these typed columns.

2. **Coordinates use binary floating-point, not decimal text.** Float64 preserves
   all GeoJSON precision. Float32 is a lossy block-level option (~1 m accuracy at
   the equator; adequate for many visualisation and consumer GPS use cases).

3. **Feature blocks are homogeneous by geometry type.** A single weavepack-geo
   document may contain multiple feature_blocks, each with a different geometry
   type. A decoder reconstructs a heterogeneous GeoJSON FeatureCollection by
   concatenating all blocks' features in document order.

## Collection names

Collections are identified by a LEB128-length + UTF-8 name string embedded
in the document header or in the `collection_replace` delta op. A document
with a single unnamed collection uses the empty string `""` as the name. Named
collections allow a single weavepack-geo byte stream to carry multiple logically
distinct layers (e.g. `"roads"`, `"buildings"`, `"water"`).

## Round-trip fidelity

A weavepack-geo implementation MUST be able to round-trip any valid GeoJSON
FeatureCollection to and from weavepack-geo with:

- Exact coordinate values (float64 mode).
- Exact feature property values for JSON types that map onto the declared ctypes.
- Exact feature IDs (string or integer or absent).
- Feature order preserved within a block; block order preserved across blocks.

## Relationship to other profiles

weavepack-geo shares the same 16 ctype table as weavepack-tabular,
weavepack-graph, and weavepack-ast. It does not import code from any other
profile; coordinate columns, property columns, and feature-ID columns are all
built using the same ctype primitives defined in 01-types.md.
