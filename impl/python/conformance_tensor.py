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
            # Delta application not implemented in Python PoC.
            skips += 1
            continue
        if rel_str.startswith("schemas/"):
            # Schemaful decoding implemented; verify here.
            try:
                hex_str = v["expected_bytes_hex"]
                schema = v["schema"]
                schema_h = v["schema_hash_hex"]
                # Verify our schema_hash_hex matches.
                if schema_hash_hex(schema) != schema_h:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: schema hash mismatch")
                    continue
                data = bytes.fromhex(hex_str)
                decoded = decode_document_schemaful(data, {schema_h: schema})
                # Just verify it decodes without error and has the right tensor names.
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
