# weavepack-ast — Column Types

## Overview

weavepack-ast uses the same 16 column types (ctypes) as weavepack-graph.
ctype values 0–15 are exhaustive; a decoder MUST refuse any block that
references a ctype ≥ 16 with error `unknown_ctype`.

## ctype table

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
| 15 | `node_id` | 64 bits | uint64 little-endian; semantically "a reference to another node's nid" |

## The `node_id` type (ctype 15)

`node_id` encodes an 8-byte little-endian uint64 but carries the semantic
type "node reference". It is used for:

- **`parent_nid`** (col_id 1) — the parent node reference. NULL sentinel:
  all-zeros (0x0000000000000000) with the nullable bit set in the null bitmap.
  A root node has `parent_nid` = NULL.
- Any user-defined property column that stores a cross-tree or back-reference.

Distinguishing `node_id` from plain `uint64` (ctype 8) at the type level
lets traversal APIs follow parent chains without requiring schema metadata.
The wire encoding is identical to `uint64`; the distinction is purely in
the ctype byte.

## Nullability

Any column may be declared nullable. Nullable columns carry a companion
**null bitmap** interleaved in the column data section:

- The null bitmap immediately precedes the column's value data.
- It is a packed bit array of `ceil(num_nodes / 8)` bytes.
- Bit `i` (0-indexed, LSB-first within each byte) is set to 1 when the
  corresponding value is NULL.
- When a value is NULL, the associated bytes in the value data MUST be
  written as zero (encoders) or ignored (decoders). Decoders MUST NOT
  interpret zero-value bytes as meaningful when the null bit is set.

The `nid` column (col_id 0) and `child_index` column (col_id 2) are
never nullable. Declaring them nullable is a protocol error; a decoder
MUST reject the block with `invalid_nullable`.

The `kind` column (col_id 3) in a node_block is stored as a block-level
constant (the `kind_string` field in the block header) rather than a
per-row column, so nullability does not apply.

## Delta encoding for the nid column

The `nid` column (col_id 0, ctype uint64) uses **delta encoding** for
compact storage. The encoder writes:

1. The first nid as a full LEB128 uint64 (base value).
2. Each subsequent nid as a LEB128 uint64 delta from the previous nid.
   The delta MUST be ≥ 1 (nids are strictly monotone within a block).

The decoder reconstructs absolute nids by prefix-summing. A decoder reading
a delta of 0 MUST reject the block with `nid_not_monotone`.

The `child_index` column (col_id 2) uses the same delta encoding within each
sibling group (nodes sharing the same parent_nid, after the encoder sorts by
`(parent_nid, child_index)`). The first child_index of each group is the base;
subsequent entries are deltas. Encoders MUST sort nodes within a block by
`(parent_nid, child_index)` to maximise delta compression.

## LEB128 conventions

- All LEB128 values in weavepack-ast are **unsigned** LEB128 unless
  explicitly stated otherwise.
- The maximum decodable unsigned LEB128 value is 2^64 − 1 (10 bytes).
- The maximum decodable signed LEB128 value is ±2^63 − 1 (10 bytes).
- Over-long encodings (e.g. encoding 0 as 0x80 0x00) are a protocol error;
  a decoder MUST reject with `overlength_leb128`.
