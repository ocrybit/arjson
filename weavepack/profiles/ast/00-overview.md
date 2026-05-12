# weavepack-ast — Profile #7 Overview

## What this is

**weavepack-ast** is a binary serialization profile for code syntax trees and
other labeled property trees. It encodes trees with typed property columns per
node kind, and supports a native delta chain model so incremental tree edits
(insert, delete, move, rename, subtree replace) are expressed in O(changed_nodes)
wire bytes rather than O(full_tree) re-serialization.

Profile identifier: `weavepack-ast` (profile id byte 0x07 in the wire envelope).

## Motivation

Existing AST serialization formats have no protocol-level delta semantics:

| Format | Typed | Schema | Deltas | Column-enc | Tree-ops | Self-desc |
|---|---|---|---|---|---|---|
| Acorn JSON | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Babel JSON | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| tree-sitter binary | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ESTree + JSON Patch | ✗ | ✗ | ~ | ✗ | ✗ | ✓ |
| **weavepack-ast** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |

The primary use cases driving the design:

1. **Language server ↔ editor delta streaming.** A language server applying
   incremental edits to an in-memory AST needs to transmit only the changed
   subtree to a client, not the entire file's parse tree.

2. **LLM code generation pipelines.** Streaming AST diffs from a code-generation
   model to a compilation cache or refactoring engine requires compact, typed,
   schema-versioned frames, not full-AST JSON snapshots.

3. **Symbol rename / bulk refactor.** Renaming a variable across N call sites
   generates N `prop_set` ops (~8 bytes each), or a single `kind_rename` op
   (~10 bytes total regardless of N). JSON Patch carries full line context per
   hunk: O(N × line_length) bytes.

## Tree model

A **weavepack-ast** document encodes a **labeled property tree**:

- Each **node** has a unique `nid` (uint64, monotone), a nullable `parent_nid`
  (NULL for root nodes), a `child_index` (uint32, 0-based position among
  siblings), a `kind` (interned UTF-8 string), and zero or more typed property
  columns.
- Nodes are grouped into **node_blocks** by kind (all nodes in a block share
  the same kind string and the same column schema), or into **mixed_blocks**
  when heterogeneous kinds are needed in a single frame.
- A **tree document** is a sequence of node_blocks and/or mixed_blocks, each
  prefixed by a block-type tag.

Tree invariants:

1. **nid uniqueness** — every nid is unique across the document or live state.
2. **parent validity** — every non-root node's `parent_nid` must reference an
   nid present in the document (either in the same payload, in topological
   order, or in the live state when the block is applied as a delta).
3. **sibling ordering** — `child_index` values for siblings of the same parent
   must be unique and contiguous from 0. The encoder assigns them in insertion
   order; delta ops that shift siblings carry the updated `child_index` values
   in-band.

## Relationship to weavepack-graph

weavepack-ast is **not** a subset of weavepack-graph. Both profiles use
nid-addressed columnar node blocks, but:

- weavepack-ast requires mandatory `parent_nid` and `child_index` columns
  (graph has no such requirement).
- weavepack-ast has tree-specific delta ops (`node_move`, `kind_rename`,
  `subtree_replace`) with no graph equivalents.
- weavepack-ast has no edge blocks.
- Profile isolation is strict: `sdk/src/profiles/ast/` imports zero code from
  `sdk/src/profiles/graph/` or any other profile directory.

## Document structure

```
weavepack-ast document
├── [schema sidecar]   optional; SHA-256-identified; see 06-schemas.md
└── payload
    ├── node_block | mixed_block
    ├── ...
    └── node_block | mixed_block
```

Each block starts with a 1-byte block-type tag:
- `0x00` = node_block (all nodes share same kind string)
- `0x01` = mixed_block (per-row kind column)

Payloads are self-describing: a decoder requires no schema to decode any
block, though schema-addressed delta paths (`.KindName.prop_name`) require
the schema sidecar.

## Incumbents and differentiation

**Acorn / Babel ESTree JSON + gzip** — the de-facto standard for JS ASTs.
Every serialization encodes the full tree; incremental updates require
diffing two full-tree snapshots or maintaining application-layer state.
Key fields (`"type"`, `"start"`, `"end"`, `"name"`) repeat across every
node, giving gzip strong back-reference wins on snapshots. weavepack-ast
trades snapshot size parity for O(1) delta ops.

**tree-sitter binary** — typed, compact, language-specific. No delta model;
re-parses and re-encodes the full tree on every mutation. No schema or
self-description. Not applicable outside the tree-sitter parse pipeline.

**ESTree + JSON Patch** — delta semantics via RFC 6902 path operations.
Patches carry string paths and full JSON values; renaming N nodes requires
N patch objects. Not typed; not columnar. Still re-encodes each affected
value as JSON text.

weavepack-ast's structural advantage is the `kind_rename` op: a rename
affecting 1 000 nodes costs ~10 wire bytes (one op frame) vs ~1 000 × 30+
bytes (JSON Patch, one object per renamed node).
