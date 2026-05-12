"""weavepack-graph — pure-Python decoder (graph documents + delta chains).

Profile isolation: imports only from .types. No JSON/tensor/wire/tabular/log profile code.
"""

import struct
from .types import (
    CTYPE, OP, PATH_KIND,
    BLOCK_TYPE_NODE, BLOCK_TYPE_EDGE,
    GRAPH_VERSION, PROFILE_NUM,
    SCHEMA_HASH_BYTES, MAX_STRING_BYTES,
    null_bitmap_bytes, get_null_bit,
)


class _ByteReader:
    def __init__(self, buf: bytes):
        self._buf = bytes(buf)
        self._pos = 0

    def eof(self) -> bool:
        return self._pos >= len(self._buf)

    def read_byte(self) -> int:
        if self._pos >= len(self._buf):
            raise ValueError("unexpected end of input")
        b = self._buf[self._pos]
        self._pos += 1
        return b

    def read_bytes(self, n: int) -> bytes:
        if self._pos + n > len(self._buf):
            raise ValueError("unexpected end of input")
        out = self._buf[self._pos:self._pos + n]
        self._pos += n
        return out

    def read_leb128(self) -> int:
        result = 0
        shift = 0
        while True:
            b = self.read_byte()
            result |= (b & 0x7F) << shift
            shift += 7
            if (b & 0x80) == 0:
                break
            if shift >= 35:
                raise ValueError("LEB128 overflow for uint32")
        return result & 0xFFFFFFFF

    def read_leb128_big(self) -> int:
        result = 0
        shift = 0
        while True:
            b = self.read_byte()
            result |= (b & 0x7F) << shift
            shift += 7
            if (b & 0x80) == 0:
                break
            if shift >= 70:
                raise ValueError("LEB128 overflow for uint64")
        return result

    def read_uint64_le(self) -> int:
        raw = self.read_bytes(8)
        lo, hi = struct.unpack("<II", raw)
        return lo | (hi << 32)


def _read_value(r: _ByteReader, ctype: int):
    if ctype == CTYPE.BOOL:
        return r.read_byte() != 0
    elif ctype == CTYPE.INT8:
        b = r.read_byte()
        return b - 256 if b > 127 else b
    elif ctype == CTYPE.INT16:
        raw = r.read_bytes(2)
        u = raw[0] | (raw[1] << 8)
        return u - 0x10000 if u > 0x7FFF else u
    elif ctype == CTYPE.INT32:
        raw = r.read_bytes(4)
        u = struct.unpack("<I", raw)[0]
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    elif ctype in (CTYPE.INT64, CTYPE.TIMESTAMP64):
        u = r.read_uint64_le()
        return u - (1 << 64) if u > 0x7FFFFFFFFFFFFFFF else u
    elif ctype == CTYPE.UINT8:
        return r.read_byte()
    elif ctype == CTYPE.UINT16:
        raw = r.read_bytes(2)
        return raw[0] | (raw[1] << 8)
    elif ctype == CTYPE.UINT32:
        raw = r.read_bytes(4)
        return struct.unpack("<I", raw)[0]
    elif ctype in (CTYPE.UINT64, CTYPE.NODE_ID):
        return r.read_uint64_le()
    elif ctype == CTYPE.FLOAT32:
        raw = r.read_bytes(4)
        return struct.unpack("<f", raw)[0]
    elif ctype == CTYPE.FLOAT64:
        raw = r.read_bytes(8)
        return struct.unpack("<d", raw)[0]
    elif ctype == CTYPE.STRING:
        length = r.read_leb128()
        if length > MAX_STRING_BYTES:
            raise ValueError("string_too_large: string exceeds limit")
        raw = r.read_bytes(length)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("invalid_utf8: string column contains invalid UTF-8")
    elif ctype == CTYPE.BYTES:
        length = r.read_leb128()
        if length > MAX_STRING_BYTES:
            raise ValueError("string_too_large: bytes exceeds limit")
        return r.read_bytes(length)
    elif ctype == CTYPE.DATE32:
        raw = r.read_bytes(4)
        u = struct.unpack("<I", raw)[0]
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    else:
        raise ValueError(f"unknown_ctype: ctype {ctype}")


def _read_bool_column(r: _ByteReader, count: int) -> list:
    n_bytes = (count + 7) // 8
    raw = r.read_bytes(n_bytes)
    return [bool((raw[i >> 3] >> (i & 7)) & 1) for i in range(count)]


def _read_value_column(r: _ByteReader, ctype: int, count: int) -> list:
    if ctype == CTYPE.BOOL:
        return _read_bool_column(r, count)
    return [_read_value(r, ctype) for _ in range(count)]


def _read_nullable_column(r: _ByteReader, ctype: int, num_elems: int) -> list:
    n_bytes = null_bitmap_bytes(num_elems)
    raw = r.read_bytes(n_bytes)
    rem = num_elems & 7
    if rem != 0:
        last = raw[n_bytes - 1]
        mask = 0xFF >> rem
        if last & mask:
            raise ValueError("invalid_null_bitmap: padding bits must be zero")
    null_flags = [get_null_bit(raw, i) for i in range(num_elems)]
    non_null_count = sum(1 for b in null_flags if not b)
    non_null_values = _read_value_column(r, ctype, non_null_count)
    values = []
    vi = 0
    for is_null in null_flags:
        if is_null:
            values.append(None)
        else:
            values.append(non_null_values[vi])
            vi += 1
    return values


def _read_id_delta_column(r: _ByteReader, count: int) -> list:
    if count == 0:
        return []
    first = r.read_leb128_big()
    ids = [first]
    prev = first
    for _ in range(1, count):
        delta = r.read_leb128_big()
        if delta < 1:
            raise ValueError("duplicate_element_id: id delta must be >=1")
        prev = prev + delta
        ids.append(prev)
    return ids


def _read_plain_uint64_column(r: _ByteReader, count: int) -> list:
    return [r.read_uint64_le() for _ in range(count)]


def _read_prop_col_schema(r: _ByteReader, min_col_id: int) -> dict:
    col_id = r.read_leb128()
    if col_id < min_col_id:
        raise ValueError(f"reserved_col_id: col_id {col_id} is reserved (must be >= {min_col_id})")
    type_byte = r.read_byte()
    ctype = type_byte & 0xF
    nullable = ((type_byte >> 4) & 1) == 1
    if ctype > 15:
        raise ValueError(f"unknown_ctype: ctype {ctype} >= 16 is reserved")
    return {"colId": col_id, "ctype": ctype, "nullable": nullable}


def _read_node_block(r: _ByteReader) -> dict:
    num_nodes = r.read_leb128_big()
    label_len = r.read_leb128()
    label = r.read_bytes(label_len).decode("utf-8") if label_len > 0 else None
    num_cols = r.read_leb128()
    schemas = [_read_prop_col_schema(r, 2) for _ in range(num_cols)]

    nids = _read_id_delta_column(r, num_nodes)
    columns = []
    for s in schemas:
        if s["nullable"]:
            values = _read_nullable_column(r, s["ctype"], num_nodes)
        else:
            values = _read_value_column(r, s["ctype"], num_nodes)
        columns.append({**s, "values": values})

    return {"type": "node", "label": label, "nids": nids, "columns": columns}


def _read_edge_block(r: _ByteReader) -> dict:
    num_edges = r.read_leb128_big()
    label_len = r.read_leb128()
    label = r.read_bytes(label_len).decode("utf-8") if label_len > 0 else None
    num_cols = r.read_leb128()
    schemas = [_read_prop_col_schema(r, 4) for _ in range(num_cols)]

    eids = _read_id_delta_column(r, num_edges)
    srcs = _read_plain_uint64_column(r, num_edges)
    dsts = _read_plain_uint64_column(r, num_edges)
    columns = []
    for s in schemas:
        if s["nullable"]:
            values = _read_nullable_column(r, s["ctype"], num_edges)
        else:
            values = _read_value_column(r, s["ctype"], num_edges)
        columns.append({**s, "values": values})

    return {"type": "edge", "label": label, "eids": eids, "srcs": srcs, "dsts": dsts, "columns": columns}


def _read_doc_header(r: _ByteReader) -> dict:
    version = r.read_leb128()
    if version != GRAPH_VERSION:
        raise ValueError(f"unsupported_version: expected graph_version {GRAPH_VERSION}, got {version}")
    profile_id = r.read_leb128()
    if profile_id != PROFILE_NUM:
        raise ValueError(f"wrong_profile: expected profile_id {PROFILE_NUM}, got {profile_id}")
    schema_hash = r.read_bytes(SCHEMA_HASH_BYTES)
    return {"schemaHash": schema_hash}


# ── Public: graph document (snapshot) ─────────────────────────────────────────


def decode_graph(data: bytes) -> dict:
    """Decode a graph document.

    Returns { 'schemaHash': bytes, 'blocks': [...] }.
    """
    r = _ByteReader(data)
    header = _read_doc_header(r)
    num_blocks = r.read_leb128()
    blocks = []
    for _ in range(num_blocks):
        block_type = r.read_byte()
        if block_type == BLOCK_TYPE_NODE:
            blocks.append(_read_node_block(r))
        elif block_type == BLOCK_TYPE_EDGE:
            blocks.append(_read_edge_block(r))
        else:
            raise ValueError(f"unknown_block_type: block type {block_type}")
    return {"schemaHash": header["schemaHash"], "blocks": blocks}


# ── Path decoding ──────────────────────────────────────────────────────────────


def _read_path(r: _ByteReader) -> dict:
    path_byte = r.read_byte()
    kind = (path_byte >> 4) & 0xF
    if kind == 15:
        raise ValueError("unknown_path_kind: path kind 15 is reserved")

    if kind == PATH_KIND.NODE:
        return {"kind": kind, "nid": r.read_leb128_big()}
    elif kind == PATH_KIND.NODE_COL:
        return {"kind": kind, "nid": r.read_leb128_big(), "colId": r.read_leb128()}
    elif kind == PATH_KIND.EDGE:
        return {"kind": kind, "eid": r.read_leb128_big()}
    elif kind == PATH_KIND.EDGE_COL:
        return {"kind": kind, "eid": r.read_leb128_big(), "colId": r.read_leb128()}
    elif kind == PATH_KIND.NODE_LABEL:
        length = r.read_leb128()
        label = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "label": label}
    elif kind == PATH_KIND.NODE_LABEL_COL:
        length = r.read_leb128()
        label = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "label": label, "colId": r.read_leb128()}
    elif kind == PATH_KIND.EDGE_LABEL:
        length = r.read_leb128()
        label = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "label": label}
    elif kind == PATH_KIND.EDGE_LABEL_COL:
        length = r.read_leb128()
        label = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "label": label, "colId": r.read_leb128()}
    elif kind == PATH_KIND.AT_NID:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_EID:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_SRC:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_DST:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_LABEL:
        length = r.read_leb128()
        label = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "label": label}
    elif kind == PATH_KIND.NODE_PROP:
        nid = r.read_leb128_big()
        length = r.read_leb128()
        prop = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "nid": nid, "prop": prop}
    elif kind == PATH_KIND.EDGE_PROP:
        eid = r.read_leb128_big()
        length = r.read_leb128()
        prop = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "eid": eid, "prop": prop}
    else:
        raise ValueError(f"unknown_path_kind: path kind {kind}")


# ── Op decoding ────────────────────────────────────────────────────────────────


def _read_op(r: _ByteReader) -> dict:
    op_byte = r.read_byte()
    op_code = op_byte & 0x7
    if op_code > 5:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved (must be 0-5)")

    if op_code == OP.NODE_INSERT:
        return {"op": op_code, "block": _read_node_block(r)}
    elif op_code == OP.NODE_DELETE:
        count = r.read_leb128_big()
        nids = [r.read_leb128_big() for _ in range(count)]
        return {"op": op_code, "nids": nids}
    elif op_code == OP.EDGE_INSERT:
        return {"op": op_code, "block": _read_edge_block(r)}
    elif op_code == OP.EDGE_DELETE:
        count = r.read_leb128_big()
        eids = [r.read_leb128_big() for _ in range(count)]
        return {"op": op_code, "eids": eids}
    elif op_code == OP.PROP_SET:
        path = _read_path(r)
        ctype_byte = r.read_byte()
        ctype = ctype_byte & 0xF
        flags_byte = r.read_byte()
        nullable = (flags_byte & 1) == 1
        is_null = ((flags_byte >> 1) & 1) == 1
        value = None if is_null else _read_value(r, ctype)
        return {"op": op_code, "path": path, "ctype": ctype, "nullable": nullable,
                "isNull": is_null, "value": value}
    elif op_code == OP.SUBGRAPH_REPLACE:
        flags = r.read_byte()
        has_node = (flags & 1) == 1
        has_edge = ((flags >> 1) & 1) == 1
        label_len = r.read_leb128()
        label = r.read_bytes(label_len).decode("utf-8") if label_len > 0 else None
        node_block = _read_node_block(r) if has_node else None
        edge_block = _read_edge_block(r) if has_edge else None
        return {"op": op_code, "label": label, "nodeBlock": node_block, "edgeBlock": edge_block}
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")


# ── Public: delta chain ─────────────────────────────────────────────────────────


def decode_chain(data: bytes) -> dict:
    """Decode a delta chain.

    Returns { 'schemaHash': bytes, 'ops': list }.
    """
    r = _ByteReader(data)
    header = _read_doc_header(r)
    num_ops = r.read_leb128()
    ops = [_read_op(r) for _ in range(num_ops)]
    return {"schemaHash": header["schemaHash"], "ops": ops}
