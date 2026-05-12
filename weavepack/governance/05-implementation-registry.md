# weavepack Governance — Implementation Registry

**Status:** Active. Phase 7 of the weavepack roadmap.

## Purpose

Lists known implementations of weavepack with their conformance
claims. Consumers use this to find an implementation in their
language; profile authors use it to know who's likely to adopt
new features.

## Listed implementations

| Name | Lang | Repo | Profiles | Vectors | Last verified |
|---|---|---|---|---|---|
| arjson (weavepack-js reference) | JavaScript / Node.js | https://github.com/weavedb/arjson | wire v0.1, tabular v0.1, tensor v0.3, log v0.1, json v1.1 (RFC 0001 fp16/bf16, RFC 0002 v1.2 magic), graph v0.1, ast v0.1 — full L3 (encode + decode + delta chain apply) for all profiles | 575/575 | 2026-05-12 |
| weavepack-wire (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-wire | wire v0.1 — full L3 (encode + decode + delta chain apply) | 74/74 | 2026-05-12 |
| weavepack-tabular (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-tabular | tabular v0.1 — full L3 (encode + decode + delta chain apply) | 52/52 | 2026-05-12 |
| weavepack-tensor (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-tensor | tensor v0.3 — full L3, all 6 delta ops, all dtypes (fp8e4m3/e5m2, cfloat32/64, int4/uint4, qint8/qint4/qfp8, fp16/bf16 via RFC 0001), delta-from-prior, schemaful qint | 109/109 | 2026-05-12 |
| weavepack-log (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-log | log v0.1 — full L3 (encode + decode + delta chain apply) | 77/77 | 2026-05-12 |
| weavepack-json (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-json | json v1.1 (RFC 0002 v1.2 magic) — full L3 (encode + decode + delta chains) | 110/110 | 2026-05-12 |
| weavepack-graph (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-graph | graph v0.1 — full L3 (encode + decode + delta chain apply) | 73/73 | 2026-05-12 |
| weavepack-ast (Rust) | Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-ast | ast v0.1 — full L3, all 6 delta ops (node_insert, node_delete, node_move, prop_set, kind_rename, subtree_replace) | 80/80 | 2026-05-12 |
| weavepack-wire (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_wire | wire v0.1 — full L3 (encode + decode + delta chain apply) | 74/74 (1 pending) | 2026-05-12 |
| weavepack-tabular (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_tabular | tabular v0.1 — full L3 (encode + decode + delta chain apply) | 52/52 | 2026-05-12 |
| weavepack-tensor (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_tensor | tensor v0.3 — full L3, all 6 delta ops, all dtypes (fp8/cfloat/int4/qint/fp16/bf16), delta-from-prior, schemaful qint | 109/109 | 2026-05-12 |
| weavepack-log (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_log | log v0.1 — full L3 (encode + decode + delta chain apply) | 77/77 | 2026-05-12 |
| weavepack-json (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_json | json v1.1 (RFC 0002 v1.2 magic) — full L3 (encode + decode + delta chains) | 110/110 | 2026-05-12 |
| weavepack-graph (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_graph | graph v0.1 — full L3 (encode + decode + delta chain apply) | 73/73 | 2026-05-12 |
| weavepack-ast (Python) | Python 3.10+ | https://github.com/weavedb/arjson tree impl/python/weavepack_ast | ast v0.1 — full L3, all 6 delta ops (node_insert, node_delete, node_move, prop_set, kind_rename, subtree_replace) | 80/80 | 2026-05-12 |
| weavepack-tensor-rs (PyO3) | Python 3.8+ via Rust | https://github.com/weavedb/arjson tree impl/rust/weavepack-tensor-py | tensor v0.1 via Rust crate (schemaful encode/decode + basic dtypes; 35 pre-existing failures for schema-less int4/fp8/cfloat vectors) | 74/109 | 2026-05-06 |

"Last verified" timestamps reflect the most recent date the
implementation passed its full conformance corpus locally. Claims
are self-asserted in each implementation's README; cross-language
agreement is independently verified via
`weavepack/tools/verify-test-vectors.js` (575 vectors, 0 fail
across JS reference + Python; Rust via per-crate `conformance` binary).

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

- Languages: ✓ JS (full, all 8 profiles), ✓ Rust (full, all 8
  profiles), ✓ Python (full, all 8 profiles), ✓ Python+Rust
  binding (partial, tensor only). Stretch languages (Go, Java,
  C++, Swift) pending community contribution.
- Use cases: ✓ full round-trip (JS, Rust, Python), ✓ bindings
  (PyO3, tensor). Pending: streaming, embedded.
- Profiles: all 8 registered profiles (wire, tabular, tensor,
  log, json, graph, ast, and null) have ≥ 3 independent
  implementations (JS + Rust + Python).
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
