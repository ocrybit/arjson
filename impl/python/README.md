# weavepack Python implementation

[![weavepack-json L3 (single-payload)](../../weavepack/badges/json/L3.svg)](../../weavepack/governance/04-conformance-certification.md)
[![weavepack-tensor L3](../../weavepack/badges/tensor/L3.svg)](../../weavepack/governance/04-conformance-certification.md)

Pure-Python proof-of-concept implementation of weavepack profiles.
No external dependencies; targets Python 3.10+.

## Status

- **weavepack-json**: encoder + decoder for **single-payload mode** at
  Level 3 (byte-exact). 37/93 corpus vectors pass. Structured-mode
  (containers, deltas, strmap dedup) deferred — see V0.2-PLANNING.md
  item D.2.
- **weavepack-tensor**: full encoder + decoder + delta application at
  Level 3 (byte-exact). 58/58 corpus vectors pass. Schemaless +
  schemaful + 5 of 6 delta ops (tensor_replace, tensor_add,
  tensor_remove, element_set, region_replace; quant_change is the
  6th and is not yet implemented in any language). Decoder also
  handles tensor_replace mode=1 (delta-from-prior arithmetic, V0.2
  A.3); encoder always emits mode=0.

## Why this exists

The roadmap's Phase 6.4 calls for Python bindings via PyO3 over
the Rust crate. This pure-Python decoder is **not** that — it's a
parallel proof-of-concept demonstrating:

1. The spec docs are implementable from prose alone (this code
   was written referencing only the spec docs in `weavepack/`,
   not the JS or Rust source).
2. Cross-language portability extends beyond JS+Rust.
3. A minimal third-party-style implementation can land conformance
   without complex tooling.

For production use, prefer the PyO3 bindings at
`impl/rust/weavepack-tensor-py/` (faster, broader profile coverage).
The pure-Python PoC is the spec-implementability proof; the PyO3
binding is the production path.

## Usage

### weavepack-json single-payload

```python
from weavepack_json import encode, decode

encode(0)               # → b'\xc0'
encode(None)            # → b'\x80'
encode("Hello")         # → b'\xbe...'  (multi-char base64url)
encode("中文")  # → b'\xbf...'  (multi-char fallback)

decode(bytes.fromhex("c0"))            # → 0
decode(bytes.fromhex("80"))            # → None
decode(bytes.fromhex("ed"))            # → 'D'
decode(bytes.fromhex("bf2bdb00380bc030"))  # → '😀'
```

### weavepack-tensor

```python
from weavepack_tensor import (
    encode_document, decode_document,
    apply_delta,
    DTYPE,
)
import struct

# Encode a single fp32 tensor.
weight_bytes = struct.pack("<3f", 1.0, 2.0, 3.0)
doc = {"tensors": {"weight": {"dtype": DTYPE.FP32, "shape": [3], "data": [1.0, 2.0, 3.0]}}}
payload = encode_document(doc)
restored = decode_document(payload)
# restored["tensors"]["weight"]["data"] = [1.0, 2.0, 3.0]
```

### Chain helpers

```python
from weavepack_tensor import parse_chain, serialize_chain, validate_chain

# Split a multi-payload chain (anchor + deltas) into individual payloads.
payloads = parse_chain(chain_bytes)

# Re-emit any prefix as a valid chain. Per-payload addressability:
# this is what lets a consumer reconstruct version N by reading only
# the prefix up to that payload — no need to load the full chain.
prefix_bytes = serialize_chain(payloads[:n + 1])

# Protocol-level framing check: LEB128 integrity, no zero-length
# payloads mid-chain. Profile-specific rules (e.g. JSON's "no
# standalone anchor past position 0") are NOT enforced here —
# use ARJSON.validate (JS reference) for JSON-profile validation.
validate_chain(chain_bytes)
```

The protocol-level helpers also exist in the Rust core crate
(`weavepack_core::chain::{chain_parse, chain_serialize, chain_validate}`)
and the PyO3 wheel (`weavepack_tensor_rs.parse_chain` /
`.serialize_chain` / `.validate_chain`). The JS reference adds a
JSON-profile-specific validator: `ARJSON.validate(buf)` checks the
"no standalone anchor past position 0" rule that the protocol-level
validators can't enforce (because first-bit semantics differ across
profiles).

See [`weavepack/profiles/tensor/examples/chain-partial-restore.py`](../../weavepack/profiles/tensor/examples/chain-partial-restore.py)
for a worked example.

## Conformance

```bash
python3 impl/python/conformance.py              # weavepack-json (37 vectors)
python3 impl/python/conformance_tensor.py       # weavepack-tensor (58 vectors)
python3 -m unittest impl.python.test_chain      # chain framing (9 tests)
python3 impl/python/test_delta_from_prior.py    # delta-from-prior (8 tests)
```

Or run the full cross-language check:

```bash
weavepack/tools/cross-language-check.sh
```

Last reported output: `Pass: 388, Fail: 0` across 6 conformance
steps (JS sdk, Rust JSON, Rust tensor, Python JSON, Python tensor,
Python chain framing).

## What's NOT implemented

- weavepack-json structured mode (objects, arrays, nested values,
  deltas). The 56 currently-skipped vectors all hit this gap. See
  `V0.2-PLANNING.md` item D.2 for the planning notes.
- weavepack-tensor `quant_change` op. Spec'd but no language
  implements it yet (depends on full quantized-dtype implementation).
- weavepack-tensor mode=1 emit from the Python encoder. The Python
  encoder always emits `tensor_replace` as mode=0; the decoder
  handles both modes (so it correctly reads JS-produced mode=1
  chains). The JS encoder ships the V0.2 A.3 mode=1 heuristic.

## License

MIT, matching the rest of the weavepack reference implementations.
