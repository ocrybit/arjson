# weavepack-wire — 00: Overview

**Status:** Draft. Phase W of the weavepack v0.3 roadmap.

## What weavepack-wire is

weavepack-wire is a profile of the weavepack universal protocol for
encoding **structured messages** — strongly-typed, schema-backed records
with native delta-chain support. It targets the same problem space as
Protocol Buffers v3, MessagePack, and FlatBuffers, but adds two
capabilities those formats lack:

- **Per-update deltas**: a delta chain records only what changed, not
  the whole message. Incremental API responses, game-state streams, and
  live database cursors transmit diffs instead of re-sending the world.

- **Bit-packing**: boolean fields cost 1 bit, not 1 byte. Small
  integers don't need a varint tag for the common range. The bit-pack
  substrate from weavepack-core applies everywhere.

A weavepack-wire document is a **message** — a finite set of typed
fields, optionally nested, with schema-declared field numbers and names.

## Why it exists

Existing RPC / serialization formats:

| Format | Bit-pack | Deltas | Schema | Self-desc | Streaming |
|---|---|---|---|---|---|
| protobuf v3 | ✗ (byte TLV) | ✗ | ✓ | ✗ | ✓ |
| MessagePack | ✗ | ✗ | ✗ | ✓ | ✓ |
| FlatBuffers | ✗ (byte-aligned) | ✗ | ✓ | ✗ | ✓ |
| Cap'n Proto | ✗ | ✗ | ✓ | ✗ | ✓ |
| **weavepack-wire** | **✓** | **✓** | **✓** | **✓** | **✓** |

The strategic gap is **incremental API responses**:

- A game client receives 60 game-state updates per second. protobuf
  clients send full snapshots because protobuf has no delta primitive.
  weavepack-wire clients send deltas — typically 5–15% of snapshot size
  when only a fraction of fields change per frame.

- A streaming LLM API response appends tokens. Each token delivery is
  a full JSON blob in most implementations. A weavepack-wire chain
  emits `repeated_append` deltas — bytes proportional to the new
  tokens only.

- A database cursor delivers live row-update notifications. A CDC
  consumer today re-serializes the entire row per event. A weavepack-wire
  chain emits only the changed field values.

Estimated compression win over protobuf+brotli for delta-heavy
workloads: the same 3–4× order of magnitude demonstrated by the tensor
profile for per-element updates. Single-snapshot parity expected within
15% (bit-pack advantage vs. TLV header overhead roughly cancel for
typical message sizes).

## Relationship to weavepack-core

weavepack-wire uses the same core machinery as weavepack-json and
weavepack-tensor:

- Bit-pack column buffers (Encoder from `sdk/src/encoder.js`)
- Wire envelope structure (mode bit + columns)
- Delta chain framing (LEB128 length-prefixed frames)
- Extension gate (for schema sidecar)

What is profile-specific:

- **Type vocabulary**: scalar types (bool, int32, float32, string,
  bytes, enum, ...) instead of JSON's 4 primitives
- **Container model**: messages, repeated fields, maps, oneofs instead
  of JSON objects/arrays
- **Path grammar**: field-number or field-name addressing, map-key
  addressing, repeated-field index
- **Delta operations**: field_set, field_delete, message_replace,
  repeated_append, repeated_splice, map_set, map_delete, oneof_switch

## Key design decisions

### Schema is optional but recommended

Without a schema, weavepack-wire self-describes via field-number tags
in each payload (similar to protobuf's self-describing mode). With a
schema, field names replace numbers in paths and the encoder can omit
repeated type information.

The schema is a JSON-profile weavepack payload carrying the type
descriptor. It is identified by a SHA-256 hash and transported
out-of-band (the receiver looks it up by hash). The same mechanism as
the tensor profile's schema sidecar (see `06-schemas.md`).

### Field numbers are the canonical identity

Field names are human-readable aliases declared in the schema. On the
wire, everything is a field number (uint32, varint-encoded, same as
protobuf). This means:

- You can rename a field without breaking the wire format
- You can add a schema after the fact to an existing stream
- Schemaless consumers can still decode (no names, just numbers)

### Bit-packing is structural, not heuristic

Bool fields always occupy 1 bit. A message with 8 bool fields fits in
1 byte of bool storage plus the field-number column (typically 1 bit
per field if the number fits in the strmap). This is not compression;
it is the natural consequence of writing what's needed and no more.

Int32 in the range 0..127 occupies 8 bits (1 byte). Int32 in the range
0..32767 occupies 16 bits. The encoder writes the smallest
representation the value fits in; the schema declares the type; the
decoder knows the expected precision. No varint tag overhead per field.

### Absent fields are structural, not sentinel-valued

protobuf v3 doesn't distinguish "field absent" from "field set to
default value". weavepack-wire maintains a presence bit column for
optional fields (1 bit per optional field, separate from the value
column). The field-number column lists only present fields.

### Presence is not stored for required fields

Required fields (schema-declared) are always present; their presence is
implicit. The field-number column only lists optional fields and map /
repeated fields that are non-empty.

## Profile isolation

weavepack-wire imports zero code from the JSON profile or the tensor
profile. It uses only `sdk/src/encoder.js`, `sdk/src/decoder.js`,
and `sdk/src/dispatch.js` from the core. Same isolation invariant as
the tensor profile: adding new profiles does not touch existing profiles.

## Scope

weavepack-wire covers:

- **Scalar types** (01-types.md): bool, integer variants, float32/64,
  string, bytes, enum
- **Container types** (02-containers.md): message, repeated, map, oneof
- **Path grammar** (03-paths.md): field-number/name paths, map keys,
  repeated indices
- **Delta operations** (04-deltas.md): 8 ops covering the full update
  space
- **Conformance** (05-conformance.md): test corpus structure and levels
- **Schema sidecar** (06-schemas.md): schema format and hash mechanism
- **Benchmarks** (07-benchmarks.md): methodology and results vs
  protobuf+brotli

## Out of scope

- **gRPC / HTTP transport**: weavepack-wire defines bytes. How those
  bytes travel is the caller's concern.
- **Service definition language**: no `.wire` equivalent of `.proto`.
  Schemas are weavepack-json payloads; tooling may emit them from
  higher-level DSLs.
- **RPC semantics**: request/response correlation, streaming lifecycle,
  error codes. weavepack-wire is a serialization profile, not an RPC
  framework.
- **Compression**: the bit-pack substrate already removes structure
  overhead. Additional entropy coding (brotli, zstd) is a transport
  concern. weavepack-wire does not mandate it.

## Open questions for v0.1 design

1. **Zigzag vs two's-complement for int32**: protobuf uses zigzag for
   signed integers to make negative values encode compactly. weavepack's
   bit-pack substrate already allocates the minimum bits for the value
   range. For signed integers stored in column buffers, zigzag is NOT
   needed — the column buffer tracks the value range and allocates bits
   accordingly. v0.1: two's-complement, no zigzag.

2. **String encoding**: UTF-8 bytes prefixed by a LEB128 byte count, or
   via the core strmap (for repeated strings)? v0.1: raw LEB128 + UTF-8.
   Strmap optimization for repeated string values is a v0.2 concern.

3. **Large repeated fields**: for a repeated field with 10000 elements,
   is the field-number-indexed column layout still efficient? Yes — the
   repeated-field stores element count once, then emits each element
   in the value column. The column overhead is O(1), not O(N).

4. **Map key types**: should map keys support integer keys (like protobuf)
   or only string keys? v0.1: both string and uint32 keys, following the
   protobuf convention.

5. **oneof compatibility**: protobuf oneofs are not field-number–contiguous.
   Any field number from the message's total field space can be a oneof
   member. v0.1 matches this: oneof case is identified by the selected
   field's number.

## Minimum viable spec coverage

- [x] `00-overview.md` (this doc)
- [ ] `01-types.md` — scalar type vocabulary, bit widths, value ranges
- [ ] `02-containers.md` — message, repeated, map, oneof encoding
- [ ] `03-paths.md` — path grammar for field addressing
- [ ] `04-deltas.md` — delta op set
- [ ] `05-conformance.md` — test corpus structure
- [ ] `06-schemas.md` — schema sidecar format and hash mechanism
- [ ] `07-benchmarks.md` — benchmark methodology and results
- [ ] JS reference implementation in `sdk/src/profiles/wire/`
- [ ] Rust implementation in `impl/rust/weavepack-wire/`
- [ ] Python implementation in `impl/python/weavepack_wire/`
