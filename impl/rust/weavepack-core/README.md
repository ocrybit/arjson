# weavepack-core — profile-agnostic Rust crate

Shared bit-level primitives that every weavepack profile needs:
the MSB-first bit reader/writer, length-encoded integers (short,
uint, leb128), helpers for finalizing a payload, and the LEB128
chain framing used to concatenate multiple payloads.

This crate intentionally has **zero profile-specific knowledge**.
It exports primitives; the profile crates (weavepack-json,
weavepack-tensor) compose them into wire-format encoders and
decoders.

## Status

- Bit primitives extracted in Phase 6.3.
- Chain helpers (parse / serialize / validate) added.
- Used by both weavepack-tensor and weavepack-json (the latter
  uses the bits module; chain helpers are re-exported via
  weavepack-tensor for backward compat).

## What's exported

```rust
use weavepack_core::{BitReader, BitWriter};

let mut w = BitWriter::new();
w.write_bits(0b1011, 4);    // write 4 bits MSB-first
let bytes = w.finish();      // pad to byte boundary

let mut r = BitReader::new(&bytes);
let value = r.read(4).unwrap(); // read 4 bits MSB-first
assert_eq!(value, 0b1011);
```

Plus `r.short()`, `r.uint()`, `r.leb128()` for the variable-length
primitives defined in `weavepack/core/03-bit-encoding.md`.

```rust
use weavepack_core::chain::{chain_parse, chain_serialize, chain_validate};

let payloads: Vec<Vec<u8>> = vec![/* ... */];
let buffer = chain_serialize(&payloads);     // LEB128-prefix concat
let split = chain_parse(&buffer);            // inverse
chain_validate(&buffer)?;                    // protocol-level check
```

## Test coverage

8 unit tests covering round-trip (empty / single / multiple /
empty-payload), LEB128 length boundary at 127↔128, prefix-is-a-
valid-chain, validate accepts well-formed chains, validate
rejects zero-length payload mid-chain.

## Spec reference

See `weavepack/core/02-wire-format.md` and
`weavepack/core/03-bit-encoding.md` for the normative spec of
what these primitives encode/decode.

## License

MIT.
