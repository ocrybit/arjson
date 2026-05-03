# weavepack-json — Rust reference implementation

[![weavepack-json L1](../../../weavepack/badges/json/L1.svg)](../../../weavepack/governance/04-conformance-certification.md)
[![weavepack-json L2](../../../weavepack/badges/json/L2.svg)](../../../weavepack/governance/04-conformance-certification.md)

Decoder for the JSON profile of weavepack. Handles single-payload
mode and structured mode (containers, deltas) at Level 1+2
conformance against the JS reference.

## Status

- **Decoder**: ✓ 93/93 conformance vectors pass byte-exact
- **Encoder**: ✓ single-payload subset (37/68 vectors verified
  byte-exact). Non-empty container encoding pending — V0.2-PLANNING.md
  D.1 follow-up.
- Profile boundary: imports nothing from weavepack-tensor; uses
  weavepack-core for shared bit primitives

## Usage

```rust
use weavepack_json::{decode, encode};

// Decode a payload
let bytes = vec![0xc0]; // single-payload encoding of integer 0
let value = decode(&bytes).unwrap();
assert_eq!(value, serde_json::json!(0));

// Encoder (single-payload only):
let json = serde_json::json!(42);
let bytes = encode(&json).unwrap();
// bytes is the byte-exact encoding the JS reference produces
```

## Conformance

```bash
cd impl/rust
cargo run -p weavepack-json --bin conformance
```

Walks `weavepack/profiles/json/test-vectors/` and validates byte-
exact agreement with the JS reference. Currently 93/93 single-
payload + structured-mode vectors pass.

## Architecture

```
src/
├── lib.rs           module declarations + re-exports
├── types.rs         JSON-specific constants (single-payload tags,
│                    alphabets, get_precision)
├── bits.rs          BitWriter + BitReader (MSB-first; shared
│                    with weavepack-tensor crate)
├── encode.rs        single-payload encoder (no structured mode yet)
├── decode.rs        full decoder: single-payload + structured + deltas
└── bin/
    └── conformance.rs   walks test-vectors corpus, validates byte-
                         exact + decode round-trip
```

Encoder is intentionally single-payload-only for now. Structured
mode requires porting the JS encoder's column accumulator
(vlinks, klinks, vtypes, etc.) and is a multi-week effort. See
`V0.2-PLANNING.md` D.1.

## License

MIT.
