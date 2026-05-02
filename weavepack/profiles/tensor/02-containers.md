# weavepack-tensor — 02: Containers (Tensor Entries)

**Status:** Draft. Phase 5 of the weavepack roadmap.

## Scope

This document specifies how a weavepack-tensor document organizes
its tensors — the **tensor entry** structure, the document-level
**tensor map**, and how shapes are declared.

Unlike the JSON profile (which has heterogeneous trees with
arbitrary nesting), the tensor profile has a **flat dictionary
structure**: a document is a finite map from string names to tensor
entries. Tensor entries themselves are not nested — they hold a
single dtype + shape + data block.

## Document model

A weavepack-tensor document is:

```
Document = { name_1 → TensorEntry_1, name_2 → TensorEntry_2, ... }
```

This matches PyTorch's `state_dict`, TensorFlow's `Checkpoint`,
safetensors' header structure, etc. It's the canonical shape for
ML model weights.

A **TensorEntry** is:

```
TensorEntry = (dtype, shape, data_block, optional_quant_metadata)
```

where:
- `dtype`: a 5-bit value from the dtype registry (`01-types.md`)
- `shape`: a vector of positive integers `[d_0, d_1, ..., d_{n-1}]`
- `data_block`: contiguous bits encoding `prod(shape)` elements
- `optional_quant_metadata`: scale + zero_point (only for quantized
  dtypes; lives in the schema, not in the data block)

## Schemaful vs schemaless

### Schemaful mode (default, recommended)

A schema sidecar declares, for each tensor name in the document:
- The dtype (5 bits)
- The shape vector (vector of varint-encoded dims)
- For quantized dtypes: scale (fp32) and zero_point (matching int dtype)
- Whether it's per-tensor or per-channel quantization (1 bit)

The schema is hashed (SHA-256) to a `schema_id`. Payloads carry the
`schema_id` once at the start; the rest of the payload is just data
blocks.

The schema is itself a weavepack payload (meta-recursion via the
`schema` profile, TBD). For v0.1, the schema is a JSON profile
payload encoding a structured object describing the tensors.

### Schemaless mode (fallback)

When no schema is available, each tensor entry carries its own
header: dtype + shape + name. This is the slower / larger path,
suitable for ad-hoc inspection but not production storage.

The wire envelope's extension gate (`weavepack-core/07-extensions.md`)
signals which mode the payload uses.

## On-wire layout (schemaful)

After the wire envelope's mode bit and schema reference:

```
0                          (mode bit: structured)
[ext gate]                 (schema-id present)
[schema-id]                (32 bytes SHA-256)

[tensor data sequence]
  for each tensor in schema order:
    [data_block]           (per-tensor bytes; size implied by schema)
```

Each tensor's data block is contiguous and immediately followed by
the next tensor's. The data block size is determined by:

```
data_bytes = ceil(product(shape) * bits_per_dtype / 8)
```

The decoder uses the schema to compute each tensor's offset; this
enables **random access**: a consumer can seek directly to tensor
N without parsing tensors 0..N-1.

For schemaful mode, the wire format provides no inline metadata
about individual tensors — everything is in the schema.

## On-wire layout (schemaless)

```
0                          (mode bit: structured)
[ext gate]                 (schemaless variant marker)

[tensor count]             (LEB128: number of tensors)
for each tensor:
  [name length]            (short(): UTF-8 byte count)
  [name bytes]             (UTF-8 of the tensor name)
  [dtype]                  (5 bits)
  [shape rank]             (short(): number of dimensions)
  [shape dims]             (rank × LEB128: each dimension)
  [quant metadata]         (only if dtype is quantized)
  [data block]             (size derived from dtype + shape)
```

Schemaless mode has no random-access guarantees: the decoder must
walk each tensor in sequence to find its offset.

## Shape encoding

Shapes are vectors of positive integers, each ≥ 1. There is no
representation for "0-dim" tensors with an empty shape — those are
scalars and use rank=1 shape `[1]`.

The rank (number of dimensions) is encoded as `short()`. Each
dimension is encoded as `leb128()`.

Maximum rank: implementation-bounded; 8 is sufficient for almost
all ML use cases. The protocol allows up to 2^16 dimensions
nominally.

Zero-element tensors (any dim = 0) are valid: `data_bytes = 0`.

## Tensor names

Tensor names are UTF-8 strings, ≤ 256 bytes. Common patterns:

```
transformer.layers.0.attn.q_proj.weight
transformer.layers.0.attn.q_proj.bias
transformer.layers.0.attn.k_proj.weight
... etc
```

Names with shared prefixes are common. The encoder MAY apply
**prefix dedup** via the standard strmap protocol from
`weavepack-core/04-strmap.md`: the strmap interns repeated
prefixes once, with subsequent names referring back. This saves
bytes on schemas with deeply repetitive naming (e.g., 100-layer
transformers).

For schemaful mode, the strmap is part of the schema, not the
payload. For schemaless mode, the strmap is built per-payload
during encode.

## Padding and alignment

Each tensor's data block is **byte-aligned**: the first bit of
the data block is the high-order bit of a byte. This means:

- Sub-byte dtypes (`bool`, `int4`) may have trailing zero bits at
  the end of one tensor before the next begins.
- The decoder, knowing the data bit-count from `shape × dtype_bits`,
  reads exactly that many bits and skips to the next byte boundary.

For multi-byte dtypes that are themselves byte-aligned (8-bit and
larger), no inter-tensor padding is needed; the next tensor starts
immediately.

## Container key types — not applicable

Unlike the JSON profile, weavepack-tensor has no nested containers,
so it doesn't use the `ktypes` column from the core data model.

The core column registry is **partially used**:

| Column | Used in tensor profile? |
|---|---|
| `dc` | Yes (mode bit, ext gate, single-tensor mode) |
| `vrefs` / `vlinks` | No (no tree structure) |
| `krefs` / `klinks` | No (no nested containers) |
| `vflags` / `kflags` | No |
| `ktypes` | No |
| `keys` / `kvals` | Yes (only for schemaless mode tensor names) |
| `vtypes` | No (dtype is fixed per tensor, not per element) |
| `bools` | No (boolean tensors use the bool dtype data block) |
| `nums` | No (numbers are typed binary, not tagged) |
| `vals` | No |
| `strmap` | Yes (for tensor name dedup in schemaless; for schema in schemaful) |
| `strdiffs` | No |

The tensor profile uses the core's bit-pack primitives (LEB128,
short, dtype emission) but bypasses most of the per-leaf column
machinery — there are no leaves with mixed types to walk.

## Why this layout

The core protocol's tree-walking ARTable is overkill for tensor
data. Every element shares the same dtype, every tensor is a flat
contiguous block, and there's no nesting. The tensor profile uses
the core's wire envelope + bit-pack primitives but defines its own
layout for the body.

This is intentional. weavepack-core is a **substrate**, not a
straitjacket. Profiles take what's useful and define their own
where the core's defaults don't apply. The JSON profile uses ~95%
of the core column registry; the tensor profile uses ~20%.

## Conformance

A Level 1 tensor decoder MUST:
- Read the wire envelope mode bit
- Detect schemaful vs schemaless mode via the extension gate
- For schemaful: fetch the schema by hash, walk tensors in schema
  order
- For schemaless: walk the inline tensor metadata, then data
- Compute data block sizes correctly (`shape × dtype_bits`)
- Handle padding between sub-byte tensors

A Level 2 tensor encoder MUST produce payloads readable by Level 1.

A Level 3 tensor encoder MUST produce byte-equivalent output to
the reference for the same input + schema.

## Test vector references

Conformance test vectors live at
`weavepack/profiles/tensor/test-vectors/containers/` (to be
populated in Phase 5.6).
