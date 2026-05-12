# weavepack-ast — benchmarks

**Status:** complete (AS.6). Results from `weavepack/tools/benchmark-ast.js`.

**Environment:** Node.js, brotli quality 6, gzip level 6. Deterministic
synthetic data (LCG seeded per scenario). Run from repo root with:
```
node weavepack/tools/benchmark-ast.js
```

## Comparison methodology

**ESTree JSON + gzip-6** is used as the baseline in all scenarios. ESTree
(the ECMAScript AST standard) is the de-facto format for JavaScript ASTs,
produced by Acorn, Babel, and all major JS parsers. Consumers typically
serialize as `JSON.stringify(ast)` and optionally gzip for transport.

For delta scenarios (scenarios 2 and 3), the baseline is the sum of
**per-snapshot** gzip sizes: the baseline consumer must re-serialize and
re-ship the entire AST on every change. weavepack emits only the incremental
delta frame. This captures the fundamental O(changed_nodes) vs O(full_tree)
asymmetry of the delta model.

---

## Synthetic AST structure

All scenarios use a deterministic 1 001-node synthetic JS AST:

- 1 `Program` (root)
- 40 `FunctionDeclaration` nodes (direct children of Program)
- Per `FunctionDeclaration`:
  - 1 `Identifier` (function name, col_id 4 = `name` string)
  - 1 `BlockStatement` (function body)
    - 11 `ExpressionStatement` nodes (per block)
      - 1 `Identifier` per `ExpressionStatement` (expression, col_id 4 = `name`)

Node kinds: Program (1), FunctionDeclaration (40), Identifier (480),
BlockStatement (40), ExpressionStatement (440).

weavepack encoding: one `node_block` per kind, col_id 4 (`name`, `string`,
nullable) for Identifier blocks.

ESTree JSON encoding: recursive `JSON.stringify` of the standard ESTree tree
object (`{ type, body/id/expression/... }`).

---

## Scenario 1 — AST snapshot

**Setup:** encode the full 1 001-node AST as a single snapshot.
**weavepack:** one tree document with 5 node_blocks (one per kind).
**ESTree JSON:** `JSON.stringify(ast)` + gzip-6.
**Gate:** weavepack brotli-6 ≤ 3× ESTree JSON gzip-6.

| Format | Raw bytes | Compressed bytes |
|--------|-----------|------------------|
| **weavepack raw** | 12,259 | — |
| **weavepack brotli-6** | — | **1,623** |
| ESTree JSON raw | 39,330 | — |
| ESTree JSON gzip-6 | — | 1,187 |

**Ratio (weavepack brotli-6 / ESTree JSON gzip-6):** 1.37×

**Gate (weavepack brotli ≤ 3× ESTree JSON gzip):** PASS ✓

### Analysis

weavepack brotli is 1.37× the ESTree JSON gzip size — comfortably within 3×.
For this small, structurally homogeneous AST, gzip's back-reference advantage
on repetitive JSON keys ("type", "body", "expression", "name") is strong.
weavepack's column layout is more efficient on larger trees and heterogeneous
property schemas. brotli's larger context window partially closes the gap.

---

## Scenario 2 — Symbol rename (50 prop_set frames)

**Setup:** start from the 1 001-node snapshot, then 50 delta frames each
renaming one Identifier's `name` property (col_id 4) via a single `prop_set`
op targeting the node by nid.
**Baseline:** per-frame ESTree JSON gzip-6 (re-serialize full AST each frame).
**Gate:** weavepack raw ≥ 20× smaller than per-snapshot ESTree JSON gzip sum.

| | Total bytes |
|---|---|
| **weavepack delta stream (raw)** | **2,303** |
| **weavepack delta stream (brotli-6)** | **1,328** |
| ESTree JSON per-frame gzip sum (50 frames) | 58,555 |

**Ratio raw (ESTree gzip sum / weavepack raw):** 25.4×

**Gate (weavepack raw ≥ 20× smaller than per-snapshot ESTree JSON gzip):** PASS ✓

### Analysis

Each `prop_set` frame is ~46 bytes (35-byte header + 11-byte op). The full
re-snapshot ESTree JSON gzip is 1,171 bytes per frame. The per-frame ratio is
25×: each weavepack rename frame is 25× smaller than a full re-snapshot.

Over 50 renames: 2,303 bytes weavepack vs 58,555 bytes ESTree — the delta
model delivers a clear O(1) vs O(N) advantage per edit.

---

## Scenario 3 — Edit stream (200 mixed-op frames)

**Setup:** 200 delta frames with random op types (uniform 1/3 each):
- `node_insert`: 5 `ExpressionStatement`+`Identifier` pairs into a random `BlockStatement` (mixed block)
- `prop_set`: rename 1 random `Identifier`'s name
- `node_delete`: remove 2 random `ExpressionStatements` (applier cascades to their Identifier children)

**Baseline:** per-frame ESTree JSON gzip-6 (re-serialize full AST each frame).
**Gate:** weavepack raw ≥ 10× smaller than per-snapshot ESTree JSON gzip sum.

| | Total bytes |
|---|---|
| **weavepack delta stream (raw)** | **14,980** |
| **weavepack delta stream (brotli-6)** | **7,472** |
| ESTree JSON per-frame gzip sum (200 frames) | 259,554 |

**Ratio raw (ESTree gzip sum / weavepack raw):** 17.3×

**Gate (weavepack raw ≥ 10× smaller than per-snapshot ESTree JSON gzip):** PASS ✓

### Analysis

The mixed-op stream includes insert frames (~200 bytes each for a 10-node
mixed block) alongside cheap prop_set (~46 bytes) and node_delete (~40 bytes)
frames. Even with the relatively expensive insert frames, the cumulative
weavepack stream is 17× smaller than the ESTree re-snapshot baseline.

As the tree grows from 1,001 to ~1,300 nodes (net 67 insert frames × 10 nodes
minus 67 delete frames × 4 nodes), each ESTree re-snapshot grows too — but
the weavepack delta size stays proportional to the changed nodes only.

---

## Summary

| Scenario | Metric | Result | Gate | Status |
|---|---|---|---|---|
| 1 — Snapshot | wp-brotli / json-gzip | 1.37× | ≤ 3× | PASS ✓ |
| 2 — Symbol rename (50 frames) | json-gzip-sum / wp-raw | 25.4× | ≥ 20× | PASS ✓ |
| 3 — Edit stream (200 frames) | json-gzip-sum / wp-raw | 17.3× | ≥ 10× | PASS ✓ |

All benchmark gates pass. v0.7 ship criterion §1–5 satisfied pending AS.6
documentation completion.
