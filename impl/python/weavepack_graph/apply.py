"""weavepack-graph — delta application (init_state, apply_chain).

Graph state:
  {
    'nodes': dict[str, {'label': str|None, 'props': dict[int|str, {'ctype': int, 'value': any}]}],
    'edges': dict[str, {'label': str|None, 'src': int, 'dst': int,
                         'props': dict[int|str, {'ctype': int, 'value': any}]}],
  }

Map keys are str(nid) / str(eid) for consistent identity.

Profile isolation: imports only from .types.
"""

import copy
from .types import OP, PATH_KIND


def _populate_nodes_from_block(nodes: dict, block: dict):
    label = block.get("label")
    nids = block.get("nids") or []
    columns = block.get("columns") or []
    for i, nid in enumerate(nids):
        key = str(nid)
        if key in nodes:
            raise ValueError(f"duplicate_element_id: nid {nid} already exists")
        props = {}
        for col in columns:
            v = col["values"][i]
            if v is not None:
                props[col["colId"]] = {"ctype": col["ctype"], "value": v}
        nodes[key] = {"label": label, "props": props}


def _populate_edges_from_block(edges: dict, block: dict):
    label = block.get("label")
    eids = block.get("eids") or []
    srcs = block.get("srcs") or []
    dsts = block.get("dsts") or []
    columns = block.get("columns") or []
    for i, eid in enumerate(eids):
        key = str(eid)
        if key in edges:
            raise ValueError(f"duplicate_element_id: eid {eid} already exists")
        props = {}
        for col in columns:
            v = col["values"][i]
            if v is not None:
                props[col["colId"]] = {"ctype": col["ctype"], "value": v}
        edges[key] = {"label": label, "src": srcs[i], "dst": dsts[i], "props": props}


def init_state(graph: dict) -> dict:
    """Build initial state from a decoded graph document."""
    state = {"nodes": {}, "edges": {}}
    for blk in (graph.get("blocks") or []):
        if blk.get("type") == "node":
            _populate_nodes_from_block(state["nodes"], blk)
        elif blk.get("type") == "edge":
            _populate_edges_from_block(state["edges"], blk)
    return state


def _resolve_element(state: dict, path: dict):
    """Return (element_dict, key, is_node, col_key) for a prop_set path."""
    kind = path["kind"]
    if kind == PATH_KIND.NODE_COL:
        key = str(path["nid"])
        return state["nodes"].get(key), key, True, path["colId"]
    elif kind == PATH_KIND.EDGE_COL:
        key = str(path["eid"])
        return state["edges"].get(key), key, False, path["colId"]
    elif kind == PATH_KIND.NODE:
        key = str(path["nid"])
        return state["nodes"].get(key), key, True, None
    elif kind == PATH_KIND.EDGE:
        key = str(path["eid"])
        return state["edges"].get(key), key, False, None
    elif kind == PATH_KIND.NODE_PROP:
        key = str(path["nid"])
        return state["nodes"].get(key), key, True, path.get("prop")
    elif kind == PATH_KIND.EDGE_PROP:
        key = str(path["eid"])
        return state["edges"].get(key), key, False, path.get("prop")
    else:
        raise ValueError(
            f"prop_set: path kind {kind} is not a valid element address for prop_set"
        )


def apply_op(state: dict, op: dict) -> dict:
    """Apply a single op to a graph state. Returns a new state (deep-copied)."""
    state = copy.deepcopy(state)
    op_code = op["op"]

    if op_code == OP.NODE_INSERT:
        _populate_nodes_from_block(state["nodes"], op["block"])

    elif op_code == OP.NODE_DELETE:
        for nid in (op.get("nids") or []):
            key = str(int(nid))
            state["nodes"].pop(key, None)
            nid_int = int(nid)
            for ek in list(state["edges"]):
                ev = state["edges"][ek]
                if ev["src"] == nid_int or ev["dst"] == nid_int:
                    del state["edges"][ek]

    elif op_code == OP.EDGE_INSERT:
        _populate_edges_from_block(state["edges"], op["block"])

    elif op_code == OP.EDGE_DELETE:
        for eid in (op.get("eids") or []):
            state["edges"].pop(str(int(eid)), None)

    elif op_code == OP.PROP_SET:
        target, key, is_node, col_key = _resolve_element(state, op["path"])
        if target is None:
            elem_type = "node" if is_node else "edge"
            raise ValueError(f"element_not_found: {elem_type} {key} not found")
        is_null = op.get("isNull", False)
        if is_null:
            if col_key is not None:
                target["props"].pop(col_key, None)
        else:
            if col_key is not None:
                target["props"][col_key] = {"ctype": op["ctype"], "value": op.get("value")}

    elif op_code == OP.SUBGRAPH_REPLACE:
        label = op.get("label")
        for k in list(state["nodes"]):
            if state["nodes"][k]["label"] == label:
                del state["nodes"][k]
        for k in list(state["edges"]):
            if state["edges"][k]["label"] == label:
                del state["edges"][k]
        if op.get("nodeBlock") is not None:
            _populate_nodes_from_block(state["nodes"], op["nodeBlock"])
        if op.get("edgeBlock") is not None:
            _populate_edges_from_block(state["edges"], op["edgeBlock"])

    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")

    return state


def apply_chain(state: dict, ops: list) -> dict:
    """Apply a list of ops in order. Returns the final graph state."""
    for op in ops:
        state = apply_op(state, op)
    return state
