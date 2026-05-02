# weavepack-core — 00: Introduction

**Status:** Draft. Phase 2 of the weavepack roadmap.

## What weavepack-core is

weavepack-core is the protocol-level specification of the weavepack
universal structural-data format. It defines the **invariants** that
every weavepack payload satisfies, independent of which **profile**
(e.g., JSON, Tensor, Tabular) the payload encodes.

A weavepack payload is the output of one of N implementations
conforming to this spec. The spec provides the contract; profiles
fill in the data-shape-specific details.

## Document scope

This `core/` directory specifies, in order:

| Doc | Topic |
|---|---|
| `00-introduction.md` | This document. Reading order, terminology, conventions. |
| `01-data-model.md` | Abstract data model: typed columns, refs, the column registry. |
| `02-wire-format.md` | Concrete byte layout: envelope, sections, column ordering. |
| `03-bit-encoding.md` | Bit-level primitives: `short`, `uint`, `leb128`, RLE, delta-pack. |
| `04-strmap.md` | String interning protocol: alphabet, dedup, hash-address. |
| `05-deltas.md` | Delta chain semantics, composition laws, re-anchor. |
| `06-schemas.md` | Optional schema sidecar mechanism, hash-addressing. |
| `07-extensions.md` | Extension gate, profile registry, version negotiation. |
| `08-security.md` | DoS bounds, adversarial input handling. |
| `09-conformance.md` | Core-level test corpus. |

A profile (e.g., `weavepack/profiles/json/`) extends weavepack-core
with profile-specific decisions: type vocabulary, container shapes,
path grammar, delta op vocabulary, and a profile-specific test corpus.

The relationship between core and a profile is layered:

```
Profile spec
  └─→ relies on weavepack-core for: column packing, bit primitives,
      strmap, delta machinery, wire envelope, extension gate
  └─→ defines: type table, container shapes, paths, delta ops,
      schema language (optional)
```

A new profile is added by writing a `profiles/<name>/` directory that
satisfies the core's interface obligations.

## Conventions

### Terminology

- **Payload**: a contiguous byte sequence representing one delta in
  a chain, or one stand-alone document.
- **Chain**: a sequence of N ≥ 1 payloads that together represent a
  versioned document. The first payload anchors the initial state;
  subsequent payloads encode incremental updates.
- **Profile**: a data-shape-specific layer above weavepack-core. JSON,
  Tensor, Tabular, etc. are profiles.
- **ARTable**: the materialized columnar state derived from a payload
  or chain. Profile-specific in content but core-defined in structure.
- **Column**: a typed bit-stream within a payload, addressed by name
  in the wire envelope. Examples: `vrefs`, `krefs`, `nums`, `strs`.
- **Strmap**: the deduplicated string table local to a payload (or
  amortized across a chain).
- **Single-payload mode**: a special encoding for stand-alone primitive
  values that bypasses the structured column layout.
- **Structured mode**: the standard encoding using all defined columns.
- **Extension gate**: a forward-compatibility mechanism allowing
  unknown wire-format extensions to be safely skipped.

### Normative language

This spec uses the conventions of [RFC 2119](
https://www.rfc-editor.org/rfc/rfc2119):

- **MUST** / **MUST NOT** — absolute requirements
- **SHOULD** / **SHOULD NOT** — strong recommendations
- **MAY** — optional behavior

Statements without these keywords are descriptive, not normative.

### Bit and byte ordering

- All multi-byte integers use **little-endian byte order** within a
  single LEB128 chunk (LSB first).
- Bit packing within a byte is **MSB-first** — the first bit of a
  field is the highest-order bit of its containing byte.
- Bit fields can span byte boundaries; the encoding is unambiguous
  given the field's declared width.

### Code references

Where this spec references implementation behavior, the JS reference
implementation in `sdk/src/` is normative for v1. Other implementations
SHOULD treat the JS implementation as the authoritative tiebreaker
when this prose is ambiguous.

For v2 and beyond, normative behavior will be specified entirely in
prose; the reference implementation will be a conformant
implementation, not the source of truth.

## Reading order for new readers

1. **`00-introduction.md`** (this document) — terminology and scope
2. **`01-data-model.md`** — what's being encoded (the abstract level)
3. **`02-wire-format.md`** — how it's laid out (the concrete level)
4. **A profile spec** (e.g., `profiles/json/01-types.md`) — see how
   the core slots together with a specific data shape
5. **`03-bit-encoding.md`** — the low-level primitives, when ready
   to implement
6. **`05-deltas.md`** — the chain mechanics
7. **Other core docs** as needed

Implementing a decoder is most easily done starting from
`02-wire-format.md` (read top-down). Implementing an encoder starts
from `01-data-model.md` (build the columnar state, then dump).

## Versioning

The wire format is versioned. The current version is **v1.1**.

| Version | Year | Major change |
|---|---|---|
| v1.0 | 2024 | Initial release. JSON profile only. |
| v1.1 | 2025 | RLE prefix on flag columns (`vflags`, `kflags`, `bools`). Backwards-incompatible with v1.0 readers. |

Versioning policy: a v1.x payload is decodable by a v1.x reader, where
x is monotonically increasing. v2 will be a major break and v1 readers
SHOULD safely refuse v2 payloads via the extension gate.

The version is encoded in the wire envelope (`02-wire-format.md`).

## Profile naming

Profiles use the naming convention `weavepack-<profile-name>` where
`<profile-name>` is a lowercase identifier. Examples: `weavepack-json`,
`weavepack-tensor`, `weavepack-tabular`.

A profile-id appears in the wire envelope to allow decoders to dispatch
to the correct profile-specific decoder. The profile-id space is
maintained in `07-extensions.md`'s registry.

## What weavepack-core does NOT specify

These are deliberately deferred to profiles or to consumers:

- **Value type vocabulary**: profile-specific (each profile defines
  its own type table)
- **Container shapes**: profile-specific (containers may be objects,
  arrays, tensors, graph nodes, etc.)
- **Path / navigation grammar**: profile-specific
- **Delta operation vocabulary**: profile-specific
- **Schema language**: profile-specific (some profiles share a
  schema language; others define their own)
- **Network layer**: out of scope (weavepack defines bytes, not
  transport)
- **Encryption**: out of scope (caller may encrypt before/after)
- **Authentication**: out of scope

Anything not in this list is in scope and is specified in the core
documents.
