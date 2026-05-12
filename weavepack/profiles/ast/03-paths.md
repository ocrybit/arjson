# weavepack-ast — Paths

## Overview

Paths address nodes or properties within the live tree state. They are used
in delta operations (04-deltas.md) to identify the target of each op.

A path is encoded as a 1-byte header containing:

```
bits 7–4: PATH_KIND (4 bits)
bits 3–0: reserved (MUST be zero on write; MUST be ignored on read)
```

followed by path-kind-specific payload bytes.

## PATH_KIND constants

| Code | Name | Payload | Addresses |
|---|---|---|---|
| 0 | `NODE` | LEB128 nid | A single node by nid |
| 1 | `NODE_COL` | LEB128 nid, LEB128 col_id | A property column of a node by nid + col_id |
| 2 | `NODE_KIND` | LEB128 byte_len, UTF-8 kind | All nodes whose kind equals the given string |
| 3 | `AT_NID` | (none) | The mandatory nid column (col_id 0) |
| 4 | `AT_PARENT` | (none) | The mandatory parent_nid column (col_id 1) |
| 5 | `AT_CHILD_INDEX` | (none) | The mandatory child_index column (col_id 2) |
| 6 | `AT_KIND` | (none) | The mandatory kind column (col_id 3) |
| 7 | `NODE_PROP` | LEB128 nid, LEB128 name_len, UTF-8 name | A property column of a node by nid + property name |
| 8–15 | reserved | — | A decoder MUST reject with `unknown_path_kind` |

## Path semantics

### NODE (code 0)

Addresses a single node. Used by `node_delete`, `node_move`, `subtree_replace`.

Payload: one unsigned LEB128 value giving the target nid.

### NODE_COL (code 1)

Addresses a single typed property slot: the intersection of a node (by nid)
and a column (by col_id). Used by `prop_set` when the caller knows the
column's col_id.

Payload: LEB128 nid, then LEB128 col_id.

col_id 0, 1, 2, 3 address the mandatory columns. Modifying nid (col_id 0)
via `prop_set` is a protocol error; a decoder MUST reject with
`immutable_col`. Modifying parent_nid (col_id 1) or child_index (col_id 2)
via `prop_set` is permitted only when the encoder has already emitted a
`node_move` op in the same delta frame; otherwise it is a protocol error.

### NODE_KIND (code 2)

Addresses all nodes in the live state whose `kind` string matches the
given value. Used by `kind_rename`. Matching is byte-exact UTF-8 comparison;
no wildcards or case-folding.

Payload: LEB128 byte_len followed by the kind string bytes.

### AT_NID, AT_PARENT, AT_CHILD_INDEX, AT_KIND (codes 3–6)

Address the respective mandatory column across all nodes in the live state.
These paths are provided for schema-agnostic traversal APIs and are NOT used
by any standard delta op (which always address specific nodes, not columns
globally). A delta op that references these paths MUST be rejected with
`invalid_path_for_op`.

### NODE_PROP (code 7)

Addresses a single property by nid and property name string. Used by
`prop_set` when the caller knows the column name but not the col_id.
A decoder that cannot resolve the name to a col_id (because no schema is
present and the column has never been seen) MUST reject with
`unknown_property_name`.

Payload: LEB128 nid, LEB128 name_len (bytes), UTF-8 name bytes.

## Path resolution order

Delta ops resolve paths in the following order:

1. The op specifies the path kind.
2. If PATH_KIND == NODE or NODE_COL or NODE_PROP: the nid is looked up in
   the live node table. If not found, the op is a no-op for that nid
   (idempotent; see 04-deltas.md per-op rules).
3. If PATH_KIND == NODE_KIND: all nodes matching the kind string are
   enumerated from the live node table. If no nodes match, the op is a
   no-op.
4. AT_* paths resolve to global column iterators and are not valid targets
   for mutation ops.

## Wire encoding example

A `prop_set` targeting node 42, col_id 4:

```
path header byte: (NODE_COL << 4) | 0x00 = 0x10
payload: LEB128(42) = 0x2A, LEB128(4) = 0x04
total: 0x10 0x2A 0x04
```

A `kind_rename` targeting kind string "Identifier" (10 bytes):

```
path header byte: (NODE_KIND << 4) | 0x00 = 0x20
payload: LEB128(10) = 0x0A, "Identifier" = 10 bytes
total: 0x20 0x0A 0x49 0x64 0x65 0x6E 0x74 0x69 0x66 0x69 0x65 0x72
```
