# weavepack Governance — Spec Interpretation Disputes

**Status:** Active. Phase 7 of the weavepack roadmap.

## When this matters

The spec is prose. Prose is ambiguous. When two implementations
disagree on what a spec sentence means, real consumers get hurt:
payloads encoded with one don't decode with the other.

This document defines how those disputes are resolved.

## The bootstrap arrangement (v1.x)

For weavepack v1.x, the **JS reference implementation is
authoritative** when prose ambiguity arises. Specifically:

- If the spec says X but the JS reference does Y, and other
  implementations have built against Y, then Y is the de-facto
  behavior. The spec is patched to say Y.
- If the spec says X and the JS reference does X, and a
  second implementation does Y, then Y is non-conforming. The
  second implementation must change.
- If the spec is genuinely silent on a behavior and two
  implementations disagree, the spec gets amended via RFC; in
  the meantime, the JS reference's behavior is provisionally
  authoritative.

This bootstrap arrangement is **transitional**. It exists because:

1. The JS reference shipped before the spec was written
2. Real consumers (weavedb) have been depending on JS reference
   behavior, including behaviors not yet in the spec

The arrangement ends at v2.0 (or earlier if we get there
sooner). At that point, the prose spec becomes normative and
all implementations — including the JS reference — track the
spec. If the JS reference at v2.0 disagrees with the v2.0
spec, the JS reference has a bug.

## Identifying ambiguity

Signs the spec is ambiguous:

- Two readers reach different conclusions about what a sentence
  means
- A specific test vector is missing from the corpus, and one
  implementation guesses one behavior while another guesses
  a different one
- The spec describes the "what" but not the "how" (e.g., "round
  to nearest" without specifying the tie-breaking rule)

When you spot ambiguity:

1. Open an issue on the spec repo titled "Spec ambiguity:
   <topic>"
2. Quote the ambiguous text
3. List the possible interpretations
4. State which interpretation your implementation uses
5. Ask which interpretation other implementations use

The discussion settles which interpretation is canonical;
spec is patched accordingly.

## Resolving disputes

When implementations disagree on a spec interpretation:

### Step 1: Identify the disagreement

File an issue with:

- Spec section being interpreted differently
- Implementation A's behavior (with test vector if possible)
- Implementation B's behavior (with test vector)
- Practical impact on consumers

### Step 2: Determine the right answer

Three sources of truth, in order of authority:

1. **The bootstrap arrangement** (v1.x): JS reference behavior
   is authoritative.

2. **A test vector**: if the conformance corpus already covers
   the disputed case, the corpus is authoritative. The
   implementation that disagrees has a bug.

3. **An RFC**: if neither of the above resolves it, an RFC
   establishes the canonical interpretation. The RFC patches
   the spec to remove ambiguity AND adds a test vector
   covering the case.

### Step 3: Update implementations

Once the right answer is determined:

- The implementation in the wrong updates its behavior in its
  next release
- The implementation in the right may be asked to add a
  comment in its code citing the resolved disagreement (helps
  future readers)
- The conformance corpus is extended with a vector pinning
  the case

### Step 4: Document the resolution

Add an entry to a "Resolved disputes" log (in this directory,
appended to over time). The entry includes:

- Date
- Spec section
- Two interpretations
- Resolution + reasoning
- Affected implementations + their fix versions

This log helps future readers understand why a spec passage
reads the way it does.

## When the JS reference itself is wrong

The JS reference is the bootstrap authority but not infallible.
If a JS reference behavior:

- Violates the algebraic laws (round-trip, delta correctness,
  composition) — that's a JS reference bug
- Produces undefined behavior (NaN-mapping ambiguity, etc.) —
  that's a spec gap, RFC needed
- Is internally inconsistent (decode of encode != input) —
  that's a JS reference bug

In all three cases, the JS reference gets fixed. Other
implementations that previously aligned with the buggy
behavior will need to update.

The bootstrap authority does NOT mean "JS reference is always
correct." It means "when prose is ambiguous and behavior
hasn't diverged, JS reference is the tiebreaker." Bugs are
bugs regardless of who has them.

## Dual-implementation rule

A non-trivial spec change requires at least 2 conforming
implementations to validate. This catches the case where the
JS reference does X for an obscure reason, and the spec gets
written to say X, but the X is actually a bug nobody noticed
because there was only one implementation.

Concretely: when an RFC proposes new behavior, the proposer
must implement it in at least 1 language other than JS before
the RFC can be Accepted. This forces independent
verification.

For RFCs that only formalize existing behavior (no new
behavior, just spec patching), the dual-impl requirement is
waived.

## Backward compatibility for resolutions

A spec interpretation change that affects the wire format is
itself an RFC requiring backwards-compat consideration:

- If the resolution matches existing payloads' behavior:
  no compat issue (the spec is being clarified, not changed)
- If the resolution changes behavior for some inputs:
  this is a breaking change, requires version bump

## When the prose vs reference question doesn't resolve

If neither source produces a clear answer (rare but possible —
e.g., the JS reference itself is internally inconsistent), the
process is:

1. Discussion phase extended (no automatic acceptance after
   2 weeks)
2. Multiple implementers are pulled in (mailing list, ping)
3. Specific test vectors proposed for each interpretation
4. The interpretation that's easier to implement consistently
   AND is consistent with the protocol's design principles
   wins
5. Resolution is documented in the disputes log

Design principles that may break ties:

- "Every bit, precise math" → prefer interpretations with
  well-defined behavior over heuristic-based ones
- "No conformance theater" → prefer interpretations grounded
  in the protocol's own semantics over those imported from
  other formats
- "Reversibility before optimization" → prefer interpretations
  preserving round-trip
- "Profile isolation" → prefer interpretations that don't
  leak across profile boundaries

## Resolved disputes log

(Empty for now. Will be appended as disputes arise.)

| Date | Section | Resolution | Affects |
|---|---|---|---|

## Anti-patterns

These ARE NOT valid resolutions:

- "Whatever the JS reference does is correct" — the bootstrap
  arrangement is transitional. Bugs are bugs.

- "Match what protobuf / parquet / cbor does" — weavepack is
  not those formats. Don't import their decisions when ours
  conflict.

- "Make both interpretations valid" — bifurcates the protocol.
  Pick one.

- "Defer to the next major version" — the disagreement is
  hurting consumers now. Resolve it now in a minor or patch.
  Major version bumps are for structural changes, not for
  spec interpretation cleanups.

## See also

- `01-rfc-process.md`: RFC procedure for spec changes
- `04-conformance-certification.md`: how implementations
  prove conformance
- `weavepack-core/09-conformance.md`: protocol conformance
  spec
