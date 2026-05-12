"""weavepack-graph Python conformance runner.

Walks weavepack/profiles/graph/test-vectors/ and validates that the
Python encoder/decoder/apply agree with the JS reference vectors.

Run from the repo root:
    python3 impl/python/conformance_graph.py
"""

import json
import sys
import math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_graph import (
    CTYPE,
    encode_graph, encode_chain,
    decode_graph, decode_chain,
    init_state, apply_chain,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS   = REPO_ROOT / "weavepack" / "profiles" / "graph" / "test-vectors"

passes   = 0
fails    = 0
failures = []

SCHEMA_HASH_BYTES = 32

# ctypes whose values are represented as strings in JSON (u64-range integers)
BIGINT_CTYPES = {CTYPE.INT64, CTYPE.UINT64, CTYPE.TIMESTAMP64, CTYPE.NODE_ID}


# ── Value normalization ─────────────────────────────────────────────────────────────────


def spec_val_to_py(ctype: int, v):
    """Convert a test-vector spec value to a Python value for the encoder."""
    if v is None:
        return None
    if isinstance(v, dict) and "_bytes" in v:
        return bytes(v["_bytes"])
    if ctype in BIGINT_CTYPES and isinstance(v, str):
        return int(v)
    return v


def py_val_to_spec(ctype: int, v):
    """Convert a Python runtime value to test-vector spec form for comparison."""
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray)):
        return {"_bytes": list(v)}
    if ctype in BIGINT_CTYPES:
        return str(int(v))
    # float32 whole-number values: JS JSON.stringify(5.0) => "5", match it
    if ctype == CTYPE.FLOAT32 and isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 9.007_199_254_740_992e15:
            return int(v)
    if ctype == CTYPE.FLOAT64 and isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 9.007_199_254_740_992e15:
            return int(v)
    return v


# ── Block/op parsing from spec ─────────────────────────────────────────────────────────


def spec_col_to_py(col: dict) -> dict:
    ctype = col["ctype"]
    return {
        "colId":    col["colId"],
        "ctype":    ctype,
        "nullable": col.get("nullable", False),
        "values":   [spec_val_to_py(ctype, v) for v in (col.get("values") or [])],
    }


def spec_block_to_py(blk: dict) -> dict:
    if blk.get("type") == "node":
        return {
            "type":    "node",
            "label":   blk.get("label"),
            "nids":    [int(n) for n in (blk.get("nids") or [])],
            "columns": [spec_col_to_py(c) for c in (blk.get("columns") or [])],
        }
    else:
        return {
            "type":    "edge",
            "label":   blk.get("label"),
            "eids":    [int(e) for e in (blk.get("eids") or [])],
            "srcs":    [int(s) for s in (blk.get("srcs") or [])],
            "dsts":    [int(d) for d in (blk.get("dsts") or [])],
            "columns": [spec_col_to_py(c) for c in (blk.get("columns") or [])],
        }


def spec_graph_to_py(spec: dict) -> dict:
    schema_hash_raw = spec.get("schemaHash")
    if schema_hash_raw and isinstance(schema_hash_raw, dict) and "_bytes" in schema_hash_raw:
        schema_hash = bytes(schema_hash_raw["_bytes"])
    else:
        schema_hash = None
    return {
        "schemaHash": schema_hash,
        "blocks": [spec_block_to_py(b) for b in (spec.get("blocks") or [])],
    }


def spec_path_to_py(p: dict) -> dict:
    out = {"kind": p["kind"]}
    if "nid" in p:
        out["nid"] = int(p["nid"])
    if "eid" in p:
        out["eid"] = int(p["eid"])
    if "colId" in p:
        out["colId"] = p["colId"]
    if "label" in p:
        out["label"] = p["label"]
    if "prop" in p:
        out["prop"] = p["prop"]
    return out


def spec_op_to_py(op: dict) -> dict:
    o = {"op": op["op"]}
    op_code = op["op"]
    if op_code == 0:    # NODE_INSERT
        o["block"] = spec_block_to_py(op["block"])
    elif op_code == 1:  # NODE_DELETE
        o["nids"] = [int(n) for n in (op.get("nids") or [])]
    elif op_code == 2:  # EDGE_INSERT
        o["block"] = spec_block_to_py(op["block"])
    elif op_code == 3:  # EDGE_DELETE
        o["eids"] = [int(e) for e in (op.get("eids") or [])]
    elif op_code == 4:  # PROP_SET
        o["path"]     = spec_path_to_py(op["path"])
        o["ctype"]    = op["ctype"]
        o["nullable"] = op.get("nullable", False)
        o["value"]    = spec_val_to_py(op["ctype"], op.get("value"))
    elif op_code == 5:  # SUBGRAPH_REPLACE
        o["label"] = op.get("label")
        if op.get("nodeBlock"):
            o["nodeBlock"] = spec_block_to_py(op["nodeBlock"])
        if op.get("edgeBlock"):
            o["edgeBlock"] = spec_block_to_py(op["edgeBlock"])
    return o


# ── State-to-spec conversion for final state comparison ───────────────────────────────────────


def state_to_spec(state: dict) -> dict:
    def sort_key_big(key: str) -> int:
        return int(key)

    def sort_col_key(col_key):
        # numeric colIds sort before string colIds; within same type: int ascending, str locale
        if isinstance(col_key, int):
            return (0, col_key, "")
        else:
            return (1, 0, str(col_key))

    nodes_out = []
    for nid_key in sorted(state["nodes"], key=sort_key_big):
        node = state["nodes"][nid_key]
        props_out = []
        for col_key in sorted(node["props"], key=sort_col_key):
            entry = node["props"][col_key]
            props_out.append({
                "colId": col_key,
                "ctype": entry["ctype"],
                "value": py_val_to_spec(entry["ctype"], entry["value"]),
            })
        nodes_out.append({
            "nid":   nid_key,
            "label": node["label"],
            "props": props_out,
        })

    edges_out = []
    for eid_key in sorted(state["edges"], key=sort_key_big):
        edge = state["edges"][eid_key]
        props_out = []
        for col_key in sorted(edge["props"], key=sort_col_key):
            entry = edge["props"][col_key]
            props_out.append({
                "colId": col_key,
                "ctype": entry["ctype"],
                "value": py_val_to_spec(entry["ctype"], entry["value"]),
            })
        edges_out.append({
            "eid":   eid_key,
            "src":   str(edge["src"]),
            "dst":   str(edge["dst"]),
            "label": edge["label"],
            "props": props_out,
        })

    return {"nodes": nodes_out, "edges": edges_out}


# ── Failure reporter ─────────────────────────────────────────────────────────────────────────


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
        graph_py     = spec_graph_to_py(v["input"])
        expected_hex = v["expected_bytes_hex"]

        encoded = encode_graph(graph_py)
        got_hex = encoded.hex()
        if got_hex != expected_hex:
            record(prefix, v["name"], "encode bytes mismatch", expected_hex, got_hex)
            return

        decoded    = decode_graph(encoded)
        re_encoded = encode_graph(decoded)
        if re_encoded.hex() != got_hex:
            record(prefix, v["name"], "decode+re-encode round-trip mismatch")
            return

        passes += 1
    except Exception as e:
        import traceback
        record(prefix, v["name"], f"exception: {e}\n{traceback.format_exc()}")


def run_delta_vector(prefix: str, v: dict):
    global passes
    try:
        ops_py             = [spec_op_to_py(op) for op in (v.get("ops") or [])]
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

        initial_graph = spec_graph_to_py(v["initial"])
        encoded_initial = encode_graph(initial_graph)
        decoded_initial = decode_graph(encoded_initial)
        state = init_state(decoded_initial)
        final_state = apply_chain(state, ops_py)
        actual_spec = state_to_spec(final_state)

        if json.dumps(actual_spec, sort_keys=False) != json.dumps(v["expected_final"], sort_keys=False):
            record(prefix, v["name"], "final state mismatch",
                   json.dumps(v["expected_final"]), json.dumps(actual_spec))
            return

        passes += 1
    except Exception as e:
        import traceback
        record(prefix, v["name"], f"exception: {e}\n{traceback.format_exc()}")


# ── Walk and dispatch ──────────────────────────────────────────────────────────────────────────


def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


for path in walk(VECTORS):
    rel    = str(path.relative_to(VECTORS))
    prefix = "graph:" + rel

    with open(path) as f:
        vectors = json.load(f)

    for v in vectors:
        if v.get("status") == "pending":
            continue
        if v.get("expected_chain_bytes_hex"):
            run_delta_vector(prefix, v)
        else:
            run_snapshot_vector(prefix, v)


print(f"\nPass: {passes}  Fail: {fails}")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f)
    sys.exit(1)
