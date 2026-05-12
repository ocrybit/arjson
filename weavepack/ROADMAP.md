# weavepack universal structural-data protocol — ROADMAP

Last updated: 2026-05-12 (governance docs finalised)

---

## Guiding principle

weavepack is a **universal structural-data serialisation protocol** designed to
cover every major data shape — tabular, graph, tensor, document, tree / AST —
under a single consistent binary wire format. Each shape is a **profile**, identified
by a small integer. All profiles share:

* A common **header** (version byte + profile id + optional schema hash)
* **LEB128** length/count fields
* **Column-oriented** value storage so homogeneous arrays compress well
* **Delta chains** for incremental updates

The roadmap below shows the profiles planned or completed, in the order they will
be specified and implemented.

---

## Legend

| Symbol | Meaning |
|--------|-------------------------------------------|
| ✅ | Complete and stable |
| 🔄 | In progress (current focus) |
| 📋 | Planned, not yet started |
| ⏸ | Deferred |

---

## Profile registry

| Profile # | Name | Status | Notes |
|-----------|------|--------|-------|
| 0 | wire (generic framing) | ✅ v0.1 | Length-prefixed frame stream |
| 1 | tabular | ✅ v0.2 | Column-store, nullable, schema |
| 2 | tensor | ✅ v0.3 | N-D array, strided |
| 3 | log | ✅ v0.4 | Append-only event log |
| 4 | json | ✅ v0.5 | Self-describing JSON |
| 5 | graph | ✅ v0.6 | Node+edge property graph |
| 6 | (reserved) | 📋 | TBD |
| 7 | ast | ✅ v0.7 | Code/syntax-tree + delta chains |
| 8 | geo | 📋 | GeoJSON-compatible |
| 9 | time-series | 📋 | High-rate sensor / metric data |
| 10 | document | 📋 | Hierarchical doc (Markdown/HTML) |

---

## v0.1 — Profile 0: wire (generic framing)

**Status:** ✅ Complete (2026-04-15)

**What it is:**
The base framing layer: a length-prefixed binary stream that can carry any
profile as a payload. No semantic content; pure transport wrapper.

**Key decisions:**
* 4-byte big-endian frame length prefix (max 4 GiB per frame)
* Frame payload is opaque bytes — no version negotiation at the frame layer
* Header byte 0 = profile id; header byte 1 = version

**Deliverables:**
* `weavepack/profiles/wire/` — spec document
* `sdk/src/profiles/wire/` — JS reference implementation
* `sdk/tests/profiles/wire/` — conformance tests
* `impl/rust/weavepack-wire/` — Rust crate
* `impl/python/weavepack_wire/` — Python package

---

## v0.2 — Profile 1: tabular

**Status:** ✅ Complete (2026-04-20)

**What it is:**
A compact column-oriented table format. Each row is a typed, nullable value
across a fixed set of named columns. Optimised for analytics workloads where
columns are read independently.

**Key decisions:**
* Schema-first: column ids, types, and nullability declared in header
* Bit-packed null bitmaps (1 bit per row, MSB-first)
* All integer types stored little-endian
* String columns: LEB128 length prefix + UTF-8 bytes

**Deliverables:**
* `weavepack/profiles/tabular/` — spec document + test vectors
* `sdk/src/profiles/tabular/` — JS reference implementation
* `sdk/tests/profiles/tabular/` — conformance tests
* `impl/python/weavepack_tabular/` — Python package

---

## v0.3 — Profile 2: tensor

**Status:** ✅ Complete (2026-04-25)

**What it is:**
N-dimensional dense array format. Covers use cases from simple vectors and
matrices to higher-rank scientific arrays.

**Key decisions:**
* Rank and shape stored as LEB128 arrays
* Strides optional (default: row-major C order)
* Element types: all numeric ctypes (no strings)
* No null support (tensors are dense by definition)

**Deliverables:**
* `weavepack/profiles/tensor/` — spec document + test vectors
* `sdk/src/profiles/tensor/` — JS reference implementation
* `sdk/tests/profiles/tensor/` — conformance tests
* `impl/python/weavepack_tensor/` — Python package

---

## v0.4 — Profile 3: log

**Status:** ✅ Complete (2026-04-28)

**What it is:**
Append-only event log format. Each entry has a monotone timestamp and a
fixed-schema payload. Designed for high-throughput write paths (telemetry,
audit logs, CDC streams).

**Key decisions:**
* Timestamps delta-encoded (LEB128 deltas, first entry absolute)
* Payload columns share schema across all entries in a chunk
* Chunk header carries entry count + schema
* Decoding is streaming: no random access

**Deliverables:**
* `weavepack/profiles/log/` — spec document + test vectors
* `sdk/src/profiles/log/` — JS reference implementation
* `sdk/tests/profiles/log/` — conformance tests
* `impl/python/weavepack_log/` — Python package

---

## v0.5 — Profile 4: json

**Status:** ✅ Complete (2026-05-01)

**What it is:**
Self-describing JSON-compatible binary format. Encodes arbitrary JSON trees
(objects, arrays, strings, numbers, booleans, null) without a pre-declared
schema. Intended as a drop-in replacement for JSON in binary transports.

**Key decisions:**
* Recursive node encoding: type tag + payload
* Object keys stored as LEB128-prefixed UTF-8
* Numbers unified as float64
* Arrays and objects store child count as LEB128

**Deliverables:**
* `weavepack/profiles/json/` — spec documents + test vectors
* `sdk/src/profiles/json/` — JS reference implementation
* `sdk/tests/profiles/json/` — conformance tests
* `impl/python/weavepack_json/` — Python package
* `sdk/src/cli/wpkt-json.js` — CLI (encode/decode JSON)

---

## v0.6 — Profile 5: graph

**Status:** ✅ Complete (2026-05-08)

**What it is:**
Labelled property graph format (nodes + directed edges, each with typed
columnar properties). Covers knowledge graphs, dependency graphs, call graphs,
and similar use cases.

**Key decisions:**
* Separate node blocks and edge blocks in a single document
* Node ids (nids) and edge ids (eids): monotone uint64, delta-packed
* Edge blocks carry source nid + destination nid columns
* Nullable columns: MSB-first null bitmap before value array
* Delta chains: NODE_INSERT, NODE_DELETE, EDGE_INSERT, EDGE_DELETE, PROP_SET,
  SUBGRAPH_REPLACE

**Deliverables:**
* `weavepack/profiles/graph/` — spec documents + test vectors (11 files,
  160+ vectors)
* `sdk/src/profiles/graph/` — JS reference implementation
* `sdk/tests/profiles/graph/` — conformance tests
* `impl/rust/weavepack-graph/` — Rust crate (encode + decode + apply, 160/160
  conformance)
* `impl/python/weavepack_graph/` — Python package (encode + decode + apply,
  160/160 conformance)
* `weavepack/profiles/graph/07-benchmarks.md` — benchmark results

---

## v0.7 — Profile 7: ast

**Status:** ✅ Complete (2026-05-12)

**What it is:**
Code / syntax-tree format with native subtree-delta chains. Tree-specific ops:
node_move (cut-paste O(1) frame), kind_rename (rename all nodes of a kind
in one frame), subtree_replace (atomic subtree swap). Differentiates from
ESTree JSON + gzip and tree-sitter binary on delta efficiency: O(changed_nodes)
bytes per edit vs O(full_tree) re-serialisation.
  AS.0–AS.2 complete 2026-05-12 (plan, spec docs 00–04, JS reference impl).
  AS.3 complete 2026-05-12: 80 conformance test vectors across 11 JSON files
  (types/scalars, types/nulls, containers/node_blocks, containers/tree,
  deltas/node_insert, node_delete, node_move, prop_set, kind_rename,
  subtree_replace, schemas/schemaful); verify-test-vectors.js extended.
  575/575 conformance vectors; 2586/2586 JS SDK tests.
  AS.4 complete 2026-05-12: Rust crate weavepack-ast (types.rs, encode.rs,
  decode.rs, apply.rs, src/bin/conformance.rs) — 80/80 conformance.
  AS.5 complete 2026-05-12: Python package weavepack_ast (types.py, encoder.py,
  decoder.py, apply.py, __init__.py) + conformance_ast.py — 80/80 conformance.
  AS.6 complete 2026-05-12: benchmark-ast.js + 07-benchmarks.md — all 3 gates
  pass (snapshot 1.37×, rename 25.4×, edit-stream 17.3×). v0.7 ship gates met.
  See V0.7-PLANNING.md for full item list.

---

## Governance (cross-cutting)

**Status:** ✅ Active (2026-05-12)

**What it is:**
Protocol-level governance: RFC process, profile registry, versioning
policy, conformance certification, implementation registry, spec
interpretation rules, and implementors' guide.

**Key documents:**
* `weavepack/governance/00-overview.md` — governance rationale and structure
* `weavepack/governance/01-rfc-process.md` — how protocol changes are proposed
* `weavepack/governance/02-profile-registry.md` — registered profiles
* `weavepack/governance/03-versioning.md` — semver rules + breaking-change policy
* `weavepack/governance/04-conformance-certification.md` — conformance levels
* `weavepack/governance/05-implementation-registry.md` — known implementations
  (JS × 8 profiles, Rust × 8 profiles, Python × 8 profiles; 575/575 vectors each)
* `weavepack/governance/06-spec-interpretation.md` — dispute resolution
* `weavepack/governance/07-implementors-guide.md` — getting-started for new impls
* `weavepack/rfcs/` — accepted RFCs: 0001 (fp16/bf16 tensor dtypes),
  0002 (v1.2 magic header for profile-id)
