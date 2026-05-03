# weavepack Python implementation

Pure-Python proof-of-concept implementation of weavepack profiles.
No external dependencies; targets Python 3.10+.

## Status

- **weavepack-json**: decoder for single-payload mode only
  (Phase 6.4 stretch). 36/36 single-payload conformance vectors
  pass against the JS reference.
- Encoder: not implemented.
- Structured mode (containers, deltas): not implemented.
- weavepack-tensor: not implemented.

## Why this exists

The roadmap's Phase 6.4 calls for Python bindings via PyO3 over
the Rust crate. This pure-Python decoder is **not** that — it's a
parallel proof-of-concept demonstrating:

1. The spec docs are implementable from prose alone (this code
   was written referencing only `weavepack/profiles/json/01-types.md`
   and `weavepack/core/03-bit-encoding.md`, not the JS or Rust
   source).
2. Cross-language portability extends beyond JS+Rust.
3. A minimal third-party-style implementation can land conformance
   without complex tooling.

For production use, prefer the eventual PyO3 bindings (faster,
broader profile coverage) once they ship.

## Usage

```python
from weavepack_json import decode

decode(bytes.fromhex("c0"))            # → 0
decode(bytes.fromhex("80"))            # → None
decode(bytes.fromhex("ed"))            # → 'D' (single char, strmap idx 3)
decode(bytes.fromhex("bf2bdb00380bc030"))  # → '😀' (UTF-16 surrogate pair)
```

## Conformance

```bash
python3 impl/python/conformance.py
```

Walks `weavepack/profiles/json/test-vectors/`, validates each
single-payload vector against the JS reference's
`expected_decoded` value.

Last verified output: `Pass: 36, Fail: 0, Skip: 57` (skipped
vectors are structured-mode containers + deltas, out of scope
for this v0.0.1 decoder).

## License

MIT, matching the rest of the weavepack reference implementations.
