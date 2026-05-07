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
    iterate_tensors_schemaful,
    DTYPE,
    fp16_bits_to_f32,
    bf16_bits_to_f32,
    wrap_payload,
    peek_header,
    PID,
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


from weavepack_tensor import parse_chain  # noqa: E402  (now publicly exported)


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

    is_v12       = rel_str.startswith("v1.2/") or rel_str.startswith("v1.2\\")
    is_streaming = rel_str.startswith("streaming/") or rel_str.startswith("streaming\\")

    for v in vectors:
        name = v.get("name", "(unnamed)")

        # ── streaming vectors ──────────────────────────────────────────────────
        if is_streaming:
            try:
                schema = v["schema"]
                schema_h = v["schema_hash_hex"]
                if schema_hash_hex(schema) != schema_h:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: schema hash mismatch")
                    continue
                registry = {schema_h: schema}
                data = bytes.fromhex(v["bytes_hex"])
                yielded = list(iterate_tensors_schemaful(data, registry))
                expected = v["expected_tensors"]
                if len(yielded) != len(expected):
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: tensor count mismatch: expected {len(expected)} got {len(yielded)}")
                    continue
                ok = True
                for i, (got, exp) in enumerate(zip(yielded, expected)):
                    if (got["name"] != exp["name"] or
                            got["dtype"] != exp["dtype"] or
                            got["shape"] != exp["shape"]):
                        fails += 1
                        failures.append(f"{rel_str} :: {name}: tensor[{i}] metadata mismatch")
                        ok = False
                        break
                    # Compare data: fp32/qint8 need float comparison
                    gd, ed = list(got["data"]), list(exp["data"])
                    if len(gd) != len(ed):
                        fails += 1
                        failures.append(f"{rel_str} :: {name}: tensor[{i}] data length mismatch")
                        ok = False
                        break
                    for j, (gv, ev) in enumerate(zip(gd, ed)):
                        if isinstance(gv, float) or isinstance(ev, float):
                            if abs(float(gv) - float(ev)) > 1e-6 * max(1.0, abs(float(ev))):
                                fails += 1
                                failures.append(f"{rel_str} :: {name}: tensor[{i}] data[{j}] mismatch: got {gv}, expected {ev}")
                                ok = False
                                break
                        elif gv != ev:
                            fails += 1
                            failures.append(f"{rel_str} :: {name}: tensor[{i}] data[{j}] mismatch: got {gv}, expected {ev}")
                            ok = False
                            break
                    if not ok:
                        break
                if ok:
                    passes += 1
            except Exception as e:
                fails += 1
                failures.append(f"{rel_str} :: {name}: streaming exception: {e}")
            continue

        # ── v1.2 envelope vectors ──────────────────────────────────────────────
        if is_v12:
            try:
                hex_str = v.get("expected_bytes_hex", "")
                if not hex_str:
                    skips += 1
                    continue
                # Encode the inner payload and wrap with the v1.2 tensor header.
                input_doc = parse_input(v["input"])
                inner = encode_document(input_doc)
                wrapped = wrap_payload(inner, PID["TENSOR"])
                if wrapped.hex() != hex_str:
                    fails += 1
                    failures.append(
                        f"{rel_str} :: {name}: v1.2 wrap mismatch\n"
                        f"    expected: {hex_str}\n"
                        f"    actual:   {wrapped.hex()}"
                    )
                    continue
                # Decode by stripping the header then decoding the inner payload.
                result = peek_header(bytes.fromhex(hex_str))
                if result is None:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: peek_header returned None for v1.2 bytes")
                    continue
                if result["profile_id"] != PID["TENSOR"]:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: wrong profile_id: {result['profile_id']}")
                    continue
                decoded = decode_document(result["payload"])
                # Verify tensor names round-trip.
                expected_names = set(v["input"]["tensors"].keys())
                actual_names = set(decoded["tensors"].keys())
                if expected_names != actual_names:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: tensor names mismatch")
                    continue
                passes += 1
            except Exception as e:
                fails += 1
                failures.append(f"{rel_str} :: {name}: v1.2 exception: {e}")
            continue

        if rel_str.startswith("deltas/"):
            # Two delta vector formats:
            #   1. initial + update + expected_chain_bytes_hex
            #      (anchor + delta encoded together as a chain)
            #   2. initial + delta_bytes_hex + expected_final
            #      (raw delta to apply to initial; tests decoder only)
            try:
                if v.get("delta_bytes_hex"):
                    # Raw-delta vector (e.g. delta-from-prior mode=1).
                    init_doc = parse_input(v["initial"])
                    delta_bytes = bytes.fromhex(v["delta_bytes_hex"])
                    doc = apply_delta(init_doc, delta_bytes)
                    expected = parse_input(v["expected_final"])
                    if not docs_equal(doc, expected):
                        fails += 1
                        failures.append(f"{rel_str} :: {name}: final state mismatch")
                        continue
                    passes += 1
                    continue

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
                # Data comparison: for fp16/bf16/fp8, expected_bits in the
                # vector overrides the input data (raw bit patterns).
                raw_bit_dtypes = (DTYPE.FP16, DTYPE.BF16, DTYPE.FP8E4M3, DTYPE.FP8E5M2)
                if "expected_bits" in v and t_input["dtype"] in raw_bit_dtypes:
                    if list(td["data"]) != list(v["expected_bits"]):
                        raise AssertionError(f"raw-bits mismatch for dtype {t_input['dtype']}")
                else:
                    # int64/uint64 stored as decimal strings in the JSON
                    # corpus; normalize for comparison.
                    expected = t_input.get("data", t_input.get("data_raw_bits", []))
                    if t_input["dtype"] in (DTYPE.INT64, DTYPE.UINT64):
                        expected = [int(s) for s in expected]
                    if not values_close(td["data"], expected, t_input["dtype"]):
                        raise AssertionError(
                            f"data mismatch: got {td['data'][:5]}... expected {expected[:5]}..."
                        )
            # Encoder check: re-encode the input and compare bytes.
            # For fp16/bf16/fp8, the input data is f32 numbers (not raw bits);
            # the encoder expects raw bits. Skip the encoder check for those
            # (the decoder check above already validates bit-exactness).
            skip_enc_dtypes = (DTYPE.FP16, DTYPE.BF16, DTYPE.FP8E4M3, DTYPE.FP8E5M2)
            has_raw_bit_dtype = any(
                t["dtype"] in skip_enc_dtypes
                for t in v["input"]["tensors"].values()
            )
            if not has_raw_bit_dtype:
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
