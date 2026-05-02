# weavepack-core — 07: Extensions and Profile Registry

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the **extension gate** mechanism — the
forward-compatibility primitive that lets weavepack add features
(new profiles, schemas, optional sidecars) without breaking older
decoders. It also specifies the **profile registry**: the canonical
list of registered profile-ids and how new profiles are added.

## The extension problem

A protocol that ships v1.0 must handle the future. New features
(profiles, schemas, compression modes, etc.) will be invented after
v1.0 ships. Existing decoders shouldn't:

- Silently ignore new features and produce wrong results
- Crash unrecoverably on unknown bit patterns
- Require a flag day where everyone upgrades simultaneously

The standard solution is a **forward-compatibility gate**: a marker
that signals "an extension follows; if you don't understand it,
refuse the payload safely."

## Gate placement

The extension gate appears at the **start of a structured-mode
payload**, immediately after the wire mode bit:

```
0                  (mode bit: structured)
[gate marker]      (1 bit; 0 = no extension, 1 = extension follows)
[extension data]   (only if gate marker = 1)
[normal columns]
```

If the gate marker is `0`: no extension; the decoder proceeds with
the normal column sequence (`02-wire-format.md`).

If the gate marker is `1`: an extension follows. The decoder reads
the extension type, looks it up in its registry, and either:
- Handles the extension (if known), then continues
- Refuses the payload with a clear error (if unknown)

Single-payload mode (mode bit = `1`) does NOT have an extension
gate. Single-payload extensions, if needed, are handled via new
tag values in the profile's tag space.

## Extension data format

When the gate marker is `1`:

```
[ext-type]       short()      ; type discriminator
[ext-payload]    (varies by type)
[next-gate]      1 bit        ; 0 = end of gate; 1 = another ext follows
```

Multiple extensions can chain: each ends with a 1-bit "next-gate"
indicator that says whether another extension follows.

The `ext-type` value is drawn from the **extension registry**
(this document, below).

## Refusal semantics

When a decoder encounters an unknown ext-type, it MUST:

1. Not silently skip the payload
2. Not silently produce a partial result
3. Raise an error indicating "unknown extension; payload not
   decodable by this implementation"

Implementations MAY include the ext-type in the error message for
debugging.

This is strict by design. The cost of silent failure (corrupted
state, lost data, indeterminate behavior) far exceeds the cost of
loud failure (clear error, caller upgrades or ignores the payload).

## Profile registry

Every weavepack payload identifies its profile via the profile-id.
The current registry:

| Profile-id | Profile | Spec | Status |
|---|---|---|---|
| `0` | weavepack-json | `profiles/json/` | Stable (v1.x) |
| `1..15` | reserved | — | Reserved for v1 era |
| `16+` | extensible | TBD | Allocated by registration |

The profile-id is encoded in the wire envelope. For v1.x payloads,
the profile-id is implicitly `0` (JSON) — there is no profile-id
field on the wire. v2 will introduce an explicit profile-id.

For now, weavepack-json is the only profile, so dispatch is
unambiguous. As new profiles ship, the wire format MAY introduce
an explicit profile-id field (via the extension gate).

## Adding a new profile

The process for registering a new profile:

1. Author writes a profile spec in `weavepack/profiles/<name>/`
   following the structure of `profiles/json/` (5+ docs covering
   types, containers, paths, deltas, conformance)
2. Author opens an issue or PR proposing the profile
3. Profile is reviewed for:
   - Coherent column-mapping (which core columns are used)
   - Defined type vocabulary
   - Defined container shapes
   - Defined delta op vocabulary
   - At least one reference implementation
   - Conformance test corpus
4. Profile-id is allocated (next available integer)
5. Profile is added to this registry

The barrier to registration is "completeness of spec + reference
impl + tests", not "vendor approval" — there is no central
authority. Anyone who follows the process gets a profile-id.

## Extension types (registry)

Initial extension types reserved for v1.x:

| ext-type | Name | Purpose |
|---|---|---|
| `0` | reserved | (do not use) |
| `1` | profile-id | Override implicit profile-id (dispatches to non-default profile) |
| `2` | schema-id | Schema sidecar reference (`06-schemas.md`) |
| `3..15` | reserved | (do not use) |
| `16+` | extensible | Allocated by registration |

The extension registry is amended as new extensions are needed.

## Forward compatibility scenarios

Examples of how the extension gate handles future features:

### Adding a new profile

1. Profile-id `0` (JSON) is the implicit default. v1.x payloads
   have no explicit profile-id.
2. A new profile (e.g., Tensor) needs profile-id `16`.
3. Tensor payloads use the extension gate with ext-type `1`
   (profile-id) and value `16`.
4. v1.x JSON-only decoders see the gate, see ext-type `1`,
   recognize "this is a non-default profile I don't support",
   and refuse the payload.
5. Newer multi-profile decoders see the gate, dispatch to the
   Tensor profile decoder, and handle it.

### Adding schema support to an existing profile

1. JSON profile starts schemaless.
2. Someone proposes "schemaful JSON" with a schema sidecar.
3. Schemaful payloads use the extension gate with ext-type `2`
   (schema-id) and the hash.
4. v1.x JSON decoders see the gate, see ext-type `2`, recognize
   "this is a schemaful payload I don't support", refuse.
5. Newer decoders that support schemas fetch the schema and
   decode accordingly.

### Adding a new bit-encoding mode

1. Hypothetically, v1.x uses LEB128. A future revision invents
   a more compact integer encoding ("zigvar128").
2. Payloads using zigvar128 use the extension gate with ext-type
   `5` (zigvar128) before the column sequence.
3. v1.x decoders refuse; new decoders adapt.

## Extension scope

An extension applies to the rest of the payload. There is no
mechanism for a "scoped" extension that applies only to a specific
column. To extend a single column's encoding, the protocol assigns
a new ext-type that signals "this entire payload uses the extended
column encoding".

## Extension and chains

Each delta in a chain is independently extensioned. `Delta_0` may
have no extension; `Delta_1` may use schema sidecar; `Delta_2` may
use a different extension. The chain framing (LEB128 length prefix)
doesn't interact with extensions.

This means: if a chain has mixed-extension deltas, a decoder must
support every extension used in any of its deltas, or it must
refuse the chain at the first unsupported delta.

## Versioning interaction

The extension gate is the primary forward-compatibility mechanism.
Wire format version bumps are reserved for changes that cannot be
expressed as extensions:

- v1.0 → v1.1: RLE flag prefix on `vflags`/`kflags`/`bools`. This
  was a structural change to existing columns, not an addition.
  v1.0 decoders cannot read v1.1 payloads.

Future versions:

- v1.x: incremental compatible extensions via the extension gate.
- v2.0: structural overhaul (e.g., adding a profile-id field to
  the wire envelope, restructuring columns). v1.x decoders refuse
  v2 payloads.

The wire format version is encoded in the wire envelope (currently
implicit; a v2 payload will explicitly carry a version field).

## Implementation note

The extension gate is **not yet implemented in v1.x**. v1.x payloads
have no gate marker; the wire format starts directly with the column
sequence after the mode bit.

The gate will be added in a v1.2 release that updates the wire
format. Implementations targeting v1.x payloads SHOULD be prepared
to add gate support in a future version.

The fact that v1.x has no gate means v1.x decoders cannot
gracefully refuse v2 payloads — they will misinterpret them. v2
will introduce the gate at a position that is structurally different
from v1.x's column start, so v2 payloads are at least clearly "not
v1.x" to a v1.x decoder (which will fail in a recoverable way:
buffer overrun or invalid bit pattern).

## Conformance

A v1.x conformant implementation MUST:
- Accept v1.x payloads (no gate)
- NOT silently accept payloads with unknown leading bit patterns

A future v1.2+ implementation MUST:
- Read the extension gate marker
- Refuse payloads with unknown extensions
- Process known extensions correctly

## Open issues

1. **Profile-id placement in v1.x**: do we add it via the gate
   in v1.2 (least disruptive) or wait until v2.0 (cleaner)?
   Decision pending the first non-JSON profile shipping.

2. **Extension scope for schemas**: schemas naturally apply to
   the whole payload, but a hybrid "some columns schemaful, some
   schemaless" mode might be useful. Open question.

3. **Backwards-compatible signatures**: if a payload has a
   cryptographic signature, the extension gate's "unknown
   extension = refuse" rule means any payload with new extensions
   is unverifiable by old verifiers. This is the right rule for
   safety but inconvenient for slow-evolving signature schemes.
