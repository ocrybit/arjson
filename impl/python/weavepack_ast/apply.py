"""weavepack-ast — delta application (init_state, apply_chain).

AST state:
  {
    'schemaHash': bytes,
    'nodes': dict[str, {
      'kind':        str,
      'parentNid':   int|None,
      'childIndex':  int,
      'props':       dict[int|str, {'ctype': int, 'value': any}],
    }],
  }

Map keys are str(nid) for consistent identity.

Profile isolation: imports only from .types.
"""

import copy
from .types import OP, PATH_KIND


def _collect_descendants(nodes: dict, root_key: str) -> set:
    """Return set of all descendant node keys of root_key."""
    result = set()
    queue = [root_key]
    while queue:
        key = queue.pop()
        for k, v in nodes.items():
            parent = v.get("parentNid")
            if parent is not None and str(parent) == key and k not in result:
                result.add(k)
                queue.append(k)
    return result


def _populate_nodes_from_block(nodes: dict, block: dict):
    nids = block.get("nids") or []
    parent_nids = block.get("parentNids") or [None] * len(nids)
    child_indices = block.get("childIndices") or [0] * len(nids)
    columns = block.get("columns") or []
    is_mixed = block.get("type") == "mixed"
    kinds = block.get("kinds") if is_mixed else None
    block_kind = block.get("kind") if not is_mixed else None

    for i, nid in enumerate(nids):
        key = str(nid)
        if key in nodes:
            raise ValueError(f"duplicate_element_id: nid {nid} already exists")
        props = {}
        for col in columns:
            v = col["values"][i]
            if v is not None:
                props[col["colId"]] = {"ctype": col["ctype"], "value": v}
        kind = kinds[i] if is_mixed else (block_kind or "")
        nodes[key] = {
            "kind":       kind,
            "parentNid":  parent_nids[i],
            "childIndex": child_indices[i] if i < len(child_indices) else 0,
            "props":      props,
        }


def init_state(tree: dict) -> dict:
    """Build initial state from a decoded AST document."""
    state = {
        "schemaHash": tree.get("schemaHash") or bytes(32),
        "nodes": {},
    }
    for blk in (tree.get("blocks") or []):
        _populate_nodes_from_block(state["nodes"], blk)
    return state


def _resolve_node_col(path: dict):
    """Return (node_key, col_key) for a prop_set path. col_key may be None."""
    kind = path["kind"]
    if kind == PATH_KIND.NODE_COL:
        return str(path["nid"]), path["colId"]
    elif kind == PATH_KIND.NODE:
        return str(path["nid"]), None
    elif kind == PATH_KIND.NODE_PROP:
        return str(path["nid"]), path.get("prop")
    else:
        raise ValueError(f"prop_set: path kind {kind} is not a valid node address")


def apply_op(state: dict, op: dict) -> dict:
    """Apply a single op to an AST state. Returns a new state (deep-copied)."""
    state = copy.deepcopy(state)
    op_code = op["op"]

    if op_code == OP.NODE_INSERT:
        _populate_nodes_from_block(state["nodes"], op["block"])

    elif op_code == OP.NODE_DELETE:
        for nid in (op.get("nids") or []):
            key = str(nid)
            descendants = _collect_descendants(state["nodes"], key)
            state["nodes"].pop(key, None)
            for dk in descendants:
                state["nodes"].pop(dk, None)

    elif op_code == OP.NODE_MOVE:
        key = str(op["nid"])
        node = state["nodes"].get(key)
        if node is None:
            raise ValueError(f"element_not_found: node {key} not found")
        new_parent = op["newParentNid"]
        # newParentNid == 0 means make root
        if int(new_parent) == 0:
            node["parentNid"] = None
        else:
            node["parentNid"] = int(new_parent)
        node["childIndex"] = int(op["newChildIndex"]) & 0xFFFFFFFF

    elif op_code == OP.PROP_SET:
        node_key, col_key = _resolve_node_col(op["path"])
        node = state["nodes"].get(node_key)
        if node is None:
            raise ValueError(f"element_not_found: node {node_key} not found")
        is_null = bool(op.get("isNull", False))
        if is_null:
            if col_key is not None:
                node["props"].pop(col_key, None)
        else:
            if col_key is not None:
                node["props"][col_key] = {"ctype": op["ctype"], "value": op["value"]}

    elif op_code == OP.KIND_RENAME:
        old_kind = op.get("oldKind") or ""
        new_kind = op.get("newKind") or ""
        for node in state["nodes"].values():
            if node["kind"] == old_kind:
                node["kind"] = new_kind

    elif op_code == OP.SUBTREE_REPLACE:
        key = str(op["rootNid"])
        # Delete descendants (keep root node itself)
        descendants = _collect_descendants(state["nodes"], key)
        for dk in descendants:
            state["nodes"].pop(dk, None)
        # Insert replacement subtree
        _populate_nodes_from_block(state["nodes"], op["block"])

    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")

    return state


def apply_chain(state: dict, ops: list) -> dict:
    """Apply a list of ops sequentially."""
    for op in ops:
        state = apply_op(state, op)
    return state
