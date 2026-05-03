# Weavepack

[![weavepack-json L3](./weavepack/badges/json/L3.svg)](./weavepack/governance/04-conformance-certification.md)
[![weavepack-tensor L3](./weavepack/badges/tensor/L3.svg)](./weavepack/governance/04-conformance-certification.md)

**Weavepack is a universal structural-data compression and update protocol.**

ARJSON (described in [README.md](./README.md)) is the JSON-specific
implementation of this protocol's first profile. Weavepack generalizes
the same machinery — bit-packed columns, delta chains, optional schema
sidecars, brotli composability — into a protocol that hosts multiple
profiles for different data shapes (JSON, tensors, tables, graphs, ASTs).

## Why this exists

Existing structural-data formats each own a 4-or-5-cell subset of the
following matrix. Weavepack aims to own all 7:

| | bit-pack | deltas | schema | self-desc | streaming | brotli-friendly | universal |
|---|---|---|---|---|---|---|---|
| JSON | ✗ | ✗ | ✗ | ✓ | ✓ | ~ | ✗ |
| CBOR / MessagePack | ✗ | ✗ | ~ | ✓ | ✓ | ~ | ✗ |
| Protobuf / Cap'n Proto | ✗ | ✗ | ✓ | ✗ | ~ | ~ | ✗ |
| Avro | ✗ | ✗ | ✓ | ~ | ✓ | ~ | ✗ |
| Parquet | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ |
| **weavepack** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |

The unique combination is **delta chains over bit-packed columns**,
which no shipping format provides.

## Current state

| Phase | Status |
|---|---|
| 0. ARJSON shipped & stable | ✓ |
| 1. JSON profile spec (5 docs + 93 conformance vectors) | ✓ |
| 2. weavepack-core spec (10 docs) | ✓ |
| 3. JS implementation refactored to protocol/profile boundary | ✓ |
| 4. Property-based testing (14 properties, ~2000 cases per run) | ✓ |
| 5. Tensor profile shipped (spec, impl, 39 vectors, benchmarks) | ✓ |
| 6.1. Rust tensor reference impl | ✓ (39/39 vectors byte-exact) |
| 6.2. Rust JSON reference impl | ✓ (93/93 vectors decode) |
| 6.3. Rust core crate (shared primitives) | ✓ |
| 6.4. Python bindings (PyO3) | ✓ — `impl/rust/weavepack-tensor-py/` (39/39 vectors) |
| 7. Governance prose (8 docs) | ✓ |
| 7. Operational governance: RFC process | ✓ (RFC 0001 in Discussion) |
| 7. Operational governance: registry maintainer, badges, CI | ✓ |
| 7. External implementors guide + call for impls | ✓ |

Plus a pure-Python proof-of-concept implementation covering both
profiles end-to-end (decode + delta application), validating the
spec is implementable from prose alone.

## Headline numbers

- **Tensor sparse delta**: e.g. 100k-element fp32 tensor with 100
  changes (0.1% sparsity) → 0.67 KB delta vs. 391 KB full encode =
  **579× smaller**. See
  [`weavepack/profiles/tensor/SIZE-EXAMPLES.md`](./weavepack/profiles/tensor/SIZE-EXAMPLES.md)
  for reproducible measurements; full benchmark methodology in
  `weavepack/profiles/tensor/07-benchmarks.md`.
- **Tensor snapshot size**: within 2% of safetensors for full
  checkpoints.
- **Cross-language conformance**: **388 vectors agree across 3
  languages** (JS 148 + Rust 93+55 + Python 37+55), 0 failures.
  Verified on every push + PR via `.github/workflows/conformance.yml`;
  reproducible locally via `weavepack/tools/cross-language-check.sh`.
  Includes `region_replace` op in all three implementations, 20
  fp16/bf16 vectors covering ±Inf, qNaN, sNaN, subnormals, RNE
  rounding, and a chain-framing equivalence check.
- **JSON conformance**: 93 byte-exact test vectors, 14 algebraic-law
  property tests over ~2000 random cases per run, all passing.
- **Cross-language**: 3 implementations (JS reference, Rust, Python
  PoC), all in agreement on the byte format for vectors they support.
- **Per-payload addressability**: every chain payload is independently
  retrievable. A 100-version JSON config chain (~600 bytes, 6 bytes/version
  average) lets a consumer fetch and reconstruct any specific version
  by reading only the bytes up to that version's payload — verified by
  regression tests in both profiles. Worked example:
  [`weavepack/profiles/json/examples/chain-partial-restore.js`](./weavepack/profiles/json/examples/chain-partial-restore.js).

## Repository layout

```
arjson/
├── README.md                       (ARJSON — JSON library description)
├── WEAVEPACK.md                    (this file — protocol overview)
├── sdk/                            (JS reference implementation)
│   ├── src/
│   │   ├── encoder.js              (generic Encoder class — substrate)
│   │   ├── artable.js              (column structure)
│   │   ├── utils.js                (bit primitives, alphabets)
│   │   └── profiles/
│   │       ├── json/               (weavepack-json — full impl)
│   │       ├── tensor/             (weavepack-tensor v0.1)
│   │       └── null/               (boundary-validation profile)
│   └── test/                       (2184 tests)
│
├── impl/
│   ├── rust/
│   │   ├── weavepack-core/         (shared bit-level primitives)
│   │   ├── weavepack-tensor/       (Rust tensor crate, 55/55 vectors)
│   │   ├── weavepack-tensor-py/    (PyO3 bindings → Python wheel)
│   │   └── weavepack-json/         (Rust JSON crate, 93/93 vectors)
│   └── python/                     (Pure-Python PoC, 37 + 55 vectors)
│
├── weavepack/                      (the protocol spec + governance)
│   ├── ROADMAP.md                  (phase-by-phase progress)
│   ├── PHASE-3-PLAN.md             (refactor strategy doc)
│   ├── core/                       (10 protocol-level spec docs)
│   ├── profiles/
│   │   ├── json/                   (5 spec docs + 93 vectors)
│   │   └── tensor/                 (6 spec docs + 31 vectors + benchmarks)
│   ├── properties/                 (property-based test generators)
│   ├── governance/                 (8 governance docs)
│   └── tools/                      (vector generators, verifier)
│
└── benchmark/                      (size + speed benchmarks)
```

## Reading order for new contributors

1. **This file** — high-level overview
2. `weavepack/ROADMAP.md` — phase-by-phase progress + design philosophy
3. `weavepack/core/00-introduction.md` — protocol-level intro
4. `weavepack/profiles/json/01-types.md` — concrete example of how a
   profile slots together with the core
5. A profile of interest (`weavepack/profiles/tensor/`) for ML
6. `weavepack/governance/01-rfc-process.md` — how to propose changes

## Adding a profile

See `weavepack/governance/02-profile-registry.md` for the procedure.

Briefly: write 5 spec docs in `weavepack/profiles/<name>/`, build a
reference implementation, ship at least 10 conformance vectors, open
a registration issue. The barrier is "do the work", not "ask permission".

## Adding an implementation

See `weavepack/governance/04-conformance-certification.md` for the
self-assertion procedure. Run the conformance corpus against your
implementation, document which profiles + levels you support, list
your repo in `weavepack/governance/05-implementation-registry.md`.

## License

MIT, matching the rest of the codebase.
