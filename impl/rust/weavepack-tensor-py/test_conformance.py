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
DTYPE_INT4     =  1
DTYPE_UINT4    =  2
DTYPE_INT8     =  3
DTYPE_UINT8    =  4
DTYPE_INT16    =  5
DTYPE_UINT16   =  6
DTYPE_INT32    =  7
DTYPE_UINT32   =  8
DTYPE_INT64    =  9
DTYPE_UINT64   = 10
DTYPE_FP8E4M3  = 11
DTYPE_FP8E5M2  = 12
DTYPE_FP16     = 13
DTYPE_BF16     = 14
DTYPE_FP32     = 15
DTYPE_FP64     = 16
DTYPE_CFLOAT32 = 17
DTYPE_CFLOAT64 = 18
DTYPE_QINT4    = 28
DTYPE_QINT8    = 29
DTYPE_QFP8     = 30

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

def float_to_fp8e4m3_bits(f: float) -> int:
    """Encode a float as fp8 e4m3 (bias=7, no Inf; NaN=0x7f). Matches JS/Rust reference."""
    if math.isnan(f):
        return 0x7f  # canonical NaN
    if f == 0.0:
        return 0x80 if math.copysign(1.0, f) < 0 else 0x00
    sign = 1 if f < 0 else 0
    f = abs(f)
    # e4m3: max finite = 448.0 (exp=14, mantissa=111)
    if f > 448.0:
        return (sign << 7) | 0x7e  # saturate to max finite
    if f < 2 ** -9:  # below smallest subnormal
        return (sign << 7)
    # Subnormal range: 2^-6 ... 2^-9
    if f < 2 ** -6:
        # subnormal: exp=0, mantissa = round(f / 2^-9)
        mantissa = round(f / (2 ** -9))
        mantissa = max(0, min(7, mantissa))
        return (sign << 7) | mantissa
    # Normal
    import math as _m
    exp_unbiased = _m.floor(_m.log2(f))
    exp_biased = exp_unbiased + 7
    if exp_biased <= 0:
        # treat as subnormal
        mantissa = round(f / (2 ** -9))
        mantissa = max(0, min(7, mantissa))
        return (sign << 7) | mantissa
    if exp_biased > 14:
        return (sign << 7) | 0x7e  # max finite
    mantissa_f = f / (2 ** exp_unbiased) - 1.0  # [0, 1)
    mantissa = round(mantissa_f * 8)
    if mantissa >= 8:  # carry
        mantissa = 0
        exp_biased += 1
    if exp_biased > 14:
        return (sign << 7) | 0x7e
    return (sign << 7) | (exp_biased << 3) | mantissa


def quantize_to_bytes(dtype: int, data: list, scale: float, zero_point: int) -> bytes:
    """Convert float data to quantized bytes for qint4/qint8/qfp8 tensors."""
    if dtype == DTYPE_QINT8:
        out = bytearray()
        for v in data:
            q = max(-128, min(127, round(float(v) / scale + zero_point)))
            out += struct.pack('<b', q)
        return bytes(out)
    elif dtype == DTYPE_QINT4:
        total = len(data)
        q_vals = []
        for v in data:
            q = max(-8, min(7, round(float(v) / scale + zero_point)))
            q_vals.append(q & 0xF)
        out = bytearray(math.ceil(total / 2))
        for i, nib in enumerate(q_vals):
            # Wire format: high nibble = even-index element, low nibble = odd-index.
            if i % 2 == 0:
                out[i // 2] = nib << 4
            else:
                out[i // 2] |= nib
        return bytes(out)
    elif dtype == DTYPE_QFP8:
        out = bytearray()
        for v in data:
            out.append(float_to_fp8e4m3_bits(float(v) / scale))
        return bytes(out)
    else:
        raise NotImplementedError(f"quantize_to_bytes: dtype {dtype}")


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
                # Schemaful vectors: verify hash, byte-exact encode, and decode round-trip.
                schema_dict = dict(v["schema"])

                # 1. Schema hash
                if "schema_hash_hex" in v:
                    got_hash = wt.schema_hash_hex(schema_dict)
                    if got_hash != v["schema_hash_hex"]:
                        record_fail(rel, name, "schema hash mismatch",
                                    v["schema_hash_hex"], got_hash)
                        continue

                # 2. Schemaful encode: byte-exact match.
                # For qint types the input stores float values that must be
                # quantized to integer bytes using scale/zero_point from schema.
                # Build tensors list without going through json_data_to_bytes for qint.
                tensors = []
                for tname, t in v["input"]["tensors"].items():
                    se = schema_dict.get(tname, {})
                    dtype = t["dtype"]
                    shape = t["shape"]
                    if dtype in (DTYPE_QINT4, DTYPE_QINT8, DTYPE_QFP8):
                        scale = float(se.get("scale", 1.0))
                        zp = int(se.get("zero_point", 0))
                        data_bytes = quantize_to_bytes(dtype, t["data"], scale, zp)
                    else:
                        data_bytes = json_data_to_bytes(dtype, t["data"])
                    tensors.append((tname, {"dtype": dtype, "shape": shape, "data": data_bytes}))
                encoded = wt.encode_schemaful(tensors, schema_dict)
                enc_hex = bytes(encoded).hex()
                if enc_hex != v["expected_bytes_hex"]:
                    record_fail(rel, name, "encode_schemaful bytes mismatch",
                                v["expected_bytes_hex"], enc_hex)
                    continue

                # 3. Schemaful decode: round-trip back to original tensor data
                decoded = wt.decode_schemaful(bytes(encoded), schema_dict)
                input_map = {n: t for n, t in tensors}
                decoded_map = {n: t for n, t in decoded}
                if set(decoded_map) != set(input_map):
                    record_fail(rel, name, "decode_schemaful key mismatch",
                                sorted(input_map), sorted(decoded_map))
                    continue
                mismatch = False
                for tname in input_map:
                    orig = input_map[tname]
                    dec = decoded_map[tname]
                    if dec["dtype"] != orig["dtype"]:
                        record_fail(rel, name, f"decode_schemaful dtype mismatch for '{tname}'")
                        mismatch = True
                        break
                    if dec["shape"] != orig["shape"]:
                        record_fail(rel, name, f"decode_schemaful shape mismatch for '{tname}'")
                        mismatch = True
                        break
                    if bytes(dec["data"]) != bytes(orig["data"]):
                        record_fail(rel, name, f"decode_schemaful data mismatch for '{tname}'")
                        mismatch = True
                        break
                if mismatch:
                    continue
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
