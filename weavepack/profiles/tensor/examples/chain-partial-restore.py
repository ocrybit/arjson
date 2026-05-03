"""Python analogue of chain-partial-restore.js (JSON profile).

Demonstrates per-payload addressability of weavepack-tensor chains
using the pure-Python implementation. Loads chain bytes produced by
the JS reference encoder (from the conformance corpus), parses them
into individual payloads, and reconstructs each intermediate state
by reading only the chain prefix needed to reach it.

This is doubly useful: it exercises the public Python chain API
(parse_chain / serialize_chain) AND demonstrates cross-language
interop — JS-produced chain bytes, Python-side decode + delta
application.

Run from the repo root:
    PYTHONPATH=impl/python python3 weavepack/profiles/tensor/examples/chain-partial-restore.py
"""

import json
from pathlib import Path

from weavepack_tensor import (
    apply_delta,
    decode_document,
    parse_chain,
    serialize_chain,
)


REPO_ROOT = Path(__file__).resolve().parents[4]
CORPUS = REPO_ROOT / "weavepack/profiles/tensor/test-vectors/deltas/tensor_replace.json"


def fp32_values(state):
    """Pure-Python decoder returns data as a list of floats already."""
    return state["tensors"]["w"]["data"]


with open(CORPUS) as f:
    vectors = json.load(f)

# Pick the basic tensor_replace vector (anchor + 1 delta).
target = next(v for v in vectors if v["name"] == "tensor_replace basic")
chain_bytes = bytes.fromhex(target["expected_chain_bytes_hex"])
expected_initial = target["initial"]["tensors"]["w"]["data"]
expected_final = target["update"]["tensors"]["w"]["data"]

print(f"Chain (from JS reference corpus): {len(chain_bytes)} bytes")
payloads = parse_chain(chain_bytes)
print(f"Payloads in chain: {len(payloads)}")
print(f"  payload 0 (anchor): {len(payloads[0])} bytes")
for i, p in enumerate(payloads[1:], 1):
    print(f"  payload {i} (delta): {len(p)} bytes")
print()

# Restore version 0 (anchor only).
prefix0 = serialize_chain(payloads[:1])
state0 = decode_document(parse_chain(prefix0)[0])
v0 = fp32_values(state0)
print(f"v0 (prefix {len(prefix0)} bytes, {len(prefix0)/len(chain_bytes)*100:.0f}% of chain): {v0}")
assert v0 == expected_initial, f"v0 mismatch: {v0} != {expected_initial}"
print(f"  matches expected initial: {expected_initial}")

# Restore version 1 (anchor + delta).
prefix1 = serialize_chain(payloads[:2])
parts = parse_chain(prefix1)
state1 = decode_document(parts[0])
state1 = apply_delta(state1, parts[1])
v1 = fp32_values(state1)
print(f"v1 (prefix {len(prefix1)} bytes, {len(prefix1)/len(chain_bytes)*100:.0f}% of chain): {v1}")
assert v1 == expected_final, f"v1 mismatch: {v1} != {expected_final}"
print(f"  matches expected updated: {expected_final}")

print()
print("Per-payload addressability verified: each version is independently")
print("retrievable by reading only the chain prefix up to its payload.")
print("Chain bytes were produced by the JS reference encoder; this Python")
print("script consumes them without any contact with the JS implementation.")
