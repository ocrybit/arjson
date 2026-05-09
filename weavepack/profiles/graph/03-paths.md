# weavepack-graph — 03: Paths

**Status:** Draft. Phase G of the weavepack v0.6 roadmap.

## Scope

This document specifies the **path grammar** of weavepack-graph — the
notation used in delta operations to address nodes, edges, and
property columns within a graph document.

## Path grammar (ABNF)

```abnf
path        = element-path / schema-path

element-path = node-path / edge-path

node-path   = "node/" nid
            / "node/" nid "." prop-name
            / "node/" nid "[" col-id "]"
            / "@nid"
            / "@label" "." node-label

edge-path   = "edge/" eid
            / "edge/" eid "." prop-name
            / "edge/" eid "[" col-id "]"
            / "@eid"
            / "@src"
            / "@dst"
            / "@label" "." edge-label

schema-path = "." node-label
            / "." node-label "." prop-name
            / "." node-label "[" col-id "]"
            / "-" edge-label
            / "-" edge-label "." prop-name
            / "-" edge-label "[" col-id "]"

nid         = 1*DIGIT   ; decimal uint64
eid         = 1*DIGIT   ; decimal uint64
col-id      = 1*DIGIT   ; decimal uint32 (≥ 2 for node props; ≥ 4 for edge props)
prop-name   = 1*(ALPHA / DIGIT / "_" / "-")
node-label  = 1*(ALPHA / DIGIT / "_" / "-" / ".")
edge-label  = 1*(ALPHA / DIGIT / "_" / "-" / ".")
```

## Path semantics

### Element-path: addressing specific nodes and edges

`node/N` — the entire node with nid `N`. Used in `node_delete` as the
removal target.

`node/N.prop_name` — the value of the property named `prop_name` on
node `N`. Requires schema; `prop_name` is resolved to a col_id via
the schema's column name table.

`node/N[col_id]` — the value of column `col_id` on node `N`. Works
in schemaless mode (col_id is resolved directly).

`edge/E` — the entire edge with eid `E`. Used in `edge_delete`.

`edge/E.prop_name` — property of edge `E` by name.

`edge/E[col_id]` — property of edge `E` by col_id.

### Special-column aliases

`@nid` — the mandatory nid column (col_id 0) of a node_block. Used
in path expressions that address all nid values, e.g., in a
`prop_set` that resets structural references. (Structural column
writes require schema-level privilege; see 04-deltas.md §Safety.)

`@eid` — the mandatory eid column (col_id 0) of an edge_block.

`@src` — the mandatory src column (col_id 1) of an edge_block.

`@dst` — the mandatory dst column (col_id 2) of an edge_block.

`@label.<label>` — all nodes (or edges) with the given label, used as
a block-level address in `subgraph_replace`. The label is resolved
by the encoder/decoder against the block headers in the document.

### Schema-path: addressing by label

Schema-paths require a schema sidecar (see 06-schemas.md).

`.NodeLabel` — all nodes with label `NodeLabel` (all blocks with that
label, merged). Used as the target of `node_insert` when the block
label is known. The leading `.` distinguishes node labels from edge
labels.

`.NodeLabel.prop_name` — a specific property column across all nodes
with label `NodeLabel`. Used in bulk `prop_set` operations.

`.NodeLabel[col_id]` — same by col_id.

`-EdgeLabel` — all edges with label `EdgeLabel` (leading `-` for edge
labels). Used as the target of `edge_insert`.

`-EdgeLabel.prop_name` — a property column across all edges of a label.

`-EdgeLabel[col_id]` — same by col_id.

## Path resolution

### Without schema

Only element-paths with numeric addresses (`node/N`, `edge/E`,
`node/N[col_id]`, `edge/E[col_id]`) are valid. Paths using
`prop_name` or schema-paths (`.Label`, `-Label`) are invalid in
schemaless mode and MUST be rejected with `schema_required`.

### With schema

All path forms are valid. A decoder resolves `prop_name` to `col_id`
using the schema's column name table for the relevant label.

If `prop_name` does not exist in the schema for the addressed label,
the decoder MUST refuse with `unknown_property`.

If the path addresses a node or edge that does not exist in the
current graph state, the decoder MUST refuse with `element_not_found`.

## Path encoding (wire)

Paths are encoded on the wire in the delta frame as a discriminated
byte string, not as a text string. This avoids the cost of UTF-8
parsing for the common case.

```
path_kind   : 4 bits
path_kind 0 : node/N          → payload: LEB128 uint64 nid
path_kind 1 : node/N[col_id]  → payload: LEB128 uint64 nid + LEB128 uint32 col_id
path_kind 2 : edge/E          → payload: LEB128 uint64 eid
path_kind 3 : edge/E[col_id]  → payload: LEB128 uint64 eid + LEB128 uint32 col_id
path_kind 4 : .NodeLabel      → payload: LEB128 uint32 label_len + label_bytes
path_kind 5 : .NodeLabel[c]   → payload: label + LEB128 uint32 col_id
path_kind 6 : -EdgeLabel      → payload: LEB128 uint32 label_len + label_bytes
path_kind 7 : -EdgeLabel[c]   → payload: label + LEB128 uint32 col_id
path_kind 8 : @nid            → no payload
path_kind 9 : @eid            → no payload
path_kind 10: @src            → no payload
path_kind 11: @dst            → no payload
path_kind 12: @label.<label>  → payload: LEB128 uint32 label_len + label_bytes
              (node or edge determined by context from the op)
path_kind 13: node/N.prop     → LEB128 uint64 nid + LEB128 uint32 label_len
              + label_bytes (prop_name as UTF-8)
path_kind 14: edge/E.prop     → LEB128 uint64 eid + LEB128 uint32 label_len
              + label_bytes (prop_name as UTF-8)
path_kind 15: reserved        → decoder MUST refuse with unknown_path_kind
```

The 4-bit `path_kind` is packed into the 4 MSBs of the first byte of
the path encoding; any remaining bits are filled by the subsequent
payload. A delta op that contains a path encodes it immediately after
the op code in the delta frame.
