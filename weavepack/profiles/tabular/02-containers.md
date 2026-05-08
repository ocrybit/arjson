# weavepack-tabular — 02: Containers (Frame Structure)

**Status:** Draft. Phase T of the weavepack v0.4 roadmap.

## Scope

This document specifies the **container model** of weavepack-tabular:
how a frame is structured, how columns are laid out, and how row_ids
are assigned and encoded.

## The frame

A weavepack-tabular document is a **frame** — the top-level container.
A frame holds:

- A schema hash (32 bytes; all-zero = no schema attached)
- A sequence of typed, named columns
- A contiguous range of rows, each identified by a `uint64` row_id

Frames are the unit of transport and storage. A delta chain is a
sequence of frames, each carrying a `frame_type` tag:

| frame_type | Code | Description |
|---|---|---|
| `snapshot` | 0 | Complete materialized table state |
| `delta` | 1 | Incremental change over the previous frame |

The first frame in a chain MUST be a `snapshot` (frame_type = 0).

## Snapshot frame layout

A snapshot frame encodes a complete table at a point in time.

```
snapshot_frame:
  frame_type    : 1 bit  = 0 (snapshot)
  schema_hash   : 256 bits (32 bytes), big-endian
  num_rows      : LEB128 uint64
  num_cols      : LEB128 uint32
  row_ids       : row_id_block (see §Row ID encoding)
  columns       : column_block[num_cols]
```

The `row_ids` block precedes the column data so a reader can build the
row_id → position index before iterating column values.

## Row ID encoding

Row IDs are `uint64` values. Within a snapshot they are stored in
strictly ascending order (the sort order is part of the invariant;
encoders MUST sort; decoders MUST verify).

Row_id encoding uses **delta coding** (same as weavepack-core's
monotone integer sequence encoding):

```
row_id_block:
  first_id      : LEB128 uint64
  deltas[num_rows − 1] : LEB128 uint64 (each delta ≥ 1)
```

For the common case where rows are densely packed (ids = 0, 1, 2, …),
every delta = 1 and the RLE mechanism compresses this to near-constant
overhead regardless of `num_rows`.

A decoder MUST verify that all deltas are ≥ 1 (strict ascent). A
delta of 0 MUST be refused with `duplicate_row_id`.

## Column block

Each column in the snapshot:

```
column_block:
  col_id        : LEB128 uint32
  ctype         : 4 bits  (from 01-types.md)
  nullable      : 1 bit   (1 = column may contain NULL)
  [null_bitmap] : ceil(num_rows / 8) bytes, if nullable = 1
  value_count   : derived: num_rows − popcount(null_bitmap)
  values        : value_column[value_count]  (encoded per ctype)
```

`col_id` is the persistent identity of the column. Within a frame,
col_ids MUST be unique. A decoder reading a duplicate col_id MUST
refuse with `duplicate_col_id`.

`col_id` values need not be contiguous or dense; gaps are allowed
(reserved for schema-evolution purposes). The `col_id` 0 is valid
and has no special meaning.

Without a schema, `col_id` is the only column identity available.
With a schema, column names are resolved through the schema sidecar
(see 06-schemas.md).

### Null bitmap details

The null bitmap is present only when `nullable = 1`. It is stored as
`ceil(num_rows / 8)` bytes, packed MSB-first:

```
null_bitmap[row_i] = (byte[row_i >> 3] >> (7 − (row_i & 7))) & 1
```

A bit of 1 = NULL for that row. Padding bits in the final byte MUST
be 0; a decoder reading a non-zero padding bit MUST refuse with
`invalid_null_bitmap`.

`value_count = num_rows − popcount(null_bitmap)`. The value column
contains exactly `value_count` encoded values, in the row order of
the non-null positions.

### Value column

The value column is a packed sequence of `value_count` values, each
encoded per its ctype (see 01-types.md). Variable-width values
(string, bytes) are stored sequentially with no additional index.
Fixed-width values are packed at their declared bit width.

RLE applies to the value column via the core RLE mechanism. A run of
identical values is encoded as a (count, value) pair.

## Delta frame layout

A delta frame encodes a change to the table relative to the previous
frame. It is smaller than a full snapshot when the change affects a
small fraction of rows and/or columns.

```
delta_frame:
  frame_type    : 1 bit  = 1 (delta)
  schema_hash   : 256 bits (same or updated schema)
  num_ops       : LEB128 uint32
  ops           : delta_op[num_ops]  (see 04-deltas.md)
```

The `schema_hash` in a delta frame MUST match the current active schema
(the schema_hash of the most recent frame with a non-zero hash). If
a `column_add` or `column_drop` delta changes the schema, the new
schema_hash reflects the post-op schema.

## Logical table state

The **logical table state** at any point in the chain is:

1. Start with the snapshot frame: `rows = { row_id → { col_id → value } }`.
2. For each subsequent delta frame, apply each op in order (see 04-deltas.md).

Invariants:
- Every row_id in the logical state is unique.
- Every col_id in the logical state is unique.
- NULL values for nullable columns are represented as absent entries
  in the per-row map (not as a sentinel value).
- Non-nullable columns have a non-NULL value for every row_id in scope.

## Streaming model

A frame chain is a **streaming sequence** — frames are processed in
order and the logical state is maintained as new frames arrive.
Consumers that do not need to materialize the full table can process
delta frames without buffering the full snapshot, provided they only
need the delta content (e.g., a CDC consumer forwarding change events).

Consumers that need random access to the current table state MUST
materialize the snapshot and apply all subsequent deltas in order.
There is no random-access index in the base spec; a conforming
implementation may build one as an out-of-band optimization.
