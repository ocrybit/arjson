# weavepack-tensor — Rust reference implementation

[![weavepack-tensor L3](../../../weavepack/badges/tensor/L3.svg)](../../../weavepack/governance/04-conformance-certification.md)

Production-grade Rust implementation of the weavepack-tensor
profile. Full encoder + decoder + delta application; passes 58/58
conformance vectors byte-exact against the JS reference, including
delta-from-prior decoder support (V0.2 A.3).

## Status

- **Encoder**: ✓ schemaless + schemaful documents; tensor_replace,
  tensor_add, tensor_remove, element_set, region_replace deltas
  (Rust encoder always emits mode=0 for tensor_replace; the JS
  reference ships the mode=1 emit heuristic at threshold 0.01,
  porting that to Rust is a V0.2 A.3 follow-up)
- **Decoder**: ✓ same coverage + tensor_replace mode=1
  delta-from-prior arithmetic
- **Conformance**: 58/58 vectors (39 tensor + 16 fp16/bf16 from
  RFC 0001 + 3 delta-from-prior) pass byte-exact
- **Profile boundary**: imports nothing from weavepack-json; uses
  weavepack-core for shared bit primitives + chain framing

## Usage

```rust
use weavepack_tensor::{TensorData, encode::encode_document, decode::decode_document};

let tensors = vec![(
    "weight".to_string(),
    TensorData {
        dtype: 15,                                      // FP32
        shape: vec![3],
        data: 1.0f32.to_le_bytes().iter()
            .chain(2.0f32.to_le_bytes().iter())
            .chain(3.0f32.to_le_bytes().iter())
            .copied().collect(),
    }
)];
let bytes = encode_document(&tensors);
let restored = decode_document(&bytes).unwrap();
```

For deltas:

```rust
use weavepack_tensor::delta::{encode_delta, apply_delta};

let delta = encode_delta(&base_tensors, &new_tensors).unwrap();
let updated = apply_delta(&base_tensors, &delta).unwrap();
```

For fp16 / bf16 conversions (RFC 0001):

```rust
use weavepack_tensor::half_dtype::{f32_to_fp16_bits, fp16_bits_to_f32};

let bits = f32_to_fp16_bits(3.14);
let back = fp16_bits_to_f32(bits);
```

## Conformance

```bash
cd impl/rust
cargo run -p weavepack-tensor --bin conformance
```

Should report `Pass: 58, Fail: 0`.

## Architecture

```
src/
├── lib.rs              module declarations + TensorData struct
├── types.rs            dtype + op constants (DTYPE_*, OP_*)
├── bits.rs             BitWriter/Reader (will migrate to weavepack-core)
├── encode.rs           encode_document, encode_document_schemaful
├── decode.rs           decode_document, decode_document_schemaful
├── delta.rs            encode_delta, apply_delta (all 6 ops including quant_change)
├── schema.rs           SHA-256 schema hash + canonicalization
├── half_dtype.rs       fp16/bf16 conversions via half crate
└── bin/
    └── conformance.rs   walks tensor test-vectors, byte-exact verify
```

## Dependencies

- `half = "2"` — IEEE 754 binary16 + bfloat16
- `sha2 = "0.10"` — SHA-256 for schema hashing
- `serde_json` — corpus parsing in conformance binary

## License

MIT.
