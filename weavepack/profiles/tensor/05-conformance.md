# weavepack-tensor — 05: Conformance

**Status:** Draft. Phase 5 of the weavepack roadmap.

## Scope

This document specifies the conformance requirements and test
corpus structure for the weavepack-tensor profile.

## Conformance levels

Same hierarchy as the JSON profile:

### Level 1 — Tensor decoder

The implementation correctly decodes byte sequences produced by a
reference tensor encoder. Recovers the original tensor data
bit-exactly.

A Level 1 tensor decoder MUST:

- Read the wire envelope mode bit and dispatch to single-tensor
  vs structured mode
- Detect schemaful vs schemaless via the extension gate
- For schemaful: fetch the schema by hash, parse it, then walk
  tensor data blocks in schema order
- For schemaless: parse inline tensor metadata (name, dtype,
  shape, optional quant params), then read the data block
- Compute data block sizes from `shape × dtype_bits`
- Handle all 18 base dtypes plus 3 quantized variants (`bool`,
  `int4..int64`, `uint4..uint64`, `fp8e4m3`, `fp8e5m2`, `fp16`,
  `bf16`, `fp32`, `fp64`, `cfloat32`, `cfloat64`, `qint4`,
  `qint8`, `qfp8`)
- Apply all 6 delta operations (`tensor_replace`, `tensor_add`,
  `tensor_remove`, `region_replace`, `element_set`,
  `quant_change`) plus the delta-from-prior sub-mode of
  `tensor_replace`
- Honor security bounds (max shape rank, max element count, max
  schema size)

A Level 1 implementation MAY support a subset of dtypes (e.g.,
fp16 + fp32 + int8 only). Receiving an unsupported dtype produces
a clear error, not silent corruption.

### Level 2 — Tensor encoder

Produces decodable payloads round-tripping via reference decoder.

A Level 2 tensor encoder MUST:

- Produce structurally valid payloads
- Choose between schemaful and schemaless mode coherently
- Emit canonical paths in delta operations
- Pick reasonable thresholds for op selection (full vs region vs
  element_set)

NOT required: byte-equivalent output to reference. Multiple valid
encoders may pick different op heuristics or schema content; all
produce decodable results.

### Level 3 — Reference tensor encoder

Byte-equivalent to the JS reference for all corpus inputs. Required
for content-addressed tensor storage.

Level 3 requires Level 2 plus:

- Same op-selection thresholds (50% full vs partial; 30% element vs
  region within bounding box)
- Same schema canonicalization (alphabetical tensor name order in
  the schema; this provides a deterministic schema-id)
- Same strmap insertion order (depth-first encode walk)

## Test corpus structure

```
weavepack/profiles/tensor/test-vectors/
├── types/
│   ├── fp32-1d.json          (1-D fp32 tensors of varied length)
│   ├── fp32-2d.json          (2-D matrices)
│   ├── fp16-1d.json
│   ├── int8-1d.json
│   ├── bool-pack.json        (bool dtype with sub-byte alignment)
│   ├── int4-pack.json        (int4 with nibble packing)
│   ├── fp8-special.json      (NaN / max-finite / denorm cases)
│   ├── bf16-1d.json
│   ├── quant-int8-tensor.json
│   └── shape-edge-cases.json (rank 1..8; empty tensors; large dims)
├── containers/
│   ├── single-tensor.json
│   ├── small-state-dict.json (3-5 tensors)
│   ├── transformer-shaped.json (layered name patterns)
│   ├── schemaful-vs-schemaless.json
│   └── tensor-name-edge-cases.json (utf8 names, dotted names)
├── paths/
│   ├── whole-tensor.txt
│   ├── element-paths.txt
│   ├── region-paths.txt
│   └── canonicalization.txt
├── deltas/
│   ├── tensor-replace.json
│   ├── tensor-add.json
│   ├── tensor-remove.json
│   ├── region-replace.json
│   ├── element-set.json
│   ├── quant-change.json
│   ├── delta-from-prior.json
│   └── chained-updates.json
└── invariants/
    ├── round-trip.json
    ├── delta-correctness.json
    ├── composition.json
    └── identity.json
```

## Test vector format

### Round-trip vector (types, containers)

```json
{
  "name": "fp32 1D vector of length 16",
  "description": "small fp32 round-trip",
  "input": {
    "schema": {
      "weight": { "dtype": "fp32", "shape": [16] }
    },
    "tensors": {
      "weight": [/* 16 fp32 values */]
    }
  },
  "expected_bytes_hex": "..."
}
```

For tensors, `input.tensors` carries the raw element values as JSON
arrays (recursive for multi-dim). The runner converts them to
typed arrays before encoding.

### Delta vector

```json
{
  "name": "single tensor partial update",
  "initial": { /* schema + tensors */ },
  "update":  { /* schema + tensors with one tensor changed */ },
  "expected_delta_bytes_hex": "...",
  "expected_chain_bytes_hex": "...",
  "expected_final": { /* tensors after applying update */ }
}
```

## Reference data sources

The initial corpus draws from:

1. **Synthetic micro-benchmarks**: small hand-crafted tensors
   covering every dtype + shape edge case. Most of `types/`.

2. **Open-source models** (small, redistributable):
   - GPT-2-small (124M params, fp32) — tests structured tensor
     dictionaries with deep naming
   - DistilBERT (66M params, fp32) — similar shape but different
     architecture
   - A quantized int8 variant of either — tests the quantization
     path

3. **Training delta scenarios**: snapshots of the same model at
   training step N and step N+1, where ~10% of params change.

4. **Adversarial cases**: zero-shape tensors, very high-rank
   tensors (rank > 8), enormous single tensors (testing memory
   bounds).

## Tooling

```bash
cd sdk
npm run conformance:tensor
```

Runs all tensor vectors at the implementation's claimed level.
Same flag set as the JSON conformance runner (`--level`,
`--profile`, `--vectors`, `--fail-fast`, `--verbose`).

## Cross-profile interaction

The tensor profile uses the same conformance corpus structure as
the JSON profile (`weavepack/profiles/json/test-vectors/`), but
the file format differs (raw element values vs JSON values). The
runners are profile-aware.

## Open issues

1. **Endianness across consumers**: the spec mandates little-
   endian, but cross-architecture validation requires testing on
   big-endian hardware. v0.1 ships LE-only with documented
   limitation.

2. **Float16 / bfloat16 round-trip on platforms without native
   support**: JavaScript doesn't have built-in fp16. Reference
   impl uses bit-manipulation; conformance corpus must verify
   bit-exact round-trip across all NaN/denorm cases.

3. **Quantized tensor numerical stability**: rounding at the
   quantize step means delta(qA, qB) ≠ quantize(delta(A, B)) in
   general. Conformance for quant_change ops needs explicit
   tolerance specs.

4. **State-dict naming conventions**: PyTorch uses dotted names;
   TensorFlow uses slashes; Flax uses nested dicts. The tensor
   profile is naming-convention-agnostic, but consumers MAY want
   conversion utilities. Out of scope.

## Acceptance criteria for shipping v0.1

The Phase 5 gate from the roadmap is:

> Profile #2 ships, beats the incumbent on size + speed + delta
> efficiency, conformance test vectors are published, at least one
> production user adopts it.

Concretely for the tensor profile:

1. **Conformance corpus**: ≥ 50 vectors covering the categories above
2. **Round-trip**: bit-exact for every supported dtype across the
   corpus
3. **Size benchmark**: weavepack-tensor encoded size ≤ safetensors
   size for the GPT-2-small reference model
4. **Delta benchmark**: weavepack-tensor delta size ≤ 0.3 ×
   safetensors-snapshot size for a 10% parameter change
5. **Speed**: encode/decode within 2× of safetensors throughput
   (primary measurement: time to load a 124M-param model)
6. **One adopter**: at least one production user (could be weavedb's
   ML feature; could be a third-party project) using the format

If any of 3-5 fails materially, iterate on the design before
shipping. The size + delta wins are the value proposition; speed
within 2× of safetensors is acceptable for now.
