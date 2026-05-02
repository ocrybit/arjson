# arPack — Universal Structural-Data Protocol

**Status:** Concept phase. Planning document. No code yet.

## What arPack is

arPack is a **universal structural-data compression and update protocol**.

It is the protocol that ARJSON has implicitly been all along. Today, ARJSON
ships as a JSON-specific library, but the underlying machinery
(typed columns, run-length encoding, dedup, bit-packed deltas, optional
schema sidecars) is data-shape-agnostic. arPack is the formalization of
that machinery as a standalone protocol with **profiles** for specific
data shapes.

```
arPack-Core — the protocol
  │   typed columns · RLE · dedup · bit-packed deltas · schema sidecars
  │   wire envelope · extension gates · profile registry
  │
  ├─ Profile: arPack-JSON     (today's ARJSON; first instantiation)
  ├─ Profile: arPack-CBOR     (binary blobs, tags, undefined)
  ├─ Profile: arPack-Tensor   (ML weights with delta updates)
  ├─ Profile: arPack-Graph    (RDF, property graphs)
  ├─ Profile: arPack-AST      (code/syntax trees)
  ├─ Profile: arPack-Tabular  (dataframes, parquet-equivalent)
  ├─ Profile: arPack-Wire     (RPC, protobuf-equivalent)
  ├─ Profile: arPack-Log      (structured event streams)
  └─ Profile: arPack-Custom   (caller-defined type tables)
```

JSON is one profile. The protocol is the product.

## Why this exists

arjson's current design is more general than its JSON-specific surface
admits. The four invariants that make arjson special — bit-level packing,
delta chains, optional schemas, brotli composability — are properties of
**structural data compression**, not of JSON.

Every existing format owns 4-5 of the cells in this matrix. arPack would
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
| **arPack** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |

The unique combination is **delta chains over bit-packed columns**, which
no shipping format provides.

## Design principles

These are non-negotiable. They derive from the philosophy that produced
ARJSON in the first place.

1. **Every bit, precise math.** Layout decisions are justified by entropy
   analysis, not by analogy to other formats. Standards-conformance is not
   a goal in itself — if a standard is wasteful, we route around it.

2. **Profile isolation.** Profiles are separable. A consumer that only
   needs arPack-JSON should not pay for arPack-Tensor's type table.
   Wire envelope carries `profile-id`; decoder dispatches.

3. **Delta-first.** Every profile must define delta semantics. Snapshot-only
   profiles are not arPack. The delta chain is the unit of storage; the
   single-payload form is just a chain of length 1.

4. **Schema is optional, not required.** arPack-with-schema gives bit-
   level entropy approaching Shannon bounds. arPack-without-schema gives
   self-describing payloads at higher cost. Consumers choose; the protocol
   supports both modes per profile.

5. **Brotli composability.** Column layouts are preserved through the
   wire envelope so brotli can see the regularity. arPack + brotli must
   beat alternatives on every measured pipeline.

6. **No conformance theater.** Compatibility shims with existing formats
   (RFC 6902, JSON Patch, etc.) are rejected. We define our own primitives
   based on what the protocol can express most efficiently.

7. **Reversibility before optimization.** Round-trip correctness
   (`decode(encode(x)) = x`) is invariant. Speed and size optimizations
   that break round-trip are rejected, full stop.

## Scope of the protocol

**arPack-Core specifies:**

- Typed value columns (variable bit width per profile)
- Container references (parent/key/index pointers)
- String interning (strmap, char encoding, dedup)
- Run-length encoding for flag and type columns
- Delta-pack for monotone integer sequences
- Extension gate (optional sections after the core columns)
- Wire envelope (version, profile-id, length-prefixed deltas)
- Schema sidecar mechanism (hash-addressed, optional)
- Conformance test corpus structure

**arPack-Core does NOT specify:**

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

### Phase 0 — Stabilize ARJSON-JSON (already done)

ARJSON v0.1.x is shipped, has 367 regression tests, has weavedb in
production. This is the proof point that the underlying machinery works
for at least one profile.

**Status:** Complete.
**Don't disturb during arPack work.** ARJSON continues to ship from
`sdk/` against the JSON-specific API. arPack development happens in
this directory until profile #2 is ready, at which point we revisit
how arjson and arPack relate (rebrand vs coexist).

### Phase 1 — Spec the JSON profile retroactively (~3 weeks)

Write `arpack/profiles/json/` documenting what arjson IS today. Pure
documentation work, no behavior change in the code base.

**Deliverables:**

- `arpack/profiles/json/01-types.md` — null, bool, num, str
- `arpack/profiles/json/02-containers.md` — object, array
- `arpack/profiles/json/03-paths.md` — `.` and `[n]` grammar
- `arpack/profiles/json/04-deltas.md` — replace, add, remove, splice, diff
- `arpack/profiles/json/05-conformance.md` — test corpus structure
- `arpack/profiles/json/test-vectors/` — `(input, deltas, expected-bytes)`
  tuples extracted from current arjson test suite

**Gate:** Someone unfamiliar with the codebase can implement an
arPack-JSON encoder/decoder from the spec alone and pass all test vectors.
Validated by: write a minimal Python decoder from spec, confirm it
agrees with the JS reference on the test corpus.

### Phase 2 — Spec arPack-Core (~3 weeks)

Write `arpack/core/` documenting the protocol-level invariants
independently of any profile. The JSON profile already conforms; the spec
makes that conformance explicit.

**Deliverables:**

- `arpack/core/00-introduction.md`
- `arpack/core/01-data-model.md` — typed columns, refs, structural layout
- `arpack/core/02-wire-format.md` — envelope, version, profile-id, sections
- `arpack/core/03-bit-encoding.md` — column packing, RLE, delta-pack, varint
- `arpack/core/04-strmap.md` — string interning, char encoding
- `arpack/core/05-deltas.md` — delta chain semantics, composition laws
- `arpack/core/06-schemas.md` — optional schema sidecar, hash addressing
- `arpack/core/07-extensions.md` — extension gate, profile registry
- `arpack/core/08-security.md` — DoS bounds, adversarial inputs
- `arpack/core/09-conformance.md` — core-level test corpus

**Gate:** The JSON profile spec from Phase 1 can be re-expressed as
"arPack-Core + JSON-specific tables" without any duplicated normative
text. Validation: line-by-line review confirms every statement in
`profiles/json/` either references a `core/` definition or extends one.

### Phase 3 — Refactor sdk/ to the protocol/profile boundary (~4 weeks)

Restructure the JS implementation so the JSON-specific code is localized
behind a profile descriptor. No wire format change. No behavior change.

**Deliverables:**

- `sdk/src/core/` — profile-agnostic encoder/decoder/builder/artable
- `sdk/src/profiles/json/` — JSON-specific type table, paths, delta vocabulary
- `sdk/src/index.js` — exports `ARJSON` (JSON profile) as the default; also
  exports `arPack` for direct profile access
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

- `arpack/properties/` — algebraic laws written as fast-check generators
  - `decode(encode(x)) = x` (round-trip)
  - `apply(delta(a, b), a) = b` (delta correctness)
  - `delta(a, c) ≡ compose(delta(a, b), delta(b, c))` (composition)
  - `replace(replace(x, a), b) = replace(x, b)` (idempotence)
  - `bit_length(encode(x)) ≤ K · entropy(x) + ε` (compression bound;
    statistical, not absolute)
- `sdk/test/properties.test.js` — runs the algebraic suite
- `arpack/tla+/Core.tla` (optional) — TLA+ model of delta chain
  convergence and schema evolution compatibility

**Gate:** Property suite runs in CI on every PR. Any regression in
algebraic laws blocks merge.

**Explicitly out of scope:** Lean formalization. The cost is
disproportionate to the value for arPack's market. If a high-assurance
buyer (consensus protocol, aerospace, medical, central bank) ever
adopts arPack, revisit then. Until then, TLA+ + property-based testing
provides ~80% of the assurance of Lean for ~5% of the effort.

### Phase 5 — Ship profile #2 (~6-12 weeks, depending on profile)

Pick one second profile. Spec it FIRST in `arpack/profiles/<name>/`.
Implement against the spec. Measure against the incumbent format in
that niche. Publish numbers.

**Candidate profiles, ranked by strategic value:**

1. **arPack-Tensor** (recommended) — ML model checkpoints with delta
   updates. No good incumbent solution; PyTorch saves whole snapshots.
   Validates the abstraction severely (tensors expose anything JSON-
   shaped that snuck into core). Credentialing for AI/ML market.
   Incumbent benchmark: PyTorch `torch.save` + zstd.

2. **arPack-Wire** — protobuf-equivalent for RPC. Bigger market, more
   competition. Wins on deltas + bit-pack vs protobuf's byte-aligned
   varints. Incumbent benchmark: protobuf v3 + brotli.

3. **arPack-Tabular** — parquet-equivalent for analytics. Crowded
   market. Wins on row-level deltas (parquet has no delta concept;
   Delta Lake / Iceberg do this at file level). Incumbent benchmark:
   parquet + snappy.

4. **arPack-AST** — compressed code/syntax storage. Niche but
   distinctive. Wins on rename-as-delta (git diffs at AST level vs
   line level). Incumbent benchmark: tree-sitter serialization + zstd.

5. **arPack-CBOR** — easy validation profile, low strategic value.
   Adds bytes/tags/undefined to the JSON profile. Useful as a
   sanity check that core abstractions hold; not a market position.

**Recommendation: arPack-Tensor.** The market gap is largest, the
abstraction stress-test is hardest, and the credentialing value is
highest.

**Gate:** Profile #2 ships, beats the incumbent on size + speed +
delta efficiency, conformance test vectors are published, at least
one production user adopts it. After this gate, the universal-protocol
framing is **earned**, not claimed.

### Phase 6 — Reference implementation in Rust (~12 weeks)

Once arPack-Core + two profiles are spec'd and stable, implement
arPack in Rust as a second reference. This is what makes the protocol
real for the broader ecosystem.

**Deliverables:**

- `impl/rust/arpack-core/` — protocol-agnostic crate
- `impl/rust/arpack-json/` — JSON profile crate
- `impl/rust/arpack-tensor/` (or whichever profile #2 is) — second profile
- Conformance test runner: Rust impl reads the test vector corpus from
  `arpack/profiles/*/test-vectors/` and confirms byte-for-byte equality
  with reference outputs
- Bindings: PyO3 wrapper for Python, neon wrapper for Node, optional
  WASM build

**Gate:** Rust impl passes the full conformance corpus for both profiles.
Bindings are usable from at least Python.

### Phase 7 — Ecosystem and governance (open-ended)

This is where arPack stops being a project and becomes infrastructure.

- Profile registry: web-accessible list of registered profiles with
  spec links and reference implementations
- Versioning policy: semver for protocol version, separate semver per
  profile, governance rules for breaking changes
- Conformance certification: implementations that pass the full
  conformance suite get a "certified arPack-N.N implementation" mark
- Community: spec discussions in GitHub issues, RFC process for new
  profiles, regular profile-author sync calls

**No fixed timeline.** Ecosystem development is reactive to adoption.

## Out of scope

These are deliberately excluded to keep the scope tractable:

- **Lean formalization.** As discussed in the rigor phase: cost-prohibitive
  for arPack's market. TLA+ + property-based testing covers the rigor
  needs at fraction of the cost.

- **Backwards compatibility with existing formats.** arPack does not
  read protobuf, parquet, JSON, or CBOR directly. Conversion tools are
  separate utilities, not part of the protocol.

- **Network layer.** arPack defines bytes; it does not define how those
  bytes are transmitted. RPC framing, transport security, congestion
  control are out of scope.

- **Encryption.** Payloads can be encrypted before/after arPack encoding
  by the consumer, but arPack itself is plaintext.

- **A central authority.** No "Internet Engineering Task Force" model;
  the spec is open-source, the registry is community-maintained, the
  reference implementations are MIT-licensed.

## Naming and identity

- **arPack** — the protocol
- **arPack-Core** — the protocol-level spec (data model, wire format,
  bit encoding, delta semantics)
- **arPack-<Profile>** — a specific instantiation (e.g., arPack-JSON,
  arPack-Tensor)
- **ARJSON** — the existing JS implementation of arPack-JSON. May be
  rebranded to `arpack-json` (npm) when arPack ships, but the existing
  package name is preserved for compatibility during the transition.

## Directory layout (target state after Phase 6)

```
arjson/
├── README.md                       (project overview)
├── arpack/
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
        ├── arpack-core/
        ├── arpack-json/
        └── arpack-tensor/
```

## What this changes about the existing project's identity

Right now the project is "arjson — JSON for permanent storage, smaller
than alternatives." Small market, clear win, shipping product.

Under arPack, the project becomes "the only protocol that simultaneously
offers bit-level compression, delta chains, optional schemas, and brotli
composability — instantiable for any structural data type." Much larger
market: anyone storing typed data with updates over time.

The product becomes the protocol; profiles are how it reaches specific
markets. Each profile is its own go-to-market motion (weavedb for JSON,
ML platforms for Tensor, etc.).

This is a significantly bigger thing than the JSON tool. If it works,
arPack becomes infrastructure-level — the substrate other formats sit on
top of.

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

Before Phase 5 ships, arPack is aspirational. After Phase 5 ships, it
is a real protocol with the demonstrated ability to host new profiles.
The honest commitment is to that gate.

## Status

- [x] Phase 0: ARJSON-JSON shipped and stable
- [ ] Phase 1: JSON profile retroactive spec
- [ ] Phase 2: arPack-Core spec
- [ ] Phase 3: sdk/ refactor to protocol/profile boundary
- [ ] Phase 4: Property-based testing + optional TLA+
- [ ] Phase 5: Profile #2 (recommended: arPack-Tensor)
- [ ] Phase 6: Rust reference implementation
- [ ] Phase 7: Ecosystem and governance

Next action when work begins: open Phase 1 by extracting test vectors
from `sdk/test/` into `arpack/profiles/json/test-vectors/` and writing
`arpack/profiles/json/01-types.md`.
