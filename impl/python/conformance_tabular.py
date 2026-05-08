"""weavepack-tabular Python conformance runner.

Walks weavepack/profiles/tabular/test-vectors/ and validates that the
Python encoder/decoder/apply agree with the JS reference.

Run from the repo root:
    python3 impl/python/conformance_tabular.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_tabular import (
    CTYPE,
    encode_frame,
    decode_frame,
    encode_chain,
    decode_chain,
    apply_chain,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS   = REPO_ROOT / "weavepack" / "profiles" / "tabular" / "test-vectors"

passes   = 0
fails    = 0
skips    = 0
failures = []

# ctypes whose JSON corpus values are stored as strings (large integers).
BIGINT_CTYPES = {CTYPE.INT64, CTYPE.UINT64, CTYPE.TIMESTAMP64}


# ── Normalization helpers ──────────────────────────────────────────────────────────────────────

def spec_val_to_py(ctype: int, v):
    """Convert a corpus value to Python-native form."""
    if v is None:
        return None
    if isinstance(v, dict) and "_bytes" in v:
        return bytes(v["_bytes"])
    if ctype in BIGINT_CTYPES and isinstance(v, str):
        return int(v)
    return v


def spec_to_frame(spec: dict) -> dict:
    """Convert a corpus frame spec to Python form (rowIds as int)."""
    return {
        "rowIds": [int(r) for r in (spec.get("rowIds") or [])],
        "columns": [
            {
                "colId":    col["colId"],
                "ctype":    col["ctype"],
                "nullable": col["nullable"],
                "values":   [spec_val_to_py(col["ctype"], v) for v in col["values"]],
                **( {"name": col["name"]} if "name" in col else {} ),
            }
            for col in (spec.get("columns") or [])
        ],
    }


def spec_to_ops(ops: list) -> list:
    out = []
    for op in ops:
        o = dict(op)
        if "rowIds" in o:
            o["rowIds"] = [int(r) for r in o["rowIds"]]
        if "columns" in o:
            o["columns"] = [
                {
                    **col,
                    "values": [spec_val_to_py(col["ctype"], v) for v in col["values"]],
                }
                for col in o["columns"]
            ]
        if o.get("hasDefault") and "defaultValue" in o:
            o["defaultValue"] = spec_val_to_py(o["ctype"], o["defaultValue"])
        out.append(o)
    return out


def py_val_to_spec(ctype: int, v):
    """Convert a Python-native value back to corpus spec form."""
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray)):
        return {"_bytes": list(v)}
    if ctype in BIGINT_CTYPES:
        return str(int(v))
    return v


def frame_to_spec(frame: dict) -> dict:
    """Convert a Python frame back to corpus spec form for comparison."""
    return {
        "rowIds": [str(rid) for rid in frame["rowIds"]],
        "columns": [
            {
                "colId":    col["colId"],
                "ctype":    col["ctype"],
                "nullable": col["nullable"],
                "values":   [py_val_to_spec(col["ctype"], v) for v in col["values"]],
                **( {"name": col["name"]} if "name" in col else {} ),
            }
            for col in frame["columns"]
        ],
    }


def frames_equal(a: dict, b: dict) -> bool:
    return json.dumps(a, sort_keys=False) == json.dumps(b, sort_keys=False)


# ── Vector runners ───────────────────────────────────────────────────────────────────────────

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
        input_py = spec_to_frame(v["input"])
        expected_hex = v["expected_bytes_hex"]

        encoded = encode_frame(input_py)
        got_hex = encoded.hex()
        if got_hex != expected_hex:
            record(prefix, v["name"], "encode bytes mismatch", expected_hex, got_hex)
            return

        decoded = decode_frame(encoded)
        re_encoded = encode_frame(decoded)
        if re_encoded.hex() != got_hex:
            record(prefix, v["name"], "decode+re-encode round-trip mismatch")
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


def run_delta_vector(prefix: str, v: dict):
    global passes
    try:
        initial_py = spec_to_frame(v["initial"])
        ops_py     = spec_to_ops(v["ops"])
        expected_chain_hex = v["expected_chain_bytes_hex"]

        chain_bytes = encode_chain({"ops": ops_py})
        got_chain_hex = chain_bytes.hex()
        if got_chain_hex != expected_chain_hex:
            record(prefix, v["name"], "chain bytes mismatch", expected_chain_hex, got_chain_hex)
            return

        decoded_chain = decode_chain(chain_bytes)
        re_encoded = encode_chain({"ops": decoded_chain["ops"]})
        if re_encoded.hex() != got_chain_hex:
            record(prefix, v["name"], "chain decode+re-encode mismatch")
            return

        # Apply to initial state (round-trip initial through encode/decode first).
        initial_rt   = decode_frame(encode_frame(initial_py))
        final_state  = apply_chain(initial_rt, ops_py)
        final_spec   = frame_to_spec(final_state)
        if not frames_equal(final_spec, v["expected_final"]):
            record(prefix, v["name"], "final state mismatch",
                   json.dumps(v["expected_final"]), json.dumps(final_spec))
            return

        passes += 1
    except Exception as e:
        record(prefix, v["name"], f"exception: {e}")


# ── Walk and dispatch ─────────────────────────────────────────────────────────────────────────

def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


for path in walk(VECTORS):
    rel    = str(path.relative_to(VECTORS))
    prefix = "tabular:" + rel
    vectors = json.loads(path.read_text())
    is_delta = rel.startswith("deltas/")

    for v in vectors:
        if v.get("status") == "pending":
            skips += 1
            continue
        if is_delta:
            run_delta_vector(prefix, v)
        else:
            run_snapshot_vector(prefix, v)

total = passes + fails + skips
print(f"\n{passes}/{total - skips} tabular conformance vectors pass "
      f"({skips} pending/skipped, {fails} fail)")
if fails > 0:
    sys.exit(1)
