"""weavepack-ast — pure-Python decoder (AST documents + delta chains).

Profile isolation: imports only from .types.
"""

import struct
from .types import (
    CTYPE, OP, PATH_KIND,
    BLOCK_TYPE_NODE, BLOCK_TYPE_MIXED,
    AST_VERSION, PROFILE_NUM,
    SCHEMA_HASH_BYTES, MAX_STRING_BYTES,
    null_bitmap_bytes, get_null_bit,
)


class _ByteReader:
    def __init__(self, buf: bytes):
        self._buf = bytes(buf)
        self._pos = 0

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


def _read_nid_delta_column(r: _ByteReader, count: int) -> list:
    if count == 0:
        return []
    first = r.read_leb128_big()
    ids = [first]
    prev = first
    for _ in range(1, count):
        delta = r.read_leb128_big()
        if delta < 1:
            raise ValueError("duplicate_element_id: nid delta must be >=1")
        prev = prev + delta
        ids.append(prev)
    return ids


def _read_parent_nid_column(r: _ByteReader, num_nodes: int) -> list:
    n_bytes = null_bitmap_bytes(num_nodes)
    bitmap = r.read_bytes(n_bytes)
    values = []
    for i in range(num_nodes):
        if get_null_bit(bitmap, i):
            values.append(None)
        else:
            values.append(r.read_uint64_le())
    return values


def _read_child_index_column(r: _ByteReader, count: int) -> list:
    return [r.read_leb128() for _ in range(count)]


def _read_kind_column(r: _ByteReader, count: int) -> list:
    kinds = []
    for _ in range(count):
        length = r.read_leb128()
        kinds.append(r.read_bytes(length).decode("utf-8"))
    return kinds


def _read_prop_col_schema(r: _ByteReader) -> dict:
    col_id = r.read_leb128()
    if col_id < 4:
        raise ValueError(f"reserved_col_id: col_id {col_id} is reserved (must be >= 4)")
    type_byte = r.read_byte()
    ctype = type_byte & 0xF
    nullable = ((type_byte >> 4) & 1) == 1
    if ctype > 15:
        raise ValueError(f"unknown_ctype: ctype {ctype} >= 16 is reserved")
    return {"colId": col_id, "ctype": ctype, "nullable": nullable}


def _read_node_block_payload(r: _ByteReader) -> dict:
    kind_len = r.read_leb128()
    kind = r.read_bytes(kind_len).decode("utf-8") if kind_len > 0 else ""

    num_nodes = r.read_leb128()
    num_cols = r.read_leb128()
    schemas = [_read_prop_col_schema(r) for _ in range(num_cols)]

    nids = _read_nid_delta_column(r, num_nodes)
    parent_nids = _read_parent_nid_column(r, num_nodes)
    child_indices = _read_child_index_column(r, num_nodes)

    columns = []
    for s in schemas:
        if s["nullable"]:
            values = _read_nullable_column(r, s["ctype"], num_nodes)
        else:
            values = _read_value_column(r, s["ctype"], num_nodes)
        columns.append({**s, "values": values})

    return {
        "type": "node", "kind": kind, "nids": nids,
        "parentNids": parent_nids, "childIndices": child_indices,
        "columns": columns,
    }


def _read_mixed_block_payload(r: _ByteReader) -> dict:
    kind_len = r.read_leb128()
    if kind_len > 0:
        r.read_bytes(kind_len)  # discard

    num_nodes = r.read_leb128()
    num_cols = r.read_leb128()
    schemas = [_read_prop_col_schema(r) for _ in range(num_cols)]

    nids = _read_nid_delta_column(r, num_nodes)
    parent_nids = _read_parent_nid_column(r, num_nodes)
    child_indices = _read_child_index_column(r, num_nodes)
    kinds = _read_kind_column(r, num_nodes)

    columns = []
    for s in schemas:
        if s["nullable"]:
            values = _read_nullable_column(r, s["ctype"], num_nodes)
        else:
            values = _read_value_column(r, s["ctype"], num_nodes)
        columns.append({**s, "values": values})

    return {
        "type": "mixed", "kinds": kinds, "nids": nids,
        "parentNids": parent_nids, "childIndices": child_indices,
        "columns": columns,
    }


def _read_block(r: _ByteReader) -> dict:
    block_type = r.read_byte()
    if block_type == BLOCK_TYPE_NODE:
        return _read_node_block_payload(r)
    elif block_type == BLOCK_TYPE_MIXED:
        return _read_mixed_block_payload(r)
    else:
        raise ValueError(f"unknown_block_type: block type {block_type}")


def _read_doc_header(r: _ByteReader) -> bytes:
    version = r.read_leb128()
    if version != AST_VERSION:
        raise ValueError(
            f"unsupported_version: expected ast_version {AST_VERSION}, got {version}"
        )
    profile_id = r.read_leb128()
    if profile_id != PROFILE_NUM:
        raise ValueError(
            f"wrong_profile: expected profile_id {PROFILE_NUM}, got {profile_id}"
        )
    return r.read_bytes(SCHEMA_HASH_BYTES)


# ── Public: AST document (snapshot) ─────────────────────────────────────────────


def decode_tree(data: bytes) -> dict:
    """Decode an AST document.

    Returns { 'schemaHash': bytes, 'blocks': [...] }.
    """
    r = _ByteReader(data)
    schema_hash = _read_doc_header(r)
    num_blocks = r.read_leb128()
    blocks = [_read_block(r) for _ in range(num_blocks)]
    return {"schemaHash": schema_hash, "blocks": blocks}


# ── Path decoding ─────────────────────────────────────────────────────────────


def _read_path(r: _ByteReader) -> dict:
    path_byte = r.read_byte()
    kind = (path_byte >> 4) & 0xF

    if kind == PATH_KIND.NODE:
        return {"kind": kind, "nid": r.read_leb128_big()}
    elif kind == PATH_KIND.NODE_COL:
        return {"kind": kind, "nid": r.read_leb128_big(), "colId": r.read_leb128()}
    elif kind == PATH_KIND.NODE_KIND:
        length = r.read_leb128()
        node_kind = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "nodeKind": node_kind}
    elif kind == PATH_KIND.AT_NID:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_PARENT:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_CHILD_INDEX:
        return {"kind": kind}
    elif kind == PATH_KIND.AT_KIND:
        return {"kind": kind}
    elif kind == PATH_KIND.NODE_PROP:
        nid = r.read_leb128_big()
        length = r.read_leb128()
        prop = r.read_bytes(length).decode("utf-8")
        return {"kind": kind, "nid": nid, "prop": prop}
    else:
        raise ValueError(f"unknown_path_kind: path kind {kind} is reserved (must be 0-7)")


# ── Op decoding ──────────────────────────────────────────────────────────────


def _read_op(r: _ByteReader) -> dict:
    op_byte = r.read_byte()
    op_code = op_byte & 0x7

    if op_code == OP.NODE_INSERT:
        return {"op": op_code, "block": _read_block(r)}
    elif op_code == OP.NODE_DELETE:
        count = r.read_leb128_big()
        nids = [r.read_leb128_big() for _ in range(count)]
        return {"op": op_code, "nids": nids}
    elif op_code == OP.NODE_MOVE:
        nid = r.read_leb128_big()
        new_parent_nid = r.read_leb128_big()
        new_child_index = r.read_leb128()
        return {"op": op_code, "nid": nid, "newParentNid": new_parent_nid,
                "newChildIndex": new_child_index}
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
    elif op_code == OP.KIND_RENAME:
        old_len = r.read_leb128()
        old_kind = r.read_bytes(old_len).decode("utf-8")
        new_len = r.read_leb128()
        new_kind = r.read_bytes(new_len).decode("utf-8")
        return {"op": op_code, "oldKind": old_kind, "newKind": new_kind}
    elif op_code == OP.SUBTREE_REPLACE:
        root_nid = r.read_leb128_big()
        block = _read_block(r)
        return {"op": op_code, "rootNid": root_nid, "block": block}
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved (must be 0-5)")


# ── Public: delta chain ─────────────────────────────────────────────────────


def decode_chain(data: bytes) -> dict:
    """Decode a delta chain.

    Returns { 'schemaHash': bytes, 'ops': list }.
    """
    r = _ByteReader(data)
    schema_hash = _read_doc_header(r)
    num_ops = r.read_leb128()
    ops = [_read_op(r) for _ in range(num_ops)]
    return {"schemaHash": schema_hash, "ops": ops}
