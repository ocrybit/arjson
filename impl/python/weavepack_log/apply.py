"""weavepack-log — delta application (apply_op, apply_chain, init_state).

Operates on a StreamState dict:
  {
    'schemaHash': bytes,
    'seqs':       list[int],
    'tss':        list[int],
    'columns':    [{'colId', 'ctype', 'nullable', 'values'}, ...],
    'expired':    set[int],
    'cursors':    dict[str, int],
    'schema':     [{'colId', 'ctype', 'nullable', 'name'}, ...],
  }

Profile isolation: imports only from .types.
"""

import copy
from .types import OP, SCHEMA_SUB_OP


def _find_col_idx(columns: list, col_id: int):
    for i, c in enumerate(columns):
        if c["colId"] == col_id:
            return i
    return None


def _find_seq_idx(seqs: list, seq: int):
    for i, s in enumerate(seqs):
        if s == seq:
            return i
    return None


def _find_schema_idx(schema: list, col_id: int):
    for i, s in enumerate(schema):
        if s["colId"] == col_id:
            return i
    return None


def init_state(batch: dict) -> dict:
    """Create an initial StreamState from a decoded batch."""
    return {
        "schemaHash": batch.get("schemaHash") or bytes(32),
        "seqs":       list(batch.get("seqs") or []),
        "tss":        list(batch.get("tss") or []),
        "columns":    copy.deepcopy(batch.get("columns") or []),
        "expired":    set(),
        "cursors":    {},
        "schema":     [],
    }


def apply_op(state: dict, op: dict) -> dict:
    """Apply a single op to a StreamState. Returns a new StreamState (deep-copied)."""
    state = copy.deepcopy(state)
    op_code = op["op"]

    if op_code == OP.EVENT_APPEND:
        seqs    = [int(s) for s in (op.get("seqs") or [])]
        tss     = [int(t) for t in (op.get("tss") or [])]
        columns = op.get("columns") or []
        num_new = len(seqs)

        if state["seqs"] and seqs:
            max_existing = state["seqs"][-1]
            if seqs[0] <= max_existing:
                raise ValueError(
                    f"seq_not_monotone: first appended seq ({seqs[0]}) must be > last seq ({max_existing})"
                )

        col_map = {c["colId"]: c for c in columns}

        for col in state["columns"]:
            src = col_map.get(col["colId"])
            if src is not None:
                if len(src["values"]) != num_new:
                    raise ValueError(f"event_append column {col['colId']} has wrong value count")
                col["values"].extend(src["values"])
            else:
                if not col.get("nullable", False):
                    raise ValueError(
                        f"non_nullable_null: non-nullable col_id {col['colId']} missing from event_append"
                    )
                col["values"].extend([None] * num_new)

        for src in columns:
            if _find_col_idx(state["columns"], src["colId"]) is None:
                back_fill = [None] * len(state["seqs"])
                new_col = {
                    "colId":    src["colId"],
                    "ctype":    src["ctype"],
                    "nullable": src.get("nullable", False),
                    "values":   back_fill + list(src["values"]),
                }
                state["columns"].append(new_col)

        state["seqs"].extend(seqs)
        state["tss"].extend(tss)

    elif op_code == OP.FIELD_UPDATE:
        seq = int(op["seq"])
        row_idx = _find_seq_idx(state["seqs"], seq)
        if row_idx is None:
            raise ValueError(f"unknown_seq: seq {seq} not found in stream")
        for uf in (op.get("columns") or []):
            ci = _find_col_idx(state["columns"], uf["colId"])
            if ci is None:
                raise ValueError(f"unknown_col_id: col_id {uf['colId']} not found")
            col = state["columns"][ci]
            if col["ctype"] != uf["ctype"]:
                raise ValueError(
                    f"ctype_mismatch: col_id {uf['colId']} expected ctype {col['ctype']}, got {uf['ctype']}"
                )
            has_value = uf.get("hasValue", uf.get("value") is not None)
            if not has_value and not col.get("nullable", False):
                raise ValueError(f"non_nullable_null: col_id {uf['colId']} is not nullable")
            col["values"][row_idx] = uf.get("value")

    elif op_code == OP.EVENT_EXPIRE:
        seq_lo = int(op["seqLo"])
        seq_hi = int(op["seqHi"])
        if _find_seq_idx(state["seqs"], seq_lo) is None:
            raise ValueError(f"unknown_seq: seq_lo {seq_lo} not found in stream")
        if _find_seq_idx(state["seqs"], seq_hi) is None:
            raise ValueError(f"unknown_seq: seq_hi {seq_hi} not found in stream")
        for s in state["seqs"]:
            if seq_lo <= s <= seq_hi:
                state["expired"].add(s)

    elif op_code == OP.SCHEMA_EVOLVE:
        sub_op = op.get("subOp", 0)
        if sub_op == SCHEMA_SUB_OP.COLUMN_ADD:
            col_id   = op["colId"]
            ctype    = op["ctype"]
            nullable = bool(op.get("nullable", False))
            name     = op["name"]
            if _find_schema_idx(state["schema"], col_id) is not None:
                raise ValueError(f"duplicate_col_id: col_id {col_id} already in schema")
            if any(s["name"] == name for s in state["schema"]):
                raise ValueError(f'duplicate_col_name: name "{name}" already in schema')
            state["schema"].append({"colId": col_id, "ctype": ctype, "nullable": nullable, "name": name})
        elif sub_op == SCHEMA_SUB_OP.COLUMN_DROP:
            col_id = op["colId"]
            si = _find_schema_idx(state["schema"], col_id)
            if si is None:
                raise ValueError(f"unknown_col_id: col_id {col_id} not found in schema")
            state["schema"].pop(si)
        elif sub_op == SCHEMA_SUB_OP.COLUMN_RENAME:
            col_id = op["colId"]
            name   = op["name"]
            si = _find_schema_idx(state["schema"], col_id)
            if si is None:
                raise ValueError(f"unknown_col_id: col_id {col_id} not found in schema")
            for i, s in enumerate(state["schema"]):
                if i != si and s["name"] == name:
                    raise ValueError(f'duplicate_col_name: name "{name}" already in use')
            state["schema"][si]["name"] = name
        else:
            raise ValueError(f"unknown_schema_sub_op: sub_op {sub_op} is reserved")

    elif op_code == OP.CURSOR_CHECKPOINT:
        seq  = int(op["seq"])
        name = op["name"]
        if _find_seq_idx(state["seqs"], seq) is None:
            raise ValueError(f"unknown_seq: cursor seq {seq} not found in stream")
        state["cursors"][name] = seq

    else:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved")

    return state


def apply_chain(state: dict, ops: list) -> dict:
    """Apply a list of ops in order. Returns the final StreamState."""
    for op in ops:
        state = apply_op(state, op)
    return state
