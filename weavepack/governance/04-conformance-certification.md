# weavepack Governance — Conformance Certification

**Status:** Draft. Phase 7 of the weavepack roadmap.

## Purpose

Conformance certification gives consumers a trustworthy answer to:
"Will this implementation correctly read/write payloads I produce
with that other implementation?"

Without certification, every consumer would have to test every
implementation pair themselves. Certification consolidates that work
into a public claim backed by reproducible test runs.

## Levels

Defined in each profile's `05-conformance.md` and in
`weavepack-core/09-conformance.md`. Recap:

- **Level 1 — Decoder**: correctly decodes any byte sequence
  produced by the reference encoder for the supported profiles.
- **Level 2 — Encoder**: produces byte sequences that the
  reference decoder accepts and decodes back to the original
  value.
- **Level 3 — Reference**: byte-equivalent to the JS reference
  for all corpus inputs.

An implementation MAY claim different levels for different
profiles. Example: an implementation might be Level 3 for
weavepack-json but Level 2 for weavepack-tensor.

## How to claim conformance

The claim is a statement in the implementation's README + a
reproducible test run that any reader can verify:

```markdown
## Conformance

This implementation claims conformance to:

- weavepack-json v1.1, conformance level 3
- weavepack-tensor v0.1, conformance level 2

Test run: `npm run conformance:json && npm run conformance:tensor`

Last verified: 2026-05-03 against test-vectors/ at commit abc123.
```

The claim is **self-asserted**. There is no external authority that
"grants" certification — the value comes from reproducibility, not
from a stamp.

## Required test runs

For each profile + level combination claimed:

### Level 1 (Decoder)

```
For every vector V in profile/test-vectors/:
  decoded = your_decode(V.expected_bytes_hex)
  assert deepEqual(decoded, V.expected_decoded || V.input)
```

PASS rate: 100% required.

### Level 2 (Encoder + decoder round-trip)

```
For every vector V in profile/test-vectors/:
  bytes = your_encode(V.input)
  via_reference = reference_decode(bytes)
  assert deepEqual(via_reference, V.input)
```

PASS rate: 100% required.

The "reference decoder" here is the JS reference at the
spec-aligned version. Implementations of profile X only need to
round-trip via the JS reference's profile-X decoder, not against
every other implementation.

### Level 3 (Byte-exact)

```
For every vector V in profile/test-vectors/ that has expected_bytes_hex:
  bytes = your_encode(V.input)
  assert hex(bytes) == V.expected_bytes_hex
```

PASS rate: 100% required for vectors with `expected_bytes_hex`.
Vectors without (e.g., property-test seeds) are not Level 3-applicable.

## Reproducibility requirements

A conformance claim MUST be reproducible. Specifically:

1. The test run command MUST be a single shell command (or a
   `Makefile` / `npm script` / equivalent) anyone can invoke.
2. The output MUST be deterministic for the same input — two
   runs produce identical pass/fail counts.
3. The test corpus version MUST be pinned (commit hash of
   `weavepack/profiles/<name>/test-vectors/`).
4. Any environment requirements (specific Node version, Rust
   toolchain, library versions) MUST be documented.

If a claim isn't reproducible, it isn't a claim — it's an
unverifiable assertion. Consumers SHOULD discount such claims.

## Verification by third parties

A third party verifying a claim:

1. Clones the implementation
2. Checks out the commit referenced in the claim
3. Runs the test command
4. Compares the output to the claimed pass count

If the output differs (test fails on third-party machine), open
an issue on the implementation's repo. Possible causes:

- Environment differences (toolchain, OS-specific behavior)
- Test corpus version mismatch (claim references an outdated
  commit)
- Non-determinism in the implementation
- Real conformance bug

## Continuous conformance

Implementations SHOULD run conformance tests in CI:

```
on every commit:
  cd impl && cargo run -p weavepack-tensor --bin conformance
  cd sdk && npm test && npm run properties
```

If a CI run fails, the implementation's claim is invalid until
the failure is fixed. Re-asserting the claim requires a new
green CI run.

## Certified-implementation badge

Implementations passing conformance MAY add a badge to their README.
Static SVG badges are hosted at `weavepack/badges/` in this repo
(see `weavepack/badges/README.md` for the full list and addition guide).

```markdown
[![weavepack-json L3](https://raw.githubusercontent.com/weavedb/arjson/weavepack/weavepack/badges/json/L3.svg)](https://github.com/weavedb/arjson/blob/weavepack/weavepack/governance/04-conformance-certification.md)
[![weavepack-tensor L2](https://raw.githubusercontent.com/weavedb/arjson/weavepack/weavepack/badges/tensor/L2.svg)](https://github.com/weavedb/arjson/blob/weavepack/weavepack/governance/04-conformance-certification.md)
[![weavepack-tensor L3](https://raw.githubusercontent.com/weavedb/arjson/weavepack/weavepack/badges/tensor/L3.svg)](https://github.com/weavedb/arjson/blob/weavepack/weavepack/governance/04-conformance-certification.md)
```

Once a live HTTPS endpoint exists (planned once ≥ 2 independent certified
implementations exist), the static files remain as fallback and the
governance doc will be updated to show the live URL as primary.

The badge is **decorative**. It carries no more weight than the
README claim it links to. Its purpose is visibility (consumers
scanning a repo see at a glance which conformance claims exist).

## Failed conformance disclosure

When an implementation discovers a conformance bug:

1. Mark the affected level claim as **Provisional** in the README
2. Open an issue with the failing test vector
3. Fix the bug
4. Re-run conformance, restore the claim

During the Provisional period, consumers know the claim is
unreliable. This is more honest than silently failing tests
or quietly downgrading the claim.

## Consumer-side checks

Consumers depending on inter-implementation compatibility SHOULD:

1. Test the round-trip themselves: encode with implementation
   A, decode with implementation B, verify equality.
2. Pin specific implementation versions, not floating "latest"
   — wire format is stable per protocol version, but
   implementation bug fixes may affect behavior.
3. Re-test on every implementation upgrade.

The conformance certification reduces the work of these
checks but does not eliminate them.

## Cross-version conformance

When a profile bumps versions (e.g., weavepack-tensor v0.1 →
v0.2 with new dtypes), an implementation supporting both versions
MUST:

1. Pass the v0.1 test corpus at the claimed level
2. Pass the v0.2 test corpus at the claimed level
3. Document which version's corpus is the active "canon" if
   the wire format diverged

If wire format is incompatible across versions, the
implementation MAY support only one. The claim states which.

## Audit trail

The implementation registry (`05-implementation-registry.md`)
records each impl's claims with timestamps. This produces an
audit trail showing how claims have evolved. Consumers can see
when a claim was made, last verified, last updated, and any
provisional periods.

## Cost discipline

Conformance test runs SHOULD complete in seconds (< 10 typically),
not minutes. Slow conformance discourages CI runs, which lets
bugs accumulate.

If a profile's corpus grows large enough that conformance takes
> 30 seconds, consider sharding the corpus into "fast" (always-
run) and "slow" (nightly) tiers.

## See also

- `weavepack-core/09-conformance.md`: protocol-level conformance
  spec
- Each profile's `05-conformance.md`: profile-specific test
  corpus structure
- `05-implementation-registry.md`: which implementations claim
  what
