# weavepack-ast — Delta Operations

## Overview

A delta frame encodes one or more operations on a live tree state. The live
state is maintained by the decoder as a mutable map from nid to node record.

A delta payload is:

```
delta_payload:
  LEB128 num_ops          number of operations in this frame
  op*                     num_ops operation records
```

Each operation begins with a 1-byte op header:

```
bits 7–3: OP code (5 bits)
bits 2–0: reserved (MUST be zero on write; MUST be ignored on read)
```

## OP codes

| Code | Name | Description |
|---|---|---|
| 0 | `node_insert` | Insert N nodes (columnar; positions defined by parent_nid + child_index) |
| 1 | `node_delete` | Remove nodes by nid, and all their descendants, from the live state |
| 2 | `node_move` | Move a subtree to a new parent_nid and child_index |
| 3 | `prop_set` | Update one property value on one node |
| 4 | `kind_rename` | Rename every node of a given kind to a new kind string |
| 5 | `subtree_replace` | Atomically replace all descendants of a node with a new subtree |
| 6–31 | reserved | A decoder MUST reject with `unknown_delta_op` |

## Op: node_insert (0)

Inserts N new nodes into the live state. The nodes are encoded as a single
`node_block` or `mixed_block` payload (see 02-containers.md), preceded by a
LEB128 count that MUST equal the `num_nodes` field in the embedded block.
(The count is redundant but allows decoders to pre-allocate without parsing
the block header first.)

```
node_insert op:
  [0x00]                     op header
  LEB128 num_nodes           must equal embedded block's num_nodes
  node_block | mixed_block   full block encoding; block-type tag included
```

Semantics:

- Every nid in the block MUST be absent from the live state. Inserting a
  duplicate nid is a protocol error; a decoder MUST reject with
  `duplicate_nid`.
- The `parent_nid` of each inserted node MUST be NULL (root) or reference
  a nid that is already present in the live state **or** appears earlier in
  topological order within this block. The encoder MUST topologically sort
  nodes within the block (parent before child). A decoder that encounters a
  forward parent reference MUST reject with `parent_not_found`.
- Inserted nodes whose `parent_nid` is non-NULL MUST NOT have a `child_index`
  that collides with any existing child of the same parent. If such a
  collision would occur, the encoder MUST renumber displaced siblings and
  emit their updated `child_index` values as `prop_set` ops in the **same
  delta frame**, immediately following the `node_insert` op.

## Op: node_delete (1)

Deletes one or more nodes (and, recursively, all their descendants) from the
live state.

```
node_delete op:
  [0x08]                     op header  (1 << 3) | 0 = 0x08
  LEB128 num_nids            number of target nids
  nid_list                   delta-packed uint64 LEB128 (same scheme as nid column)
```

Semantics:

- If a referenced nid does not exist in the live state, the delete for that
  nid is a **no-op** (idempotent delete). No error is raised.
- Descendants of a deleted nid are recursively deleted in depth-first order.
  The encoder need not list descendants; the decoder derives them from the
  live state's parent_nid index.
- After deletion, the remaining siblings of a deleted node retain their
  original `child_index` values. The `child_index` values become non-
  contiguous; the encoder SHOULD renumber siblings in the same frame if
  contiguous indices matter to the application, but the protocol does not
  require it.

## Op: node_move (2)

Moves the subtree rooted at a given nid to a new parent and child position.

```
node_move op:
  [0x10]                     op header  (2 << 3) | 0 = 0x10
  LEB128 nid                 the node to move
  LEB128 new_parent_nid      0 = make root (detach from parent); otherwise target parent
  LEB128 new_child_index     0-based index position at the new parent
  LEB128 num_sibling_updates number of sibling child_index updates (may be 0)
  sibling_update*            num_sibling_updates entries:
    LEB128 sibling_nid       nid of a displaced sibling
    LEB128 new_ci            its updated child_index value
```

Semantics:

- The `nid` MUST exist in the live state; otherwise reject with `nid_not_found`.
- `new_parent_nid` MUST exist in the live state (if non-zero); otherwise reject
  with `parent_not_found`.
- Moving a node to be its own ancestor is a protocol error; a decoder MUST
  detect and reject with `cyclic_move`.
- The encoder renumbers displaced siblings at both the source parent (after
  the subtree is removed) and the destination parent (after the subtree is
  inserted). These updates are carried inline in the `sibling_update` list
  rather than emitted as separate `prop_set` ops. The encoder MUST include
  all displaced siblings; the decoder MUST apply all `sibling_update` entries
  atomically with the move.
- After the move, the moved subtree's internal structure is unchanged; only
  the root node's `parent_nid` and `child_index` are updated.

## Op: prop_set (3)

Updates a single property value on a single node.

```
prop_set op:
  [0x18]                     op header  (3 << 3) | 0 = 0x18
  path                       1-byte path header + payload (see 03-paths.md)
                             valid PATH_KINDs: NODE_COL (1), NODE_PROP (7)
  1 byte ctype               0–15; type of the new value
  1 byte nullable_flag       0x00 = not null, 0x01 = null
  [value_bytes]              present iff nullable_flag == 0x00; encoded per ctype
```

Semantics:

- The nid identified by the path MUST exist; if not, the op is a **no-op**.
- The col_id (or name-resolved col_id) identifies the target column.
  col_id 0 (nid) MUST NOT be the target; reject with `immutable_col`.
- If the existing column has a different ctype, the new ctype replaces the
  old one (ctype migration is allowed for user columns; not for mandatory
  columns 1–3).
- Setting a NULL value is permitted only when the column is declared nullable.
  Attempting to set NULL on a non-nullable column is a protocol error; reject
  with `null_on_non_nullable`. (Mandatory columns parent_nid / child_index /
  kind are always non-nullable via prop_set; moving a node changes parent_nid
  and child_index only through `node_move`.)

## Op: kind_rename (4)

Renames every node in the live state whose `kind` equals `old_kind` to
`new_kind`. Encoded as a single frame regardless of how many nodes are
affected.

```
kind_rename op:
  [0x20]                     op header  (4 << 3) | 0 = 0x20
  LEB128 old_len             byte length of old kind string
  UTF-8 bytes                old kind string
  LEB128 new_len             byte length of new kind string
  UTF-8 bytes                new kind string
```

Semantics:

- A decoder iterates the live node table and applies the rename to every
  matching node in O(N) time (N = live node count).
- If no nodes match `old_kind`, the op is a **no-op**.
- `kind_rename` is idempotent: applying the same (old_kind, new_kind) pair
  twice on a state where no nodes have `old_kind` is a no-op on both
  applications.
- `old_kind` == `new_kind` is a legal no-op.

Wire efficiency: renaming a variable named "foo" across 1 000 Identifier
nodes with `kind_rename` costs `1 + 1 + 3 + 1 + 3 = 9` bytes. JSON Patch
would require 1 000 `{ "op": "replace", "path": "/...", "value": "..." }`
objects.

## Op: subtree_replace (5)

Atomically replaces all descendants of a node with a new subtree, while
keeping the root node itself.

```
subtree_replace op:
  [0x28]                     op header  (5 << 3) | 0 = 0x28
  LEB128 root_nid            the node whose children are replaced
  LEB128 num_nodes           node count in the replacement block (may be 0 = delete all children)
  [node_block | mixed_block] present iff num_nodes > 0; full block encoding
```

Semantics:

- `root_nid` MUST exist in the live state; otherwise reject with `nid_not_found`.
- All current descendants of `root_nid` are deleted recursively (depth-first)
  before the new children are inserted.
- If `num_nodes` == 0, the op deletes all descendants and leaves `root_nid`
  as a leaf. No block follows.
- If `num_nodes` > 0, the replacement block is decoded and inserted under
  `root_nid`. Each inserted node's `parent_nid` MUST be `root_nid` or the
  nid of another node in the replacement block (topological order required,
  same as `node_insert`).
- The replacement block MUST NOT contain any nid already present in the live
  state (after the delete step). Duplicate nids are a protocol error; reject
  with `duplicate_nid`.
- `subtree_replace` applied twice on the same root_nid is last-write-wins:
  the second replacement fully supersedes the first.

## Delta composition laws

These laws hold when applying sequences of delta frames to the same live
state:

1. `node_insert` ops with **disjoint nid sets** commute (order-independent).
2. `node_delete` is idempotent: `delete(S)` then `delete(S)` = `delete(S)`.
3. `node_move(nid)` followed by `node_delete(nid)` = `node_delete(nid)`.
4. `prop_set(nid, col_id, v1)` then `prop_set(nid, col_id, v2)` = `prop_set(nid, col_id, v2)` (last-write-wins).
5. `kind_rename(A, B)` is idempotent for the same (A, B) pair.
6. `subtree_replace(nid, T1)` then `subtree_replace(nid, T2)` = `subtree_replace(nid, T2)` (last-write-wins).

## Error codes referenced in this document

| Error | Meaning |
|---|---|
| `unknown_delta_op` | Op code ≥ 6 in a delta frame |
| `duplicate_nid` | node_insert or subtree_replace introduces a nid already in live state |
| `parent_not_found` | Inserted node's parent_nid not in live state and not in same block (topo order violated) |
| `nid_not_found` | node_move or subtree_replace references a nid absent from live state |
| `parent_not_found` | new_parent_nid absent from live state |
| `cyclic_move` | node_move would create a cycle (new_parent is a descendant of moved nid) |
| `immutable_col` | prop_set targets col_id 0 (nid) |
| `null_on_non_nullable` | prop_set sets NULL on a non-nullable column |
