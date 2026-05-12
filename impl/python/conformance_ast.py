"""weavepack-ast Python conformance runner.

Walks weavepack/profiles/ast/test-vectors/ and validates that the
Python encoder/decoder/apply agree with the JS reference vectors.

Run from the repo root:
    python3 impl/python/conformance_ast.py
"""

import json
import sys
import math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_ast import (
    CTYPE,
    encode_tree, encode_chain,
    decode_tree, decode_chain,
    init_state, apply_chain,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS   = REPO_ROOT / "weavepack" / "profiles" / "ast" / "test-vectors"

passes   = 0
fails    = 0
failures = []

SCHEMA_HASH_BYTES = 32

BIGINT_CTYPES = {CTYPE.INT64, CTYPE.UINT64, CTYPE.TIMESTAMP64, CTYPE.NODE_ID}


# ── Value normalization ──────────────────────────────────────────────────


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
    if ctype == CTYPE.FLOAT32 and isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 9.007_199_254_740_992e15:
            return int(v)
    if ctype == CTYPE.FLOAT64 and isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 9.007_199_254_740_992e15:
            return int(v)
    return v


# ── Block/op parsing from spec ─────────────────────────────────────────────


def spec_col_to_py(col: dict) -> dict:
    ctype = col["ctype"]
    return {
        "colId":    col["colId"],
        "ctype":    ctype,
        "nullable": col.get("nullable", False),
        "values":   [spec_val_to_py(ctype, v) for v in (col.get("values") or [])],
    }


def spec_block_to_py(blk: dict) -> dict:
    btype = blk.get("type", "node")
    nids        = [int(n) for n in (blk.get("nids") or [])]
    parent_nids = [None if p is None else int(p) for p in (blk.get("parentNids") or [])]
    child_indices = [int(c) for c in (blk.get("childIndices") or [])]
    columns = [spec_col_to_py(c) for c in (blk.get("columns") or [])]

    if btype == "node":
        return {
            "type":         "node",
            "kind":         blk.get("kind", ""),
            "nids":         nids,
            "parentNids":   parent_nids,
            "childIndices": child_indices,
            "columns":      columns,
        }
    else:  # mixed
        kinds = blk.get("kinds") or []
        return {
            "type":         "mixed",
            "kinds":        kinds,
            "nids":         nids,
            "parentNids":   parent_nids,
            "childIndices": child_indices,
            "columns":      columns,
        }


def spec_tree_to_py(spec: dict) -> dict:
    schema_hash_raw = spec.get("schemaHash")
    if schema_hash_raw and isinstance(schema_hash_raw, dict) and "_bytes" in schema_hash_raw:
        schema_hash = bytes(schema_hash_raw["_bytes"])
    else:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    return {
        "schemaHash": schema_hash,
        "blocks":     [spec_block_to_py(b) for b in (spec.get("blocks") or [])],
    }


def spec_path_to_py(p: dict) -> dict:
    out = {"kind": p["kind"]}
    if "nid" in p:
        out["nid"] = int(p["nid"])
    if "colId" in p:
        out["colId"] = p["colId"]
    if "nodeKind" in p:
        out["nodeKind"] = p["nodeKind"]
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
    elif op_code == 2:  # NODE_MOVE
        o["nid"]           = int(op["nid"])
        o["newParentNid"]  = int(op["newParentNid"]) if op.get("newParentNid") is not None else 0
        o["newChildIndex"] = int(op.get("newChildIndex", 0))
    elif op_code == 3:  # PROP_SET
        o["path"]     = spec_path_to_py(op["path"])
        o["ctype"]    = op["ctype"]
        o["nullable"] = op.get("nullable", False)
        o["value"]    = spec_val_to_py(op["ctype"], op.get("value"))
    elif op_code == 4:  # KIND_RENAME
        o["oldKind"] = op.get("oldKind", "")
        o["newKind"] = op.get("newKind", "")
    elif op_code == 5:  # SUBTREE_REPLACE
        o["rootNid"] = int(op["rootNid"])
        o["block"]   = spec_block_to_py(op["block"])
    return o


# ── State-to-spec conversion for final state comparison ───────────────────────


def state_to_spec(state: dict) -> dict:
    def sort_col_key(col_key):
        if isinstance(col_key, int):
            return (0, col_key, "")
        return (1, 0, str(col_key))

    nodes_out = []
    for nid_key in sorted(state["nodes"], key=lambda k: int(k)):
        node = state["nodes"][nid_key]
        props_out = []
        for col_key in sorted(node["props"], key=sort_col_key):
            entry = node["props"][col_key]
            props_out.append({
                "colId": col_key,
                "ctype": entry["ctype"],
                "value": py_val_to_spec(entry["ctype"], entry["value"]),
            })
        parent = node["parentNid"]
        nodes_out.append({
            "nid":       nid_key,
            "kind":      node["kind"],
            "parentNid": None if parent is None else str(parent),
            "childIndex": node["childIndex"],
            "props":     props_out,
        })

    return {"nodes": nodes_out}


# ── Failure reporter ─────────────────────────────────────────────────────────


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


# ── Vector runners ──────────────────────────────────────────────────────────


def run_snapshot_vector(prefix: str, v: dict):
    global passes
    try:
        tree_py      = spec_tree_to_py(v["input"])
        expected_hex = v["expected_bytes_hex"]

        encoded = encode_tree(tree_py)
        got_hex = encoded.hex()
        if got_hex != expected_hex:
            record(prefix, v["name"], "encode bytes mismatch", expected_hex, got_hex)
            return

        decoded    = decode_tree(encoded)
        re_encoded = encode_tree(decoded)
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

        initial_tree    = spec_tree_to_py(v["initial"])
        encoded_initial = encode_tree(initial_tree)
        decoded_initial = decode_tree(encoded_initial)
        state           = init_state(decoded_initial)
        final_state     = apply_chain(state, ops_py)
        actual_spec     = state_to_spec(final_state)

        if json.dumps(actual_spec, sort_keys=False) != json.dumps(v["expected_final"], sort_keys=False):
            record(prefix, v["name"], "final state mismatch",
                   json.dumps(v["expected_final"]), json.dumps(actual_spec))
            return

        passes += 1
    except Exception as e:
        import traceback
        record(prefix, v["name"], f"exception: {e}\n{traceback.format_exc()}")


# ── Walk and dispatch ──────────────────────────────────────────────────────────


def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


for path in walk(VECTORS):
    rel    = str(path.relative_to(VECTORS))
    prefix = "ast:" + rel

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
