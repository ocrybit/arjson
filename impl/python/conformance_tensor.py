"""weavepack-tensor Python conformance runner.

Walks weavepack/profiles/tensor/test-vectors/ and validates that the
Python decoder agrees with the JS reference for the vectors it
supports (schemaless documents). Schemaful, delta, and schema vectors
are skipped where not implemented.

Run from the repo root:
    python3 impl/python/conformance_tensor.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_tensor import (
    decode_document,
    decode_document_schemaful,
    encode_document,
    encode_document_schemaful,
    apply_delta,
    schema_hash_hex,
    DTYPE,
    fp16_bits_to_f32,
    bf16_bits_to_f32,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "weavepack" / "profiles" / "tensor" / "test-vectors"

passes = 0
fails = 0
skips = 0
failures = []


def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


def parse_input(json_doc):
    """Convert a JSON-corpus tensor doc into the Python decoder's
    expected output shape (data as Python list with int64-string fixup)."""
    out = {"tensors": {}}
    for name, t in json_doc["tensors"].items():
        data = list(t["data"])
        if t["dtype"] in (DTYPE.INT64, DTYPE.UINT64):
            data = [int(s) if isinstance(s, str) else s for s in data]
        out["tensors"][name] = {"dtype": t["dtype"], "shape": list(t["shape"]), "data": data}
    return out


def parse_chain(chain_bytes):
    """Split a leb128-length-prefixed chain into individual delta byte arrays."""
    out = []
    off = 0
    while off < len(chain_bytes):
        length = 0
        shift = 0
        while True:
            b = chain_bytes[off]
            off += 1
            length |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        out.append(chain_bytes[off:off + length])
        off += length
    return out


def docs_equal(a, b):
    if set(a["tensors"]) != set(b["tensors"]):
        return False
    for name in a["tensors"]:
        ta, tb = a["tensors"][name], b["tensors"][name]
        if ta["dtype"] != tb["dtype"] or ta["shape"] != tb["shape"]:
            return False
        # Float comparisons: tolerate fp32 precision loss when corpus
        # values were stored as fp64 JSON but flow through an fp32
        # tensor (decoded fp32 → Python float → expected fp64).
        if ta["dtype"] == DTYPE.FP32:
            for x, y in zip(ta["data"], tb["data"]):
                if abs(x - y) > max(1e-6, 1e-6 * abs(y)):
                    return False
        elif list(ta["data"]) != list(tb["data"]):
            return False
    return True


def values_close(a, b, dtype):
    """Compare decoded data list `a` against expected list `b`. fp16
    and bf16 are compared as raw bits (matching expected_bits if
    present)."""
    if len(a) != len(b):
        return False
    if dtype in (DTYPE.FP32, DTYPE.FP64):
        for x, y in zip(a, b):
            if x != y and not (isinstance(x, float) and isinstance(y, float) and x != x and y != y):
                # Allow NaN to compare equal to NaN.
                return False
        return True
    return list(a) == list(b)


for vec_file in walk(VECTORS):
    rel = vec_file.relative_to(VECTORS)
    rel_str = str(rel)
    with open(vec_file) as f:
        vectors = json.load(f)

    for v in vectors:
        name = v.get("name", "(unnamed)")
        if rel_str.startswith("deltas/"):
            # Delta vector format: initial + update + expected_chain_bytes_hex.
            # Validate that applying the delta reaches the expected_final state.
            try:
                init_doc = parse_input(v["initial"])
                # The chain_bytes_hex is initial bytes + leb128(len) + delta bytes.
                # Easier: parse the chain frame structure ourselves.
                chain_hex = v.get("expected_chain_bytes_hex", "")
                if not chain_hex:
                    skips += 1
                    continue
                chain = bytes.fromhex(chain_hex)
                deltas = parse_chain(chain)
                # First frame is the initial document (full encode).
                doc = decode_document(deltas[0])
                # Apply each subsequent delta.
                for d_bytes in deltas[1:]:
                    doc = apply_delta(doc, d_bytes)
                expected = parse_input(v["expected_final"])
                if not docs_equal(doc, expected):
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: final state mismatch")
                    continue
                passes += 1
            except NotImplementedError:
                skips += 1
            except Exception as e:
                fails += 1
                failures.append(f"{rel_str} :: {name}: exception: {e}")
            continue
        if rel_str.startswith("schemas/"):
            # Schemaful encode + decode round-trip.
            try:
                hex_str = v["expected_bytes_hex"]
                schema = v["schema"]
                schema_h = v["schema_hash_hex"]
                if schema_hash_hex(schema) != schema_h:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: schema hash mismatch")
                    continue
                # Encoder side.
                input_doc = parse_input(v["input"])
                encoded = encode_document_schemaful(input_doc, schema)
                if encoded.hex() != hex_str:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: schemaful encode mismatch")
                    continue
                # Decoder side.
                decoded = decode_document_schemaful(bytes.fromhex(hex_str), {schema_h: schema})
                expected_names = set(v["input"]["tensors"].keys())
                actual_names = set(decoded["tensors"].keys())
                if expected_names != actual_names:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: tensor names mismatch")
                    continue
                passes += 1
            except Exception as e:
                fails += 1
                failures.append(f"{rel_str} :: {name}: exception: {e}")
            continue
        # Schemaless document vector.
        try:
            hex_str = v.get("expected_bytes_hex", "")
            if not hex_str:
                skips += 1
                continue
            data = bytes.fromhex(hex_str)
            decoded = decode_document(data)
            # Compare per-tensor decoded data against input.
            for tname, t_input in v["input"]["tensors"].items():
                if tname not in decoded["tensors"]:
                    raise AssertionError(f"missing tensor {tname}")
                td = decoded["tensors"][tname]
                if td["dtype"] != t_input["dtype"]:
                    raise AssertionError(f"dtype {td['dtype']} != {t_input['dtype']}")
                if td["shape"] != t_input["shape"]:
                    raise AssertionError(f"shape {td['shape']} != {t_input['shape']}")
                # Data comparison: for fp16/bf16, expected_bits in the
                # vector overrides the input data.
                if "expected_bits" in v and t_input["dtype"] in (DTYPE.FP16, DTYPE.BF16):
                    if list(td["data"]) != list(v["expected_bits"]):
                        raise AssertionError(f"fp16/bf16 bits mismatch")
                else:
                    # int64/uint64 stored as decimal strings in the JSON
                    # corpus; normalize for comparison.
                    expected = t_input["data"]
                    if t_input["dtype"] in (DTYPE.INT64, DTYPE.UINT64):
                        expected = [int(s) for s in expected]
                    if not values_close(td["data"], expected, t_input["dtype"]):
                        raise AssertionError(
                            f"data mismatch: got {td['data'][:5]}... expected {expected[:5]}..."
                        )
            # Encoder check: re-encode the input and compare bytes.
            # For fp16/bf16, the input data is f32 numbers; the encoder
            # needs raw bits. Skip the encoder check for those (the
            # decoder check above already validates bit-exactness).
            has_half = any(
                t["dtype"] in (DTYPE.FP16, DTYPE.BF16)
                for t in v["input"]["tensors"].values()
            )
            if not has_half:
                input_doc = parse_input(v["input"])
                encoded = encode_document(input_doc)
                if encoded.hex() != hex_str:
                    raise AssertionError(
                        f"encode mismatch: got {encoded.hex()[:64]}... expected {hex_str[:64]}..."
                    )
            passes += 1
        except NotImplementedError:
            skips += 1
        except Exception as e:
            fails += 1
            failures.append(f"{rel_str} :: {name}: {e}")

print(f"Pass: {passes}")
print(f"Fail: {fails}")
print(f"Skip: {skips} (deltas + non-byte-vectored)")

if fails:
    print("\nFailures:")
    for fl in failures:
        print(f"  {fl}")
    sys.exit(1)
