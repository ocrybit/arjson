"""weavepack-ast — delta application (init_state, apply_chain).

AST state:
  {
    'nodes': dict[str(nid), {
        'kind': str,
        'parentNid': int|None,
        'childIndex': int,
        'props': dict[int|str, {'ctype': int, 'value': any}],
    }],
  }

Profile isolation: imports only from .types.
Mirrors sdk/src/profiles/ast/apply.js exactly, including the
null-value-store behavior of prop_set (value=None is stored, not deleted).
"""

import copy
from .types import OP, PATH_KIND


def _collect_descendants(nodes: dict, root_nid: int) -> list:
    result = []
    queue = [root_nid]
    while queue:
        nid = queue.pop()
        for k, node in nodes.items():
            if node["parentNid"] == nid and int(k) not in result:
                result.append(int(k))
                queue.append(int(k))
    return result


def _populate_nodes_from_block(nodes: dict, block: dict):
    btype = block.get("type")
    nids = block.get("nids") or []
    parent_nids = block.get("parentNids") or []
    child_indices = block.get("childIndices") or []
    columns = block.get("columns") or []

    for i, nid in enumerate(nids):
        key = str(nid)
        if key in nodes:
            raise ValueError(f"duplicate_element_id: nid {nid} already exists")
        kind = block.get("kind", "") if btype == "node" else (block.get("kinds") or [])[i]
        props = {}
        for col in columns:
            v = col["values"][i]
            if v is not None:
                props[col["colId"]] = {"ctype": col["ctype"], "value": v}
        nodes[key] = {
            "kind": kind,
            "parentNid": parent_nids[i],
            "childIndex": child_indices[i],
            "props": props,
        }


def init_state(doc: dict) -> dict:
    """Build initial AST state from a decoded tree document."""
    state = {"nodes": {}}
    for blk in (doc.get("blocks") or []):
        _populate_nodes_from_block(state["nodes"], blk)
    return state


def apply_op(state: dict, op: dict) -> dict:
    """Apply a single op to AST state. Returns a new state (deep-copied)."""
    state = copy.deepcopy(state)
    op_code = op["op"]
    nodes = state["nodes"]

    if op_code == OP.NODE_INSERT:
        _populate_nodes_from_block(nodes, op["block"])

    elif op_code == OP.NODE_DELETE:
        for nid in (op.get("nids") or []):
            nid_int = int(nid)
            descendants = _collect_descendants(nodes, nid_int)
            nodes.pop(str(nid_int), None)
            for dk in descendants:
                nodes.pop(str(dk), None)

    elif op_code == OP.NODE_MOVE:
        nid_str = str(int(op["nid"]))
        node = nodes.get(nid_str)
        if node is None:
            raise ValueError(f"element_not_found: node {op['nid']} not found")
        new_parent = op.get("newParentNid", 0)
        node["parentNid"] = None if (new_parent == 0 or new_parent is None) else int(new_parent)
        node["childIndex"] = int(op.get("newChildIndex", 0))

    elif op_code == OP.PROP_SET:
        path = op["path"]
        kind = path["kind"]
        if kind == PATH_KIND.NODE_COL:
            col_key = path["colId"]
            nid_str = str(int(path["nid"]))
        elif kind == PATH_KIND.NODE:
            col_key = None
            nid_str = str(int(path["nid"]))
        elif kind == PATH_KIND.NODE_PROP:
            col_key = path.get("prop")
            nid_str = str(int(path["nid"]))
        else:
            return state  # no-op for other path kinds

        node = nodes.get(nid_str)
        if node is None:
            return state  # no-op if node not found

        if col_key is not None:
            # Store the value (including None/null) — mirrors astSpecToOp+applyOp in JS
            # which stores null rather than deleting the prop entry.
            node["props"][col_key] = {"ctype": op["ctype"], "value": op.get("value")}

    elif op_code == OP.KIND_RENAME:
        old_kind = op.get("oldKind", "")
        new_kind = op.get("newKind", "")
        for node in nodes.values():
            if node["kind"] == old_kind:
                node["kind"] = new_kind

    elif op_code == OP.SUBTREE_REPLACE:
        root_nid = int(op["rootNid"])
        descendants = _collect_descendants(nodes, root_nid)
        for dk in descendants:
            nodes.pop(str(dk), None)
        _populate_nodes_from_block(nodes, op["block"])

    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")

    return state


def apply_chain(state: dict, ops: list) -> dict:
    """Apply a list of ops in order. Returns the final AST state."""
    for op in ops:
        state = apply_op(state, op)
    return state
