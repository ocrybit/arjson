# weavepack-ast — Containers

## Block-type tags

Every block in a weavepack-ast payload begins with a 1-byte block-type tag:

| Tag | Name | Description |
|---|---|---|
| 0x00 | `node_block` | N nodes, all sharing the same `kind` string |
| 0x01 | `mixed_block` | N nodes with per-row `kind` values |
| 0x02–0xFF | reserved | A decoder MUST reject with `unknown_block_type` |

## node_block

A `node_block` encodes N nodes of a single kind. The kind string is
stored once in the block header rather than per row.

### Wire layout

```
node_block:
  [0x00]                     1 byte  block-type tag
  LEB128 num_nodes           unsigned LEB128
  LEB128 num_cols            unsigned LEB128; counts user-defined columns only (col_ids ≥ 4)
  kind_string:
    LEB128 byte_len          length in bytes
    UTF-8 bytes              kind name
  mandatory columns:
    nid_column               col_id 0; delta-packed uint64 LEB128
    parent_nid_column        col_id 1; node_id (nullable); see below
    child_index_column       col_id 2; delta-packed uint32 LEB128 (within sibling groups)
  user columns (num_cols entries):
    for each column:
      LEB128 col_id          col_id ≥ 4; must be unique within the block; ascending order
      1 byte ctype           0–15
      1 byte nullable_flag   0x00 = not nullable, 0x01 = nullable
      [null_bitmap]          present iff nullable_flag == 0x01; ceil(num_nodes/8) bytes
      value_data             column payload (encoding per ctype; see 01-types.md)
```

The `kind` column is not stored as a per-row column; it is carried in the
`kind_string` field. A decoder that encounters col_id 3 as a user column
MUST reject the block with `reserved_col_id`.

User column col_ids MUST be written in strictly ascending order. A decoder
reading col_ids out of order MUST reject with `col_id_not_ascending`.

### nid column (col_id 0)

Stored as delta-packed unsigned LEB128 values. See 01-types.md § Delta
encoding for the nid column. The first value is the base nid; each
subsequent value is the delta. All deltas MUST be ≥ 1.

### parent_nid column (col_id 1)

Stored as a nullable `node_id` column (ctype 15). The null bitmap always
precedes the value data, even when `num_nodes == 1`. Each non-null value is
an 8-byte little-endian uint64. The null sentinel value (when the bit is
set) MUST be written as 8 zero bytes by encoders.

Exactly one node per tree document (or per delta payload) MAY have
`parent_nid` = NULL; that node is the root. Documents with multiple NULL
parent_nids encode a **forest** (multiple root nodes). Decoders MUST accept
forests.

### child_index column (col_id 2)

Stored as delta-packed unsigned LEB128. The encoder MUST sort nodes within
the block by `(parent_nid, child_index)` before encoding. Delta encoding
resets at each parent group boundary: the first child_index of a new parent
group is written as an absolute value; subsequent entries within the same
group are written as deltas ≥ 1.

To signal a group boundary, the encoder prefixes the base value of each new
group with a 0 delta byte (`0x00`) followed by the base value as an
absolute LEB128. The decoder interprets a 0 delta as a group separator and
reads the next LEB128 as an absolute base.

Concretely: for parent group sequence `[0, 1, 2]` then parent group
`[0, 1]`, the encoded child_index stream is:

```
abs(0) delta(1) delta(1)  GROUP_SEP abs(0) delta(1)
```

Where `GROUP_SEP` is the single byte `0x00`.

## mixed_block

A `mixed_block` is identical to `node_block` except that the `kind` column
is a per-row `string` column (col_id 3) rather than a block-level constant.

### Wire layout

```
mixed_block:
  [0x01]                     1 byte  block-type tag
  LEB128 num_nodes           unsigned LEB128
  LEB128 num_cols            unsigned LEB128; counts user-defined columns only (col_ids ≥ 4)
  mandatory columns:
    nid_column               col_id 0; same as node_block
    parent_nid_column        col_id 1; same as node_block
    child_index_column       col_id 2; same as node_block
    kind_column              col_id 3; string (ctype 11); not nullable;
                                       LEB128 byte_len + UTF-8 per row
  user columns (num_cols entries):
    same layout as node_block
```

In a `mixed_block`, col_id 3 is the kind column and MUST appear immediately
after the child_index column. User col_ids begin at 4 and MUST be in
ascending order. A decoder that receives col_id 3 in the user-column section
(after the mandatory section) MUST reject with `reserved_col_id`.

## tree document

A tree document is a byte sequence:

```
tree_document:
  [optional schema sidecar]   see 06-schemas.md for presence flag
  block*                      zero or more node_block or mixed_block
```

The schema sidecar, if present, is identified by a 1-byte presence flag
(`0x01` = sidecar follows, `0x00` = no sidecar) before the first block.
A decoder that reads `0x00` proceeds directly to block decoding.

There is no document-level frame length or block count prefix. A decoder
reads blocks until the byte stream is exhausted or an error occurs.

## Column ordering invariant

Within any block, the mandatory columns (nid, parent_nid, child_index, and
kind for mixed_block) MUST appear in the order col_id 0, 1, 2 [, 3] before
any user columns. A decoder reading mandatory columns out of order MUST
reject with `mandatory_col_out_of_order`.

## Size limits

Implementations SHOULD enforce the following soft limits and MAY use them
as circuit breakers:

| Field | Soft limit |
|---|---|
| `num_nodes` per block | 2^20 (1 048 576) |
| `num_cols` per block | 256 |
| `kind_string` length | 4096 bytes |
| property string value length | 65 535 bytes |

Exceeding a soft limit is not a protocol error; encoders MAY produce larger
blocks and decoders MAY accept them. Hard limits are bounded by the uint64
nid space.
