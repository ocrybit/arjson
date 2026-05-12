# weavepack-geo — Delta Operations

## Overview

A delta frame (block type 0x02 in the document; see 02-containers.md) encodes
one or more operations against a named collection. The live collection state
is maintained by the decoder as an ordered sequence of feature records, keyed
by feature ID (FID_STRING or FID_UINT64) when IDs are present.

Delta frame wire layout:

```
delta_frame:
  [0x02]             block-type tag
  LEB128 name_len    collection name byte length (0 = unnamed)
  UTF-8  name        collection name
  LEB128 num_ops     number of operations in this frame
  op*                num_ops operation records
```

Each operation record begins with a 1-byte op header:

```
bits 7–3: OP code (5 bits)
bits 2–0: reserved (MUST be zero on write; MUST be ignored on read)
```

## OP codes

| Code | Name | Description |
|---|---|---|
| 0 | `feature_insert` | Insert N new features into the collection |
| 1 | `feature_delete` | Remove one or more features by path or index range |
| 2 | `geometry_replace` | Replace the geometry of a specific feature |
| 3 | `prop_set` | Set or update one property value on a feature |
| 4 | `prop_delete` | Remove a property from a feature |
| 5 | `collection_replace` | Atomic full-snapshot replacement of the collection |
| 6–31 | reserved | A decoder MUST reject with `unknown_delta_op` |

## Op: feature_insert (code 0)

Inserts N new features at the end of the named collection. The features are
encoded as a complete `feature_block` or `geometry_collection_block` payload
(see 02-containers.md), without the outer document header.

```
feature_insert op:
  [0x00]                         op header
  feature_block                  full block encoding (block-type tag through prop_columns)
  | geometry_collection_block    full block encoding
```

Semantics:

- The inserted block's `fid_kind` MUST be compatible with the collection's
  established `fid_kind`. If the collection is empty (this is the first insert),
  the block's `fid_kind` establishes the collection-level `fid_kind`. Subsequent
  inserts MUST use the same `fid_kind`. A mismatch is a protocol error; a decoder
  MUST reject with `fid_kind_mismatch`.

- Feature IDs (if `fid_kind ≠ FID_ABSENT`) MUST be unique within the collection.
  Any ID that already exists in the live collection is a protocol error; a decoder
  MUST reject with `duplicate_fid`.

- Features are appended in block order. A decoder MUST maintain collection order.

- A `feature_insert` that uses GEOM_TYPE 7 (NULL_GEOMETRY) inserts features with
  null geometry; this is valid and represents GeoJSON `"geometry": null` features.

## Op: feature_delete (code 1)

Deletes one or more features from the collection.

Two deletion modes are supported, selected by a 1-byte mode byte:

```
feature_delete op:
  [0x08]              op header  (1 << 3) | 0 = 0x08
  1 byte  mode        0 = path_list, 1 = index_range
  <mode-specific payload>
```

### mode = 0 (path_list)

Deletes features addressed by an explicit list of paths.

```
path_list payload:
  LEB128 count         number of path entries
  path*                count path records (each a FEAT_BY_IDX, FEAT_BY_STR_FID,
                        or FEAT_BY_INT_FID path; see 03-paths.md)
```

Paths MUST address distinct features. Duplicate paths within a single
`feature_delete` op are a protocol error; a decoder MUST reject with
`duplicate_delete_target`.

A decoder that cannot find a targeted feature MUST reject with
`feature_not_found`.

After deletion, the collection's feature sequence is re-indexed (0-based
indices are contiguous). Subsequent `FEAT_BY_IDX` paths in the same frame
that refer to indices ≥ the deleted feature's post-deletion index MUST account
for the shift. The canonical encoding emits deletions in descending index order
within a single `feature_delete` op to avoid index shift ambiguity.

### mode = 1 (index_range)

Deletes a contiguous range of features by index.

```
index_range payload:
  LEB128 start     0-based start index (inclusive)
  LEB128 count     number of features to delete
```

`start + count` MUST be ≤ collection.size. A decoder MUST reject with
`feature_index_out_of_bounds` otherwise.

## Op: geometry_replace (code 2)

Replaces the geometry of one feature without changing its properties or ID.

```
geometry_replace op:
  [0x10]              op header  (2 << 3) | 0 = 0x10
  path                FEAT_GEOMETRY path (see 03-paths.md)
  feature_block       a single-feature block (num_features = 1) encoding the new geometry
```

The embedded `feature_block` MUST have `num_features = 1`, `num_prop_cols = 0`,
and `fid_kind = FID_ABSENT`. Property columns and feature IDs from the original
feature are preserved unchanged. Only the geometry (coordinates and ring/part
structure) is replaced.

The new geometry's `geom_type` may differ from the original feature's
`geom_type`. A decoder MUST update the feature's geometry type in the live
state accordingly.

## Op: prop_set (code 3)

Sets or replaces one property value on a specific feature.

```
prop_set op:
  [0x18]             op header  (3 << 3) | 0 = 0x18
  path               FEAT_PROP_NAME or FEAT_PROP_IDX path (see 03-paths.md)
  1 byte  ctype      the ctype of the new value (0–14)
  value_data         encoded value (encoding per ctype; see 01-types.md)
```

If the property name (or index) already exists in the collection's live schema
for the targeted feature, its value is replaced. If the property name is new:

- The property is added to the feature's schema with the given ctype.
- Other features in the same block are not affected; the new property is
  `NULL` for them (the column is implicitly nullable for features that
  predated the property's introduction).

Setting a property to a value with a ctype different from the column's declared
ctype is not a type error at the delta-application level; the decoder MUST update
the stored value and record the new ctype for this feature. Schema evolution is
the responsibility of the application layer.

## Op: prop_delete (code 4)

Removes a property from a specific feature.

```
prop_delete op:
  [0x20]             op header  (4 << 3) | 0 = 0x20
  path               FEAT_PROP_NAME or FEAT_PROP_IDX path (see 03-paths.md)
```

If the addressed property does not exist on the feature, the operation is a
no-op (idempotent). A decoder MUST NOT reject this op if the property is absent.

When the last feature in a block no longer has a given property (all have been
deleted or never had it), the column is removed from the block's logical schema.

## Op: collection_replace (code 5)

Atomically replaces the entire contents of the named collection with a new
snapshot.

```
collection_replace op:
  [0x28]              op header  (5 << 3) | 0 = 0x28
  LEB128 num_blocks   number of feature_block / geometry_collection_block records
  block*              num_blocks full block encodings (no delta_frame blocks allowed)
```

All previously live features are discarded. The new collection state is
exactly the union of all features in the embedded blocks, in order.

A `collection_replace` that embeds zero blocks results in an empty collection
(all features deleted). This is valid.

A `collection_replace` that embeds a `delta_frame` block (block-type 0x02) is
a protocol error; a decoder MUST reject with `delta_inside_replace`.

## Composition laws

Let `apply(op, state)` denote the function that applies op to collection state.

1. **feature_insert is monotone**: `apply(feature_insert(F), s)` adds F at the
   end of s. `apply(feature_insert(F2), apply(feature_insert(F1), s))` appends
   F1 then F2 regardless of contents.

2. **feature_delete is idempotent** (path_list mode, absent target): deleting a
   feature_id that is not present is a no-op (same final state).

3. **geometry_replace is last-write-wins**:
   `apply(geometry_replace(p, g2), apply(geometry_replace(p, g1), s)) =
    apply(geometry_replace(p, g2), s)`.

4. **prop_set is last-write-wins**:
   `apply(prop_set(p, k, v2), apply(prop_set(p, k, v1), s)) =
    apply(prop_set(p, k, v2), s)`.

5. **prop_delete + prop_set**:
   `apply(prop_set(p, k, v), apply(prop_delete(p, k), s)) = s[feature p, prop k = v]`
   `apply(prop_delete(p, k), apply(prop_set(p, k, v), s)) = s[feature p, no prop k]`

6. **collection_replace dominates**: for any finite sequence of ops O* followed
   by `collection_replace(C)`, the final state equals `apply(collection_replace(C), ∅)`.
   Prior ops are irrelevant.

## Error codes

| Code | Trigger |
|---|---|
| `unknown_delta_op` | op header code ≥ 6 |
| `feature_not_found` | path references a non-existent feature ID |
| `feature_index_out_of_bounds` | FEAT_BY_IDX index ≥ collection.size |
| `duplicate_fid` | feature_insert provides a feature ID already in the collection |
| `fid_kind_mismatch` | path kind and collection fid_kind are incompatible |
| `duplicate_delete_target` | two paths in one path_list delete op address the same feature |
| `delta_inside_replace` | collection_replace embeds a delta_frame block |
| `col_idx_out_of_bounds` | FEAT_PROP_IDX col_idx ≥ num_prop_cols |
| `prop_not_found` | FEAT_PROP_NAME references a property name not in the schema |
