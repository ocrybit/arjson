# Weavepack — Universal Structural-Data Protocol

**Status:** Concept phase. Planning document. No code yet.

## What weavepack is

Weavepack is a **universal structural-data compression and update protocol**.

It is the protocol that ARJSON has implicitly been all along. Today, ARJSON
ships as a JSON-specific library, but the underlying machinery
(typed columns, run-length encoding, dedup, bit-packed deltas, optional
schema sidecars) is data-shape-agnostic. Weavepack is the formalization of
that machinery as a standalone protocol with **profiles** for specific
data shapes.

```
weavepack-core — the protocol
  │   typed columns · RLE · dedup · bit-packed deltas · schema sidecars
  │   wire envelope · extension gates · profile registry
  │
  ├─ Profile: weavepack-json     (today's ARJSON; first instantiation)
  ├─ Profile: weavepack-cbor     (binary blobs, tags, undefined)
  ├─ Profile: weavepack-tensor   (ML weights with delta updates)
  ├─ Profile: weavepack-graph    (RDF, property graphs)
  ├─ Profile: weavepack-ast      (code/syntax trees)
  ├─ Profile: weavepack-tabular  (dataframes, parquet-equivalent)
  ├─ Profile: weavepack-wire     (RPC, protobuf-equivalent)
  ├─ Profile: weavepack-log      (structured event streams)
  └─ Profile: weavepack-custom   (caller-defined type tables)
```

JSON is one profile. The protocol is the product.

## Why this exists

arjson's current design is more general than its JSON-specific surface
admits. The four invariants that make arjson special — bit-level packing,
delta chains, optional schemas, brotli composability — are properties of
**structural data compression**, not of JSON.

Every existing format owns 4-5 of the cells in this matrix. Weavepack would
own all 7:

| | bit-pack | deltas | schema | self-desc | streaming | brotli-friendly | universal |
|---|---|---|---|---|---|---|---|
| JSON | ✗ | ✗ | ✗ | ✓ | ✓ | ~ | ✗ |
| CBOR | ✗ | ✗ | ~ | ✓ | ✓ | ~ | ✗ |
| MessagePack | ✗ | ✗ | ✗ | ✓ | ✓ | ~ | ✗ |
| Protobuf | ✗ | ✗ | ✓ | ✗ | ~ | ~ | ✗ |
| Cap'n Proto | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Avro | ✗ | ✗ | ✓ | ~ | ✓ | ~ | ✗ |
| Parquet | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ |
| **weavepack** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |

The unique combination is **delta chains over bit-packed columns**, which
no shipping format provides.

## Design principles

These are non-negotiable. They derive from the philosophy that produced
ARJSON in the first place.

1. **Every bit, precise math.** Layout decisions are justified by entropy
   analysis, not by analogy to other formats. Standards-conformance is not
   a goal in itself — if a standard is wasteful, we route around it.

2. **Profile isolation.** Profiles are separable. A consumer that only
   needs weavepack-json should not pay for weavepack-tensor's type table.
   Wire envelope carries `profile-id`; decoder dispatches.

3. **Delta-first.** Every profile must define delta semantics. Snapshot-only
   profiles are not weavepack. The delta chain is the unit of storage; the
   single-payload form is just a chain of length 1.

4. **Schema is optional, not required.** Weavepack-with-schema gives bit-
   level entropy approaching Shannon bounds. Weavepack-without-schema gives
   self-describing payloads at higher cost. Consumers choose; the protocol
   supports both modes per profile.

5. **Brotli composability.** Column layouts are preserved through the
   wire envelope so brotli can see the regularity. Weavepack + brotli must
   beat alternatives on every measured pipeline.

6. **No conformance theater.** Compatibility shims with existing formats
   (RFC 6902, JSON Patch, etc.) are rejected. We define our own primitives
   based on what the protocol can express most efficiently.

7. **Reversibility before optimization.** Round-trip correctness
   (`decode(encode(x)) = x`) is invariant. Speed and size optimizations
   that break round-trip are rejected, full stop.

## Scope of the protocol

**weavepack-core specifies:**

- Typed value columns (variable bit width per profile)
- Container references (parent/key/index pointers)
- String interning (strmap, char encoding, dedup)
- Run-length encoding for flag and type columns
- Delta-pack for monotone integer sequences
- Extension gate (optional sections after the core columns)
- Wire envelope (version, profile-id, length-prefixed deltas)
- Schema sidecar mechanism (hash-addressed, optional)
- Conformance test corpus structure

**weavepack-core does NOT specify:**

- The set of value types (each profile declares this)
- The set of container shapes (each profile declares this)
- The path/navigation grammar (each profile declares this)
- The delta operation vocabulary (each profile declares this)
- The schema language (each profile declares this; profiles can share)

A profile is the closure that fills these gaps for a specific data shape.

## Roadmap

The plan is staged. Each stage produces a deliverable that is useful on
its own and reduces the risk of the next stage. Stages are gated by
checkpoints; we do not proceed past a gate without the deliverable.

### Phase 0 — Stabilize ARJSON (already done)

ARJSON v0.1.x is shipped, has 367 regression tests, has weavedb in
production. This is the proof point that the underlying machinery works
for at least one profile.

**Status:** Complete.
**Don't disturb during weavepack work.** ARJSON continues to ship from
`sdk/` against the JSON-specific API. Weavepack development happens in
`weavepack/` until profile #2 is ready, at which point we revisit
how arjson and weavepack relate (rebrand the npm package vs coexist).

### Phase 1 — Spec the JSON profile retroactively (~3 weeks)

Write `weavepack/profiles/json/` documenting what arjson IS today. Pure
documentation work, no behavior change in the code base.

**Deliverables:**

- `weavepack/profiles/json/01-types.md` — null, bool, num, str
- `weavepack/profiles/json/02-containers.md` — object, array
- `weavepack/profiles/json/03-paths.md` — `.` and `[n]` grammar
- `weavepack/profiles/json/04-deltas.md` — replace, add, remove, splice, diff
- `weavepack/profiles/json/05-conformance.md` — test corpus structure
- `weavepack/profiles/json/test-vectors/` — `(input, deltas, expected-bytes)`
  tuples extracted from current arjson test suite

**Gate:** Someone unfamiliar with the codebase can implement a
weavepack-json encoder/decoder from the spec alone and pass all test vectors.
Validated by: write a minimal Python decoder from spec, confirm it
agrees with the JS reference on the test corpus.

### Phase 2 — Spec weavepack-core (~3 weeks)

Write `weavepack/core/` documenting the protocol-level invariants
independently of any profile. The JSON profile already conforms; the spec
makes that conformance explicit.

**Deliverables:**

- `weavepack/core/00-introduction.md`
- `weavepack/core/01-data-model.md` — typed columns, refs, structural layout
- `weavepack/core/02-wire-format.md` — envelope, version, profile-id, sections
- `weavepack/core/03-bit-encoding.md` — column packing, RLE, delta-pack, varint
- `weavepack/core/04-strmap.md` — string interning, char encoding
- `weavepack/core/05-deltas.md` — delta chain semantics, composition laws
- `weavepack/core/06-schemas.md` — optional schema sidecar, hash addressing
- `weavepack/core/07-extensions.md` — extension gate, profile registry
- `weavepack/core/08-security.md` — DoS bounds, adversarial inputs
- `weavepack/core/09-conformance.md` — core-level test corpus

**Gate:** The JSON profile spec from Phase 1 can be re-expressed as
"weavepack-core + JSON-specific tables" without any duplicated normative
text. Validation: line-by-line review confirms every statement in
`profiles/json/` either references a `core/` definition or extends one.

### Phase 3 — Refactor sdk/ to the protocol/profile boundary (~4 weeks)

Restructure the JS implementation so the JSON-specific code is localized
behind a profile descriptor. No wire format change. No behavior change.

**Deliverables:**

- `sdk/src/core/` — profile-agnostic encoder/decoder/builder/artable
- `sdk/src/profiles/json/` — JSON-specific type table, paths, delta vocabulary
- `sdk/src/index.js` — exports `ARJSON` (JSON profile) as the default; also
  exports `weavepack` for direct profile access
- All existing tests pass unchanged
- New tests verify the profile boundary is real (e.g., constructing a
  null profile that does nothing should decode an empty wire envelope)

**Gate:** A new profile can be added without touching anything in
`sdk/src/core/`. Validated by: implement a trivial second profile
(`profiles/null/` — single value type, no containers) end-to-end and
confirm it works.

### Phase 4 — Strengthen rigor without Lean (~3 weeks)

Property-based testing covering algebraic laws + optional TLA+ spec for
protocol-level properties.

**Deliverables:**

- `weavepack/properties/` — algebraic laws written as fast-check generators
  - `decode(encode(x)) = x` (round-trip)
  - `apply(delta(a, b), a) = b` (delta correctness)
  - `delta(a, c) ≡ compose(delta(a, b), delta(b, c))` (composition)
  - `replace(replace(x, a), b) = replace(x, b)` (idempotence)
  - `bit_length(encode(x)) ≤ K · entropy(x) + ε` (compression bound;
    statistical, not absolute)
- `sdk/test/properties.test.js` — runs the algebraic suite
- `weavepack/tla+/Core.tla` (optional) — TLA+ model of delta chain
  convergence and schema evolution compatibility

**Gate:** Property suite runs in CI on every PR. Any regression in
algebraic laws blocks merge.

**Explicitly out of scope:** Lean formalization. The cost is
disproportionate to the value for weavepack's market. If a high-assurance
buyer (consensus protocol, aerospace, medical, central bank) ever
adopts weavepack, revisit then. Until then, TLA+ + property-based testing
provides ~80% of the assurance of Lean for ~5% of the effort.

### Phase 5 — Ship profile #2 (~6-12 weeks, depending on profile)

Pick one second profile. Spec it FIRST in `weavepack/profiles/<name>/`.
Implement against the spec. Measure against the incumbent format in
that niche. Publish numbers.

**Candidate profiles, ranked by strategic value:**

1. **weavepack-tensor** (recommended) — ML model checkpoints with delta
   updates. No good incumbent solution; PyTorch saves whole snapshots.
   Validates the abstraction severely (tensors expose anything JSON-
   shaped that snuck into core). Credentialing for AI/ML market.
   Incumbent benchmark: PyTorch `torch.save` + zstd.

2. **weavepack-wire** — protobuf-equivalent for RPC. Bigger market, more
   competition. Wins on deltas + bit-pack vs protobuf's byte-aligned
   varints. Incumbent benchmark: protobuf v3 + brotli.

3. **weavepack-tabular** — parquet-equivalent for analytics. Crowded
   market. Wins on row-level deltas (parquet has no delta concept;
   Delta Lake / Iceberg do this at file level). Incumbent benchmark:
   parquet + snappy.

4. **weavepack-ast** — compressed code/syntax storage. Niche but
   distinctive. Wins on rename-as-delta (git diffs at AST level vs
   line level). Incumbent benchmark: tree-sitter serialization + zstd.

5. **weavepack-cbor** — easy validation profile, low strategic value.
   Adds bytes/tags/undefined to the JSON profile. Useful as a
   sanity check that core abstractions hold; not a market position.

**Recommendation: weavepack-tensor.** The market gap is largest, the
abstraction stress-test is hardest, and the credentialing value is
highest.

**Gate:** Profile #2 ships, beats the incumbent on size + speed +
delta efficiency, conformance test vectors are published, at least
one production user adopts it. After this gate, the universal-protocol
framing is **earned**, not claimed.

### Phase 6 — Reference implementation in Rust (~12 weeks)

Once weavepack-core + two profiles are spec'd and stable, implement
weavepack in Rust as a second reference. This is what makes the protocol
real for the broader ecosystem.

**Deliverables:**

- `impl/rust/weavepack-core/` — protocol-agnostic crate
- `impl/rust/weavepack-json/` — JSON profile crate
- `impl/rust/weavepack-tensor/` (or whichever profile #2 is) — second profile
- Conformance test runner: Rust impl reads the test vector corpus from
  `weavepack/profiles/*/test-vectors/` and confirms byte-for-byte equality
  with reference outputs
- Bindings: PyO3 wrapper for Python, neon wrapper for Node, optional
  WASM build

**Gate:** Rust impl passes the full conformance corpus for both profiles.
Bindings are usable from at least Python.

### Phase 7 — Ecosystem and governance (open-ended)

This is where weavepack stops being a project and becomes infrastructure.

- Profile registry: web-accessible list of registered profiles with
  spec links and reference implementations
- Versioning policy: semver for protocol version, separate semver per
  profile, governance rules for breaking changes
- Conformance certification: implementations that pass the full
  conformance suite get a "certified weavepack-N.N implementation" mark
- Community: spec discussions in GitHub issues, RFC process for new
  profiles, regular profile-author sync calls

**No fixed timeline.** Ecosystem development is reactive to adoption.

## Out of scope

These are deliberately excluded to keep the scope tractable:

- **Lean formalization.** As discussed in the rigor phase: cost-prohibitive
  for weavepack's market. TLA+ + property-based testing covers the rigor
  needs at fraction of the cost.

- **Backwards compatibility with existing formats.** Weavepack does not
  read protobuf, parquet, JSON, or CBOR directly. Conversion tools are
  separate utilities, not part of the protocol.

- **Network layer.** Weavepack defines bytes; it does not define how those
  bytes are transmitted. RPC framing, transport security, congestion
  control are out of scope.

- **Encryption.** Payloads can be encrypted before/after weavepack encoding
  by the consumer, but weavepack itself is plaintext.

- **A central authority.** No "Internet Engineering Task Force" model;
  the spec is open-source, the registry is community-maintained, the
  reference implementations are MIT-licensed.

## Naming and identity

**weavepack** = **weave** + **pack**.

Two meanings, both intended:

1. **Technical**: the protocol literally weaves multiple typed columns
   together through a shared wire envelope (vrefs, krefs, vtypes, ktypes,
   bools, nums, strs, strmap, ...). Columnar interleaving is what
   distinguishes the layout from byte-stream formats.

2. **Ecosystem**: "the weave" is the foundational metaphor of Arweave's
   permanent data structure (blockweave). Weavepack is the pack format
   that fits the weave — designed for permanent append-only storage with
   bit-level density and per-update delta chains.

Naming convention:

- **weavepack** — the protocol (lowercase in code, npm, paths)
- **Weavepack** — the protocol when starting a sentence or in a title
- **weavepack-core** — the protocol-level spec (data model, wire format,
  bit encoding, delta semantics)
- **weavepack-\<profile\>** — a specific instantiation
  (e.g., weavepack-json, weavepack-tensor)
- **ARJSON** — the existing JS implementation that ships today.
  Becomes the reference implementation of weavepack-json. The npm
  package `arjson` is preserved for compatibility; a new package
  `weavepack` will be published once the protocol/profile boundary
  refactor lands (Phase 3).

The npm name `weavepack` is unclaimed today and will be reserved early
in Phase 1.

## Directory layout (target state after Phase 6)

```
arjson/
├── README.md                       (project overview)
├── weavepack/
│   ├── ROADMAP.md                  (this file)
│   ├── core/                       (protocol spec)
│   │   ├── 00-introduction.md
│   │   ├── 01-data-model.md
│   │   ├── ...
│   │   └── 09-conformance.md
│   ├── profiles/
│   │   ├── json/                   (JSON profile spec)
│   │   │   ├── 01-types.md
│   │   │   ├── ...
│   │   │   └── test-vectors/
│   │   ├── tensor/                 (Tensor profile spec, post-Phase-5)
│   │   └── ...
│   ├── properties/                 (algebraic-law generators)
│   └── tla+/                       (optional TLA+ models)
│
├── sdk/                            (JS reference implementation)
│   ├── src/
│   │   ├── core/                   (profile-agnostic)
│   │   └── profiles/
│   │       └── json/
│   └── test/
│
└── impl/
    └── rust/                       (Rust reference implementation, post-Phase-6)
        ├── weavepack-core/
        ├── weavepack-json/
        └── weavepack-tensor/
```

## What this changes about the existing project's identity

Right now the project is "arjson — JSON for permanent storage, smaller
than alternatives." Small market, clear win, shipping product.

Under weavepack, the project becomes "the only protocol that
simultaneously offers bit-level compression, delta chains, optional
schemas, and brotli composability — instantiable for any structural
data type." Much larger market: anyone storing typed data with updates
over time.

The product becomes the protocol; profiles are how it reaches specific
markets. Each profile is its own go-to-market motion (weavedb for JSON,
ML platforms for tensor, etc.).

This is a significantly bigger thing than the JSON tool. If it works,
weavepack becomes infrastructure-level — the substrate other formats
sit on top of.

## How to evaluate whether this should proceed

The technical foundations are real. The framing is correct. But the
protocol/profile distinction has to be **demonstrated**, not just
declared.

The decision points are:

- **After Phase 1-2:** Did spec'ing the existing protocol expose gaps,
  inconsistencies, or underspecified behaviors that we couldn't
  cleanly resolve? If yes, the current implementation is more
  ad-hoc than we thought and protocolization is harder than it looks.

- **After Phase 3:** Did the protocol/profile boundary refactor land
  cleanly, or did JSON-specific assumptions tangle through core in
  ways that resist localization? If the latter, the universal-protocol
  framing is shakier than the prior analysis suggests.

- **After Phase 5:** Did profile #2 ship, beat its incumbent, and find
  a user? If yes, the framing is **earned**. If no, fold the lessons
  back into the JSON profile and retire the universal-protocol claim.

Before Phase 5 ships, weavepack is aspirational. After Phase 5 ships,
it is a real protocol with the demonstrated ability to host new
profiles. The honest commitment is to that gate.

## Status

- [x] Phase 0: ARJSON shipped and stable
- [x] Phase 1: JSON profile retroactive spec — 5 spec docs + 93 vectors
- [x] Phase 2: weavepack-core spec — 10 spec docs
- [x] Phase 3: sdk/ refactor to protocol/profile boundary — null-profile gate passing
- [x] Phase 4: Property-based testing — 12 property tests, 1700+ generated cases per run, all passing
- [x] Phase 5: Profile #2 (weavepack-tensor)
  - [x] Phase 5.1–5.4: spec docs (01–05), fp32 round-trip, multi-dtype, deltas
  - [x] Phase 5.5: schemaful sidecar spec + implementation (06-schemas.md, schema.js)
  - [x] Phase 5.6: conformance test corpus — 31 vectors across 5 files
    (types/dtypes, containers/shapes, deltas/tensor_replace,
    deltas/tensor_add_remove, deltas/element_set, schemas/schemaful);
    verify-test-vectors.js extended to cover tensor profile
  - [x] Phase 5.7: benchmarks vs safetensors + zstd/brotli
    (07-benchmarks.md, tools/benchmark-tensor.js; snapshot parity with
    safetensors within 2%; sparse delta 1000–2500× smaller than safetensors
    full re-encode; single-tensor delta 3–4× smaller; gate: PASSED)
- [x] Phase 5: Profile #2 complete — weavepack-tensor v0.1 spec + impl + corpus + benchmarks
- [x] Phase 6: Rust reference implementation
  - [x] Phase 6.1: weavepack-tensor Rust crate scaffold
    (impl/rust/weavepack-tensor/ — encode/decode/delta/schema; 31/31 conformance vectors pass
    byte-for-byte against the JS reference; includes `conformance` binary that runs all
    tensor test vectors from weavepack/profiles/tensor/test-vectors/)
  - [x] Phase 6.2: weavepack-json Rust crate
    (impl/rust/weavepack-json/ — full structured-mode decoder; 93/93 conformance vectors pass
    (Level 1 + Level 2) against the JS reference; includes `conformance` binary that runs all
    JSON test vectors from weavepack/profiles/json/test-vectors/)
  - [x] Phase 6.3: weavepack-core Rust crate (shared primitives extracted)
    (impl/rust/weavepack-core/ — BitWriter, BitReader, write_leb128, write_short,
    write_uint; both profile crates depend on it; 31/31 tensor + 93/93 JSON
    conformance vectors still pass byte-for-byte after migration)
  - [x] Phase 6.4: bindings (PyO3 Python)
    (impl/rust/weavepack-tensor-py/ — PyO3 crate exposing encode/decode/encode_delta/
    apply_delta/schema_hash/schema_hash_hex; built with maturin into a manylinux wheel;
    39/39 conformance vectors pass byte-for-byte via test_conformance.py)
- [x] Phase 6: Rust reference implementation complete
- [x] Phase 7: Ecosystem and governance
  - [x] Governance prose: 8 docs
    (00-overview, 01-rfc-process, 02-profile-registry, 03-versioning,
    04-conformance-certification, 05-implementation-registry,
    06-spec-interpretation, 07-implementors-guide)
  - [x] Bootstrap the registry maintainer role + first RFC
    (02-profile-registry.md: project maintainer at ocrybit/arjson is
    bootstrap maintainer; RFC 0001 fp16/bf16 in Discussion with 20
    conformance vectors covering ±Inf, qNaN, sNaN, subnormals, RNE
    rounding, mixed-dtype; verify-test-vectors.js extended with
    data_raw_bits support for non-finite test values)
  - [x] Set up badge endpoint (static SVG badges hosted at weavepack/badges/;
    json/L3.svg, tensor/L2.svg, tensor/L3.svg; raw GitHub URLs usable now,
    live HTTPS endpoint deferred until ≥ 2 independent certified impls;
    04-conformance-certification.md updated with real badge URLs)
  - [x] External implementors guide + call for implementations
    (weavepack/governance/07-implementors-guide.md: getting-started guide
    covering Level 1–3 conformance workflow, corpus structure, badge
    claims, registration process, checklist; repo has issues disabled so
    outreach is via the guide doc itself and external channels)

- A.4 sub-tensor random access (skip-load): ✓ COMPLETE — JS + Rust + Python
  (no wire format change). The schema gives each tensor's exact
  `dataBytes(dtype, shape)`, so the decoder computes bit-offsets arithmetically
  and seeks to tensor N without parsing tensors 0..N-1.
  JS: `listTensorsSchemaful` + `decodeTensorSchemaful`; 11 unit tests.
  Rust: `list_tensors_schemaful` + `decode_tensor_schemaful` in decode.rs;
  shared `parse_schemaful_header` helper; 7 inline unit tests.
  Python: `list_tensors_schemaful` + `decode_tensor_schemaful` in
  impl/python/weavepack_tensor/decoder.py; `_parse_schemaful_header` helper;
  11 unit tests in impl/python/test_skip_load.py (first/middle/last tensor,
  parity with full decode, unknown name error, qint8 dequantization,
  byte-offset cross-check, 5-tensor doc, schemaless error, unknown schema error).

- A.5 streaming iterator: ✓ COMPLETE — JS + Rust + Python (no wire format change).
  JS: generator `iterateTensorsSchemaful(bytes, registry)` yields
  `{ name, dtype, shape, data }` in canonical order with a single advancing
  cursor — no per-tensor offset arithmetic or seeking. Lazy: early break
  does not decode remaining tensors. 9 unit tests in tensor-stream.test.js.
  Rust: `SchemafulIter<'bytes, 'reg>` struct implementing `Iterator` with
  `iterate_tensors_schemaful(bytes, registry)` constructor; exported from
  lib.rs. 7 unit tests (canonical order, full-decode parity, single-tensor
  doc, mixed dtypes, early stop, A.4 cross-check, schemaless-rejection).
  Python: `iterate_tensors_schemaful` generator in
  impl/python/weavepack_tensor/decoder.py; shares `_parse_schemaful_header`
  and `_dequantize` helpers with A.4; single advancing `_BitReader` cursor;
  9 unit tests in impl/python/test_skip_load.py (canonical order, full-decode
  parity, single-tensor doc, mixed dtypes, early stop, A.4 cross-check,
  qint8 dequantization, schemaless-rejection). 20/20 Python unit tests pass;
  97/97 Python conformance vectors pass; 2277/2277 JS SDK tests pass;
  190/190 conformance vectors pass.

- A.1 fp16/bf16: ✓ RFC 0001 Accepted (2026-05-06). JS + Rust + Python pass
  20/20 vectors byte-exact. Open questions resolved: any-NaN, emit-per-IEEE
  subnormals, silent f32→fp16/bf16 conversion. All Tier 1 v0.2 items now
  complete.

- D.3 Python JSON structured-mode encoder: ✓ COMPLETE — 68/68 encoder vectors
  byte-exact (was 37/68; 31 structured-mode vectors now tested and passing).
  Full ARTable encoder ported to Python (impl/python/weavepack_json/encoder.py):
  _StructEnc class with column buffers (_ColBuf), vlink/klink diff+RLE,
  vtypes RLE, nums diff+RLE, flag-column prefix scheme (all-zero/all-one/mixed),
  strmap dedup for keys and values. encode() now routes non-empty arrays/objects
  to _encode_structured() instead of raising NotImplementedError. Python JSON
  conformance: 93/93 decode + 68/68 encode (full Level 3 parity with Rust impl).

B.2 (array-of-objects per-element diff) architectural finding (2026-05-06):
The ARTable delta encoder does not support add/remove of keys on objects that
are nested inside arrays. Only replacements at already-existing leaf paths
within array-element objects work. Recursive diff from diffArray would silently
corrupt output for add/remove ops at paths like list[0].newKey. Full analysis
and required architecture changes documented in V0.2-PLANNING.md B.2 section.
B.2 implementation deferred until an RFC redesigns the delta encoder to support
nested-object mutations. Not a v0.1 regression; the existing bail-to-replace
behavior is correct.

- PyO3 schemaful encode/decode bindings: ✓ DONE (see below).
- PyO3 full conformance: ✓ COMPLETE — 97/97 vectors (was 61/93).
  test_conformance.py gains: float_to_fp8e5m2_bits (port of JS f32ToFp8e5m2);
  json_data_to_bytes coverage for int4/uint4 (nibble pack), fp8e4m3/fp8e5m2,
  cfloat32/cfloat64 (interleaved f32/f64), qint4/qint8/qfp8 (pre-quantized raw);
  raw_bits_to_bytes helper + parse_tensor_doc data_raw_bits support (fp16/bf16 uint16
  LE, fp8 uint8 raw); delta branch split for delta_bytes_hex-only vectors
  (delta_from_prior, quant_change) — apply_delta verified without re-encoding.

V0.2 in-progress (incremental):
- A.2 quant_change Rust + Python decoders: ✓ COMPLETE — 97/97 Rust + Python
  conformance (was 93/93; +4 quant_change vectors). Rust delta.rs apply_delta
  now handles op 5 (reads name, fp32 scale, dtype-dependent zp, data block).
  Python decoder.py gains matching QUANT_CHANGE branch. Rust conformance binary
  adds QINT8/QINT4/QFP8 cases to json_data_to_bytes for signed initial data.
- A.2 quant_change Rust encoder: ✓ COMPLETE — TensorData gains scale/zero_point
  fields; QuantChange DeltaOp variant added; compute_ops detects when QINT8/
  QINT4/QFP8 tensor has same dtype/shape but different scale or zero_point;
  encode_delta emits op 5 byte-exact vs JS reference (verified by unit test:
  delta hex 80d1770000803f00050a0f1400 for qint8 scale 0.1→1.0). apply_delta
  quant_change branch now preserves new scale/zero_point in TensorData instead
  of discarding. PyO3 bindings and conformance binary updated. 37/37 Rust unit
  tests; 97/97 conformance; 190/190 corpus; 2277/2277 JS SDK.
- A.3 delta-from-prior: ✓ DONE (encoder + decoder, all 3 langs).
  Decoder in JS, Rust, Python (58/58 vectors). Encoder heuristic
  emits mode=1 when max abs delta ≤ 0.01 on fp32/fp64 dense
  updates; now ported to Rust (was JS-only). Rust encoder: 3 new
  unit tests (small fp32, large fp32, small fp64); all 35 delta
  tests pass; 97/97 conformance vectors pass. Empirically,
  weavepack+brotli is 1.6× smaller than safetensors+brotli on the
  dense Adam-style training scenario (V0.2-PLANNING.md A.3 table).
- D.1 Rust JSON encoder: ✓ COMPLETE — 68/68 vectors byte-exact.
  Full structured-mode encoder (struct_encode.rs): column buffers, vlink/
  klink diff+RLE, vtypes RLE, nums diff+RLE, vflags/kflags/bools prefix
  scheme, strmap dedup. Also fixed a latent debug-mode overflow in
  weavepack-core::BitWriter (1u8<<8 when free==8).
- D.2 Python JSON delta chain decoder: ✓ COMPLETE — 93/93 conformance
  vectors pass (was 68/93; 25 chain vectors now tested and passing).
  New: parse_chain(), decode_chain(), context-aware _decode_payload()
  (snapshot + delta modes), _apply_delta_to_json() (set/del/splice/
  strdiff ops directly on the JSON tree). Also fixed _BitReader
  zero-extend-past-end and splice_rep column dispatch in
  _vt_num_tag / _vt_str_type / _vt_is_bool. See V0.2-PLANNING.md D.2.

- A.1 fp8/cfloat Rust + Python: ✓ COMPLETE — 79/79 conformance.
  New Rust module fp8_dtype.rs (port of JS fp8.js: RNE rounding, subnormals,
  NaN/Inf, both e4m3 and e5m2 formats). Rust + Python conformance binaries
  now handle all 79 tensor corpus vectors including fp8e4m3, fp8e5m2,
  cfloat32, cfloat64. Also fixed data_raw_bits decoder in Rust conformance
  binary (was hardcoded 2 bytes/element; fp8 needs 1 byte/element).

- A.1 qint8/qint4/qfp8: ✓ COMPLETE (JS + Rust + Python). Schemaful
  encode+decode for all three quantized dtypes in all three impls.
  qint8: q = clamp(round(f32/scale + zp), -128, 127). qint4: nibble-packed.
  qfp8: fp8e4m3 sub-format with scale factor. 14 corpus vectors in
  schemas/qint.json (5 qint8 + 5 qint4 + 4 qfp8). 93/93 conformance in
  Rust and Python (was 79/93). Schema hash fix: recursive key sort in Python
  canonicalize_schema and Rust format_f64_json to match JS JSON.stringify.

Cross-language total: JS 177+14 tensor + 93 JSON = 284; Rust 97 tensor
  + 93 JSON = 190; Python 97 tensor + 93 JSON = 190. quant_change (op 5)
  decoder ported to Rust + Python (was 93 each; +4 quant_change vectors).
  Rust conformance binary gains QINT8/QINT4/QFP8 branches in json_data_to_bytes
  to parse pre-quantized signed integer test-vector data arrays.

- PyO3 schemaful encode/decode bindings: ✓ COMPLETE.
  New functions in impl/rust/weavepack-tensor-py/src/lib.rs:
  `encode_schemaful(tensors, schema)` — wraps encode_document_schemaful;
  `decode_schemaful(data, schema)` — computes hash, builds single-entry
  registry, wraps decode_document_schemaful. Both registered in the
  weavepack_tensor_rs Python module. Conformance test updated: all 17
  schema vectors (3 schemaful.json + 14 qint.json) now exercise the full
  encode→byte-check→decode round-trip (was hash-only). qint4/qint8/qfp8
  quantization helpers added to test helper (float→nibble/int8/fp8e4m3
  bytes). PyO3 conformance: 61/93 pass (32 pre-existing failures for
  int4/fp8/cfloat schema-less vectors; 0 new regressions).

- D.4 Python tensor delta encoder: ✓ COMPLETE — compute_delta + encode_delta
  in impl/python/weavepack_tensor/encoder.py; 14/14 corpus delta vectors
  byte-exact (tensor_replace, tensor_add, tensor_remove, element_set,
  region_replace, quant_change); mode=1 (delta-from-prior) heuristic
  matches JS/Rust threshold (≤ 0.01 for fp32/fp64); 15 unit tests in
  impl/python/test_encode_delta.py. All cross-language totals unchanged;
  97/97 Python conformance, 2277/2277 JS SDK, 190/190 corpus vectors.
