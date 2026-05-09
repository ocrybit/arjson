# weavepack-graph — 02: Containers

**Status:** Draft. Phase G of the weavepack v0.6 roadmap.

## Scope

This document specifies the **container model** of weavepack-graph —
how nodes, edges, and complete graphs are organized on the wire.

## Container hierarchy

```
graph_document
  ├─ node_block[0]   (N₀ nodes, one label)
  ├─ edge_block[0]   (M₀ edges, one label)
  ├─ node_block[1]   (N₁ nodes, different label)
  └─ edge_block[1]   (M₁ edges, different label)
```

A `graph_document` is a header followed by an ordered sequence of
zero or more `node_block` and `edge_block` segments. The order of
blocks is encoder-defined; a reader MUST process all blocks to
reconstruct the full graph.

## Node block

A `node_block` groups N nodes of the same (or absent) label into a
columnar block with mandatory structural columns and optional property
columns.

### Wire layout

```
block_type    : 1 bit  = 0 (node_block)
num_nodes     : LEB128 uint64
label_len     : LEB128 uint32  (0 = no label)
label_bytes   : label_len bytes (UTF-8)
num_prop_cols : LEB128 uint32
[prop_col_schema × num_prop_cols]
nid_column    : delta-pack uint64 sequence (num_nodes values)
[prop_col_data × num_prop_cols]
```

### Column schema header

Each property column is prefixed with a schema entry:

```
col_id   : LEB128 uint32
ctype    : 4 bits
nullable : 1 bit
[3 padding bits to byte boundary]
```

`col_id` values must be ≥ 2 (col_ids 0 and 1 are reserved for the
mandatory `nid` and `label` columns and are not listed in `prop_col_schema`).

### nid column encoding

The `nid` column contains `num_nodes` monotone strictly-increasing
uint64 node identifiers, encoded using **delta-pack**:

```
first_nid : LEB128 uint64
delta[1]  : LEB128 uint64  (≥ 1; represents nid[1] - nid[0])
delta[2]  : LEB128 uint64  (≥ 1; represents nid[2] - nid[1])
...
delta[N-1]: LEB128 uint64
```

An encoder SHOULD assign nid values densely (delta = 1) when building
a graph from scratch; this minimizes LEB128 byte count. Sparse nid
spaces (delta > 1) are legal for graphs constructed via incremental
delta chains.

A decoder MUST reject a block where any delta is 0 (duplicate nid)
with error class `duplicate_element_id`.

### label column

The block-level label (in `label_bytes`) applies to all nodes in this
block. It is NOT a per-element property column — it is a block-level
discriminant used to separate nodes of different types into distinct
blocks. A decoder uses the block label to route nodes to the correct
node table (in schemaful mode) or to a labeled bucket (in schemaless
mode).

A block with `label_len = 0` represents nodes with no label (unlabeled
nodes). Multiple unlabeled node_blocks in a graph document are legal;
they are merged into a single logical unlabeled node table.

### Property column data

After the `nid` column, property columns appear in `col_id` order.
Each property column's data section:

```
[null_bitmap: ceil(num_nodes / 8) bytes]  (only if nullable = 1)
values                                     (packed per ctype)
```

For `string` and `bytes` ctypes, each value is:
```
byte_count : LEB128 uint32
payload    : byte_count bytes
```

For fixed-width ctypes (bool, int8..int64, uint8..uint64, float32,
float64, date32, timestamp64, node_id), values are packed
consecutively with no per-value framing:

- `bool`: 1 bit per value, LSB-first within each byte.
- `int8`, `uint8`: 8 bits per value.
- `int16`, `uint16`: 16 bits, little-endian.
- `int32`, `uint32`, `float32`, `date32`: 32 bits, little-endian.
- `int64`, `uint64`, `float64`, `timestamp64`, `node_id`: 64 bits, little-endian.

NULL cells contribute no bits to the value array; the null bitmap
identifies their positions.

## Edge block

An `edge_block` groups M edges of the same (or absent) label into a
columnar block with four mandatory structural columns and optional
property columns.

### Wire layout

```
block_type    : 1 bit  = 1 (edge_block)
num_edges     : LEB128 uint64
label_len     : LEB128 uint32  (0 = no label)
label_bytes   : label_len bytes (UTF-8)
num_prop_cols : LEB128 uint32
[prop_col_schema × num_prop_cols]
eid_column    : delta-pack uint64 sequence (num_edges values)
src_column    : uint64 little-endian × num_edges
dst_column    : uint64 little-endian × num_edges
[prop_col_data × num_prop_cols]
```

The `prop_col_schema` format is the same as node_block. Property
column col_ids must be ≥ 4 (col_ids 0–3 are reserved for `eid`,
`src`, `dst`, `label`).

### eid column encoding

Identical to `nid` delta-pack: monotone strictly-increasing uint64
values. The eid space is global across all edge_blocks in a document;
an encoder SHOULD assign eids with no overlap between blocks.

### src and dst column encoding

Plain uint64 arrays (no delta-pack). Each value is an 8-byte
little-endian unsigned integer referencing a nid in the same document.

A decoder MAY validate that all `src` and `dst` values appear as
`nid` values in some `node_block` of the same document (referential
integrity check). This check is OPTIONAL in Level 1 and Level 2
conformance; it is REQUIRED in Level 3 conformance with a schema.

### Property column data

Same layout as node_block property columns, with `num_edges` elements.

## Graph document

### Wire layout

```
graph_version   : LEB128 uint32   = 1 (this specification)
profile_id      : LEB128 uint32   = 6 (weavepack-graph; per core registry)
schema_hash     : 32 bytes SHA-256, or 32 zero bytes (schemaless)
num_blocks      : LEB128 uint32
block[0]        : node_block or edge_block (discriminated by 1-bit block_type prefix)
block[1]        : ...
...
block[num_blocks - 1]
```

The `schema_hash` field is all-zero for schemaless documents. For
schemaful documents, it is the SHA-256 of the canonical schema JSON
(see 06-schemas.md). A decoder in schemaless mode MUST accept all-zero
schema_hash and MUST NOT require schema lookup.

### Block ordering

Blocks MAY appear in any order. An encoder SHOULD place all node_blocks
before edge_blocks to allow a single-pass decoder to validate
referential integrity (src/dst nids exist). This is a RECOMMENDATION,
not a REQUIREMENT.

Within node_blocks, blocks of the same label SHOULD be merged into one
block (smaller header overhead). Splitting one label across multiple
blocks is legal but discouraged.

## Delta frame document

A delta frame is a graph_document-shaped wire unit with an additional
delta header:

```
delta_op    : 3 bits
[op-specific data; see 04-deltas.md]
```

Delta frames are chained using the same LEB128 length-prefix mechanism
as weavepack-core delta chains: each frame is preceded by its byte
length as a LEB128 uint64, allowing a reader to skip unknown frames.
