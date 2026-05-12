# weavepack-geo — Paths

## Overview

Paths address features or feature properties within a named collection. They
are used in delta operations (04-deltas.md) to identify the target of each op.

A path is encoded as a 1-byte header:

```
bits 7–4: PATH_KIND (4 bits)
bits 3–0: reserved (MUST be zero on write; MUST be ignored on read)
```

followed by path-kind-specific payload bytes.

## PATH_KIND constants

| Code | Name | Payload | Addresses |
|---|---|---|---|
| 0 | `FEAT_BY_IDX` | LEB128 index | A single feature by 0-based position in the collection |
| 1 | `FEAT_BY_STR_FID` | LEB128 len, UTF-8 bytes | A single feature by string feature ID |
| 2 | `FEAT_BY_INT_FID` | 8 bytes uint64 LE | A single feature by integer feature ID |
| 3 | `FEAT_GEOMETRY` | path to feature (codes 0–2) | The geometry of the addressed feature |
| 4 | `FEAT_PROP_NAME` | path to feature (0–2), LEB128 name_len, UTF-8 name | A named property of the addressed feature |
| 5 | `FEAT_PROP_IDX` | path to feature (0–2), LEB128 col_idx | A property by 0-based column index within the block's schema |
| 6–15 | reserved | — | A decoder MUST reject with `unknown_path_kind` |

Compound paths (codes 3, 4, 5) embed a feature-addressing sub-path (code 0,
1, or 2) inline, followed by additional payload. The decoder reads the inner
path first, then the additional bytes.

## PATH_KIND semantics

### FEAT_BY_IDX (code 0)

Addresses a feature by its 0-based sequential index within the named
collection (ordered across all blocks in document order).

Payload: one unsigned LEB128 value giving the 0-based index.

A decoder receiving an index ≥ collection.size MUST reject the operation
with `feature_index_out_of_bounds`.

### FEAT_BY_STR_FID (code 1)

Addresses a feature by its string feature ID (FID_STRING).

Payload: LEB128 byte-count, then UTF-8 bytes.

Using this path kind against a collection that has `fid_kind = FID_ABSENT`
or `fid_kind = FID_UINT64` is a protocol error; a decoder MUST reject with
`fid_kind_mismatch`.

A decoder that cannot find the given feature ID MUST reject the operation with
`feature_not_found`.

### FEAT_BY_INT_FID (code 2)

Addresses a feature by its integer feature ID (FID_UINT64).

Payload: 8 bytes, little-endian uint64.

Using this path kind against a collection that has `fid_kind = FID_ABSENT`
or `fid_kind = FID_STRING` is a protocol error; a decoder MUST reject with
`fid_kind_mismatch`.

A decoder that cannot find the given feature ID MUST reject the operation with
`feature_not_found`.

### FEAT_GEOMETRY (code 3)

Addresses the geometry of a specific feature. Used by `geometry_replace` ops.

Wire layout:
```
[0x30]              path header (PATH_KIND = 3)
<inner path>        FEAT_BY_IDX, FEAT_BY_STR_FID, or FEAT_BY_INT_FID
```

### FEAT_PROP_NAME (code 4)

Addresses a named property slot of a specific feature.

Wire layout:
```
[0x40]              path header (PATH_KIND = 4)
<inner path>        FEAT_BY_IDX, FEAT_BY_STR_FID, or FEAT_BY_INT_FID
LEB128 name_len     byte length of property name
UTF-8  name         property name bytes
```

Using this path kind to reference a property name not present in the feature's
block schema is a protocol error; a decoder MUST reject with `prop_not_found`.

### FEAT_PROP_IDX (code 5)

Addresses a property by 0-based column index within the feature's block schema.
Primarily used by encoders that already know the column layout; avoids
name-string overhead in tight delta chains.

Wire layout:
```
[0x50]              path header (PATH_KIND = 5)
<inner path>        FEAT_BY_IDX, FEAT_BY_STR_FID, or FEAT_BY_INT_FID
LEB128 col_idx      0-based column index
```

A `col_idx` ≥ the number of property columns in the feature's block is a
protocol error; a decoder MUST reject with `col_idx_out_of_bounds`.

## Path encoding examples

The feature at index 7 in the (unnamed) collection:
```
[0x00]  PATH_KIND = FEAT_BY_IDX
[0x07]  LEB128 index = 7
```

The geometry of the feature with string ID "poi_42":
```
[0x30]  PATH_KIND = FEAT_GEOMETRY
[0x10]  inner PATH_KIND = FEAT_BY_STR_FID
[0x06]  LEB128 name_len = 6
poi_42  UTF-8 bytes
```

The `"speed_kmh"` property of the feature with integer ID 9001:
```
[0x40]  PATH_KIND = FEAT_PROP_NAME
[0x20]  inner PATH_KIND = FEAT_BY_INT_FID
[0x29 0x23 0x00 0x00 0x00 0x00 0x00 0x00]   uint64 LE = 9001
[0x09]  LEB128 name_len = 9
speed_kmh   UTF-8 bytes
```
