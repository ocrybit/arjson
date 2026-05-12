# weavepack-geo — Column Types and Constants

## Column types (ctypes)

weavepack-geo uses the same 16 column types as weavepack-graph, weavepack-ast,
and weavepack-tabular. A decoder MUST refuse any block referencing a ctype ≥ 16
with error `unknown_ctype`.

| ctype | Name | Width | Encoding |
|---|---|---|---|
| 0 | `bool` | 1 bit | Packed in 8-bit bytes; padding bits in the final byte MUST be zero |
| 1 | `int8` | 8 bits | Signed two's complement, little-endian |
| 2 | `int16` | 16 bits | Signed two's complement, little-endian |
| 3 | `int32` | 32 bits | Signed two's complement, little-endian |
| 4 | `int64` | 64 bits | Signed two's complement, little-endian |
| 5 | `uint8` | 8 bits | Unsigned, little-endian |
| 6 | `uint16` | 16 bits | Unsigned, little-endian |
| 7 | `uint32` | 32 bits | Unsigned, little-endian |
| 8 | `uint64` | 64 bits | Unsigned, little-endian |
| 9 | `float32` | 32 bits | IEEE 754 binary32, little-endian |
| 10 | `float64` | 64 bits | IEEE 754 binary64, little-endian |
| 11 | `string` | variable | LEB128 byte-count (unsigned), followed by that many UTF-8 bytes |
| 12 | `bytes` | variable | LEB128 byte-count (unsigned), followed by that many raw octets |
| 13 | `date32` | 32 bits | Days since Unix epoch (1970-01-01), signed, little-endian |
| 14 | `timestamp64` | 64 bits | Microseconds since Unix epoch, signed, little-endian, UTC |
| 15 | `fid` | variable | Feature ID: see § Feature ID encoding below |

Ctype 15 (`fid`) is a geo-profile-specific type used only in the feature-ID
column (see 02-containers.md). In all other profiles, ctype 15 is `node_id`.
The wire encoding of a non-null `fid` value depends on the block-level
`fid_kind` flag (see 02-containers.md § Feature ID column). An encoder
that emits ctype 15 in a user property column (rather than in the reserved
feature-ID slot) MUST be rejected by the decoder with `fid_in_property_col`.

## Nullability

Any property column may be declared nullable. Nullable columns carry a
companion **null bitmap** immediately before the column's value data:

- The null bitmap is a packed bit array of `ceil(num_features / 8)` bytes.
- Bit `i` (0-indexed, LSB-first within each byte) is 1 when the i-th value
  is NULL.
- When a value is NULL, the associated bytes in the value data MUST be written
  as zero by encoders and MUST be ignored by decoders.
- Padding bits in the final byte of the null bitmap MUST be zero.

The feature-ID column and coordinate columns (x, y, z) are never nullable.
Declaring them nullable is a protocol error; a decoder MUST reject with
`invalid_nullable`.

## Geometry type enum (GEOM_TYPE)

| Value | Name | GeoJSON type |
|---|---|---|
| 0 | `POINT` | `"Point"` |
| 1 | `LINESTRING` | `"LineString"` |
| 2 | `POLYGON` | `"Polygon"` |
| 3 | `MULTIPOINT` | `"MultiPoint"` |
| 4 | `MULTILINESTRING` | `"MultiLineString"` |
| 5 | `MULTIPOLYGON` | `"MultiPolygon"` |
| 6 | `GEOMETRY_COLLECTION` | `"GeometryCollection"` |
| 7 | `NULL_GEOMETRY` | GeoJSON Feature with `"geometry": null` |
| 8–255 | reserved | A decoder MUST reject with `unknown_geom_type` |

GEOM_TYPE is stored as a single byte in the block header. A `feature_block`
covers only one GEOM_TYPE; a `geometry_collection_block` uses GEOM_TYPE 6.
A feature with a null geometry uses GEOM_TYPE 7 (NULL_GEOMETRY) and has no
coordinate columns.

## Coordinate precision flag (COORD_PRECISION)

| Value | Name | Coord ctype | Bytes per coordinate | Approx. accuracy at equator |
|---|---|---|---|---|
| 0 | `FLOAT64` | `float64` (ctype 10) | 8 | ~0.1 mm |
| 1 | `FLOAT32` | `float32` (ctype 9) | 4 | ~1.1 m |
| 2–255 | reserved | — | — | A decoder MUST reject with `unknown_coord_precision` |

COORD_PRECISION is stored as a single byte in the block header. It applies to
all coordinate columns (x, y, and z if present) within the block.

## Altitude flag (HAS_Z)

A single byte in the block header indicating whether a z (altitude) column
is present.

| Value | Meaning |
|---|---|
| 0 | No altitude; coordinate columns are x and y only |
| 1 | Altitude present; coordinate columns are x, y, and z |
| 2–255 | reserved; a decoder MUST reject with `unknown_has_z` |

## Feature ID kind (FID_KIND)

| Value | Name | Feature ID encoding |
|---|---|---|
| 0 | `FID_ABSENT` | No feature ID column; all features in this block have no ID |
| 1 | `FID_STRING` | Feature IDs are UTF-8 strings; stored as a `string` column |
| 2 | `FID_UINT64` | Feature IDs are non-negative integers; stored as a `uint64` column |
| 3–255 | reserved | A decoder MUST reject with `unknown_fid_kind` |

FID_KIND is stored as a single byte in the block header. Feature IDs MUST be
unique within a named collection (across all blocks). Duplicate IDs in the
same collection are a protocol error; a decoder MUST reject with `duplicate_fid`.

## Feature ID encoding

For FID_STRING, each feature ID is stored as LEB128 byte-count followed by
UTF-8 bytes (same as the `string` ctype).

For FID_UINT64, each feature ID is stored as an 8-byte little-endian uint64.

An ID of value 0 (FID_UINT64) is valid and distinct from FID_ABSENT. The
`fid_kind` field is the authoritative indicator of whether feature IDs are
present, not the presence or absence of zero values.

## Ring and part count encoding

Polygon ring counts and multi-geometry part counts are stored as LEB128
unsigned integers. Each value represents the number of coordinates (vertices)
in one ring or the number of rings/parts in one multi-geometry part. See
02-containers.md for the full encoding layout.

A ring_count of 0 is a protocol error (every ring must have ≥ 3 vertices plus
closure vertex = ≥ 4 coordinates). A decoder MUST reject with
`empty_ring` if a ring_count is < 4.

A part_count of 0 for MULTIPOINT, MULTILINESTRING, or MULTIPOLYGON is a
protocol error. A decoder MUST reject with `empty_multi_geometry`.
