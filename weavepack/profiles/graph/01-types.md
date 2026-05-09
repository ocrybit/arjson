# weavepack-graph — 01: Types (Column Types)

**Status:** Draft. Phase G of the weavepack v0.6 roadmap.

## Scope

This document specifies the **column type vocabulary** of
weavepack-graph — the set of primitive types a property column can
carry, their bit widths, value ranges, null semantics, and on-wire
encoding.

weavepack-graph column types are a strict superset of weavepack-tabular
column types (00–14). A decoder that supports weavepack-tabular can
decode any weavepack-graph property column using the same logic, with
the addition of ctype 15 (`node_id`).

## Column type space (4 bits, ctype 0..15)

| ctype | Name | Bits | Range / form |
|---|---|---|---|
| 0 | `bool` | 1 | {false, true} |
| 1 | `int8` | 8 | −128 .. 127 (two's-complement) |
| 2 | `int16` | 16 | −32 768 .. 32 767 |
| 3 | `int32` | 32 | −2^31 .. 2^31−1 |
| 4 | `int64` | 64 | −2^63 .. 2^63−1 |
| 5 | `uint8` | 8 | 0 .. 255 |
| 6 | `uint16` | 16 | 0 .. 65 535 |
| 7 | `uint32` | 32 | 0 .. 2^32−1 |
| 8 | `uint64` | 64 | 0 .. 2^64−1 |
| 9 | `float32` | 32 | IEEE 754 binary32, little-endian |
| 10 | `float64` | 64 | IEEE 754 binary64, little-endian |
| 11 | `string` | variable | LEB128-byte-count + UTF-8 bytes |
| 12 | `bytes` | variable | LEB128-byte-count + raw octets |
| 13 | `date32` | 32 | days since 1970-01-01 (signed int32) |
| 14 | `timestamp64` | 64 | microseconds since 1970-01-01T00:00:00Z (signed int64) |
| 15 | `node_id` | 64 | uint64 with semantic type "node reference" (wire: same as uint64) |

All multi-byte scalar values are stored **little-endian**. String and
bytes values are stored as a LEB128-encoded byte count followed
immediately by the payload bytes. This matches the tabular profile
encoding precisely.

## The `node_id` type (ctype 15)

`node_id` encodes identically to `uint64` on the wire — 8 bytes,
little-endian, unsigned. The distinction is **semantic**:

- A column with ctype `node_id` contains values that are node
  identifiers (`nid` values) from the same graph document's node table.
- This allows traversal APIs to distinguish structural references
  (edges to follow) from data properties (integers to compute) without
  requiring schema information at the column level.
- A decoder that does not understand `node_id` can treat it as `uint64`
  without loss of data; the distinction is purely advisory for consumers.

The mandatory `src` (col_id 1) and `dst` (col_id 2) columns of every
`edge_block` have ctype `node_id`. The mandatory `nid` (col_id 0)
column of every `node_block` has ctype `uint64` (not `node_id`, because
it is the identity column, not a reference to another block).

## Null semantics

Any property column may be declared **nullable**. Nullable columns
carry a companion **null bitmap**: one bit per element in the block,
packed most-significant-bit-first within each byte.

Null bitmap layout (identical to weavepack-tabular):
```
null_bitmap[i] = (bitmap_byte[i >> 3] >> (7 - (i & 7))) & 1
```
A bit of 1 means the cell at position `i` is NULL. A bit of 0 means
the cell has a non-null value.

For NULL cells, **no bits appear in the value column**. The value
column contains only the non-null values, in element-order. A decoder
must iterate the null bitmap to skip NULL positions when reading the
value column.

Non-nullable columns carry no null bitmap.

Mandatory structural columns (`nid`, `eid`, `src`, `dst`) are always
non-nullable. A malformed block that marks any mandatory column as
nullable MUST be rejected with error class `malformed_mandatory_column`.

## Encoding of the mandatory structural columns

The mandatory columns use ctype `uint64` (nid, eid) or `node_id`
(src, dst), but their bit layout is further specialized:

**`nid` column (node_block col_id 0):**
Values are a monotone strictly-increasing sequence of uint64 node
identifiers. Encoded using **delta-pack** (same as weavepack-tabular
`row_id` encoding): the first value is emitted as a LEB128 uint64;
subsequent values are emitted as LEB128 deltas (each delta ≥ 1).

**`eid` column (edge_block col_id 0):**
Same delta-pack as `nid`: monotone, strictly-increasing edge
identifiers.

**`src` and `dst` columns (edge_block col_ids 1 and 2):**
Node references — not necessarily monotone. Encoded as a plain array
of uint64 little-endian values (no delta-pack). Reason: src/dst pairs
in a block of edges of the same label are not generally sorted or
monotone, so delta-pack would not reduce size.

**`label` column (node_block col_id 1; edge_block col_id 3):**
Encoded as ctype `string` (nullable). If all elements in the block
share the same label — the common case for homogeneous blocks — the
string is interned in the strmap and repeated via RLE.

## Capacity limits

To bound decoder memory allocation:

- Maximum nodes in a single node_block: 2^31 − 1 (LEB128 uint64 cap
  applied at the block level; this is a per-block limit, not a
  per-graph limit).
- Maximum edges in a single edge_block: 2^31 − 1 (same).
- Maximum nid or eid value: 2^64 − 1.
- Maximum property column count per block: 65 535 (16-bit col_id).
- Maximum string / bytes property value length: 2^30 bytes (1 GiB
  hard limit). A decoder receiving a LEB128 byte count > 2^30 MUST
  refuse with `string_too_large`.

A graph document may contain arbitrarily many blocks (no per-graph
element count limit), subject to the caller's memory constraints.
