"""weavepack-wire — delta application (apply_chain, apply_op).

Operates on decoded field lists (the same representation that
decode_document/encode_document use). No byte-level work here.

Profile isolation: imports only from .types.
"""

import copy
from .types import OP


def _clone_fields(fields: list) -> list:
    return copy.deepcopy(fields)


def _find_field(fields: list, num: int) -> int:
    for i, f in enumerate(fields):
        if f["num"] == num:
            return i
    return -1


def _navigate(fields: list, path: list):
    """Walk all path components except the last, returning (parent_fields, last_comp).

    Returns (fields, None) when path is empty (root message).
    """
    if not path:
        return None, None

    current = fields
    for comp in path[:-1]:
        if "field" in comp:
            idx = _find_field(current, comp["field"])
            if idx == -1:
                raise ValueError(f"field {comp['field']} not found")
            f = current[idx]
            if "message" not in f:
                raise ValueError(f"field {comp['field']} is not a message")
            current = f["message"]
        elif "index" in comp:
            raise ValueError("nested repeated navigation not supported in v0.1")
        else:
            raise ValueError(f"unexpected mid-path component type")

    return current, path[-1]


def _apply_op(fields: list, op: dict) -> list:
    fields = _clone_fields(fields)
    path = op.get("path") or []
    op_code = op["op"]

    if op_code == OP.MESSAGE_REPLACE:
        if not path:
            return _clone_fields(op["message"])
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            replacement = {"num": last["field"], "message": _clone_fields(op["message"])}
            if idx == -1:
                parent.append(replacement)
            else:
                parent[idx] = replacement
            parent.sort(key=lambda f: f["num"])
        return fields

    if op_code == OP.FIELD_SET:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            v = op["value"]
            if "message" in v:
                new_field = {"num": last["field"], "message": _clone_fields(v["message"])}
            else:
                new_field = {"num": last["field"], "vtype": v["vtype"], "value": v["value"]}
            if idx == -1:
                parent.append(new_field)
            else:
                parent[idx] = new_field
            parent.sort(key=lambda f: f["num"])
        return fields

    if op_code == OP.FIELD_DELETE:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            if idx != -1:
                parent.pop(idx)
        return fields

    if op_code == OP.REPEATED_APPEND:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            elems = op["elements"]
            if idx == -1:
                parent.append({
                    "num": last["field"],
                    "repeated": {"elemType": elems["elemType"], "values": list(elems["values"])},
                })
                parent.sort(key=lambda f: f["num"])
            else:
                f = parent[idx]
                if "repeated" not in f:
                    raise ValueError(f"field {last['field']} is not repeated")
                f["repeated"]["values"].extend(elems["values"])
        return fields

    if op_code == OP.REPEATED_SPLICE:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            if idx == -1:
                raise ValueError(f"repeated field {last['field']} not found")
            f = parent[idx]
            if "repeated" not in f:
                raise ValueError(f"field {last['field']} is not repeated")
            vals = f["repeated"]["values"]
            splice_idx = op["index"]
            delete_count = op["deleteCount"]
            insert_values = op["insertValues"]
            vals[splice_idx:splice_idx + delete_count] = insert_values
        return fields

    if op_code == OP.MAP_SET:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            if idx == -1:
                parent.append({
                    "num": last["field"],
                    "map": {"keyType": op["keyType"], "valueType": op["valueType"],
                            "entries": [[op["key"], op["value"]]]},
                })
                parent.sort(key=lambda f: f["num"])
            else:
                f = parent[idx]
                if "map" not in f:
                    raise ValueError(f"field {last['field']} is not a map")
                entries = f["map"]["entries"]
                key = op["key"]
                for i, (k, _) in enumerate(entries):
                    if k == key:
                        entries[i][1] = op["value"]
                        break
                else:
                    entries.append([op["key"], op["value"]])
        return fields

    if op_code == OP.MAP_DELETE:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            if idx != -1:
                f = parent[idx]
                if "map" not in f:
                    raise ValueError(f"field {last['field']} is not a map")
                key = op["key"]
                entries = f["map"]["entries"]
                f["map"]["entries"] = [[k, v] for k, v in entries if k != key]
        return fields

    if op_code == OP.ONEOF_SWITCH:
        parent, last = _navigate(fields, path)
        if "field" in last:
            idx = _find_field(parent, last["field"])
            new_oneof = {
                "num": last["field"],
                "oneof": {"activeField": op["activeField"], "valueType": op["valueType"],
                          "value": op["value"]},
            }
            if idx == -1:
                parent.append(new_oneof)
                parent.sort(key=lambda f: f["num"])
            else:
                parent[idx] = new_oneof
        return fields

    raise ValueError(f"unknown op {op_code}")


def apply_chain(fields: list, ops: list) -> list:
    """Apply a sequence of ops to a field list, returning a new list."""
    state = fields
    for op in ops:
        state = _apply_op(state, op)
    return state
