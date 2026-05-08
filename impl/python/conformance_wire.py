"""weavepack-wire Python conformance runner.

Walks weavepack/profiles/wire/test-vectors/ and validates that the
Python encoder/decoder/apply agree with the JS reference.

Run from the repo root:
    python3 impl/python/conformance_wire.py
"""

import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_wire import (
    encode_document,
    decode_document,
    encode_chain,
    decode_chain,
    apply_chain,
    VTYPE,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "weavepack" / "profiles" / "wire" / "test-vectors"

passes = 0
fails = 0
skips = 0
failures = []

BIGINT_VTYPES = {VTYPE.INT64, VTYPE.UINT64, VTYPE.SINT64}


def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


def normalize_fields(fields):
    """Recursively convert JSON-corpus values to Python-native types.

    int64/uint64/sint64 values arrive as strings → convert to int.
    bytes values arrive as {"_bytes": [...]} → convert to bytes.
    """
    if not isinstance(fields, list):
        return fields
    result = []
    for f in fields:
        out = dict(f)
        # Scalar BigInt types stored as strings
        if f.get("vtype") in BIGINT_VTYPES and isinstance(f.get("value"), str):
            out["value"] = int(f["value"])
        # Scalar bytes stored as {"_bytes": [...]}
        if f.get("vtype") == VTYPE.BYTES and isinstance(f.get("value"), dict) and "_bytes" in f["value"]:
            out["value"] = bytes(f["value"]["_bytes"])
        # Nested message
        if "message" in f:
            out["message"] = normalize_fields(f["message"])
        # Repeated
        if "repeated" in f:
            r = f["repeated"]
            elem_type = r["elemType"]
            values = r["values"]
            if elem_type in BIGINT_VTYPES:
                values = [int(v) if isinstance(v, str) else v for v in values]
            elif elem_type == VTYPE.BYTES:
                values = [bytes(v["_bytes"]) if isinstance(v, dict) and "_bytes" in v else v for v in values]
            out["repeated"] = {"elemType": elem_type, "values": values}
        # Map
        if "map" in f:
            m = f["map"]
            value_type = m["valueType"]
            entries = []
            for k, v in m["entries"]:
                if value_type in BIGINT_VTYPES and isinstance(v, str):
                    v = int(v)
                elif value_type == VTYPE.BYTES and isinstance(v, dict) and "_bytes" in v:
                    v = bytes(v["_bytes"])
                entries.append([k, v])
            out["map"] = {"keyType": m["keyType"], "valueType": value_type, "entries": entries}
        # Oneof
        if "oneof" in f:
            o = f["oneof"]
            value_type = o["valueType"]
            value = o["value"]
            if value_type in BIGINT_VTYPES and isinstance(value, str):
                value = int(value)
            elif value_type == VTYPE.BYTES and isinstance(value, dict) and "_bytes" in value:
                value = bytes(value["_bytes"])
            out["oneof"] = {"activeField": o["activeField"], "valueType": value_type, "value": value}
        result.append(out)
    return result


def normalize_ops(ops):
    """Normalize a list of ops from JSON corpus."""
    result = []
    for op in ops:
        out = dict(op)
        if "path" in op:
            out["path"] = [dict(c) for c in op["path"]]
        # field_set value
        if "value" in op and isinstance(op["value"], dict):
            v = op["value"]
            value_out = dict(v)
            if v.get("vtype") in BIGINT_VTYPES and isinstance(v.get("value"), str):
                value_out["value"] = int(v["value"])
            if v.get("vtype") == VTYPE.BYTES and isinstance(v.get("value"), dict) and "_bytes" in v["value"]:
                value_out["value"] = bytes(v["value"]["_bytes"])
            if "message" in v:
                value_out["message"] = normalize_fields(v["message"])
            out["value"] = value_out
        # message_replace
        if "message" in op:
            out["message"] = normalize_fields(op["message"])
        # repeated_append elements
        if "elements" in op:
            elems = op["elements"]
            elem_type = elems["elemType"]
            values = elems["values"]
            if elem_type in BIGINT_VTYPES:
                values = [int(v) if isinstance(v, str) else v for v in values]
            out["elements"] = {"elemType": elem_type, "values": values}
        # repeated_splice insertValues
        if "insertValues" in op:
            elem_type = op.get("elemType", 0)
            insert_values = op["insertValues"]
            if elem_type in BIGINT_VTYPES:
                insert_values = [int(v) if isinstance(v, str) else v for v in insert_values]
            out["insertValues"] = insert_values
        # map_set/map_delete value
        if "value" in op and not isinstance(op["value"], dict):
            vt = op.get("valueType")
            if vt in BIGINT_VTYPES and isinstance(op["value"], str):
                out["value"] = int(op["value"])
        result.append(out)
    return result


def _canonical(v):
    """Recursively convert a decoded field/op structure to a comparable form."""
    if isinstance(v, bytes):
        return ("__bytes__", v.hex())
    if isinstance(v, list):
        return [_canonical(x) for x in v]
    if isinstance(v, dict):
        return {k: _canonical(val) for k, val in v.items()}
    return v


def wire_equals(a, b) -> bool:
    return _canonical(a) == _canonical(b)


def record(prefix: str, name: str, reason: str, expected=None, got=None):
    global fails
    fails += 1
    msg = f"FAIL [{prefix}] {name}: {reason}"
    if expected is not None:
        msg += f"\n  expected: {expected}"
    if got is not None:
        msg += f"\n  got:      {got}"
    failures.append(msg)
    print(msg)


def run_snapshot_vector(prefix: str, v: dict):
    global passes
    try:
        inp = normalize_fields(v["input"])
        expected_hex = v["expected_bytes_hex"]

        encoded = encode_document(inp)
        got_hex = encoded.hex()
        if got_hex != expected_hex:
            record(prefix, v["name"], "encode bytes mismatch", expected_hex, got_hex)
            return

        decoded = decode_document(encoded)
        expected_decoded = normalize_fields(v["expected_decoded"]) if "expected_decoded" in v else inp
        if not wire_equals(decoded, expected_decoded):
            record(prefix, v["name"], "decode round-trip mismatch",
                   _canonical(expected_decoded), _canonical(decoded))
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


def run_delta_vector(prefix: str, v: dict):
    global passes
    try:
        initial = normalize_fields(v["initial"])
        ops = normalize_ops(v["ops"])
        expected_chain_hex = v["expected_chain_bytes_hex"]

        chain_bytes = encode_chain(ops)
        got_chain_hex = chain_bytes.hex()
        if got_chain_hex != expected_chain_hex:
            record(prefix, v["name"], "chain bytes mismatch", expected_chain_hex, got_chain_hex)
            return

        decoded_ops = decode_chain(chain_bytes)
        if not wire_equals(decoded_ops, ops):
            record(prefix, v["name"], "ops round-trip mismatch",
                   _canonical(ops), _canonical(decoded_ops))
            return

        final = apply_chain(initial, ops)
        expected_final = normalize_fields(v["expected_final"])
        if not wire_equals(final, expected_final):
            record(prefix, v["name"], "final state mismatch",
                   _canonical(expected_final), _canonical(final))
            return

        snap_bytes = encode_document(final)
        snap_decoded = decode_document(snap_bytes)
        if not wire_equals(snap_decoded, final):
            record(prefix, v["name"], "snapshot round-trip mismatch")
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


for path in walk(VECTORS):
    rel = str(path.relative_to(VECTORS))
    prefix = "wire:" + rel
    vectors = json.loads(path.read_text())
    is_delta = rel.startswith("deltas/")
    is_schema = rel.startswith("schemas/")

    for v in vectors:
        if v.get("status") == "pending":
            skips += 1
            continue
        if is_schema:
            skips += 1
            continue
        elif is_delta:
            run_delta_vector(prefix, v)
        else:
            run_snapshot_vector(prefix, v)

total = passes + fails + skips
print(f"\n{passes}/{total - skips} wire conformance vectors pass "
      f"({skips} pending/skipped, {fails} fail)")
if fails > 0:
    sys.exit(1)
