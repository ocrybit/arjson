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
- [ ] Phase 5: Profile #2 (recommended: weavepack-tensor)
  - [x] Phase 5.1–5.4: spec docs (01–05), fp32 round-trip, multi-dtype, deltas
  - [x] Phase 5.5: schemaful sidecar spec + implementation (06-schemas.md, schema.js)
  - [x] Phase 5.6: conformance test corpus — 31 vectors across 5 files
    (types/dtypes, containers/shapes, deltas/tensor_replace,
    deltas/tensor_add_remove, deltas/element_set, schemas/schemaful);
    verify-test-vectors.js extended to cover tensor profile
  - [ ] Phase 5.7: benchmarks vs safetensors / PyTorch + zstd
- [ ] Phase 6: Rust reference implementation
- [ ] Phase 7: Ecosystem and governance

Next action: Phase 5.7 — benchmark weavepack-tensor against safetensors
and PyTorch + zstd on a representative model (e.g. GPT-2-small fp32).
Measure: encode size, encode time, decode time, delta chain size after
N weight updates. Goal: publish numbers that either confirm or falsify
the "beat its incumbent" gate from Phase 5.
