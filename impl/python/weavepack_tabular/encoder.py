"""weavepack-tabular — pure-Python encoder (snapshot frames + delta chains).

Profile isolation: imports only from .types. No JSON/tensor/wire profile code.
"""

import struct
from .types import (
    CTYPE, OP, FRAME_SNAPSHOT, FRAME_DELTA,
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

    def write_int64_le(self, v: int):
        v = int(v)
        if v < 0:
            v = v + (1 << 64)
        lo = v & 0xFFFFFFFF
        hi = (v >> 32) & 0xFFFFFFFF
        self._buf.extend(struct.pack("<II", lo, hi))

    def to_bytes(self) -> bytes:
        return bytes(self._buf)


def _write_row_id_block(w: _ByteWriter, row_ids: list):
    if not row_ids:
        return
    w.write_leb128_big(int(row_ids[0]))
    prev = int(row_ids[0])
    for i in range(1, len(row_ids)):
        cur = int(row_ids[i])
        delta = cur - prev
        if delta < 1:
            raise ValueError(f"row_ids must be strictly ascending; got delta {delta} at index {i}")
        w.write_leb128_big(delta)
        prev = cur


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
    elif ctype == CTYPE.INT64 or ctype == CTYPE.TIMESTAMP64:
        w.write_int64_le(int(value))
    elif ctype == CTYPE.UINT8:
        w.write_byte(int(value) & 0xFF)
    elif ctype == CTYPE.UINT16:
        v = int(value) & 0xFFFF
        w.write_byte(v & 0xFF)
        w.write_byte((v >> 8) & 0xFF)
    elif ctype == CTYPE.UINT32:
        w.write_bytes(struct.pack("<I", int(value) & 0xFFFFFFFF))
    elif ctype == CTYPE.UINT64:
        w.write_int64_le(int(value))
    elif ctype == CTYPE.FLOAT32:
        w.write_bytes(struct.pack("<f", float(value)))
    elif ctype == CTYPE.FLOAT64:
        w.write_bytes(struct.pack("<d", float(value)))
    elif ctype == CTYPE.STRING:
        utf8 = str(value).encode("utf-8")
        if len(utf8) > MAX_STRING_BYTES:
            raise ValueError("string exceeds 256 MiB limit")
        w.write_leb128(len(utf8))
        w.write_bytes(utf8)
    elif ctype == CTYPE.BYTES:
        src = bytes(value)
        if len(src) > MAX_STRING_BYTES:
            raise ValueError("bytes exceeds 256 MiB limit")
        w.write_leb128(len(src))
        w.write_bytes(src)
    elif ctype == CTYPE.DATE32:
        v = int(value)
        u = v + 0x100000000 if v < 0 else v
        w.write_bytes(struct.pack("<I", u & 0xFFFFFFFF))
    elif ctype == CTYPE.EXT:
        raise ValueError("EXT ctype encoding not implemented in v0.1")
    else:
        raise ValueError(f"unknown ctype {ctype}")


def _write_bool_column(w: _ByteWriter, values: list):
    n = len(values)
    bitmap = bytearray((n + 7) // 8)
    for i, v in enumerate(values):
        if v:
            bitmap[i >> 3] |= (1 << (7 - (i & 7)))
    w.write_bytes(bitmap)


def _write_value_column(w: _ByteWriter, ctype: int, values: list):
    non_null = [v for v in values if v is not None]
    if ctype == CTYPE.BOOL:
        _write_bool_column(w, non_null)
    else:
        for v in non_null:
            _write_value(w, ctype, v)


def _write_null_bitmap(w: _ByteWriter, values: list, num_rows: int):
    bitmap = bytearray(null_bitmap_bytes(num_rows))
    for i in range(num_rows):
        if values[i] is None:
            set_null_bit(bitmap, i)
    w.write_bytes(bitmap)


def _write_column_block(w: _ByteWriter, col_id: int, ctype: int, nullable: bool, values: list, num_rows: int):
    w.write_leb128(col_id)
    w.write_byte(((1 if nullable else 0) << 4) | (ctype & 0x0F))
    if nullable:
        _write_null_bitmap(w, values, num_rows)
    _write_value_column(w, ctype, values)


def encode_frame(frame: dict) -> bytes:
    """Encode a snapshot frame. frame = {schemaHash?, rowIds, columns}."""
    w = _ByteWriter()
    row_ids = frame.get("rowIds", [])
    columns = frame.get("columns", [])
    num_rows = len(row_ids)
    num_cols = len(columns)

    w.write_byte(FRAME_SNAPSHOT)

    schema_hash = frame.get("schemaHash")
    if schema_hash is None:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    w.write_bytes(schema_hash)

    w.write_leb128_big(num_rows)
    w.write_leb128(num_cols)

    _write_row_id_block(w, row_ids)

    for col in columns:
        if len(col["values"]) != num_rows:
            raise ValueError(f"column {col['colId']} has {len(col['values'])} values but frame has {num_rows} rows")
        _write_column_block(w, col["colId"], col["ctype"], col["nullable"], col["values"], num_rows)

    return w.to_bytes()


def _write_op(w: _ByteWriter, op: dict):
    w.write_byte(op["op"] & 0xFF)

    op_code = op["op"]
    if op_code in (OP.ROW_INSERT, OP.ROW_UPDATE, OP.BATCH_UPSERT):
        row_ids = op["rowIds"]
        num_rows = len(row_ids)
        w.write_leb128_big(num_rows)
        _write_row_id_block(w, row_ids)
        cols = op.get("columns") or []
        w.write_leb128(len(cols))
        for col in cols:
            _write_column_block(w, col["colId"], col["ctype"], col["nullable"], col["values"], num_rows)

    elif op_code == OP.ROW_DELETE:
        row_ids = op["rowIds"]
        w.write_leb128_big(len(row_ids))
        _write_row_id_block(w, row_ids)

    elif op_code == OP.COLUMN_ADD:
        w.write_leb128(op["colId"])
        w.write_byte(((1 if op["nullable"] else 0) << 4) | (op["ctype"] & 0x0F))
        has_default = 1 if op.get("hasDefault") else 0
        w.write_byte(has_default)
        if has_default:
            _write_value(w, op["ctype"], op["defaultValue"])

    elif op_code == OP.COLUMN_DROP:
        w.write_leb128(op["colId"])

    elif op_code == OP.COLUMN_RENAME:
        w.write_leb128(op["colId"])
        name_bytes = op["name"].encode("utf-8")
        if len(name_bytes) == 0:
            raise ValueError("invalid_col_name: empty name")
        w.write_leb128(len(name_bytes))
        w.write_bytes(name_bytes)

    else:
        raise ValueError(f"unknown_delta_op: {op_code}")


def encode_chain(chain: dict) -> bytes:
    """Encode a delta chain. chain = {schemaHash?, ops}."""
    w = _ByteWriter()
    w.write_byte(FRAME_DELTA)

    schema_hash = chain.get("schemaHash")
    if schema_hash is None:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    w.write_bytes(schema_hash)

    ops = chain.get("ops", [])
    w.write_leb128(len(ops))
    for op in ops:
        _write_op(w, op)
    return w.to_bytes()
