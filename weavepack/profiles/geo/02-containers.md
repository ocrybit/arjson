# weavepack-geo — Containers

## Document layout

A weavepack-geo document begins with a 1-byte document tag, followed by a
LEB128 block count and zero or more blocks:

```
document:
  [0x08]           1 byte   profile id (geo = 8)
  LEB128 name_len  collection name byte length (0 for unnamed)
  UTF-8  name      collection name bytes
  LEB128 num_blocks
  block*           num_blocks blocks
```

Each `block` starts with a 1-byte block-type tag:

| Tag | Name | Description |
|---|---|---|
| 0x00 | `feature_block` | N features sharing geometry type and property schema |
| 0x01 | `geometry_collection_block` | N GEOMETRY_COLLECTION features |
| 0x02 | `delta_frame` | One or more delta operations on a named collection |
| 0x03–0xFF | reserved | A decoder MUST reject with `unknown_block_type` |

## feature_block

A `feature_block` encodes N features that share:
- The same geometry type (GEOM_TYPE)
- The same coordinate precision (COORD_PRECISION)
- The same altitude flag (HAS_Z)
- The same feature ID kind (FID_KIND)
- The same set of property column descriptors

### Wire layout

```
feature_block:
  [0x00]                     1 byte   block-type tag
  1 byte  geom_type          GEOM_TYPE constant (0–7; see 01-types.md)
  1 byte  coord_precision    COORD_PRECISION constant (0–1)
  1 byte  has_z              HAS_Z flag (0 or 1)
  1 byte  fid_kind           FID_KIND constant (0–2)
  LEB128  num_features       number of features in this block (≥ 1)
  LEB128  num_prop_cols      number of property columns (may be 0)
  [feature_id_column]        present iff fid_kind ≠ FID_ABSENT
  geometry_section           coordinate data + ring/part counts
  prop_columns               num_prop_cols property column records
```

A `feature_block` with `num_features = 0` is a protocol error; a decoder
MUST reject with `empty_feature_block`.

### Feature ID column

Present iff `fid_kind ≠ 0 (FID_ABSENT)`.

For **FID_STRING** (`fid_kind = 1`):

```
feature_id_column:
  for each feature (num_features entries):
    LEB128 byte_len          byte length of feature ID string
    UTF-8  bytes             feature ID bytes
```

For **FID_UINT64** (`fid_kind = 2`):

```
feature_id_column:
  for each feature (num_features entries):
    8 bytes                  uint64 little-endian feature ID
```

### Geometry section

The geometry section layout depends on `geom_type`:

#### POINT (geom_type = 0)

A POINT feature has exactly one vertex. Coordinate columns:

```
geometry_section (POINT):
  x_col   num_features × coord_width bytes   x (longitude) values
  y_col   num_features × coord_width bytes   y (latitude) values
  [z_col] num_features × coord_width bytes   z (altitude), present iff has_z = 1
```

`coord_width` is 8 bytes for FLOAT64 and 4 bytes for FLOAT32.

All `x_col` values are written contiguously, then all `y_col` values, then
(if has_z) all `z_col` values. This columnar layout (rather than interleaved
`[x, y]` pairs) gives compressors a homogeneous float stream per dimension.

#### LINESTRING (geom_type = 1)

A LINESTRING feature has a variable number of vertices (≥ 2). Layout:

```
geometry_section (LINESTRING):
  coord_counts_col   num_features × LEB128   vertex count per feature
  x_col              total_vertices × coord_width bytes
  y_col              total_vertices × coord_width bytes
  [z_col]            total_vertices × coord_width bytes (iff has_z)
```

`total_vertices` is the sum of all `coord_counts_col` values. A
`coord_count` of 0 or 1 is a protocol error; a decoder MUST reject with
`linestring_too_short`.

#### POLYGON (geom_type = 2)

A POLYGON feature has one or more rings. The first ring is the exterior ring;
subsequent rings are interior rings (holes). Each ring is a closed linear
ring: the first and last vertex are identical and MUST be identical in the
encoded data. Layout:

```
geometry_section (POLYGON):
  ring_counts_col    total_rings × LEB128   vertex count per ring
  rings_per_feature  num_features × LEB128  ring count per feature
  x_col              total_vertices × coord_width bytes
  y_col              total_vertices × coord_width bytes
  [z_col]            total_vertices × coord_width bytes (iff has_z)
```

`total_rings` is the sum of all `rings_per_feature` values.
`total_vertices` is the sum of all `ring_counts_col` values.

A `ring_count` (vertex count for one ring) MUST be ≥ 4 (exterior ring must
have ≥ 3 distinct vertices plus the closure vertex). A decoder MUST reject
with `ring_too_short` if any ring_count is < 4.

A `rings_per_feature` of 0 is valid only if `geom_type = NULL_GEOMETRY`;
for POLYGON it is a protocol error. A decoder MUST reject with `polygon_no_rings`.

#### MULTIPOINT (geom_type = 3)

A MULTIPOINT feature is a collection of points. Layout:

```
geometry_section (MULTIPOINT):
  part_counts_col    num_features × LEB128   point count per feature
  x_col              total_points × coord_width bytes
  y_col              total_points × coord_width bytes
  [z_col]            total_points × coord_width bytes (iff has_z)
```

A `part_count` (point count per feature) of 0 is a protocol error; a decoder
MUST reject with `empty_multi_geometry`.

#### MULTILINESTRING (geom_type = 4)

Layout:

```
geometry_section (MULTILINESTRING):
  part_counts_col    num_features × LEB128   line count per feature
  coord_counts_col   total_lines × LEB128    vertex count per line
  x_col              total_vertices × coord_width bytes
  y_col              total_vertices × coord_width bytes
  [z_col]            total_vertices × coord_width bytes (iff has_z)
```

`total_lines` is the sum of all `part_counts_col` values.
`total_vertices` is the sum of all `coord_counts_col` values.

A `part_count` of 0 is a protocol error; a decoder MUST reject with
`empty_multi_geometry`. A line `coord_count` of < 2 is a protocol error; a
decoder MUST reject with `linestring_too_short`.

#### MULTIPOLYGON (geom_type = 5)

Layout:

```
geometry_section (MULTIPOLYGON):
  part_counts_col       num_features × LEB128   polygon count per feature
  rings_per_part_col    total_polygons × LEB128  ring count per polygon
  ring_counts_col       total_rings × LEB128     vertex count per ring
  x_col                 total_vertices × coord_width bytes
  y_col                 total_vertices × coord_width bytes
  [z_col]               total_vertices × coord_width bytes (iff has_z)
```

`total_polygons` is the sum of all `part_counts_col` values.
`total_rings` is the sum of all `rings_per_part_col` values.
`total_vertices` is the sum of all `ring_counts_col` values.

The same ring validation rules as POLYGON apply (ring_count ≥ 4, first ring
per polygon = exterior ring).

#### NULL_GEOMETRY (geom_type = 7)

Features with null geometry have no coordinate data. The geometry section is
empty for this geom_type. Property columns and the feature ID column (if any)
are encoded as for any other feature_block.

### Property columns

```
prop_columns (num_prop_cols entries):
  for each column:
    LEB128 name_len   byte length of property name
    UTF-8  name       property name
    1 byte ctype      0–14 (ctype 15 = fid is not allowed here)
    1 byte nullable   0x00 = not nullable, 0x01 = nullable
    [null_bitmap]     present iff nullable = 0x01; ceil(num_features/8) bytes
    value_data        column payload (encoding per ctype; see 01-types.md)
```

Property column names within a block MUST be unique. Duplicate names are a
protocol error; a decoder MUST reject with `duplicate_prop_name`.

## geometry_collection_block

A `geometry_collection_block` encodes N GEOMETRY_COLLECTION features, where
each feature holds a heterogeneous list of sub-geometries.

```
geometry_collection_block:
  [0x01]                       1 byte   block-type tag
  1 byte  coord_precision       COORD_PRECISION constant (0–1)
  1 byte  has_z                 HAS_Z flag (0 or 1)
  1 byte  fid_kind              FID_KIND constant (0–2)
  LEB128  num_features          number of features
  LEB128  num_prop_cols         number of property columns
  [feature_id_column]           as in feature_block
  LEB128  total_sub_geoms       sum of sub-geometry counts across all features
  sub_geom_counts_col           num_features × LEB128 (sub-geometry count per feature)
  sub_geom_types_col            total_sub_geoms × 1 byte (GEOM_TYPE per sub-geometry)
  sub_geom_payloads             one geometry payload per sub-geometry (see below)
  prop_columns                  as in feature_block
```

Each sub-geometry payload is encoded using the same geometry section layout as
the corresponding GEOM_TYPE in `feature_block`, with `num_features = 1`.

A sub-geometry of type GEOMETRY_COLLECTION (recursive nesting) is not supported.
A decoder MUST reject with `nested_geometry_collection` if a `sub_geom_types_col`
entry has value 6.

## delta_frame

A delta frame applies one or more operations to a named collection. See
04-deltas.md for the full delta encoding.

```
delta_frame:
  [0x02]             1 byte   block-type tag
  LEB128 name_len    collection name byte length (0 = unnamed)
  UTF-8  name        collection name
  LEB128 num_ops     number of operations
  op*                encoded operations (see 04-deltas.md)
```
