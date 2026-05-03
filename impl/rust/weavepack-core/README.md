# weavepack-core — profile-agnostic Rust crate

Shared bit-level primitives that every weavepack profile needs:
the MSB-first bit reader/writer, length-encoded integers (short,
uint, leb128), and helpers for finalizing a payload.

This crate intentionally has **zero profile-specific knowledge**.
It exports primitives; the profile crates (weavepack-json,
weavepack-tensor) compose them into wire-format encoders and
decoders.

## Status

- Bit primitives extracted in Phase 6.3.
- Used by weavepack-tensor (full); will be used by weavepack-json
  encoder when V0.2 ships.

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

## Spec reference

See `weavepack/core/02-wire-format.md` and
`weavepack/core/03-bit-encoding.md` for the normative spec of
what these primitives encode/decode.

## License

MIT.
