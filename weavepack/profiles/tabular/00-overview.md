# weavepack-tabular — 00: Overview

**Status:** Draft. Phase T of the weavepack v0.4 roadmap.

## What weavepack-tabular is

weavepack-tabular is a profile of the weavepack universal protocol for
encoding **structured tabular data** — typed, column-oriented record
sets with native row-level delta-chain support. It targets the same
problem space as Apache Parquet, Apache Arrow IPC, and ORC, but adds
two capabilities those formats lack:

- **Row-level deltas**: a delta chain records only which rows changed
  and which columns within those rows changed. CDC streams, live
  cursor updates, and incremental aggregation transmit diffs instead of
  re-sending entire row groups.

- **Bit-packing**: boolean columns cost 1 bit per row. Integer columns
  are stored at the minimum bit width required by the range actually
  present in the data, not the declared type width. The bit-pack
  substrate from weavepack-core applies everywhere.

A weavepack-tabular document is a **frame** — a finite set of named,
typed columns with a contiguous block of rows identified by `uint64`
row_ids.

## Why it exists

Existing tabular formats:

| Format | Bit-pack | Deltas | Schema | Self-desc | Streaming |
|---|---|---|---|---|---|
| Parquet | ✓ (RLE/Dict) | ✗ | ✓ | ✗ | ✗ |
| Arrow IPC | ✗ (byte-aligned) | ✗ (append-only) | ✓ | ✗ | ✓ |
| ORC | ✓ | ✗ | ✓ | ✗ | ✗ |
| CSV | ✗ | ✗ | ✗ | ✓ | ✓ |
| **weavepack-tabular** | **✓** | **✓** | **✓** | **✓** | **✓** |

The strategic gap is **Change-Data-Capture (CDC) streams**:

- A database replication log delivers row-level update events. Tools
  like Debezium re-serialize the entire row per event even when one
  column changed. A weavepack-tabular `row_update` delta encodes only
  the changed columns — bytes proportional to the edit, not to the
  row width.

- A live analytics pipeline receives 10 000 append events per second.
  Parquet is write-once; each micro-batch requires a new row group.
  weavepack-tabular chains `row_insert` deltas with no snapshot
  overhead between batches.

- A data warehouse receives periodic schema changes (add column, drop
  column). Arrow and Parquet handle this as a new file with a new
  schema; readers must stitch schemas manually. A weavepack-tabular
  chain emits `column_add` / `column_drop` operations in-band; any
  conforming reader reconstitutes the current schema from the chain.

Estimated compression advantage over Parquet+brotli for CDC-style
workloads: the same structural delta advantage demonstrated by the
tensor profile (single-element deltas 3–4× smaller) and the wire
profile (incremental API responses 18× smaller). The ratio depends
on column count vs. changed-column count per event.

## Relationship to weavepack-core

weavepack-tabular uses the same core machinery as weavepack-json,
weavepack-tensor, and weavepack-wire:

- Bit-pack column buffers (`Encoder` from `sdk/src/encoder.js`)
- Wire envelope structure (mode bit + columns)
- Delta chain framing (LEB128 length-prefixed frames)
- Extension gate (for schema sidecar, null bitmaps as columns)

What is profile-specific:

- **Type vocabulary**: 16 column types (bool, int8…int64, uint8…uint64,
  float32, float64, string, bytes, date32, timestamp64, null)
- **Container model**: frame / column / row instead of object/array
  (JSON) or message/repeated/map (wire)
- **Path grammar**: `[col_id]` / `.col_name` / `#row_id` / `#row_id[col_id]`
- **Delta operations**: row_insert, row_update, row_delete, column_add,
  column_drop, column_rename, batch_upsert

## Key design decisions

### Why row_id and not row number?

Row numbers (0-indexed positions) become invalid after any delete or
insert. Row_ids are assigned once and never reassigned; delete removes
a row_id from the logical view but the id is never reused. Update and
delete operations reference row_ids, not positions.

This is the same reason SQL uses primary keys rather than ROWNUM.

Consequence: the null bitmap for a column after N deletions may have
gaps (logical row_ids with no corresponding value). The frame encoding
stores the row_id sequence explicitly so readers can reconstruct the
sparse mapping without a schema.

### Why 4-bit ctype?

16 types covers all Arrow primitive types relevant to analytics. Types
12–15 are mostly assigned (bytes, date32, timestamp64, null), leaving
no free slots. Future types use the extension gate (ctype = 15 with a
follow-up LEB128 extended type id).

Parquet's type system is more complex (BYTE_ARRAY, FIXED_LEN_BYTE_ARRAY,
physical vs. logical types). weavepack-tabular collapses this: `bytes`
is variable-length binary; `string` is bytes + UTF-8 validation.

### Null bitmap placement

Each nullable column carries its null bitmap immediately before the
value data. This keeps null-check latency low (the bitmap is contiguous
with the data it guards) and matches the Arrow layout intuition.
Non-nullable columns carry no bitmap; the schema declares nullability.

Without a schema, a 1-bit `nullable` flag in the column header
determines whether a bitmap is present.

### No dictionary encoding in the base spec

Parquet's dictionary encoding (RLE of integer indices into a per-column
dictionary) is effective for low-cardinality string columns. This profile
defers per-column dictionary encoding to an extension gate rather than
building it into the base spec. The weavepack-core strmap already handles
repeated strings across the whole frame; per-column dictionaries add
complexity without changing the correctness invariants.

If benchmarks show a significant regression on string-heavy, low-cardinality
columns, a `DICT_COL` extension gate entry will be specified in 06-schemas.md.

### Schema sidecar hash

The frame header carries a 32-byte schema hash (SHA-256 of the canonical
schema JSON). All-zero = no schema attached. The same mechanism as
weavepack-wire and weavepack-tensor.

## Scope of this spec

`00-overview.md` — this document: motivation, design decisions, scope.
`01-types.md` — column type vocabulary (ctype table, encodings, null).
`02-containers.md` — frame structure, column layout, row_id semantics.
`03-paths.md` — path grammar for delta addressing.
`04-deltas.md` — delta operation vocabulary and wire encoding.
`05-conformance.md` — test corpus structure and conformance levels.
`06-schemas.md` — schema sidecar format and hash algorithm.
`07-benchmarks.md` — benchmark methodology and results vs. Parquet+brotli.
