# weavepack-core — 06: Schemas (Optional Sidecar)

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the **optional schema sidecar** mechanism.
A profile MAY use schemas to constrain payload contents and reduce
size by eliminating type-discriminator overhead. Schemaless and
schemaful payloads coexist within the same protocol.

The current JSON profile (v1.x) is **schemaless**. Schemas are a
forward-looking feature, prototyped via the extension gate
(`07-extensions.md`) and stabilized when adopted by a profile that
benefits.

## Why schemas

Schemaless weavepack achieves ~30-40% the size of raw JSON. Schemaful
weavepack approaches the Shannon entropy floor for fixed-shape data:
~3-8% the size of raw JSON for well-shaped workloads. The savings
come from:

- **Type column elimination**: schemas fix per-field types, so
  `vtypes` / `ktypes` columns can be omitted entirely
- **Bit-width fitting**: schemas declare numeric ranges (e.g.,
  `uint8`, `uint32`); the encoder uses exactly that many bits
  instead of variable-length encoding
- **Enum dictionaries**: schemas declare enum fields with N values;
  encoder uses `⌈log₂ N⌉` bits per value
- **Field ordering**: schemas declare field order; key strings are
  not emitted at all
- **Skip-streaming**: schemas allow partial decode — read field by
  position without parsing the whole payload

For workloads with stable shape (telemetry, RPC, ML weights, time
series), these wins compound. Schemas are mandatory for matching
parquet/protobuf-class density.

## Sidecar concept

A **schema sidecar** is a separate object that defines the data shape.
It is referenced from the payload by hash, not embedded inline. This
matters because:

- A schema typically changes rarely; embedding it in every payload
  wastes space
- Hash-addressing makes schemas canonical and shareable across many
  payloads
- For permanent storage (e.g., Arweave), the schema is one
  transaction; the payloads reference it by content hash

The sidecar MAY be transmitted alongside the payload (e.g., in a
chain frame) or stored separately (e.g., in a known blob store)
and fetched on demand.

## Schema language (profile-specific)

The core spec does NOT define a single schema language. Each
schemaful profile defines its own language tailored to its data
shape:

- **weavepack-tabular** (proposed): a language similar to Avro
  schemas — fields with names, types, defaults, optional / required
- **weavepack-tensor** (proposed): a language similar to PyTorch
  state-dict shape declarations — tensor names with dtype and shape
- **weavepack-wire** (proposed): a language similar to protobuf
  `.proto` files — message types with field numbers and types

A schema language MUST satisfy these core obligations:

1. **Stable hash**: a schema document hashes to a canonical content
   identifier (the encoder and decoder MUST agree on the hash
   function — typically SHA-256 of the schema's canonical form)
2. **Versioning**: schemas have a version number; minor versions
   are forward-compatible (decoders that know v1 can decode v1.x);
   major versions are not
3. **Reflection**: a schema is itself encodable as a weavepack
   payload (recursively). This allows a schema-of-schemas profile.

## Wire format integration

A schemaful payload signals its schema in the **extension gate**
(`07-extensions.md`) at the start of the payload, after the wire
mode bit:

```
0                  (mode bit: structured)
[ext gate]         (extension marker; signals schema sidecar follows)
[schema-id]        (hash address of the schema sidecar)
[normal columns]   (with schema-driven omissions)
```

The schema-id is a fixed-width hash (typically 32 bytes for
SHA-256). The decoder fetches the schema by hash, then interprets
the column layout per the schema.

A schemaless payload omits the extension gate; the decoder
interprets the payload per the profile's default rules
(self-describing).

## Column omission with schemas

When a schema fixes types, the corresponding type columns can be
omitted:

| Schema declares | Omittable columns |
|---|---|
| All field types | `vtypes`, `ktypes` |
| All field bit widths | (sub-encoding within `nums`, `vals`) |
| All field positions | `keys`, `kvals` |
| All enum values | encode as direct dictionary index in `nums` |

The minimal schemaful payload — schema fixes everything — has only
value columns. For a workload of fixed-shape records with all enum
fields and integer fields, the payload is essentially `n × bits-per-
record` bytes, no overhead.

## Backward compatibility

Schemaful payloads are NOT compatible with schemaless decoders. A
v1.0 JSON-profile decoder receiving a schemaful payload should:

1. See the extension gate marker
2. Recognize it doesn't understand the extension
3. Refuse the payload via the gate's "unknown extension" rule
   (`07-extensions.md`)

This is the forward-compatibility rule: unknown extensions are
fatal. The decoder doesn't try to "skip" the schema and decode
the columns as if schemaless — that would silently corrupt
results.

## Schema evolution

A schema MAY evolve over time. Two compatible evolutions:

1. **Adding optional fields**: existing payloads remain decodable
   under the new schema (the new fields default to "absent").
2. **Widening enum sets**: existing payloads remain decodable.
   New payloads MAY use the wider enum.

Two incompatible evolutions:

1. **Removing fields**: existing payloads still reference the field
   by position; the schema must keep the slot.
2. **Reordering fields**: changes the wire format.
3. **Narrowing types**: existing payloads may have values out of
   range.

Compatible evolutions get a minor version bump. Incompatible
evolutions get a major version bump and a new schema-id.

## Schema-as-delta-chain (advanced)

A profile MAY declare its schema itself as a weavepack delta chain
(meta-recursive):

```
schema_chain = ⟨Schema_0, SchemaDelta_1, SchemaDelta_2, ...⟩
```

This lets schemas evolve incrementally without breaking back-
compatibility — each schema delta describes how the schema changed
(added field, widened enum, etc.). Payloads tag themselves with the
schema-chain version they use.

This is the most ambitious version of the schema feature. None of
the existing protocols (parquet, protobuf, avro) handle schema
evolution as a first-class chain. Whether weavepack adopts this
form is a Phase 5+ decision.

## Examples (profile-specific)

The core spec doesn't include schema examples — those belong in
the profile docs that define a schema language. Forward-looking
examples:

- **Tensor profile**: a schema declaring "tensor named 'weight'
  with shape [1024, 768] and dtype float16". Payloads carry just
  the 786,432 float16 values, no metadata.
- **Tabular profile**: a schema declaring "row of (id: uint32,
  timestamp: int64, severity: enum{INFO, WARN, ERROR}, message:
  string)". Payloads are bit-packed rows.
- **Wire profile**: a schema declaring "RPC method `getUser` taking
  uint64 request id, returning struct { id, name, email }". Payloads
  are bit-packed structs.

## Conformance

A schemaless decoder MUST:
- Reject schemaful payloads via the extension gate's unknown-
  extension rule

A schemaful decoder MUST:
- Fetch the schema by hash before decoding
- Refuse to decode if the schema-id is unknown
- Refuse to decode if the schema version is incompatible
- Validate decoded values against the schema's constraints

## Open issues

These are deferred to the first profile that uses schemas:

1. **Schema fetching mechanism**: how does the decoder fetch a
   schema by hash? Options: (a) caller pre-loads schemas, (b) a
   schema registry URL is part of the wire envelope, (c) the
   schema sidecar is bundled with the payload. To be decided per
   profile.

2. **Hash function**: SHA-256 is the obvious default. Other choices
   (BLAKE3, BLAKE2) may be considered for performance.

3. **Schema language unification**: should there be a single
   schema language across profiles, or one per profile? Initial
   answer: one per profile, but with a shared core (the meta-schema
   profile that describes other schemas).

4. **Schema migration**: when a payload references schema-id X
   and the consumer wants to read it under schema-id Y (a later
   version), what's the migration semantics? Most likely
   answer: not the protocol's concern; consumers run their own
   migration step.
