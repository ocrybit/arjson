# weavepack-tensor — 06: Schema Sidecar

**Status:** Draft. Phase 5.5 of the weavepack roadmap.

## Scope

This document specifies the **optional schema sidecar** for the
weavepack-tensor profile. It defines:

1. The tensor schema language (name → dtype + shape declarations)
2. Canonical serialization and SHA-256 hash addressing
3. The schemaful wire format (data-only payload; metadata known from schema)
4. The schema registry abstraction (how decoders resolve hash → schema)
5. Size analysis and acceptance criteria

The core schema sidecar mechanism is described in
`weavepack-core/06-schemas.md`. This document is the tensor-profile
instantiation of that mechanism.

## Motivation

In schemaless mode, every tensor payload carries inline metadata:

```
per tensor: name-length + name-bytes + dtype + rank + shape-dims + data-block
```

For a model with 200 tensors of known fixed shape, this metadata
is emitted on every encode — and re-transmitted on every delta.
For a 124M-parameter GPT-2 model (fp32):

| Component | Size |
|---|---|
| Raw fp32 data | ~497 MB |
| Per-tensor schemaless metadata | ~8 KB |
| Fraction | ~0.0016% |

The overhead is negligible for full-model snapshots, but non-zero.
More importantly, schemas enable two additional benefits:

1. **Delta compression**: a schemaful delta that touches only data
   blocks (no name/dtype/shape changes) is leaner than a schemaless
   delta that re-emits metadata in every tensor_add / tensor_replace op.

2. **Skip-streaming**: knowing the layout in advance lets a decoder
   seek directly to a specific tensor without parsing the entire payload.

3. **Schema-addressed storage**: for content-addressed stores (Arweave),
   a schema is stored once by hash; many payloads reference it.

## Tensor schema language

A **tensor schema** is a JSON object mapping tensor names to their
static properties:

```json
{
  "<tensor-name>": {
    "dtype": <dtype-code>,
    "shape": [<dim>, ...]
  },
  ...
}
```

Where:
- `<tensor-name>` is the UTF-8 string identifying the tensor (same as
  in schemaless mode)
- `dtype` is an integer dtype code from `01-types.md` (0–30 range)
- `shape` is a non-empty JSON array of non-negative integers

**Example:**

```json
{
  "attention.weight": { "dtype": 15, "shape": [768, 768] },
  "attention.bias":   { "dtype": 15, "shape": [768] },
  "fc.weight":        { "dtype": 15, "shape": [3072, 768] },
  "fc.bias":          { "dtype": 15, "shape": [3072] }
}
```

(Dtype code 15 = `FP32` per `01-types.md`.)

### Constraints

- Tensor names MUST be non-empty UTF-8 strings.
- Duplicate names are forbidden.
- `dtype` MUST be a defined dtype code (0–18 for base dtypes,
  28–30 for quantized variants per `01-types.md`).
- `shape` MUST be a non-empty array (rank ≥ 1).
- Shape dims MUST be non-negative integers.
- A tensor with any zero-length dim is a valid empty tensor (0 elements).

### Schema version

The schema object MAY include a top-level `"_version"` key:

```json
{ "_version": 1, "weight": { "dtype": 15, "shape": [768, 768] } }
```

If present, `_version` MUST be an integer. Version 0 or absent = v0.
The `_version` key is excluded from the canonical form used for hashing
(see below) so that bumping it doesn't invalidate content addresses.
Wait — actually `_version` IS included in the canonical form to ensure
schema version identity is part of the hash. Callers that change version
get a different hash.

Version compatibility:
- Minor schema changes (adding tensors with new names) get a new hash.
  Decoders that know the old hash MUST NOT attempt to decode payloads
  referencing the new hash without re-fetching the schema.
- There is no minor/major split at the protocol level; every schema
  mutation produces a new hash.

## Canonical form and hash

To produce a stable, implementation-independent hash, the schema is
serialized in **canonical JSON** before hashing:

1. All keys at every level are sorted alphabetically (Unicode code point
   order, same as `Object.keys().sort()` in JS / `sorted()` in Python).
2. No whitespace other than what `JSON.stringify` emits (no pretty-print).
3. The result is a UTF-8 byte sequence.

The **schema-id** (schema hash) is the **SHA-256** of the canonical
UTF-8 bytes.

```
schema-id = SHA-256(canonical_utf8(schema))
```

Two schemas produce the same schema-id if and only if their canonical
forms are byte-identical.

### Reference canonicalization

For the schema object `{ "b": {...}, "a": {...} }`, the canonical form is:

```
{"a":{...},"b":{...}}
```

Each tensor entry is also sorted: `{"dtype":...,"shape":[...]}` with
`dtype` before `shape` (alphabetical). Nested objects follow the same rule.

### Determinism requirement

An encoder computing a schema-id MUST produce the same bytes as any
other conformant implementation for the same logical schema. This is
the reason canonical form is specified — non-canonical JSON (e.g.,
insertion-order keys) would produce different hashes.

## Wire format: schemaful document

A **schemaful tensor document** uses the following wire format:

```
bit 0:       0          (payload type = document)
bit 1:       1          (schema gate = schema present)
bits 2–257:  <hash>     (256 bits = 32 bytes; SHA-256 of schema canonical form)
per tensor (in schema key order after canonical sort):
  data block:  (elements × dtype_bits) bits, little-endian element bytes
               bool tensors: 1 bit per element, MSB-first within bytes
```

The tensor count is NOT emitted; it is derived from the schema.
Tensor names, dtypes, and shapes are NOT emitted; they are known from
the schema. Only the raw data blocks are present on the wire.

Element order within a data block is C-style row-major (outermost dim
varies slowest, innermost fastest), identical to schemaless mode.

### Schemaless document (updated discriminant)

For compatibility with the schemaful wire format, schemaless documents
use the following format (one bit wider than the original v0.1 format):

```
bit 0:       0          (payload type = document)
bit 1:       0          (schema gate = no schema)
leb128:      tensor count
per tensor:  (name + dtype + shape + data) as before
```

### Delta (updated discriminant)

Deltas start with bit 0 = 1 (distinguishing them from documents):

```
bit 0:       1          (payload type = delta)
leb128:      op count
op*:         as per 04-deltas.md
```

The two-bit document discriminant (`00` = schemaless, `01` = schemaful)
and one-bit delta discriminant (`1`) are non-overlapping:

| First bit | Second bit | Meaning |
|---|---|---|
| `0` | `0` | Schemaless document |
| `0` | `1` | Schemaful document |
| `1` | any | Delta |

Note: this supersedes the pre-5.5 format where documents used 1 header
bit and deltas used 2. All implementations MUST use the 5.5+ format.

## Schema registry

A **schema registry** is the mechanism by which a decoder resolves
a schema-id (hash) to a schema object. The protocol does not specify
the storage layer; implementations provide a registry interface:

```js
// Lookup interface (JS reference):
const registry = new Map()             // hex-hash → schema object
registry.set(schemaHashHex(mySchema), mySchema)

// Decoder call:
decodeDocumentSchemaful(bytes, registry)
```

If the decoder encounters a schema-id for which the registry has no
entry, it MUST throw a clear error:
```
Error: unknown schema-id <hex>; register the schema before decoding
```

It MUST NOT attempt to decode the payload as schemaless, since the
data blocks have no inline metadata.

## Schemaful delta (deferred to v0.2)

Schemaful deltas (where the delta payload also omits per-tensor metadata
because the schema declares all tensor shapes) are deferred to v0.2.
In v0.1 with schema sidecar, only full-document payloads can be schemaful.
Deltas remain schemaless (they carry full op payloads including metadata).

The primary benefit in v0.1 is for snapshot / initial-anchor payloads,
which are typically the largest frames in a delta chain.

## Size analysis

For a 124M-parameter GPT-2-small model (fp32, 197 tensors):

| Mode | Approximate payload size |
|---|---|
| Schemaless document | 497 MB data + 8 KB metadata = ~497 MB |
| Schemaful document | 497 MB data + 32 bytes hash = ~497 MB |
| Savings | ~8 KB (negligible for snapshot) |

The schema sidecar's primary value is NOT in snapshot size (where
metadata overhead is < 0.002%). Its value is in:

1. **Chain frame overhead**: over 10,000 delta frames in a training run,
   avoiding per-frame metadata re-emission saves ~80 MB.
2. **Schema-addressed stores**: one schema transaction on Arweave (< 1 KB)
   vs metadata embedded in every payload.
3. **Skip-streaming**: random access to tensor N without parsing 1..N-1.

## Security

Same bounds as schemaless tensor payloads (`05-conformance.md`), plus:

- **Schema size limit**: a conformant decoder MUST reject schemas larger
  than 1 MB (1,048,576 bytes). Schemas larger than 1 MB likely indicate
  either an adversarial input or a misuse of the schema mechanism.
- **Hash verification**: the decoder MUST verify the schema fetched from
  the registry actually hashes to the claimed schema-id. If not, the
  payload is corrupt or the registry is compromised.
- **Schema rank / element bounds**: same as per-tensor bounds in
  `05-conformance.md` (max rank 8, max elements 2^30).

## Implementation notes

The v0.1 JS reference implements:

- `canonicalizeSchema(schema)` → JSON string (in `schema.js`)
- `schemaHash(schema)` → Uint8Array[32] SHA-256
- `schemaHashHex(schema)` → 64-char hex string
- `encodeDocumentSchemaful(doc, schema)` → Uint8Array
- `decodeDocumentSchemaful(bytes, registry)` → document

`encodeDocument` and `decodeDocument` (schemaless) are updated to use
the new 2-bit discriminant (`00` prefix).

## Open issues

1. **Schema fetching in TensorPack chains**: when building a chain,
   should the schema sidecar be bundled as a synthetic chain frame 0,
   or transmitted out-of-band? v0.1 assumes out-of-band (caller manages
   the registry). A future version may add a "schema frame" type to
   the chain serialization.

2. **Quantized tensor schemas**: QINT4 / QINT8 / QFP8 tensors have a
   scale + zero_point per tensor. The schema language does not yet
   declare these; schemaful mode for quantized tensors is deferred.

3. **Schema evolution and re-anchoring**: when a schema changes (new
   tensors added, shapes changed), the chain must re-anchor. The
   anchor frame may use the new schema-id; the registry must have both
   old and new schemas. Protocol-level migration utilities are deferred.

4. **Schemaful deltas**: encoding deltas without per-tensor metadata
   when schema is known. Deferred to v0.2.
