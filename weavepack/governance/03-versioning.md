# weavepack Governance — Versioning

**Status:** Active. Phase 7 of the weavepack roadmap.

## Three independent version axes

weavepack has three things that get version numbers, and they
move on independent cadences:

1. **Protocol version** (`weavepack-core` v1.0, v1.1, v2.0, ...)
2. **Profile version** (per profile: `weavepack-tensor` v0.1, v0.2, v1.0, ...)
3. **Implementation version** (per implementation: arjson 0.1.3,
   `impl/rust/weavepack-tensor` 0.1.0, ...)

Conformance claims state which protocol + profile versions an
implementation supports.

## Protocol versioning

Protocol version is `MAJOR.MINOR`. (No patch component — the
protocol either is or isn't a given version; spec edits that
don't change behavior are not versioned.)

### Major version

A major bump indicates **wire-format incompatibility**. Old
decoders cannot read new payloads (they'll either error
cleanly or — if the change wasn't gracefully gated — produce
wrong results).

Triggers for a major bump:

- Restructuring the column sequence
- Removing or repurposing existing column types
- Changing the wire envelope's header format
- Breaking the extension gate's invariants

Major bumps are rare. v1.0 → v2.0 is years apart.

### Minor version

A minor bump indicates **forward-compatible additions**.
Old decoders can still read old payloads; they may not
understand new features but will refuse them safely via the
extension gate (or other documented mechanism).

Triggers for a minor bump:

- Adding a new extension type to the registry
- Adding RLE prefix to a column (v1.0 → v1.1 was this)
- Adding optional sections that decoders can skip
- Tightening conformance criteria (existing payloads still valid)

### Compatibility table (current state)

| From | To | Direction | Compatibility |
|---|---|---|---|
| v1.0 | v1.1 | reading v1.1 payloads | ✗ NOT compatible (RLE prefix is structural) |
| v1.1 | v1.0 | reading v1.0 payloads | ~ partial (v1.0 payloads don't have RLE prefix; v1.1 reader expects it) |

NOTE: v1.0 → v1.1 was technically a minor bump that broke
forward and backward compatibility for the structured-mode
columns that gained RLE. This was a mistake that we're
documenting now; future minor bumps must preserve forward
compatibility (old decoders read new payloads with degraded
fidelity, never with corruption).

The v1.0 → v1.1 break is grandfathered. The lesson:
**minor bumps that touch structural columns are dangerous;
prefer extension-gate additions instead**.

## Profile versioning

Each profile has its own version, independent of the protocol.
Standard semver: `MAJOR.MINOR.PATCH`.

- **MAJOR**: wire-format break specific to the profile
- **MINOR**: new ops, dtypes, or features that decoders skip
  cleanly (or refuse via extension gate)
- **PATCH**: spec clarifications without behavior change

Profile versions can move independently. weavepack-tensor v0.1
runs over weavepack-core v1.1; a future weavepack-tensor v1.0
might still run over weavepack-core v1.x (no protocol change
required).

## Implementation versioning

Each implementation chooses its own scheme. Recommended:
semver with the following meanings:

- MAJOR: breaks the implementation's public API (not the
  protocol)
- MINOR: adds capabilities (e.g., supporting a new profile,
  new conformance level)
- PATCH: bug fixes, performance improvements

The implementation's version says nothing about which protocol
or profile versions it supports — that's a separate
declaration in its README / package metadata.

## Conformance declarations

An implementation's README MUST state, for every profile it
implements:

```
weavepack-<profile> support: protocol vX.Y, profile vA.B.C, conformance level N
```

Example for the JS reference:

```
weavepack-json support:    protocol v1.1, profile v1.1, conformance level 3
weavepack-tensor support:  protocol v1.1, profile v0.3, conformance level 3
```

## Breaking change policy

A breaking change is acceptable when:

1. There's a clear correctness or security reason
2. The break is gated (extension type, opt-in flag)
3. Migration path is documented

A breaking change is NOT acceptable when:

1. The break is purely cosmetic / aesthetic
2. The break is for performance reasons that an implementation
   could optimize internally without changing wire format
3. The break is to align with another format's conventions

## Deprecation timeline

When a feature is deprecated:

1. **Announcement**: marked `Deprecated` in the spec; release
   notes mention it
2. **Grace period**: minimum 6 months before removal in any
   major version bump
3. **Removal**: at the next major version, the feature is
   removed; old payloads using it are no longer decodable by
   new implementations (but old implementations can still
   decode them)

For schema sidecars: a deprecated schema-id remains in the
hash registry forever; payloads referencing it remain
decodable as long as someone has the schema document.

## Pre-1.0 profiles

Profiles with version < 1.0 are explicitly **unstable**.
Wire format may break between minor versions. Consumers using
pre-1.0 profiles in production accept this risk.

A profile is graduated to 1.0 when:

1. Wire format has been stable for ≥ 6 months
2. ≥ 2 independent implementations exist
3. ≥ 1 production user has adopted it

weavepack-json is at v1.1 (graduated from arjson lineage).
weavepack-tensor is at v0.3 (pre-1.0, not yet stable).

## What about Rust crate versions

Each Rust crate in `impl/rust/` has its own version in
Cargo.toml. These are **implementation versions**, not protocol
versions. Crate v0.1.0 may implement protocol v1.1 + profile
v0.1.

Crates SHOULD use feature flags to gate optional capabilities
(e.g., `tensor-quantized` feature for fp8/qint variants when
they ship). The feature set + version together define what
a crate can do.

## Spec edits without version bumps

Editorial edits to spec docs (typos, clarifications, prose
improvements) don't require a version bump. The git commit
history is the change log for these.

When in doubt:
- Behavior changed for any input → version bump
- Behavior unchanged, prose clearer → no bump

## Tooling

The spec docs each have a `**Status:**` line at the top. As
the protocol evolves:

- `Draft` → first version under design
- `Stable` → released; behavior frozen except for fixes
- `Deprecated` → marked for removal in next major
- `Removed` → no longer in current protocol; old payloads
  may still reference it via historical conformance

Implementations can scrape this status line to understand
which features are committed to vs. which are tentative.
