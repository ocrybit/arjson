# weavepack-graph — 04: Deltas

**Status:** Draft. Phase G of the weavepack v0.6 roadmap.

## Scope

This document specifies the **delta operation vocabulary** of
weavepack-graph and how each op is encoded on the wire. The chain
semantics inherit from `weavepack-core/05-deltas.md`; this profile
defines the op set tailored to node/edge graph data.

## Operation set

Six operations cover the graph update space:

| Op | Wire code | Purpose |
|---|---|---|
| `node_insert` | 0 | Insert N nodes into the graph (columnar block) |
| `node_delete` | 1 | Remove nodes by nid (implicit edge cleanup) |
| `edge_insert` | 2 | Insert N edges into the graph (columnar block) |
| `edge_delete` | 3 | Remove edges by eid |
| `prop_set` | 4 | Update a property value for a node or edge |
| `subgraph_replace` | 5 | Atomically replace a named subgraph |

The op code is 3 bits. Codes 6–7 are reserved. A decoder reading
op code 6 or 7 MUST refuse with `unknown_delta_op`.

## Per-op encoding

### `node_insert` (code 0)

Insert N new nodes into the graph. The new nodes form a `node_block`
encoded exactly as specified in `02-containers.md`. All nid values in
the inserted block MUST be strictly greater than all nid values
previously seen across all prior `node_insert` operations in this
delta chain.

```
op_code     : 3 bits = 000
[5 padding bits to byte boundary]
node_block  : as per 02-containers.md §Node block wire layout
```

A decoder that receives a `node_insert` with a nid that already exists
in the current graph state MUST refuse with `duplicate_element_id`.

### `node_delete` (code 1)

Remove one or more nodes from the graph. Removing a node implicitly
removes all edges where `src` or `dst` equals the deleted nid.
Implicit edge removal is not separately logged in the delta frame;
the consumer is responsible for cleaning up dangling edge references.

```
op_code     : 3 bits = 001
[5 padding bits to byte boundary]
num_nids    : LEB128 uint64
nid[0]      : LEB128 uint64
nid[1]      : LEB128 uint64
...
nid[N-1]   : LEB128 uint64
```

nid values in the list need not be sorted. Duplicate nid values in a
single `node_delete` frame are legal and idempotent (the node is
deleted at most once). Deleting a nid that does not exist in the
current graph state is a no-op (idempotent).

### `edge_insert` (code 2)

Insert N new edges into the graph. The new edges form an `edge_block`
encoded exactly as specified in `02-containers.md`. All eid values in
the inserted block MUST be strictly greater than all eid values
previously seen across all prior `edge_insert` operations in this
delta chain.

```
op_code     : 3 bits = 010
[5 padding bits to byte boundary]
edge_block  : as per 02-containers.md §Edge block wire layout
```

A decoder that receives an `edge_insert` with an eid that already
exists in the current graph state MUST refuse with
`duplicate_element_id`.

A Level 3 (schemaful) decoder MUST validate that all `src` and `dst`
values in the inserted edge_block correspond to nid values present in
the current graph state. If validation fails: refuse with
`referential_integrity`.

### `edge_delete` (code 3)

Remove one or more edges from the graph by eid.

```
op_code     : 3 bits = 011
[5 padding bits to byte boundary]
num_eids    : LEB128 uint64
eid[0]      : LEB128 uint64
eid[1]      : LEB128 uint64
...
eid[N-1]   : LEB128 uint64
```

Semantics mirror `node_delete`: idempotent, no-op for non-existent
eids, duplicate eids in one frame are harmless.

Unlike `node_delete`, `edge_delete` does NOT transitively remove
other elements — it removes only the specified edges.

### `prop_set` (code 4)

Update the value of one property column for one node or edge. This is
a single-cell update: one element (node or edge), one column, one value.

```
op_code     : 3 bits = 100
[5 padding bits to byte boundary]
path        : encoded path (path_kind 0, 1, 2, 3, 13, or 14; see 03-paths.md)
ctype       : 4 bits
[4 padding bits to byte boundary]
nullable    : 1 bit
is_null     : 1 bit  (only meaningful if nullable = 1; 0 otherwise)
[6 padding bits to byte boundary]
[value      : encoded per ctype; absent if is_null = 1]
```

The `path` MUST address a single property column of a single node or
edge (path_kinds 0–3, 13, 14 from §03-paths.md). Paths addressing
structural columns (`@nid`, `@eid`, `@src`, `@dst`) are NOT permitted
in `prop_set`; those would alter graph structure and must use
`node_delete` + `node_insert` or `edge_delete` + `edge_insert`.

A decoder that receives a `prop_set` targeting a non-existent element
MUST refuse with `element_not_found`.

A decoder that receives a `prop_set` with a `ctype` incompatible with
the schema-declared type for that column MUST refuse with
`type_mismatch` (schemaful mode only; schemaless mode accepts any ctype).

**Last-write-wins**: if the delta chain contains multiple `prop_set`
ops for the same (element, col_id) pair, the final op's value is the
authoritative state.

### `subgraph_replace` (code 5)

Atomically replace a named subgraph (all nodes and edges of a specific
label) with a new subgraph. This is the high-level "replace all nodes
and edges of type X" operation, equivalent to `node_delete` for all
matching nodes + `edge_delete` for all matching edges + `node_insert`
+ `edge_insert` for the new content, but encoded as a single frame.

```
op_code       : 3 bits = 101
[5 padding bits to byte boundary]
flags         : 8 bits
  bit 0 = has_node_block  (1 = replacement node block follows)
  bit 1 = has_edge_block  (1 = replacement edge block follows)
  bits 2-7 = reserved (MUST be 0)
label_len     : LEB128 uint32  (0 = replace unlabeled elements)
label_bytes   : label_len bytes (UTF-8; the label to replace)
[node_block   : as per 02-containers.md; only if has_node_block = 1]
[edge_block   : as per 02-containers.md; only if has_edge_block = 1]
```

Semantics:

1. Remove all nodes from the current graph state where
   `node_block.label == label_bytes`.
2. Remove all edges from the current graph state where
   `edge_block.label == label_bytes`.
3. If `has_node_block = 1`: insert the new `node_block`.
4. If `has_edge_block = 1`: insert the new `edge_block`.

The replacement is atomic within the delta frame. A consumer applies
steps 1–4 as an indivisible unit.

`subgraph_replace` is idempotent when the replacement content is
identical to the current state. It is NOT idempotent in general
(applying it twice with different replacement data results in the
second replacement winning).

## Delta composition laws

The following composition laws hold for well-formed delta chains:

**node_insert + node_delete:**
`node_delete({nid: N})` after `node_insert({nid: N, ...})` results
in no node `N` in the final state. The pair composes to a no-op for
node `N`.

**edge_insert + edge_delete:**
Analogous. `edge_delete({eid: E})` after `edge_insert({eid: E, ...})`
composes to a no-op for edge `E`.

**prop_set commutativity:**
Two `prop_set` ops on different (element, col_id) pairs commute.
Two `prop_set` ops on the same (element, col_id) pair do NOT commute;
order is significant (last-write-wins).

**node_delete and edge cascades:**
`node_delete(N)` subsumes all `edge_delete` ops for edges incident to
`N`. An encoder MAY omit redundant `edge_delete` frames when they
would be cleaned up by a subsequent `node_delete`; a decoder MUST
handle the case where the incident edges were not explicitly deleted.

**subgraph_replace idempotency:**
Two consecutive `subgraph_replace` ops with the same label but
different replacement content are NOT idempotent — the second wins.
Two consecutive `subgraph_replace` ops with identical replacement
content are idempotent.

## Safety invariants

A delta chain is **well-formed** if and only if:

1. All nid values in `node_insert` frames are unique across the chain.
2. All eid values in `edge_insert` frames are unique across the chain.
3. No `prop_set` targets a structural column (`@nid`, `@eid`, `@src`, `@dst`).
4. After applying all frames in order, no edge in the graph state has
   a `src` or `dst` that does not exist as a `nid` in the graph state
   (referential integrity; Level 3 only).

A decoder reading a well-formedness violation MUST refuse with the
appropriate error class:
- Condition 1 or 2: `duplicate_element_id`
- Condition 3: `structural_column_write`
- Condition 4: `referential_integrity`
