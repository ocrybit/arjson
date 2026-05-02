# weavepack-tensor — 00: Overview

**Status:** Draft. Phase 5 of the weavepack roadmap.

## What weavepack-tensor is

weavepack-tensor is a profile of the weavepack universal protocol for
encoding **multi-dimensional numerical arrays** ("tensors") with delta
updates. It targets ML model checkpoints, scientific data, and any
workload where the data is fundamentally arrays of typed numbers
rather than tree-structured records.

A weavepack-tensor document is a **state-dict-shaped collection** —
a dictionary mapping string names to tensors, where each tensor has
a fixed dtype, a fixed shape, and a contiguous block of values. This
matches PyTorch's `state_dict`, TensorFlow's checkpoint format, and
similar conventions.

## Why it exists

Existing tensor storage formats:

| Format | Bit-pack | Deltas | Schema | Per-tensor compression |
|---|---|---|---|---|
| PyTorch `.pt` (torch.save) | ✗ | ✗ | implicit | rare |
| safetensors | ✗ | ✗ | yes | no |
| TensorFlow checkpoint | ✗ | ✗ | yes | rare |
| HDF5 | ~ | ✗ | yes | yes (per-dataset) |
| NumPy `.npy` / `.npz` | ✗ | ✗ | implicit | with .npz |
| ONNX | ✗ | ✗ | yes | optional |

None of them have **delta updates**. A model checkpoint saved at
training step 1000 vs step 1001 is two whole files — even though
maybe 10% of the parameters changed materially. Storage cost scales
linearly with checkpoints kept; bandwidth cost scales linearly with
checkpoints fetched.

weavepack-tensor changes this:

- **Initial checkpoint**: full encode (≈ size of safetensors + brotli).
- **Subsequent checkpoint**: delta against prior. Typically 5-30% the
  size of a full save, depending on how much actually changed and
  whether quantization is used.
- **Random-access**: each tensor in the dictionary is independently
  addressable; consumers fetching just the encoder weights skip the
  decoder weights at the byte level.

Use cases that benefit:

1. **Distributed training**: shipping gradient updates as deltas
   instead of full params
2. **Continual learning**: storing 10 fine-tuned variants of a base
   model without 10x the disk
3. **Permanent ledger of training**: storing every checkpoint of a
   training run on Arweave, addressable by step
4. **Model versioning**: git-LFS-equivalent that's structure-aware
   and bit-packed

## Relationship to weavepack-core

weavepack-tensor uses the same core machinery as weavepack-json:

- Bit-pack column buffers (Encoder class from `sdk/src/encoder.js`)
- Wire envelope structure (mode bit + columns)
- Delta chain framing (LEB128 length-prefixed)
- Extension gate (for schema sidecar)
- ARTable column structure (for compact + delta application)

What's profile-specific:

- **Type vocabulary**: dtype set (float32, float16, int8, etc.)
  instead of JSON's 4 primitives
- **Container shape**: a "tensor entry" with name + dtype + shape +
  data, instead of objects/arrays
- **Path grammar**: `tensor_name` + `[i, j, k, ...]` index for
  per-element access
- **Delta operations**: per-element replace, region replace,
  whole-tensor replace, tensor add/remove
- **No string strmap**: tensor data is binary; the strmap is used
  only for tensor names (small dedup win)

See `01-types.md` for the dtype vocabulary, `02-containers.md` for
tensor entry encoding, `03-paths.md` for tensor name + index syntax,
`04-deltas.md` for the delta op set, and `05-conformance.md` for the
test corpus.

## Key design decisions (and why)

### Schemaful by default

A weavepack-tensor document is **schemaful**. The schema declares:

- The set of tensor names in the document
- For each tensor: dtype and shape

This is encoded once as a sidecar; subsequent payloads reference the
schema by hash. Without a schema, every payload would re-emit the
type and shape information, defeating the size-efficiency goal.

For ad-hoc / exploratory tensor data without a fixed schema, a
**self-describing variant** is supported via the extension gate, but
this is the slower path and not recommended for production.

### Per-tensor independent encoding

Each tensor's data block is independently encoded into a contiguous
byte region. This enables:

- **Random access**: skip to a specific tensor by offset
- **Per-tensor compression**: each tensor can use a different
  compression mode (raw, quantized, delta-from-prior)
- **Lazy loading**: consumers fetch only the tensors they need

This contrasts with JSON's interleaved column layout; tensors are
discrete units with their own storage.

### Quantization as a first-class option

For inference-time models, 4-bit / 8-bit / 16-bit quantized weights
are common. weavepack-tensor supports quantized dtypes natively:

- `int4`, `int8`, `fp8e4m3`, `fp8e5m2`, `fp16`, `bf16`, `fp32`,
  `fp64`, `int16`, `int32`, `int64`, `bool`

A tensor's dtype is declared in the schema; the wire format
allocates exactly that many bits per element. No type-tag overhead.

### Delta strategy: per-element vs region

For small parameter changes (1-10% of elements), per-element deltas
win. For large changes (50%+), full-tensor replace wins. The
encoder picks per-tensor based on a measurement during diff:

```
if changed_elements / total_elements < threshold (default 0.3):
  emit per-element delta
else:
  emit full-tensor replace
```

The threshold is configurable per consumer (e.g., training pipelines
might tune it differently from inference deployment).

### Block-level deltas

Many parameter changes have spatial locality: contiguous rows or
columns of a matrix change together. A block-delta op is provided:

```
block_replace(tensor_name, [start_indices], [end_indices], new_values)
```

This is one delta op covering N×M elements at once, more compact
than N×M per-element ops.

## Out of scope

- **Sparse tensors**: weavepack-tensor handles dense tensors. For
  sparse storage, a future weavepack-sparse profile may be defined.
- **Symbolic computation**: this is a storage format, not a
  computation graph format (use ONNX for that).
- **Custom dtypes**: only the standard dtypes listed above are
  supported. Custom dtypes (e.g., posit, bfloat16-with-stochastic-
  rounding variants) require a custom profile.
- **Lazy materialization to compute graphs**: out of scope; consumers
  decode to dense arrays.

## Minimum viable spec coverage

To ship a v0.1 implementation, the spec needs:

- [x] `00-overview.md` (this doc)
- [ ] `01-types.md` — dtype vocabulary, bit widths, value ranges
- [ ] `02-containers.md` — tensor entry encoding
- [ ] `03-paths.md` — tensor name + index path grammar
- [ ] `04-deltas.md` — delta op set (replace/add/remove/region/quantize-change)
- [ ] `05-conformance.md` — test corpus structure
- [ ] reference implementation in `sdk/src/profiles/tensor/`
- [ ] benchmark vs PyTorch + zstd on a real model

Phase 5 gate: profile #2 (this profile) ships, beats the incumbent
(PyTorch + zstd or safetensors) on size, speed, and delta efficiency
on at least one realistic ML benchmark.

## Open questions for v0.1 design

1. **Endianness**: native (consumer's machine) or fixed (always
   little-endian)? Tensors crossing platforms argue for fixed-LE;
   in-process speed argues for native. v0.1: fixed little-endian.

2. **Tensor name dedup**: PyTorch state-dicts have repeated prefixes
   (e.g., `transformer.layers.0.attn.q_proj.weight`). Should we
   strmap-intern these? Initial answer: yes, but treat as core
   strmap (the existing protocol primitive).

3. **Sub-tensor random access**: should the wire format index into
   tensors so a consumer can fetch row 5 of a 10000×10000 matrix
   without decoding the whole tensor? Initial answer: defer to v0.2.
   v0.1 is whole-tensor units only.

4. **Float16 vs bfloat16**: both are common. Both supported.
   Quantization (int4 / int8 / fp8) is also supported. The schema
   declares which.

5. **Quantization metadata**: a quantized tensor has a scale +
   zero_point in addition to the data. Where do those live? In the
   schema (rare-changing, per-tensor), or inline (per-block)? v0.1:
   per-tensor in the schema.

## Implementation phasing

Phase 5 itself is staged:

- **5.1**: spec docs (01-05) — this iteration's focus
- **5.2**: reference impl `sdk/src/profiles/tensor/` skeleton with
  no-quant float32 only
- **5.3**: extend reference impl to all dtypes + quant
- **5.4**: delta op implementation (region, per-element, full)
- **5.5**: schema sidecar implementation
- **5.6**: benchmark suite vs safetensors + zstd
- **5.7**: ship if benchmarks favorable; iterate if not
