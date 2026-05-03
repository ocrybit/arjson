# weavepack-tensor-rs — PyO3 Python bindings

Production-grade Python bindings for the weavepack-tensor profile,
wrapping the Rust crate via PyO3. Shipped under Phase 6.4 of the
weavepack roadmap.

This is the **fast path** for Python consumers — encoding/decoding
goes through compiled Rust (zero-copy where possible) instead of
pure-Python bit-twiddling.

## Build

Requires Python 3.8+, Rust toolchain, and [maturin](https://github.com/PyO3/maturin):

```bash
pipx install maturin            # or: pip install --user maturin
cd impl/rust/weavepack-tensor-py
maturin develop                 # builds + installs into your active venv
```

After `maturin develop`, the module is importable as `weavepack_tensor_rs`:

```python
import weavepack_tensor_rs as wt
print(wt.__doc__ or "imported successfully")
```

## Usage

```python
import struct
import weavepack_tensor_rs as wt

# Encode a single fp32 tensor.
weight_bytes = struct.pack("<3f", 1.0, 2.0, 3.0)
tensors = [("weight", 15, [3], weight_bytes)]    # (name, dtype, shape, data_bytes)
payload = wt.encode_document(tensors)

# Decode it back.
restored = wt.decode_document(payload)
for name, dtype, shape, data in restored:
    print(name, dtype, shape, len(data))
    # weight 15 [3] 12
```

## Conformance

```bash
cd impl/rust/weavepack-tensor-py
python3 test_conformance.py
```

Should report `Pass: 55, Fail: 0` (matches Rust + JS for the tensor
corpus).

## Two Python paths — when to use which

| | pure-Python (`impl/python/`) | PyO3 (`impl/rust/weavepack-tensor-py/`) |
|---|---|---|
| Performance | low (interpreted bit reader) | high (Rust core) |
| Dependencies | none (Python 3.10+ stdlib) | maturin + Rust toolchain to build |
| Use case | spec implementability proof; minimum-viable consumer | production embedding in Python apps |
| Read-only? | yes (decoder only for both profiles) | encoder + decoder + delta application |

Both expose roughly the same API surface for decode operations.
The PyO3 path can encode and apply deltas; the pure-Python path
focuses on decoding to validate the spec.

## Cross-language conformance

This binding is one of three implementations that pass the
weavepack tensor corpus byte-exact:

```
JS reference     pass=55
Rust crate       pass=55
PyO3 binding     pass=55
Pure-Python PoC  pass=55
```

(Pure-Python decoder uses the same corpus, but verifies decode
round-trip rather than byte-exact encoder output for some vectors.
See `impl/python/conformance_tensor.py`.)

## License

MIT.
