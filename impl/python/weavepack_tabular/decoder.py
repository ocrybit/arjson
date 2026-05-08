"""weavepack-tabular — pure-Python decoder (snapshot frames + delta chains).

Profile isolation: imports only from .types. No JSON/tensor/wire profile code.
"""

import struct
from .types import (
    CTYPE, OP, FRAME_SNAPSHOT, FRAME_DELTA,
    SCHEMA_HASH_BYTES, MAX_STRING_BYTES,
    null_bitmap_bytes, get_null_bit,
)


class _ByteReader:
    def __init__(self, data: bytes | bytearray):
        self._buf = bytes(data)
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

    def read_int64_le(self) -> int:
        b = self.read_bytes(8)
        lo, hi = struct.unpack_from("<II", b, 0)
        u = (hi << 32) | lo
        return u - (1 << 64) if u > 0x7FFFFFFFFFFFFFFF else u


def _read_row_id_block(r: _ByteReader, num_rows: int) -> list:
    if num_rows == 0:
        return []
    row_ids = []
    first = r.read_leb128_big()
    row_ids.append(first)
    prev = first
    for _ in range(1, num_rows):
        delta = r.read_leb128_big()
        if delta < 1:
            raise ValueError("duplicate_row_id: row_id delta must be ≥1")
        prev = prev + delta
        row_ids.append(prev)
    return row_ids


def _read_value(r: _ByteReader, ctype: int):
    if ctype == CTYPE.BOOL:
        return r.read_byte() != 0
    elif ctype == CTYPE.INT8:
        b = r.read_byte()
        return b - 256 if b > 127 else b
    elif ctype == CTYPE.INT16:
        b = r.read_bytes(2)
        u = b[0] | (b[1] << 8)
        return u - 0x10000 if u > 0x7FFF else u
    elif ctype == CTYPE.INT32:
        u, = struct.unpack_from("<I", r.read_bytes(4), 0)
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    elif ctype == CTYPE.INT64 or ctype == CTYPE.TIMESTAMP64:
        return r.read_int64_le()
    elif ctype == CTYPE.UINT8:
        return r.read_byte()
    elif ctype == CTYPE.UINT16:
        b = r.read_bytes(2)
        return b[0] | (b[1] << 8)
    elif ctype == CTYPE.UINT32:
        u, = struct.unpack_from("<I", r.read_bytes(4), 0)
        return u
    elif ctype == CTYPE.UINT64:
        b = r.read_bytes(8)
        lo, hi = struct.unpack_from("<II", b, 0)
        return (hi << 32) | lo
    elif ctype == CTYPE.FLOAT32:
        v, = struct.unpack_from("<f", r.read_bytes(4), 0)
        return v
    elif ctype == CTYPE.FLOAT64:
        v, = struct.unpack_from("<d", r.read_bytes(8), 0)
        return v
    elif ctype == CTYPE.STRING:
        length = r.read_leb128()
        if length > MAX_STRING_BYTES:
            raise ValueError("string exceeds 256 MiB limit")
        try:
            return r.read_bytes(length).decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("invalid_utf8: string column contains invalid UTF-8")
    elif ctype == CTYPE.BYTES:
        length = r.read_leb128()
        if length > MAX_STRING_BYTES:
            raise ValueError("bytes exceeds 256 MiB limit")
        return r.read_bytes(length)
    elif ctype == CTYPE.DATE32:
        u, = struct.unpack_from("<I", r.read_bytes(4), 0)
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    elif ctype == CTYPE.EXT:
        raise ValueError("unknown_ext_type: EXT ctype not implemented in v0.1")
    else:
        raise ValueError(f"unknown ctype {ctype}")


def _read_bool_column(r: _ByteReader, count: int) -> list:
    n_bytes = (count + 7) // 8
    data = bytearray(r.read_bytes(n_bytes))
    values = []
    for i in range(count):
        values.append(bool((data[i >> 3] >> (7 - (i & 7))) & 1))
    return values


def _read_value_column(r: _ByteReader, ctype: int, count: int) -> list:
    if ctype == CTYPE.BOOL:
        return _read_bool_column(r, count)
    return [_read_value(r, ctype) for _ in range(count)]


def _read_null_bitmap(r: _ByteReader, num_rows: int) -> list:
    n_bytes = null_bitmap_bytes(num_rows)
    data = bytearray(r.read_bytes(n_bytes))

    # Validate padding bits in the final byte are zero.
    rem = num_rows & 7
    if rem != 0:
        last = data[n_bytes - 1]
        mask = 0xFF >> rem
        if last & mask:
            raise ValueError("invalid_null_bitmap: padding bits must be zero")

    return [get_null_bit(data, i) for i in range(num_rows)]


def _read_column_block(r: _ByteReader, num_rows: int) -> dict:
    col_id = r.read_leb128()
    type_byte = r.read_byte()
    ctype = type_byte & 0x0F
    nullable = ((type_byte >> 4) & 1) == 1

    if nullable:
        null_flags = _read_null_bitmap(r, num_rows)
        non_null_count = sum(1 for b in null_flags if not b)
        non_null_values = _read_value_column(r, ctype, non_null_count)
        values = []
        vi = 0
        for i in range(num_rows):
            if null_flags[i]:
                values.append(None)
            else:
                values.append(non_null_values[vi])
                vi += 1
    else:
        values = _read_value_column(r, ctype, num_rows)

    return {"colId": col_id, "ctype": ctype, "nullable": nullable, "values": values}


def decode_frame(data: bytes) -> dict:
    """Decode a snapshot frame. Returns {schemaHash, rowIds, columns}."""
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag != FRAME_SNAPSHOT:
        if flag == FRAME_DELTA:
            raise ValueError("expected snapshot frame, got delta chain")
        raise ValueError(f"unknown frame flag 0x{flag:02x}")

    schema_hash = r.read_bytes(SCHEMA_HASH_BYTES)
    num_rows = r.read_leb128_big()
    num_cols = r.read_leb128()

    row_ids = _read_row_id_block(r, num_rows)

    columns = [_read_column_block(r, num_rows) for _ in range(num_cols)]

    return {"schemaHash": schema_hash, "rowIds": row_ids, "columns": columns}


def _read_op(r: _ByteReader) -> dict:
    op_code = r.read_byte()

    if op_code in (0, 1, 6):  # ROW_INSERT, ROW_UPDATE, BATCH_UPSERT
        num_rows = r.read_leb128_big()
        row_ids = _read_row_id_block(r, num_rows)
        num_cols = r.read_leb128()
        columns = [_read_column_block(r, num_rows) for _ in range(num_cols)]
        return {"op": op_code, "rowIds": row_ids, "columns": columns}

    elif op_code == 2:  # ROW_DELETE
        num_rows = r.read_leb128_big()
        row_ids = _read_row_id_block(r, num_rows)
        return {"op": op_code, "rowIds": row_ids}

    elif op_code == 3:  # COLUMN_ADD
        col_id = r.read_leb128()
        type_byte = r.read_byte()
        ctype = type_byte & 0x0F
        nullable = ((type_byte >> 4) & 1) == 1
        has_default = r.read_byte() == 1
        default_value = _read_value(r, ctype) if has_default else None
        return {
            "op": op_code, "colId": col_id, "ctype": ctype,
            "nullable": nullable, "hasDefault": has_default,
            "defaultValue": default_value,
        }

    elif op_code == 4:  # COLUMN_DROP
        col_id = r.read_leb128()
        return {"op": op_code, "colId": col_id}

    elif op_code == 5:  # COLUMN_RENAME
        col_id = r.read_leb128()
        name_len = r.read_leb128()
        if name_len == 0:
            raise ValueError("invalid_col_name: empty name")
        name = r.read_bytes(name_len).decode("utf-8")
        return {"op": op_code, "colId": col_id, "name": name}

    elif op_code == 7:
        raise ValueError("unknown_delta_op: op code 7 is reserved")
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")


def decode_chain(data: bytes) -> dict:
    """Decode a delta chain. Returns {schemaHash, ops}."""
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag != FRAME_DELTA:
        raise ValueError(f"expected delta chain (flag 0x01), got 0x{flag:02x}")

    schema_hash = r.read_bytes(SCHEMA_HASH_BYTES)
    num_ops = r.read_leb128()
    ops = [_read_op(r) for _ in range(num_ops)]
    return {"schemaHash": schema_hash, "ops": ops}
