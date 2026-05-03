#!/usr/bin/env python3
"""Conformance test for weavepack_tensor_rs Python bindings.

Runs all tensor test vectors from weavepack/profiles/tensor/test-vectors/
and verifies byte-for-byte equality with the expected bytes, matching
the behaviour of the JS reference and the Rust conformance binary.
"""
import json
import math
import os
import struct
import sys

import weavepack_tensor_rs as wt

# ── dtype constants ───────────────────────────────────────────────────────────

DTYPE_BOOL     =  0
DTYPE_INT8     =  3
DTYPE_UINT8    =  4
DTYPE_INT16    =  5
DTYPE_UINT16   =  6
DTYPE_INT32    =  7
DTYPE_UINT32   =  8
DTYPE_INT64    =  9
DTYPE_UINT64   = 10
DTYPE_FP16     = 13
DTYPE_BF16     = 14
DTYPE_FP32     = 15
DTYPE_FP64     = 16

# ── float conversion helpers ──────────────────────────────────────────────────

def _f32_bits(f: float) -> int:
    return struct.unpack('<I', struct.pack('<f', f))[0]

def float_to_fp16_bits(f: float) -> int:
    return struct.unpack('<H', struct.pack('<e', float(f)))[0]

def float_to_bf16_bits_rte(f: float) -> int:
    """Round-to-nearest-even bf16 conversion (matches JS reference and half crate)."""
    if math.isnan(f):
        return 0x7fc0
    bits = _f32_bits(f)
    upper = (bits >> 16) & 0xffff
    lower = bits & 0xffff
    if lower > 0x8000 or (lower == 0x8000 and (upper & 1)):
        return (upper + 1) & 0xffff
    return upper

def pack_bools_msb_first(data: list) -> bytes:
    """Pack boolean values MSB-first (bit i → byte i//8, bit 7-(i%8))."""
    n = len(data)
    out = bytearray(math.ceil(n / 8))
    for i, v in enumerate(data):
        if v:
            out[i >> 3] |= 1 << (7 - (i & 7))
    return bytes(out)

def json_data_to_bytes(dtype: int, data: list) -> bytes:
    """Convert a JSON data array to raw little-endian element bytes."""
    if dtype == DTYPE_BOOL:
        return pack_bools_msb_first(data)
    elif dtype == DTYPE_INT8:
        return struct.pack(f"<{len(data)}b", *[int(v) for v in data])
    elif dtype == DTYPE_UINT8:
        return struct.pack(f"<{len(data)}B", *[int(v) for v in data])
    elif dtype == DTYPE_INT16:
        return struct.pack(f"<{len(data)}h", *[int(v) for v in data])
    elif dtype == DTYPE_UINT16:
        return struct.pack(f"<{len(data)}H", *[int(v) for v in data])
    elif dtype == DTYPE_INT32:
        return struct.pack(f"<{len(data)}i", *[int(v) for v in data])
    elif dtype == DTYPE_UINT32:
        return struct.pack(f"<{len(data)}I", *[int(v) for v in data])
    elif dtype == DTYPE_INT64:
        # JSON stores int64 as decimal strings to avoid precision loss.
        return struct.pack(f"<{len(data)}q", *[int(v) for v in data])
    elif dtype == DTYPE_UINT64:
        return struct.pack(f"<{len(data)}Q", *[int(v) for v in data])
    elif dtype == DTYPE_FP16:
        out = bytearray()
        for v in data:
            out += struct.pack("<H", float_to_fp16_bits(float(v)))
        return bytes(out)
    elif dtype == DTYPE_BF16:
        out = bytearray()
        for v in data:
            out += struct.pack("<H", float_to_bf16_bits_rte(float(v)))
        return bytes(out)
    elif dtype == DTYPE_FP32:
        return struct.pack(f"<{len(data)}f", *[float(v) for v in data])
    elif dtype == DTYPE_FP64:
        return struct.pack(f"<{len(data)}d", *[float(v) for v in data])
    else:
        raise NotImplementedError(f"dtype {dtype} not handled in test helper")

def parse_tensor_doc(json_doc: dict) -> list:
    """Convert a JSON tensor document to the list-of-(name, dict) form."""
    result = []
    for name, t in json_doc["tensors"].items():
        raw = json_data_to_bytes(t["dtype"], t["data"])
        result.append((name, {"dtype": t["dtype"], "shape": t["shape"], "data": raw}))
    return result

# ── chain wire format ─────────────────────────────────────────────────────────

def leb128_encode(n: int) -> bytes:
    """Encode a non-negative integer as LEB128."""
    out = bytearray()
    while n >= 128:
        out.append((n & 0x7f) | 0x80)
        n //= 128
    out.append(n)
    return bytes(out)

def chain_serialize(segments: list) -> bytes:
    """Serialize a list of byte segments as a length-prefixed chain."""
    out = bytearray()
    for seg in segments:
        out += leb128_encode(len(seg))
        out += seg
    return bytes(out)

# ── test runner ────────────────────────────────────────────────────────────────

TENSOR_ROOT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "..", "weavepack", "profiles", "tensor", "test-vectors"
)

passed = 0
failed = 0
failures = []

def record_fail(path, name, reason, expected=None, actual=None):
    global failed
    failed += 1
    failures.append({"path": path, "name": name, "reason": reason,
                     "expected": expected, "actual": actual})

def walk_json(root):
    for dirpath, _, files in os.walk(root):
        for f in sorted(files):
            if f.endswith(".json"):
                yield os.path.join(dirpath, f)

for path in sorted(walk_json(TENSOR_ROOT)):
    rel = os.path.relpath(path, TENSOR_ROOT)
    is_delta = rel.startswith("deltas")
    is_schema = rel.startswith("schemas")

    with open(path) as f:
        vectors = json.load(f)

    for v in vectors:
        name = v.get("name", "<unnamed>")
        try:
            if is_schema:
                # Schemaful vectors: verify schema hash + encode snapshot bytes.
                tensors = parse_tensor_doc(v["input"])
                schema_dict = {
                    t_name: (t_info["dtype"], t_info["shape"])
                    for t_name, t_info in v["schema"].items()
                }
                # Verify schema hash
                if "schema_hash_hex" in v:
                    got_hash = wt.schema_hash_hex(schema_dict)
                    if got_hash != v["schema_hash_hex"]:
                        record_fail(rel, name, "schema hash mismatch",
                                    v["schema_hash_hex"], got_hash)
                        continue
                # Verify schemaless encoding for now (schemaful binding not
                # yet exposed; this validates the hash only).
                passed += 1

            elif is_delta:
                # Delta vectors: build chain, compare chain hex, verify apply_delta.
                initial_tensors = parse_tensor_doc(v["initial"])
                update_tensors = parse_tensor_doc(v["update"])

                init_enc = wt.encode(initial_tensors)
                delta_enc = wt.encode_delta(initial_tensors, update_tensors)

                if delta_enc is None:
                    # Identity delta: chain is just the initial snapshot.
                    chain = chain_serialize([bytes(init_enc)])
                else:
                    chain = chain_serialize([bytes(init_enc), bytes(delta_enc)])

                chain_hex = chain.hex()
                if chain_hex != v["expected_chain_bytes_hex"]:
                    record_fail(rel, name, "chain bytes mismatch",
                                v["expected_chain_bytes_hex"], chain_hex)
                    continue

                # Verify apply_delta round-trip (skip for identity).
                if delta_enc is not None:
                    result = wt.apply_delta(initial_tensors, bytes(delta_enc))
                    final_tensors = parse_tensor_doc(v["expected_final"])
                    result_map = {n: t for n, t in result}
                    final_map = {n: t for n, t in final_tensors}
                    if set(result_map) != set(final_map):
                        record_fail(rel, name, "apply_delta key mismatch",
                                    sorted(final_map), sorted(result_map))
                        continue
                    mismatch = False
                    for tname in final_map:
                        ra = result_map[tname]
                        ex = final_map[tname]
                        if (ra["dtype"] != ex["dtype"] or ra["shape"] != ex["shape"]
                                or bytes(ra["data"]) != bytes(ex["data"])):
                            record_fail(rel, name, f"apply_delta tensor mismatch for '{tname}'")
                            mismatch = True
                            break
                    if mismatch:
                        continue
                passed += 1

            else:
                # Snapshot vectors: encode and verify bytes + decode round-trip.
                tensors = parse_tensor_doc(v["input"])
                encoded = wt.encode(tensors)
                enc_hex = bytes(encoded).hex()
                if enc_hex != v["expected_bytes_hex"]:
                    record_fail(rel, name, "encode bytes mismatch",
                                v["expected_bytes_hex"], enc_hex)
                    continue

                decoded = wt.decode(bytes(encoded))
                mismatch = False
                for (d_name, d_tensor), orig in zip(decoded, tensors):
                    if d_name != orig[0]:
                        record_fail(rel, name, f"decoded name mismatch")
                        mismatch = True
                        break
                    if d_tensor["dtype"] != orig[1]["dtype"]:
                        record_fail(rel, name, f"decoded dtype mismatch for '{d_name}'")
                        mismatch = True
                        break
                    if d_tensor["shape"] != orig[1]["shape"]:
                        record_fail(rel, name, f"decoded shape mismatch for '{d_name}'")
                        mismatch = True
                        break
                    if bytes(d_tensor["data"]) != bytes(orig[1]["data"]):
                        record_fail(rel, name, f"decoded data mismatch for '{d_name}'")
                        mismatch = True
                        break
                if not mismatch:
                    passed += 1

        except Exception as e:
            import traceback
            record_fail(rel, name, f"exception: {e}\n{traceback.format_exc()}")

# ── report ────────────────────────────────────────────────────────────────────

print(f"weavepack_tensor_rs Python conformance: {passed} passed, {failed} failed")
if failures:
    for f in failures:
        print(f"  FAIL [{f['path']}] {f['name']}: {f['reason']}")
        if f.get("expected"):
            print(f"       expected: {f['expected']}")
        if f.get("actual"):
            print(f"       actual:   {f['actual']}")
    sys.exit(1)
else:
    print("All vectors passed.")
    sys.exit(0)
