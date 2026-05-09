"""weavepack-log Python conformance runner.

Walks weavepack/profiles/log/test-vectors/ and validates that the
Python encoder/decoder/apply agree with the JS reference.

Run from the repo root:
    python3 impl/python/conformance_log.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_log import (
    CTYPE,
    encode_batch, encode_stream_header, encode_chain,
    decode_batch, decode_stream_header, decode_chain,
    init_state, apply_chain,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS   = REPO_ROOT / "weavepack" / "profiles" / "log" / "test-vectors"

passes   = 0
fails    = 0
failures = []

BIGINT_CTYPES = {CTYPE.INT64, CTYPE.UINT64, CTYPE.TIMESTAMP64}
SCHEMA_HASH_BYTES = 32
STREAM_ID_BYTES   = 16


# ── Value normalization ─────────────────────────────────────────────────────────────────


def spec_val_to_py(ctype: int, v):
    if v is None:
        return None
    if isinstance(v, dict) and "_bytes" in v:
        return bytes(v["_bytes"])
    if ctype in BIGINT_CTYPES and isinstance(v, str):
        return int(v)
    return v


def py_val_to_spec(ctype: int, v):
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray)):
        return {"_bytes": list(v)}
    if ctype in BIGINT_CTYPES:
        return str(int(v))
    return v


# ── Batch / header / op parsing ────────────────────────────────────────────────────────────


def spec_to_batch(spec: dict) -> dict:
    schema_hash_raw = spec.get("schemaHash")
    if schema_hash_raw and isinstance(schema_hash_raw, dict) and "_bytes" in schema_hash_raw:
        schema_hash = bytes(schema_hash_raw["_bytes"])
    else:
        schema_hash = bytes(SCHEMA_HASH_BYTES)

    seqs = [int(s) for s in (spec.get("seqs") or [])]
    tss  = [int(t) for t in (spec.get("tss") or [])]
    columns = [
        {
            "colId":    col["colId"],
            "ctype":    col["ctype"],
            "nullable": col.get("nullable", False),
            "values":   [spec_val_to_py(col["ctype"], v) for v in col["values"]],
        }
        for col in (spec.get("columns") or [])
    ]
    return {"schemaHash": schema_hash, "seqs": seqs, "tss": tss, "columns": columns}


def spec_to_header(spec: dict) -> dict:
    id_raw = spec.get("streamId", {})
    if isinstance(id_raw, dict) and "_bytes" in id_raw:
        stream_id = bytes(id_raw["_bytes"])
    else:
        stream_id = bytes(STREAM_ID_BYTES)

    schema_hash_raw = spec.get("schemaHash")
    if schema_hash_raw and isinstance(schema_hash_raw, dict) and "_bytes" in schema_hash_raw:
        schema_hash = bytes(schema_hash_raw["_bytes"])
    else:
        schema_hash = bytes(SCHEMA_HASH_BYTES)

    seq_start_v = spec.get("seqStart", 0)
    seq_start = int(seq_start_v) if seq_start_v is not None else 0

    return {
        "streamId":   stream_id,
        "source":     spec.get("source") or "",
        "schemaHash": schema_hash,
        "seqStart":   seq_start,
    }


def spec_to_ops(ops_raw: list) -> list:
    out = []
    for op in ops_raw:
        o = dict(op)
        op_code = o["op"]
        if op_code == 0:  # EVENT_APPEND
            o["seqs"] = [int(s) for s in (o.get("seqs") or [])]
            o["tss"]  = [int(t) for t in (o.get("tss") or [])]
            o["columns"] = [
                {
                    "colId":    col["colId"],
                    "ctype":    col["ctype"],
                    "nullable": col.get("nullable", False),
                    "values":   [spec_val_to_py(col["ctype"], v) for v in col["values"]],
                }
                for col in (o.get("columns") or [])
            ]
        elif op_code == 1:  # FIELD_UPDATE
            o["seq"] = int(o["seq"])
            o["columns"] = [
                {
                    "colId":    col["colId"],
                    "ctype":    col["ctype"],
                    "hasValue": col.get("hasValue", col.get("value") is not None),
                    "value":    spec_val_to_py(col["ctype"], col.get("value")),
                }
                for col in (o.get("columns") or [])
            ]
        elif op_code == 2:  # EVENT_EXPIRE
            o["seqLo"] = int(o["seqLo"])
            o["seqHi"] = int(o["seqHi"])
        elif op_code == 4:  # CURSOR_CHECKPOINT
            o["seq"] = int(o["seq"])
        out.append(o)
    return out


# ── State-to-spec conversion for final state comparison ───────────────────────────────────────


def state_to_spec(state: dict) -> dict:
    seqs = [str(s) for s in state["seqs"]]
    tss  = [str(t) for t in state["tss"]]
    columns = [
        {
            "colId":    col["colId"],
            "ctype":    col["ctype"],
            "nullable": col.get("nullable", False),
            "values":   [py_val_to_spec(col["ctype"], v) for v in col["values"]],
        }
        for col in state["columns"]
    ]
    spec = {"seqs": seqs, "tss": tss, "columns": columns}
    if state.get("schema"):
        spec["schema"] = [
            {"colId": s["colId"], "ctype": s["ctype"], "nullable": s.get("nullable", False), "name": s["name"]}
            for s in state["schema"]
        ]
    if state.get("expired"):
        spec["expired"] = [str(s) for s in sorted(state["expired"])]
    if state.get("cursors"):
        spec["cursors"] = {k: str(v) for k, v in state["cursors"].items()}
    return spec


def normalize_spec(v):
    if isinstance(v, dict):
        return {k: normalize_spec(val) for k, val in v.items()}
    if isinstance(v, list):
        return [normalize_spec(x) for x in v]
    return v


def specs_equal(a, b) -> bool:
    return json.dumps(normalize_spec(a), sort_keys=False) == json.dumps(normalize_spec(b), sort_keys=False)


# ── Failure reporter ───────────────────────────────────────────────────────────────────────────


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


# ── Vector runners ─────────────────────────────────────────────────────────────────────────────


def run_snapshot_vector(prefix: str, v: dict):
    global passes
    try:
        batch_py     = spec_to_batch(v["input"])
        expected_hex = v["expected_bytes_hex"]

        encoded = encode_batch(batch_py)
        got_hex = encoded.hex()
        if got_hex != expected_hex:
            record(prefix, v["name"], "encode bytes mismatch", expected_hex, got_hex)
            return

        decoded   = decode_batch(encoded)
        re_encoded = encode_batch(decoded)
        if re_encoded.hex() != got_hex:
            record(prefix, v["name"], "decode+re-encode round-trip mismatch")
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


def run_header_vector(prefix: str, v: dict):
    global passes
    try:
        hdr_py       = spec_to_header(v["input"])
        expected_hex = v["expected_bytes_hex"]

        encoded = encode_stream_header(hdr_py)
        got_hex = encoded.hex()
        if got_hex != expected_hex:
            record(prefix, v["name"], "encode bytes mismatch", expected_hex, got_hex)
            return

        decoded = decode_stream_header(encoded)
        if decoded["source"] != hdr_py["source"]:
            record(prefix, v["name"], "source mismatch", hdr_py["source"], decoded["source"])
            return
        if decoded["seqStart"] != hdr_py["seqStart"]:
            record(prefix, v["name"], "seqStart mismatch", hdr_py["seqStart"], decoded["seqStart"])
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


def run_delta_vector(prefix: str, v: dict):
    global passes
    try:
        ops_py             = spec_to_ops(v["ops"])
        expected_chain_hex = v["expected_chain_bytes_hex"]
        null_hash          = bytes(SCHEMA_HASH_BYTES)

        chain_bytes = encode_chain(null_hash, ops_py)
        got_hex = chain_bytes.hex()
        if got_hex != expected_chain_hex:
            record(prefix, v["name"], "chain bytes mismatch", expected_chain_hex, got_hex)
            return

        decoded_chain = decode_chain(chain_bytes)
        re_encoded = encode_chain(null_hash, decoded_chain["ops"])
        if re_encoded.hex() != got_hex:
            record(prefix, v["name"], "chain decode+re-encode mismatch")
            return

        initial_batch = spec_to_batch(v["initial"])
        state         = init_state(initial_batch)
        final_state   = apply_chain(state, ops_py)
        actual_spec   = state_to_spec(final_state)

        if not specs_equal(actual_spec, v["expected_final"]):
            record(prefix, v["name"], "final state mismatch",
                   json.dumps(v["expected_final"]), json.dumps(actual_spec))
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


# ── Walk and dispatch ──────────────────────────────────────────────────────────────────────────


def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


for path in walk(VECTORS):
    rel    = str(path.relative_to(VECTORS))
    prefix = "log:" + rel

    with open(path) as f:
        vectors = json.load(f)

    is_delta  = rel.startswith("deltas/")
    is_header = rel == "containers/stream_header.json"

    for v in vectors:
        if v.get("status") == "pending":
            continue
        if is_header:
            run_header_vector(prefix, v)
        elif is_delta:
            run_delta_vector(prefix, v)
        else:
            run_snapshot_vector(prefix, v)


print(f"\nPass: {passes}  Fail: {fails}")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f)
    sys.exit(1)
