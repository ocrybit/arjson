# weavepack Governance — Profile Registry

**Status:** Active. Phase 7 of the weavepack roadmap.

## Profile-id allocation

Each registered profile is assigned a stable integer **profile-id**.
The profile-id appears in the wire envelope (via the extension gate
for non-default profiles) so decoders can dispatch to the right
profile-specific reader.

Profile-id `0` is reserved for **weavepack-json**, the default
profile (no explicit id needed in v1.x payloads).

Profile-ids `1..15` are reserved for v1.x core profiles.

Profile-ids `16+` are allocated to community profiles per the
registration process (`01-rfc-process.md`, profile-author lighter
weight track).

## Registered profiles (v1.x)

| ID | Name | Status | Wire spec | Reference impl |
|---|---|---|---|---|
| 0 | weavepack-json | Stable | `weavepack/profiles/json/` | `sdk/src/profiles/json/` (JS), `impl/rust/weavepack-json/` (Rust), `impl/python/weavepack_json/` (Python) |
| 1 | weavepack-tensor | v0.3 | `weavepack/profiles/tensor/` | `sdk/src/profiles/tensor/` (JS), `impl/rust/weavepack-tensor/` (Rust), `impl/python/weavepack_tensor/` (Python) |
| 2 | weavepack-null | Test | `sdk/src/profiles/null/` (impl-only; no spec) | `sdk/src/profiles/null/` |
| 3 | weavepack-wire | v0.1 | `weavepack/profiles/wire/` | `sdk/src/profiles/wire/` (JS), `impl/rust/weavepack-wire/` (Rust), `impl/python/weavepack_wire/` (Python) |
| 4 | weavepack-tabular | v0.1 | `weavepack/profiles/tabular/` | `sdk/src/profiles/tabular/` (JS), `impl/rust/weavepack-tabular/` (Rust), `impl/python/weavepack_tabular/` (Python) |
| 5 | weavepack-log | v0.1 | `weavepack/profiles/log/` | `sdk/src/profiles/log/` (JS), `impl/rust/weavepack-log/` (Rust), `impl/python/weavepack_log/` (Python) |
| 6 | weavepack-graph | v0.1 | `weavepack/profiles/graph/` | `sdk/src/profiles/graph/` (JS), `impl/rust/weavepack-graph/` (Rust), `impl/python/weavepack_graph/` (Python) |
| 7 | weavepack-ast | v0.1 | `weavepack/profiles/ast/` | `sdk/src/profiles/ast/` (JS), `impl/rust/weavepack-ast/` (Rust), `impl/python/weavepack_ast/` (Python) |
| 8..15 | reserved | — | — | — |

The null profile (id 2) is a boundary-validation test profile
(see Phase 3.8 in the roadmap). It demonstrates the
protocol/profile boundary holds with a minimum profile that
doesn't depend on JSON-specific code. It is not intended for
production use; consumers should not encode anything as
weavepack-null in real payloads.

## Reserved IDs

These are reserved for plausible additions but unallocated
pending an RFC:

- 9: weavepack-geo (GeoJSON-compatible)
- 10: weavepack-time-series (high-rate sensor / metric data)
- 11: weavepack-document (hierarchical doc, Markdown/HTML)
- 12..15: open

If you want to register one of these, follow the profile-author
RFC track. The reservation is just a placeholder so id allocation
is predictable.

## Allocating a new profile-id

Procedure (per `01-rfc-process.md`, profile-author track):

1. **Check the reserved list** above. If your profile fits an
   existing reservation, use that id. Otherwise, request the
   next available id ≥ 16.

2. **Write the spec** in `weavepack/profiles/<name>/` covering:
   - `00-overview.md`: motivation, scope, design decisions
   - `01-types.md`: dtype / value vocabulary
   - `02-containers.md`: structural shape
   - `03-paths.md`: navigation grammar (or N/A if flat)
   - `04-deltas.md`: delta op vocabulary
   - `05-conformance.md`: test corpus structure

3. **Implement in at least one language**, with conformance
   binary that reproduces the JS reference's byte output for
   the corpus.

4. **Conformance corpus**: ≥ 10 test vectors, exercising
   each primitive op, each ctype, and at least one delta path.
   Adversarial vectors encouraged but not required.

5. **Open registration issue** titled "Profile registration:
   weavepack-<name>" with:
   - Link to the spec PR
   - Link to the reference impl PR
   - Link to the test corpus
   - Statement of intended use cases
   - Requested profile-id

6. **Review** by ≥ 1 reviewer with prior weavepack contribution
   (any committed PR counts). They check:
   - Spec is complete and structurally consistent with other
     profiles
   - Implementation passes the test corpus
   - Profile boundary is respected (no imports from other
     profiles' internal code)

7. **Acceptance**: registry maintainer updates this doc with
   the new entry, marks the registration issue closed.

8. **Stable id**: the profile-id is now permanent. Even if the
   profile is later deprecated, the id is not reused.

## Registry maintainer

A single person who can update this registry on accepted
registrations. The role exists to avoid contention over which
PR lands first when two profile authors race for the same id.

**Bootstrap maintainer (v0.x phase):** The project maintainer(s)
at `ocrybit/arjson` on GitHub serve as the registry maintainer
until the community has grown enough to warrant a dedicated role.
Concretely: anyone with merge rights to `ocrybit/arjson:weavepack`
may accept a registration and update this table.

**Bootstrapping ends when** either (a) a second independent
implementation passes the full conformance suite for any profile,
or (b) the community nominates a dedicated maintainer via RFC.

When the ecosystem grows enough to need a permanent maintainer,
selection happens via RFC.

## Deprecation

A profile may be marked `Deprecated` if:

- Superseded by a successor profile (e.g., weavepack-tensor v2
  replacing v1 with a different wire format)
- Discovered to be unimplementable (a fundamental design flaw
  not fixable within the same id)
- Abandoned (no maintainer for ≥ 1 year, no production users)

Deprecation:

1. Update this registry with `Deprecated` status and successor
   reference (or "no successor")
2. Update the profile's `00-overview.md` to point to the
   successor or explain the deprecation
3. Existing payloads using the deprecated profile remain
   decodable by implementations that support it; new
   implementations are NOT required to support deprecated
   profiles.

The id is retired (not reused).

## Profile naming convention

- All profile names start with `weavepack-` followed by a
  lowercase identifier
- Identifier is short (typically one word: `json`, `tensor`,
  `tabular`, `graph`)
- No dashes within the identifier (use camelcase or single word)
- Names are case-sensitive in the registry but rendered
  consistently in lowercase

Bad names (would be rejected): `WeavePack-JSON`,
`weavepack-my-cool-format`, `wp-foo`, `tensor` (missing prefix).

Good names: `weavepack-json`, `weavepack-tensor`,
`weavepack-quark`, `weavepack-gguf`.

## Profile-id space limits

The 5-bit dtype space in weavepack-tensor leaves 5 bits = 32
slots. The profile-id space (in the extension gate's profile-id
extension type) is **LEB128 unsigned**, so practically unbounded.
The reservation system (1..15 reserved, 16+ open) is policy,
not protocol limit.

If the ecosystem ever hits 100+ profiles, the registry maintainer
may want to organize by namespace (e.g., `weavepack-arweave-*` for
Arweave-specific profiles, `weavepack-ml-*` for ML-specific). No
hard rule on this until adoption justifies it.

## Profile-id collisions in v1.x payloads

v1.x payloads do NOT carry an explicit profile-id (the implicit
default is 0 = JSON). To use a non-JSON profile in v1.x, a
producer must use the extension gate with the `profile-id`
extension type.

A v1.x JSON-only decoder receiving a payload with the profile-id
extension MUST refuse it via the unknown-extension rule
(`weavepack-core/07-extensions.md`). It MUST NOT silently parse
the rest as if the profile-id didn't matter.

This is the safety property that lets new profiles ship without
a flag day.

## See also

- `01-rfc-process.md`: how to propose a new profile
- `04-conformance-certification.md`: how implementations claim
  to support a profile
- `05-implementation-registry.md`: which implementations support
  which profiles
