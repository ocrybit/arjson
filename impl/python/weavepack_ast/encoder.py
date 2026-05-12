"""weavepack-ast — pure-Python encoder (AST documents + delta chains).

Profile isolation: imports only from .types.

Wire format:
  AST document (snapshot):
    ast_version  : LEB128 uint32 = 1
    profile_id   : LEB128 uint32 = 7
    schema_hash  : 32 bytes
    num_blocks   : LEB128 uint32
    block[*]     : 1-byte block_type (0=node_block, 1=mixed_block) + payload

  Delta chain:
    ast_version  : LEB128 uint32 = 1
    profile_id   : LEB128 uint32 = 7
    schema_hash  : 32 bytes
    num_ops      : LEB128 uint32
    op[*]        : 1-byte (op_code & 0x7) + op-specific payload

Node block payload:
  kind_len  : LEB128 (0 = mixed_block)
  kind      : UTF-8 bytes (kind_len bytes)
  num_nodes : LEB128
  num_cols  : LEB128
  col schemas: [LEB128 col_id, 1-byte (nullable<<4)|ctype] × num_cols
  nid_col   : delta-packed LEB128 uint64
  parent_nid: MSB-first null bitmap + plain LE uint64 per non-null
  child_idx : LEB128 uint32 per value
  (mixed only) kind_col: [LEB128 len + UTF-8] per row
  user_cols : data per schema

Op encoding:
  node_insert   : op_byte + block_type + block_payload
  node_delete   : op_byte + LEB128(count) + [LEB128 nid] (NOT delta-packed)
  node_move     : op_byte + LEB128(nid) + LEB128(new_parent_nid) + LEB128(new_child_index)
  prop_set      : op_byte + path + ctype_byte + flags_byte + [value]
  kind_rename   : op_byte + LEB128(old_len) + old_kind + LEB128(new_len) + new_kind
  subtree_replace: op_byte + LEB128(root_nid) + block_type + block_payload
"""

import struct
from .types import (
    CTYPE, OP, PATH_KIND,
    BLOCK_TYPE_NODE, BLOCK_TYPE_MIXED,
    AST_VERSION, PROFILE_NUM,
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


def _write_parent_nid_null_bitmap(w: _ByteWriter, parent_nids: list, num_elems: int):
    buf = bytearray(null_bitmap_bytes(num_elems))
    for i in range(num_elems):
        if parent_nids[i] is None:
            set_null_bit(buf, i)
    w.write_bytes(buf)


def _write_value_column(w: _ByteWriter, ctype: int, values: list):
    non_null = [v for v in values if v is not None]
    if ctype == CTYPE.BOOL:
        _write_bool_column(w, non_null)
    else:
        for v in non_null:
            _write_value(w, ctype, v)


def _write_prop_col_schema(w: _ByteWriter, col: dict):
    col_id = col["colId"]
    ctype = col["ctype"]
    nullable = bool(col.get("nullable", False))
    if col_id < 4:
        raise ValueError(f"reserved_col_id: col_id {col_id} is reserved (must be >= 4)")
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


def _write_nid_delta_column(w: _ByteWriter, nids: list):
    if not nids:
        return
    prev = int(nids[0])
    w.write_leb128_big(prev)
    for i in range(1, len(nids)):
        cur = int(nids[i])
        delta = cur - prev
        if delta < 1:
            raise ValueError(
                f"duplicate_element_id: nid delta must be >=1 at index {i}"
            )
        w.write_leb128_big(delta)
        prev = cur


def _write_parent_nid_column(w: _ByteWriter, parent_nids: list):
    _write_parent_nid_null_bitmap(w, parent_nids, len(parent_nids))
    for p in parent_nids:
        if p is not None:
            w.write_uint64_le(int(p))


def _write_child_index_column(w: _ByteWriter, child_indices: list):
    for ci in child_indices:
        w.write_leb128(int(ci))


def _write_kind_column(w: _ByteWriter, kinds: list):
    for k in kinds:
        b = str(k).encode("utf-8")
        w.write_leb128(len(b))
        w.write_bytes(b)


def _write_node_block_payload(w: _ByteWriter, block: dict):
    kind = block.get("kind", "")
    kind_bytes = kind.encode("utf-8") if kind else b""
    w.write_leb128(len(kind_bytes))
    if kind_bytes:
        w.write_bytes(kind_bytes)

    nids = block.get("nids") or []
    parent_nids = block.get("parentNids") or []
    child_indices = block.get("childIndices") or []
    cols = block.get("columns") or []
    num_nodes = len(nids)

    w.write_leb128(num_nodes)
    w.write_leb128(len(cols))
    for col in cols:
        _write_prop_col_schema(w, col)

    _write_nid_delta_column(w, nids)
    _write_parent_nid_column(w, parent_nids)
    _write_child_index_column(w, child_indices)

    for col in cols:
        _write_prop_col_data(w, col, num_nodes)


def _write_mixed_block_payload(w: _ByteWriter, block: dict):
    # kind_len = 0 for mixed
    w.write_leb128(0)

    nids = block.get("nids") or []
    parent_nids = block.get("parentNids") or []
    child_indices = block.get("childIndices") or []
    kinds = block.get("kinds") or []
    cols = block.get("columns") or []
    num_nodes = len(nids)

    w.write_leb128(num_nodes)
    w.write_leb128(len(cols))
    for col in cols:
        _write_prop_col_schema(w, col)

    _write_nid_delta_column(w, nids)
    _write_parent_nid_column(w, parent_nids)
    _write_child_index_column(w, child_indices)
    _write_kind_column(w, kinds)

    for col in cols:
        _write_prop_col_data(w, col, num_nodes)


def _write_block(w: _ByteWriter, block: dict):
    btype = block.get("type")
    if btype == "node":
        w.write_byte(BLOCK_TYPE_NODE)
        _write_node_block_payload(w, block)
    elif btype == "mixed":
        w.write_byte(BLOCK_TYPE_MIXED)
        _write_mixed_block_payload(w, block)
    else:
        raise ValueError(f"unknown block type: {btype}")


def _write_doc_header(w: _ByteWriter, schema_hash):
    w.write_leb128(AST_VERSION)
    w.write_leb128(PROFILE_NUM)
    if schema_hash is None:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    w.write_bytes(schema_hash)


# ── Public: AST document (snapshot) ─────────────────────────────────────────────


def encode_tree(doc: dict) -> bytes:
    """Encode an AST document (snapshot).

    doc = {
        'schemaHash': bytes (32 bytes; omit -> all-zero),
        'blocks': [{'type': 'node'|'mixed', ...block fields}, ...],
    }
    """
    w = _ByteWriter()
    blocks = doc.get("blocks") or []
    _write_doc_header(w, doc.get("schemaHash"))
    w.write_leb128(len(blocks))
    for blk in blocks:
        _write_block(w, blk)
    return w.to_bytes()


# ── Path encoding ──────────────────────────────────────────────────────────


def _write_path(w: _ByteWriter, path: dict):
    kind = path["kind"]
    w.write_byte((kind & 0xF) << 4)

    if kind == PATH_KIND.NODE:
        w.write_leb128_big(int(path["nid"]))
    elif kind == PATH_KIND.NODE_COL:
        w.write_leb128_big(int(path["nid"]))
        w.write_leb128(int(path["colId"]))
    elif kind == PATH_KIND.NODE_KIND:
        b = (path.get("nodeKind") or "").encode("utf-8")
        w.write_leb128(len(b))
        w.write_bytes(b)
    elif kind in (PATH_KIND.AT_NID, PATH_KIND.AT_PARENT, PATH_KIND.AT_CHILD_INDEX, PATH_KIND.AT_KIND):
        pass  # no payload
    elif kind == PATH_KIND.NODE_PROP:
        w.write_leb128_big(int(path["nid"]))
        b = (path.get("prop") or "").encode("utf-8")
        w.write_leb128(len(b))
        w.write_bytes(b)
    else:
        raise ValueError(f"unknown_path_kind: path kind {kind} is reserved (must be 0-7)")


# ── Op encoding ────────────────────────────────────────────────────────────


def _write_op(w: _ByteWriter, op: dict):
    op_code = op["op"]
    w.write_byte(op_code & 0x7)

    if op_code == OP.NODE_INSERT:
        _write_block(w, op["block"])
    elif op_code == OP.NODE_DELETE:
        nids = op.get("nids") or []
        w.write_leb128_big(len(nids))
        for nid in nids:
            w.write_leb128_big(int(nid))
    elif op_code == OP.NODE_MOVE:
        w.write_leb128_big(int(op["nid"]))
        new_parent = op.get("newParentNid")
        w.write_leb128_big(int(new_parent) if new_parent is not None else 0)
        w.write_leb128(int(op.get("newChildIndex", 0)))
    elif op_code == OP.PROP_SET:
        _write_path(w, op["path"])
        ctype = op["ctype"]
        w.write_byte(ctype & 0xF)
        nullable = bool(op.get("nullable", False))
        value = op.get("value")
        is_null = (value is None) and nullable
        w.write_byte((1 if nullable else 0) | ((1 if is_null else 0) << 1))
        if not is_null and value is not None:
            _write_value(w, ctype, value)
    elif op_code == OP.KIND_RENAME:
        old_b = (op.get("oldKind") or "").encode("utf-8")
        w.write_leb128(len(old_b))
        w.write_bytes(old_b)
        new_b = (op.get("newKind") or "").encode("utf-8")
        w.write_leb128(len(new_b))
        w.write_bytes(new_b)
    elif op_code == OP.SUBTREE_REPLACE:
        w.write_leb128_big(int(op["rootNid"]))
        _write_block(w, op["block"])
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved (must be 0-5)")


# ── Public: delta chain ─────────────────────────────────────────────────────


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
