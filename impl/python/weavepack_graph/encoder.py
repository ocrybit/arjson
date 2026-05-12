"""weavepack-graph — pure-Python encoder (graph documents + delta chains).

Profile isolation: imports only from .types. No JSON/tensor/wire/tabular/log profile code.

Wire format:
  Graph document (snapshot):
    graph_version  : LEB128 uint32 = 1
    profile_id     : LEB128 uint32 = 6
    schema_hash    : 32 bytes
    num_blocks     : LEB128 uint32
    block[*]       : 1-byte block_type (0=node, 1=edge) + block payload

  Delta chain:
    graph_version  : LEB128 uint32 = 1
    profile_id     : LEB128 uint32 = 6
    schema_hash    : 32 bytes
    num_ops        : LEB128 uint32
    op[*]          : 1-byte op_code (low 3 bits) + op-specific payload

Column type_byte: (nullable << 4) | (ctype & 0xF)   [4-bit ctype, graph-profile specific]
Bool column: LSB-first (bit i in byte[i>>3] at position i&7).
Null bitmap: MSB-first (bit i set = NULL at index i).
NID/EID: delta-packed LEB128 uint64. SRC/DST: plain LE uint64.
"""

import struct
from .types import (
    CTYPE, OP, PATH_KIND,
    BLOCK_TYPE_NODE, BLOCK_TYPE_EDGE,
    GRAPH_VERSION, PROFILE_NUM,
    SCHEMA_HASH_BYTES, MAX_STRING_BYTES,
    null_bitmap_bytes, set_null_bit,
)


class _ByteWriter:
    def __init__(self):
        self._buf = bytearray()

    def write_byte(self, b: int):
        self._buf.append(b & 0xFF)

    def write_bytes(self, src):
        self._buf.extend(src)

    def write_leb128(self, v: int):
        v = int(v) & 0xFFFFFFFF
        while v >= 128:
            self._buf.append((v & 0x7F) | 0x80)
            v >>= 7
        self._buf.append(v)

    def write_leb128_big(self, v: int):
        v = int(v)
        while v >= 128:
            self._buf.append((v & 0x7F) | 0x80)
            v >>= 7
        self._buf.append(v)

    def write_uint64_le(self, v: int):
        v = int(v) & 0xFFFFFFFFFFFFFFFF
        lo = v & 0xFFFFFFFF
        hi = (v >> 32) & 0xFFFFFFFF
        self._buf.extend(struct.pack("<II", lo, hi))

    def to_bytes(self) -> bytes:
        return bytes(self._buf)


def _write_value(w: _ByteWriter, ctype: int, value):
    if ctype == CTYPE.BOOL:
        w.write_byte(1 if value else 0)
    elif ctype == CTYPE.INT8:
        v = int(value)
        w.write_byte(v + 256 if v < 0 else v)
    elif ctype == CTYPE.INT16:
        v = int(value)
        u = v + 65536 if v < 0 else v
        w.write_byte(u & 0xFF)
        w.write_byte((u >> 8) & 0xFF)
    elif ctype == CTYPE.INT32:
        v = int(value)
        u = v + 0x100000000 if v < 0 else v
        w.write_bytes(struct.pack("<I", u & 0xFFFFFFFF))
    elif ctype in (CTYPE.INT64, CTYPE.TIMESTAMP64):
        v = int(value)
        u = v + (1 << 64) if v < 0 else v
        w.write_uint64_le(u)
    elif ctype == CTYPE.UINT8:
        w.write_byte(int(value) & 0xFF)
    elif ctype == CTYPE.UINT16:
        v = int(value) & 0xFFFF
        w.write_byte(v & 0xFF)
        w.write_byte((v >> 8) & 0xFF)
    elif ctype == CTYPE.UINT32:
        v = int(value) & 0xFFFFFFFF
        w.write_bytes(struct.pack("<I", v))
    elif ctype in (CTYPE.UINT64, CTYPE.NODE_ID):
        w.write_uint64_le(int(value))
    elif ctype == CTYPE.FLOAT32:
        w.write_bytes(struct.pack("<f", float(value)))
    elif ctype == CTYPE.FLOAT64:
        w.write_bytes(struct.pack("<d", float(value)))
    elif ctype == CTYPE.STRING:
        b = str(value).encode("utf-8")
        if len(b) > MAX_STRING_BYTES:
            raise ValueError("string_too_large: string exceeds limit")
        w.write_leb128(len(b))
        w.write_bytes(b)
    elif ctype == CTYPE.BYTES:
        b = bytes(value)
        if len(b) > MAX_STRING_BYTES:
            raise ValueError("string_too_large: bytes exceeds limit")
        w.write_leb128(len(b))
        w.write_bytes(b)
    elif ctype == CTYPE.DATE32:
        v = int(value)
        u = v + 0x100000000 if v < 0 else v
        w.write_bytes(struct.pack("<I", u & 0xFFFFFFFF))
    else:
        raise ValueError(f"unknown_ctype: ctype {ctype}")


def _write_bool_column(w: _ByteWriter, values: list):
    n = len(values)
    buf = bytearray((n + 7) // 8)
    for i, v in enumerate(values):
        if v:
            buf[i >> 3] |= (1 << (i & 7))
    w.write_bytes(buf)


def _write_null_bitmap(w: _ByteWriter, values: list, num_elems: int):
    buf = bytearray(null_bitmap_bytes(num_elems))
    for i in range(num_elems):
        if values[i] is None:
            set_null_bit(buf, i)
    w.write_bytes(buf)


def _write_value_column(w: _ByteWriter, ctype: int, values: list):
    non_null = [v for v in values if v is not None]
    if ctype == CTYPE.BOOL:
        _write_bool_column(w, non_null)
    else:
        for v in non_null:
            _write_value(w, ctype, v)


def _write_prop_col_schema(w: _ByteWriter, col: dict, min_col_id: int):
    col_id = col["colId"]
    ctype = col["ctype"]
    nullable = bool(col.get("nullable", False))
    if col_id < min_col_id:
        raise ValueError(f"reserved_col_id: col_id {col_id} is reserved (must be >= {min_col_id})")
    if ctype > 15:
        raise ValueError(f"unknown_ctype: ctype {ctype} >= 16 is reserved")
    w.write_leb128(col_id)
    w.write_byte(((1 if nullable else 0) << 4) | (ctype & 0xF))


def _write_prop_col_data(w: _ByteWriter, col: dict, num_elems: int):
    values = col["values"]
    if len(values) != num_elems:
        raise ValueError(
            f"column {col['colId']} has {len(values)} values but block has {num_elems} elements"
        )
    nullable = bool(col.get("nullable", False))
    ctype = col["ctype"]
    if nullable:
        _write_null_bitmap(w, values, num_elems)
    _write_value_column(w, ctype, values)


def _write_id_delta_column(w: _ByteWriter, ids: list):
    if not ids:
        return
    prev = int(ids[0])
    w.write_leb128_big(prev)
    for i in range(1, len(ids)):
        cur = int(ids[i])
        delta = cur - prev
        if delta < 1:
            raise ValueError(
                f"duplicate_element_id: id delta must be >=1; got {delta} at index {i}"
            )
        w.write_leb128_big(delta)
        prev = cur


def _write_plain_uint64_column(w: _ByteWriter, values: list):
    for v in values:
        w.write_uint64_le(int(v))


def _write_node_block(w: _ByteWriter, block: dict):
    nids = block.get("nids") or []
    cols = block.get("columns") or []
    num_nodes = len(nids)

    label = block.get("label")
    label_bytes = label.encode("utf-8") if label else b""
    w.write_leb128_big(num_nodes)
    w.write_leb128(len(label_bytes))
    if label_bytes:
        w.write_bytes(label_bytes)

    w.write_leb128(len(cols))
    for col in cols:
        _write_prop_col_schema(w, col, 2)

    _write_id_delta_column(w, nids)

    for col in cols:
        _write_prop_col_data(w, col, num_nodes)


def _write_edge_block(w: _ByteWriter, block: dict):
    eids = block.get("eids") or []
    srcs = block.get("srcs") or []
    dsts = block.get("dsts") or []
    cols = block.get("columns") or []
    num_edges = len(eids)

    if len(srcs) != num_edges:
        raise ValueError(f"srcs length ({len(srcs)}) must equal eids length ({num_edges})")
    if len(dsts) != num_edges:
        raise ValueError(f"dsts length ({len(dsts)}) must equal eids length ({num_edges})")

    label = block.get("label")
    label_bytes = label.encode("utf-8") if label else b""
    w.write_leb128_big(num_edges)
    w.write_leb128(len(label_bytes))
    if label_bytes:
        w.write_bytes(label_bytes)

    w.write_leb128(len(cols))
    for col in cols:
        _write_prop_col_schema(w, col, 4)

    _write_id_delta_column(w, eids)
    _write_plain_uint64_column(w, srcs)
    _write_plain_uint64_column(w, dsts)

    for col in cols:
        _write_prop_col_data(w, col, num_edges)


def _write_doc_header(w: _ByteWriter, schema_hash):
    w.write_leb128(GRAPH_VERSION)
    w.write_leb128(PROFILE_NUM)
    if schema_hash is None:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    w.write_bytes(schema_hash)


# ── Public: graph document (snapshot) ─────────────────────────────────────────


def encode_graph(graph: dict) -> bytes:
    """Encode a graph document (snapshot).

    graph = {
        'schemaHash': bytes (32 bytes; omit -> all-zero),
        'blocks': [{'type': 'node'|'edge', ...block fields}, ...],
    }
    """
    w = _ByteWriter()
    blocks = graph.get("blocks") or []
    _write_doc_header(w, graph.get("schemaHash"))
    w.write_leb128(len(blocks))
    for blk in blocks:
        if blk.get("type") == "node":
            w.write_byte(BLOCK_TYPE_NODE)
            _write_node_block(w, blk)
        elif blk.get("type") == "edge":
            w.write_byte(BLOCK_TYPE_EDGE)
            _write_edge_block(w, blk)
        else:
            raise ValueError(f"unknown block type: {blk.get('type')}")
    return w.to_bytes()


# ── Path encoding (for prop_set) ───────────────────────────────────────────────


def _write_path(w: _ByteWriter, path: dict):
    kind = path["kind"]
    if kind == 15:
        raise ValueError("unknown_path_kind: path kind 15 is reserved")
    w.write_byte((kind & 0xF) << 4)

    if kind == PATH_KIND.NODE:
        w.write_leb128_big(int(path["nid"]))
    elif kind == PATH_KIND.NODE_COL:
        w.write_leb128_big(int(path["nid"]))
        w.write_leb128(int(path["colId"]))
    elif kind == PATH_KIND.EDGE:
        w.write_leb128_big(int(path["eid"]))
    elif kind == PATH_KIND.EDGE_COL:
        w.write_leb128_big(int(path["eid"]))
        w.write_leb128(int(path["colId"]))
    elif kind == PATH_KIND.NODE_LABEL:
        lb = (path.get("label") or "").encode("utf-8")
        w.write_leb128(len(lb))
        w.write_bytes(lb)
    elif kind == PATH_KIND.NODE_LABEL_COL:
        lb = (path.get("label") or "").encode("utf-8")
        w.write_leb128(len(lb))
        w.write_bytes(lb)
        w.write_leb128(int(path["colId"]))
    elif kind == PATH_KIND.EDGE_LABEL:
        lb = (path.get("label") or "").encode("utf-8")
        w.write_leb128(len(lb))
        w.write_bytes(lb)
    elif kind == PATH_KIND.EDGE_LABEL_COL:
        lb = (path.get("label") or "").encode("utf-8")
        w.write_leb128(len(lb))
        w.write_bytes(lb)
        w.write_leb128(int(path["colId"]))
    elif kind in (PATH_KIND.AT_NID, PATH_KIND.AT_EID, PATH_KIND.AT_SRC, PATH_KIND.AT_DST):
        pass  # no payload
    elif kind == PATH_KIND.AT_LABEL:
        lb = (path.get("label") or "").encode("utf-8")
        w.write_leb128(len(lb))
        w.write_bytes(lb)
    elif kind == PATH_KIND.NODE_PROP:
        lb = (path.get("prop") or "").encode("utf-8")
        w.write_leb128_big(int(path["nid"]))
        w.write_leb128(len(lb))
        w.write_bytes(lb)
    elif kind == PATH_KIND.EDGE_PROP:
        lb = (path.get("prop") or "").encode("utf-8")
        w.write_leb128_big(int(path["eid"]))
        w.write_leb128(len(lb))
        w.write_bytes(lb)
    else:
        raise ValueError(f"unknown_path_kind: path kind {kind}")


# ── Op encoding ─────────────────────────────────────────────────────────────────


def _write_op(w: _ByteWriter, op: dict):
    op_code = op["op"]
    if op_code > 5:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved (must be 0-5)")
    w.write_byte(op_code & 0x7)

    if op_code == OP.NODE_INSERT:
        _write_node_block(w, op["block"])
    elif op_code == OP.NODE_DELETE:
        nids = op.get("nids") or []
        w.write_leb128_big(len(nids))
        for nid in nids:
            w.write_leb128_big(int(nid))
    elif op_code == OP.EDGE_INSERT:
        _write_edge_block(w, op["block"])
    elif op_code == OP.EDGE_DELETE:
        eids = op.get("eids") or []
        w.write_leb128_big(len(eids))
        for eid in eids:
            w.write_leb128_big(int(eid))
    elif op_code == OP.PROP_SET:
        _write_path(w, op["path"])
        ctype = op["ctype"]
        w.write_byte(ctype & 0xF)
        nullable = bool(op.get("nullable", False))
        value = op.get("value")
        is_null = (value is None) and nullable
        w.write_byte((1 if nullable else 0) | ((1 if is_null else 0) << 1))
        if not is_null:
            _write_value(w, ctype, value)
    elif op_code == OP.SUBGRAPH_REPLACE:
        node_block = op.get("nodeBlock")
        edge_block = op.get("edgeBlock")
        has_node = 1 if node_block is not None else 0
        has_edge = 1 if edge_block is not None else 0
        w.write_byte((has_node & 1) | ((has_edge & 1) << 1))
        label = op.get("label")
        label_bytes = label.encode("utf-8") if label else b""
        w.write_leb128(len(label_bytes))
        if label_bytes:
            w.write_bytes(label_bytes)
        if has_node:
            _write_node_block(w, node_block)
        if has_edge:
            _write_edge_block(w, edge_block)
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")


# ── Public: delta chain ─────────────────────────────────────────────────────────


def encode_chain(schema_hash: bytes, ops: list) -> bytes:
    """Encode a delta chain.

    schema_hash: bytes (32 bytes; pass bytes(32) for no-schema)
    ops: list of op dicts
    """
    w = _ByteWriter()
    if schema_hash is None:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    _write_doc_header(w, schema_hash)
    w.write_leb128(len(ops))
    for op in ops:
        _write_op(w, op)
    return w.to_bytes()
