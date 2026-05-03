# weavepack Governance — Implementation Registry

**Status:** Draft. Phase 7 of the weavepack roadmap.

## Purpose

Lists known implementations of weavepack with their conformance
claims. Consumers use this to find an implementation in their
language; profile authors use it to know who's likely to adopt
new features.

## Listed implementations

| Name | Lang | Repo | Profiles | Levels | Last verified |
|---|---|---|---|---|---|
| arjson (a.k.a. weavepack-js reference) | JavaScript / Node | https://github.com/weavedb/arjson | json v1.1 (L3), tensor v0.1 (L3), null (test) | 148/148 (JSON+tensor) | 2026-05-03 |
| weavepack-tensor (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-tensor | tensor v0.1 (L3, 5 delta ops + region_replace + RFC 0001 fp16/bf16) | 55/55 vectors | 2026-05-03 |
| weavepack-json (Rust, partial) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-json | json v1.1 (L1+L2 decoder; L3 encoder for single-payload subset) | 93/93 vectors | 2026-05-03 |
| weavepack-json (Python, PoC) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/ | json v1.1 partial (L3 encoder + decoder for single-payload only) | 37/93 vectors | 2026-05-03 |
| weavepack-tensor (Python, PoC) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/ | tensor v0.1 (L3 encoder + decoder; schemaless + schemaful + 5 delta ops including region_replace) | 55/55 vectors | 2026-05-03 |
| weavepack-tensor-rs (PyO3) | Python 3.8+ via Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-tensor-py/ | tensor v0.1 (L3 via Rust crate) | 55/55 vectors | 2026-05-03 |

The "TBD on last verified" entries will get real timestamps once
the certification badge infrastructure exists. For now, claims are
self-asserted in each implementation's README.

## How to register your implementation

1. Implement weavepack (or any subset)
2. Run conformance per `04-conformance-certification.md`
3. Open an issue on the spec repo titled "Implementation
   registration: <name>"
4. Provide:
   - Implementation name + repo URL
   - Language(s) / platform(s)
   - Profiles supported with version + claimed conformance level
   - Test run command + last verified date
   - Maintainer contact (GitHub handle, email, or "abandoned")
5. Reviewer checks the conformance run reproduces locally
6. Registry maintainer updates this table with the new entry

The barrier to listing is "you have a working implementation that
passes conformance". No vetting beyond that.

## Implementation lifecycle states

An entry in the registry has an implicit lifecycle state, derived
from `Last verified`:

- **Active** (verified within 90 days): listed normally
- **Stale** (verified > 90 days ago): listed with a `(stale)`
  marker
- **Abandoned** (verified > 1 year, no maintainer response):
  listed with an `(abandoned)` marker

Stale and abandoned entries remain in the registry as historical
artifacts (consumers may still find them useful for old payloads).
They are NOT removed.

## Implementation diversity goals

For weavepack to be a real protocol (not a single-language
library), the registry should diversify across:

1. **Languages**: at minimum JS, Rust, Python (via bindings).
   Stretch: Go, Java, C++, Swift.

2. **Use cases**: encoder-only, decoder-only, full round-trip,
   embedded (size-constrained), high-throughput (server),
   streaming.

3. **Profiles**: every registered profile (`02-profile-registry.md`)
   ideally has ≥ 2 implementations.

4. **Independence**: implementations not derived from the JS
   reference's translation prove the spec is implementable.
   (Translation-derived impls catch the same bugs.)

Current state vs goals:

- Languages: ✓ JS, ✓ Rust (partial). Pending: Python.
- Use cases: ✓ full round-trip (JS, Rust). Pending: streaming,
  embedded.
- Profiles: weavepack-json has 2 impls (JS full, Rust partial);
  weavepack-tensor has 2 impls (JS, Rust full).
- Independence: All current impls are reference-derived.
  Pending: an independent third-party impl.

## Removal policy

Entries are NOT removed from the registry. The implementation
lifecycle marker (Active / Stale / Abandoned) communicates
freshness. This avoids broken references when consumers cite
an implementation by registry entry.

If an implementation is genuinely deleted (repo gone), the
entry is updated to mark the link as broken with a note about
when. Wayback Machine links may be added if available.

## Bindings

A binding (e.g., Python via PyO3 over the Rust crate, or a Node
NAPI binding over Rust) is a separate registry entry from the
underlying implementation. It has its own conformance claim,
since the binding may have its own bugs.

Format: `<lang>-bindings-for-<base>`. Example: `python-bindings-for-weavepack-rust`.

## Updates and notifications

When the spec changes (RFC accepted), implementations are NOT
automatically updated. Each implementation chooses when to
adopt new spec versions. The registry table reflects which
spec version each implementation currently supports.

For coordinating cross-implementation upgrades, use the spec
repo's discussions / mailing list (when established).

## See also

- `02-profile-registry.md`: which profiles exist
- `04-conformance-certification.md`: how to claim a level
- `06-spec-interpretation.md`: when implementations disagree
  on what the spec means
