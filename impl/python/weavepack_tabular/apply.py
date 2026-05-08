"""weavepack-tabular — delta application (apply_chain, apply_op).

Profile isolation: imports only from .types. No JSON/tensor/wire profile code.
"""

from .types import OP


def _clone_frame(frame: dict) -> dict:
    return {
        "schemaHash": bytes(frame["schemaHash"]),
        "rowIds": list(frame["rowIds"]),
        "columns": [
            {**col, "values": list(col["values"])}
            for col in frame["columns"]
        ],
    }


def _find_col_idx(columns: list, col_id: int) -> int:
    for i, col in enumerate(columns):
        if col["colId"] == col_id:
            return i
    return -1


def _build_row_index(row_ids: list) -> dict:
    return {str(rid): i for i, rid in enumerate(row_ids)}


def apply_op(frame: dict, op: dict) -> dict:
    frame = _clone_frame(frame)
    row_ids = frame["rowIds"]
    columns = frame["columns"]
    op_code = op["op"]

    if op_code in (OP.ROW_INSERT, OP.ROW_UPDATE, OP.BATCH_UPSERT) and op_code == OP.BATCH_UPSERT:
        row_idx = _build_row_index(row_ids)
        to_update = [i for i, rid in enumerate(op["rowIds"]) if str(rid) in row_idx]
        to_insert = [i for i, rid in enumerate(op["rowIds"]) if str(rid) not in row_idx]

        if to_update:
            update_row_ids = [op["rowIds"][i] for i in to_update]
            update_cols = [
                {**col, "values": [col["values"][i] for i in to_update]}
                for col in (op.get("columns") or [])
            ]
            frame = apply_op(frame, {"op": OP.ROW_UPDATE, "rowIds": update_row_ids, "columns": update_cols})
            row_ids = frame["rowIds"]
            columns = frame["columns"]
        if to_insert:
            insert_row_ids = [op["rowIds"][i] for i in to_insert]
            insert_cols = [
                {**col, "values": [col["values"][i] for i in to_insert]}
                for col in (op.get("columns") or [])
            ]
            frame = apply_op(frame, {"op": OP.ROW_INSERT, "rowIds": insert_row_ids, "columns": insert_cols})
        return frame

    elif op_code == OP.ROW_INSERT:
        existing = _build_row_index(row_ids)
        for rid in op["rowIds"]:
            if str(rid) in existing:
                raise ValueError(f"duplicate_row_id: row_id {rid} already exists")

        col_data_map = {col["colId"]: col for col in (op.get("columns") or [])}
        all_row_ids = sorted(row_ids + list(op["rowIds"]), key=lambda r: int(r))
        old_idx_map = _build_row_index(row_ids)
        insert_idx_map = _build_row_index(op["rowIds"])

        new_columns = []
        for col in columns:
            insert_col = col_data_map.get(col["colId"])
            new_values = []
            for rid in all_row_ids:
                rid_str = str(rid)
                if rid_str in old_idx_map:
                    new_values.append(col["values"][old_idx_map[rid_str]])
                elif insert_col and rid_str in insert_idx_map:
                    new_values.append(insert_col["values"][insert_idx_map[rid_str]])
                else:
                    new_values.append(None)
            new_columns.append({**col, "values": new_values})

        frame["rowIds"] = all_row_ids
        frame["columns"] = new_columns

    elif op_code == OP.ROW_UPDATE:
        row_idx = _build_row_index(row_ids)
        for rid in op["rowIds"]:
            if str(rid) not in row_idx:
                raise ValueError(f"unknown_row_id: row_id {rid} not found")
        update_idx_map = _build_row_index(op["rowIds"])

        for update_col in (op.get("columns") or []):
            ci = _find_col_idx(columns, update_col["colId"])
            if ci == -1:
                raise ValueError(f"unknown_col_id: col_id {update_col['colId']} not found")
            if columns[ci]["ctype"] != update_col["ctype"]:
                raise ValueError(
                    f"ctype_mismatch: col_id {update_col['colId']} expected ctype "
                    f"{columns[ci]['ctype']}, got {update_col['ctype']}"
                )
            new_values = list(columns[ci]["values"])
            for i, rid in enumerate(op["rowIds"]):
                ri = row_idx[str(rid)]
                new_values[ri] = update_col["values"][i]
            columns[ci] = {**columns[ci], "values": new_values}

    elif op_code == OP.ROW_DELETE:
        row_idx = _build_row_index(row_ids)
        for rid in op["rowIds"]:
            if str(rid) not in row_idx:
                raise ValueError(f"unknown_row_id: row_id {rid} not found")
        delete_set = {str(rid) for rid in op["rowIds"]}
        keep_mask = [str(rid) not in delete_set for rid in row_ids]
        frame["rowIds"] = [rid for rid, keep in zip(row_ids, keep_mask) if keep]
        frame["columns"] = [
            {**col, "values": [v for v, keep in zip(col["values"], keep_mask) if keep]}
            for col in columns
        ]

    elif op_code == OP.COLUMN_ADD:
        if _find_col_idx(columns, op["colId"]) != -1:
            raise ValueError(f"duplicate_col_id: col_id {op['colId']} already exists")
        if not op["nullable"] and not op.get("hasDefault") and len(row_ids) > 0:
            raise ValueError(
                "column_add malformed: non-nullable column with no default cannot be added to non-empty table"
            )
        default_val = op.get("defaultValue") if op.get("hasDefault") else None
        new_col = {
            "colId": op["colId"],
            "ctype": op["ctype"],
            "nullable": op["nullable"],
            "values": [default_val for _ in row_ids],
        }
        if "name" in op and op["name"] is not None:
            new_col["name"] = op["name"]
        frame["columns"] = columns + [new_col]

    elif op_code == OP.COLUMN_DROP:
        ci = _find_col_idx(columns, op["colId"])
        if ci == -1:
            raise ValueError(f"unknown_col_id: col_id {op['colId']} not found")
        frame["columns"] = [col for i, col in enumerate(columns) if i != ci]

    elif op_code == OP.COLUMN_RENAME:
        ci = _find_col_idx(columns, op["colId"])
        if ci == -1:
            raise ValueError(f"unknown_col_id: col_id {op['colId']} not found")
        if not op.get("name"):
            raise ValueError("invalid_col_name: empty name")
        for i, col in enumerate(columns):
            if i != ci and col.get("name") == op["name"]:
                raise ValueError(f"duplicate_col_name: name \"{op['name']}\" already in use")
        frame["columns"] = [
            {**col, "name": op["name"]} if i == ci else col
            for i, col in enumerate(columns)
        ]

    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")

    return frame


def apply_chain(frame: dict, ops: list) -> dict:
    """Apply a list of ops to a frame, returning the final frame state."""
    state = frame
    for op in ops:
        state = apply_op(state, op)
    return state
