# weavepack Governance — RFC Process

**Status:** Draft. Phase 7 of the weavepack roadmap.

## When an RFC is required

An RFC is required for changes that:

1. **Modify the wire format** of weavepack-core or any registered
   profile (e.g., adding a new column type, changing an existing
   column's encoding).
2. **Change the conformance criteria** for any level (e.g., raising
   Level 2 to require a new property).
3. **Add a new extension type** to the extension registry
   (`weavepack-core/07-extensions.md`).
4. **Add a new profile** to the registry (allocate a profile-id,
   include the spec in `weavepack/profiles/`).
5. **Deprecate a profile or extension** (mark obsolete, recommend
   migration path).
6. **Change governance rules** themselves (this directory).

Changes NOT requiring RFC:

- Editorial spec fixes (typos, clarifications that don't change
  behavior)
- Adding test vectors
- Performance optimizations within an implementation that don't
  affect wire format
- New tooling (benchmark scripts, conformance runners)

When in doubt, open an RFC. It's cheaper to discuss than to
revert a merged behavior change.

## RFC document format

An RFC lives in `weavepack/rfcs/NNNN-<short-name>.md` where NNNN
is the next available number. The document has these sections:

```
# RFC NNNN — <Title>

**Status:** Draft | Discussion | Accepted | Rejected | Superseded by NNNN
**Author(s):** <names + GitHub handles>
**Created:** YYYY-MM-DD
**Affects:** weavepack-core | weavepack-<profile> | governance

## Summary

One paragraph: what changes, who benefits.

## Motivation

What problem does this solve? What's wrong with the status quo?
Cite specific use cases or pain points.

## Detailed design

The actual change. Wire format diffs, algorithm specs, examples.
Should be precise enough that two independent implementations
would produce the same bytes.

## Backwards compatibility

How does this affect existing implementations and payloads?

- Hard break (wire format incompatible)? Then this needs a
  major version bump.
- Soft break (extension that v1.x decoders refuse)? Then it
  fits within the extension gate; specify the extension type.
- No break (additive within existing tags / behavior)? Then it
  can ship in a minor version.

## Reference implementation

A working implementation in at least one language (preferably
the JS reference) demonstrating the change. The implementation
doesn't have to be merged before the RFC, but it must exist
before the RFC can be Accepted.

## Test vectors

At least 3 byte-exact test vectors covering the new behavior.
Adversarial cases (truncated input, malformed payload) are
encouraged.

## Migration

If this changes existing behavior: how do existing payloads
remain decodable? When can old behavior be removed?

## Alternatives considered

Other approaches you rejected and why. Helps reviewers
understand the design space.

## Open questions

Things you haven't decided. Reviewers will weigh in here.
```

## RFC lifecycle

```
[Draft] ──→ [Discussion] ──→ [Accepted] ──→ merged
            └──→ [Rejected]
            └──→ [Superseded by RFC NNNN]
```

### Draft

The RFC document is being written. Status: `Draft`. Open in a PR
against `weavepack/rfcs/`. Reviewers may comment but binding
review starts when the author marks the RFC `Discussion`.

### Discussion

The author has finished the initial draft and is soliciting
review. Minimum **2 weeks** of discussion before acceptance can
proceed. During this period:

- Anyone may comment on the PR
- The author may revise in response to comments
- Reviewers may identify blocking issues that must be resolved
  before acceptance

The 2-week minimum exists to give people across time zones,
holidays, and busy periods a chance to weigh in.

### Accepted

After discussion completes (no unresolved blocking issues +
≥ 2 weeks elapsed), the RFC is marked `Accepted`. The PR is
merged into `weavepack/rfcs/`. Implementation can then proceed
in any conforming implementation.

For RFCs that affect wire format: the protocol/profile version
in the spec docs (`weavepack/core/00-introduction.md`,
`weavepack/profiles/<name>/00-overview.md`) is bumped in a
follow-up PR.

### Rejected

The proposal isn't going forward. Document the rejection
reasons in the RFC itself (this is useful history — future
proposers can see what was considered and why).

A rejected RFC stays in `weavepack/rfcs/` with status
`Rejected`. It is not deleted.

### Superseded

A later RFC replaces this one. Cross-reference both directions
(the old RFC says "Superseded by RFC NNNN"; the new one says
"Replaces RFC NNNN").

## Decision rule

RFCs are accepted by **rough consensus** of active contributors.
Concretely:

1. The author marks the RFC `Discussion`.
2. After ≥ 2 weeks, if there are no unresolved blocking issues
   from at least one reviewer who has built against weavepack
   (i.e., shipped an implementation, profile, or significant
   consumer), the author may mark it `Accepted`.
3. If there ARE unresolved blocking issues, the author either:
   - Revises and re-iterates
   - Withdraws the RFC (mark `Rejected`)
   - Escalates to a wider discussion call (mailing list,
     scheduled video call) to break the impasse

There is no formal vote count. The principle is: if reasonable
people who understand the protocol disagree, work through the
disagreement. If they can't, the more conservative path wins
by default.

## Blocking objections

A "blocking" objection must:

1. Identify a specific harm (correctness bug, security issue,
   compatibility break, conformance violation)
2. Suggest a path to address it (alternative design, scoped
   restriction, follow-up RFC)
3. Be made by someone who has demonstrated engagement with
   weavepack (built something against it)

Pure aesthetic disagreements ("I don't like the name", "the
algorithm is ugly") are not blocking. They may motivate
revisions but cannot stop an RFC.

## Fast-track for security

Security-critical changes (e.g., a decoder bounds check that
allows DoS via crafted input) may bypass the 2-week discussion
requirement. The author marks the RFC `Discussion (security
fast-track)` and seeks acceptance from any other active
contributor within 48 hours.

The discussion period is shortened, not eliminated. Even
security fixes need at least one independent review to catch
mistakes.

## Profile-author RFCs (lighter weight)

Adding a new profile is technically an RFC, but the process is
streamlined since profiles are self-contained:

1. Author writes the profile spec in
   `weavepack/profiles/<name>/` (5+ docs covering types,
   containers, paths, deltas, conformance — see
   `weavepack/profiles/json/` for the template).
2. Author opens an issue with title "Profile registration:
   weavepack-<name>".
3. Reviewers verify:
   - Spec is complete (5 docs minimum)
   - Reference implementation exists in at least one language
   - Conformance corpus has ≥ 10 test vectors
   - Profile-id is reasonable (no collision with reserved range)
4. Registry maintainer (currently TBD; see
   `02-profile-registry.md`) assigns the next available
   profile-id and updates the registry.
5. Profile is added to `weavepack/governance/02-profile-registry.md`.

Estimated turnaround: days to a couple weeks, depending on
review backlog.

## Withdrawing or amending

The original author of an RFC may withdraw it at any time
before it's `Accepted`.

After acceptance, changes require a new RFC that supersedes
the old one. The old RFC is not edited.

## Examples (forward-looking)

Hypothetical RFCs that would be expected:

- RFC 0001: Schema evolution as delta chains (mentioned in
  `weavepack-core/06-schemas.md` as deferred)
- RFC 0002: Add region_replace + quant_change ops to
  weavepack-tensor (mentioned in tensor 04-deltas.md as v0.1
  partial coverage)
- RFC 0003: weavepack-graph profile registration
- RFC 0004: Adding fp16 / bf16 / int4 dtypes to
  weavepack-tensor v0.2

The first real RFC will likely shake out gaps in this process
doc. That's expected — the process is itself amendable via RFC.

## Number assignment

RFCs are numbered sequentially starting at 0001. The next
available number is whichever is one greater than the highest
in `weavepack/rfcs/`. The author picks their own number when
opening the PR; if a collision occurs, the later PR rebases to
the next available.

Reserved: RFC 0000 is the meta-RFC defining the RFC process
itself (this document). Future revisions of the process are
new RFCs that supersede 0000.
