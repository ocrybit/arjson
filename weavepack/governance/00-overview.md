# weavepack Governance — Overview

**Status:** Active. Phase 7 of the weavepack roadmap.

## Why governance

weavepack is a protocol, not a single library. As soon as multiple
profiles ship and multiple implementations exist, decisions about
the protocol's evolution affect more than one party. Without
explicit governance, conflicts get resolved ad-hoc — favoring
whoever shouts loudest, breaks fastest, or owns the dominant
implementation.

This directory establishes the rules for:

- Adding new profiles to the registry
- Evolving the wire format
- Certifying implementations
- Resolving disputes about spec interpretation

## Documents

| Doc | Topic |
|---|---|
| `00-overview.md` | This document. Rationale, structure, audience. |
| `01-rfc-process.md` | How protocol changes are proposed and accepted |
| `02-profile-registry.md` | The registered profiles + how to add yours |
| `03-versioning.md` | Semver rules for protocol vs profiles + breaking-change policy |
| `04-conformance-certification.md` | How implementations claim conformance levels |
| `05-implementation-registry.md` | Listed implementations, their conformance, contact info |
| `06-spec-interpretation.md` | When the spec and reference implementation disagree |

## Audience

Three groups of readers:

1. **Implementers**: people writing weavepack libraries in any
   language. Need to know which profile-ids are taken, which
   conformance level they should target, how to claim it.

2. **Profile authors**: people defining new profiles for novel
   data shapes (graphs, time-series, ASTs, etc.). Need to know
   the RFC process and what the registry expects.

3. **Consumers**: applications using weavepack as infrastructure
   (e.g., weavedb, hypothetical ML platforms). Need to know
   what guarantees apply across implementations and how to
   verify them.

## Governance scope (and non-scope)

In scope:

- Protocol evolution (wire format changes, extension types)
- Profile registry (allocation of profile-ids, spec inclusion)
- Conformance specification (what claims mean, how they're verified)
- Implementation listing (so consumers know what's available)
- Dispute resolution between implementations (when wire format
  ambiguity matters)

NOT in scope:

- License enforcement (each implementation chooses its license;
  reference impls are MIT)
- Code style (each implementation chooses its conventions)
- Performance benchmarks beyond conformance (separate effort)
- Security advisories (handled per-implementation by their own
  vulnerability disclosure processes)
- Marketing / brand decisions (community organic)

## Authority model

There is **no central authority**. Specifically:

- No "weavepack foundation" or corporation owns the protocol.
- No single person has veto power over RFCs.
- No implementation is "the official one"; the JS reference is
  authoritative for v1.x prose ambiguity, but that's a transitional
  arrangement (see `06-spec-interpretation.md`).

Decisions are made by **rough consensus** among active contributors:

- Spec changes: RFC process (`01-rfc-process.md`)
- Profile additions: profile-author proposes, reviewers verify
  spec completeness + reference impl, registry maintainer assigns
  profile-id
- Conformance claims: self-asserted, with reproducible test runs
  posted publicly
- Disputes: discussion on the spec repo's GitHub issues; if
  unresolved, the dispute documents both interpretations and
  consumers choose

This model assumes the ecosystem stays small enough that rough
consensus works (10s of implementations, not 1000s). If weavepack
hits genuinely large adoption, governance may need to formalize
further. That's a future-revisit problem, not a launch-day one.

## Versioning at a glance

- **Protocol versions** (v1.x, v2.x, ...): semver-like, with
  major bumps for wire-format breaks. Detailed in
  `03-versioning.md`.
- **Profile versions** (per profile): independent semver, e.g.
  weavepack-tensor v0.1, v0.2, v1.0. Each profile evolves on its
  own cadence.
- **Implementation versions**: each implementation chooses its
  own; conformance claims state which protocol + profile
  versions are supported.

## Bootstrapping notes

Until the ecosystem has at least 3 active implementations, the JS
reference is the de-facto specification. The prose specs in
`weavepack/core/` and `weavepack/profiles/` are intended to be
normative, but where they disagree with the JS reference for
v1.x, the JS reference wins by default.

This bootstrap arrangement ends at v2.0, when the prose spec
becomes normative and reference implementations track it.

## How to participate

- Read the spec (`weavepack/core/`, `weavepack/profiles/`)
- Build something against it (a new profile, a new implementation,
  a consumer application)
- Open issues / PRs on the spec repo with proposed changes
- Follow the RFC process (`01-rfc-process.md`) for non-trivial
  proposals

The barrier to participating is "do something useful with the
protocol, then propose your changes." There is no preliminary
membership step, dues, contributor agreement, or organizational
gatekeeping. This is intentional.
