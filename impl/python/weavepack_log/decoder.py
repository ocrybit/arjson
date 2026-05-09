"""weavepack-log — pure-Python decoder (event batches + stream headers + delta chains).

Profile isolation: imports only from .types. No JSON/tensor/wire/tabular profile code.
"""

import struct
from .types import (
    CTYPE, OP, SCHEMA_SUB_OP,
    FRAME_SNAPSHOT, FRAME_DELTA, FRAME_STREAM_HEADER,
    SCHEMA_HASH_BYTES, STREAM_ID_BYTES, MAX_STRING_BYTES,
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

    def read_zigzag64(self) -> int:
        enc = self.read_leb128_big()
        v = (enc >> 1) ^ -(enc & 1)
        if v >= (1 << 63):
            v -= (1 << 64)
        return v


def _read_seq_block(r: _ByteReader, num_events: int) -> list:
    if num_events == 0:
        return []
    first = r.read_leb128_big()
    seqs = [first]
    prev = first
    for _ in range(1, num_events):
        delta = r.read_leb128_big()
        if delta < 1:
            raise ValueError("duplicate_seq: seq delta must be >=1")
        prev = prev + delta
        seqs.append(prev)
    return seqs


def _read_ts_block(r: _ByteReader, num_events: int) -> list:
    if num_events == 0:
        return []
    first = r.read_zigzag64()
    tss = [first]
    prev = first
    for _ in range(1, num_events):
        delta = r.read_leb128_big()
        prev = prev + delta
        tss.append(prev)
    return tss


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
    elif ctype == CTYPE.INT64:
        raw = r.read_bytes(8)
        lo, hi = struct.unpack("<II", raw)
        u = lo | (hi << 32)
        return u - (1 << 64) if u > 0x7FFFFFFFFFFFFFFF else u
    elif ctype == CTYPE.UINT8:
        return r.read_byte()
    elif ctype == CTYPE.UINT16:
        raw = r.read_bytes(2)
        return raw[0] | (raw[1] << 8)
    elif ctype == CTYPE.UINT32:
        raw = r.read_bytes(4)
        return struct.unpack("<I", raw)[0]
    elif ctype == CTYPE.UINT64:
        raw = r.read_bytes(8)
        lo, hi = struct.unpack("<II", raw)
        return lo | (hi << 32)
    elif ctype == CTYPE.FLOAT32:
        raw = r.read_bytes(4)
        return struct.unpack("<f", raw)[0]
    elif ctype == CTYPE.FLOAT64:
        raw = r.read_bytes(8)
        return struct.unpack("<d", raw)[0]
    elif ctype == CTYPE.STRING:
        length = r.read_leb128()
        if length > MAX_STRING_BYTES:
            raise ValueError("string exceeds 256 MiB limit")
        raw = r.read_bytes(length)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("invalid_utf8: string column contains invalid UTF-8")
    elif ctype == CTYPE.BYTES:
        length = r.read_leb128()
        if length > MAX_STRING_BYTES:
            raise ValueError("bytes exceeds 256 MiB limit")
        return r.read_bytes(length)
    elif ctype == CTYPE.DATE32:
        raw = r.read_bytes(4)
        u = struct.unpack("<I", raw)[0]
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    elif ctype == CTYPE.TIMESTAMP64:
        raw = r.read_bytes(8)
        lo, hi = struct.unpack("<II", raw)
        u = lo | (hi << 32)
        return u - (1 << 64) if u > 0x7FFFFFFFFFFFFFFF else u
    elif ctype == CTYPE.LEVEL:
        v = r.read_byte()
        if v > 5:
            raise ValueError(f"unknown_level: level value {v} is reserved")
        return v
    else:
        raise ValueError(f"unknown_ctype: ctype {ctype}")


def _read_bool_column(r: _ByteReader, count: int) -> list:
    n_bytes = (count + 7) // 8
    raw = r.read_bytes(n_bytes)
    return [bool((raw[i >> 3] >> (7 - (i & 7))) & 1) for i in range(count)]


def _read_level_column(r: _ByteReader, count: int) -> list:
    n_bytes = (count * 3 + 7) // 8
    raw = r.read_bytes(n_bytes)
    values = []
    for i in range(count):
        bit_base = i * 3
        v = 0
        for b in range(3):
            pos = bit_base + b
            if (raw[pos >> 3] >> (pos & 7)) & 1:
                v |= (1 << b)
        if v >= 6:
            raise ValueError(f"unknown_level: level value {v} is reserved")
        values.append(v)
    total_bits = count * 3
    used_in_last = total_bits & 7
    if used_in_last != 0 and n_bytes > 0:
        last = raw[n_bytes - 1]
        mask = 0xFF << used_in_last
        if last & mask & 0xFF:
            raise ValueError("invalid_level_padding: padding bits must be zero")
    return values


def _read_null_bitmap(r: _ByteReader, num_events: int) -> list:
    n_bytes = null_bitmap_bytes(num_events)
    raw = r.read_bytes(n_bytes)
    rem = num_events & 7
    if rem != 0:
        last = raw[n_bytes - 1]
        mask = 0xFF >> rem
        if last & mask:
            raise ValueError("invalid_null_bitmap: padding bits must be zero")
    return [get_null_bit(raw, i) for i in range(num_events)]


def _read_value_column(r: _ByteReader, ctype: int, count: int) -> list:
    if ctype == CTYPE.BOOL:
        return _read_bool_column(r, count)
    elif ctype == CTYPE.LEVEL:
        return _read_level_column(r, count)
    else:
        return [_read_value(r, ctype) for _ in range(count)]


def _read_column_block(r: _ByteReader, num_events: int) -> dict:
    col_id = r.read_leb128()
    if col_id < 2:
        raise ValueError(f"reserved_col_id: col_id {col_id} is reserved (must be >= 2)")
    type_byte = r.read_byte()
    ctype    = type_byte & 0x1F
    nullable = ((type_byte >> 5) & 1) == 1
    if ctype > 16:
        raise ValueError(f"unknown_ctype: ctype {ctype} >= 17 is reserved")

    if nullable:
        null_flags = _read_null_bitmap(r, num_events)
        non_null_count = sum(1 for b in null_flags if not b)
        raw_vals = _read_value_column(r, ctype, non_null_count)
        values = []
        vi = 0
        for is_null in null_flags:
            if is_null:
                values.append(None)
            else:
                values.append(raw_vals[vi])
                vi += 1
    else:
        values = _read_value_column(r, ctype, num_events)

    return {"colId": col_id, "ctype": ctype, "nullable": nullable, "values": values}


# ── Public: decode event batch (snapshot frame) ──────────────────────────────────────────


def decode_batch(data: bytes) -> dict:
    """Decode a snapshot frame (event batch).

    Returns { 'schemaHash': bytes, 'seqs': list[int], 'tss': list[int], 'columns': [...] }.
    """
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag == FRAME_DELTA:
        raise ValueError("expected event batch (0x00), got delta chain (0x01)")
    if flag == FRAME_STREAM_HEADER:
        raise ValueError("expected event batch (0x00), got stream header (0x02)")
    if flag != FRAME_SNAPSHOT:
        raise ValueError(f"unknown frame flag 0x{flag:02x}")

    schema_hash = r.read_bytes(SCHEMA_HASH_BYTES)
    num_events  = r.read_leb128_big()

    seqs = _read_seq_block(r, num_events)
    tss  = _read_ts_block(r, num_events)

    num_user_cols = r.read_leb128()
    columns = [_read_column_block(r, num_events) for _ in range(num_user_cols)]

    return {"schemaHash": schema_hash, "seqs": seqs, "tss": tss, "columns": columns}


# ── Public: decode stream header ───────────────────────────────────────────────────────


def decode_stream_header(data: bytes) -> dict:
    """Decode a stream header frame.

    Returns { 'streamId': bytes, 'source': str, 'schemaHash': bytes, 'seqStart': int }.
    """
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag != FRAME_STREAM_HEADER:
        raise ValueError(f"expected stream header (0x02), got 0x{flag:02x}")

    stream_id = r.read_bytes(STREAM_ID_BYTES)

    source_len   = r.read_leb128()
    source_bytes = r.read_bytes(source_len)
    try:
        source = source_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("invalid_utf8: source contains invalid UTF-8")

    schema_hash = r.read_bytes(SCHEMA_HASH_BYTES)
    seq_start   = r.read_leb128_big()

    return {"streamId": stream_id, "source": source, "schemaHash": schema_hash, "seqStart": seq_start}


# ── Op decoding ──────────────────────────────────────────────────────────────────────


def _read_event_append(r: _ByteReader) -> dict:
    num_events = r.read_leb128_big()
    seqs = _read_seq_block(r, num_events)
    tss  = _read_ts_block(r, num_events)
    num_cols = r.read_leb128()
    columns = [_read_column_block(r, num_events) for _ in range(num_cols)]
    return {"op": OP.EVENT_APPEND, "seqs": seqs, "tss": tss, "columns": columns}


def _read_field_update(r: _ByteReader) -> dict:
    seq = r.read_leb128_big()
    num_cols = r.read_leb128()
    columns = []
    for _ in range(num_cols):
        col_id    = r.read_leb128()
        type_byte = r.read_byte()
        ctype     = type_byte & 0x1F
        has_value = ((type_byte >> 5) & 1) == 1
        if ctype > 16:
            raise ValueError(f"unknown_ctype: ctype {ctype} >= 17 is reserved")
        value = _read_value(r, ctype) if has_value else None
        columns.append({"colId": col_id, "ctype": ctype, "hasValue": has_value, "value": value})
    return {"op": OP.FIELD_UPDATE, "seq": seq, "columns": columns}


def _read_event_expire(r: _ByteReader) -> dict:
    seq_lo = r.read_leb128_big()
    seq_hi = r.read_leb128_big()
    if seq_lo > seq_hi:
        raise ValueError(f"invalid_seq_range: seq_lo ({seq_lo}) > seq_hi ({seq_hi})")
    return {"op": OP.EVENT_EXPIRE, "seqLo": seq_lo, "seqHi": seq_hi}


def _read_schema_evolve(r: _ByteReader) -> dict:
    sub_op = r.read_byte()
    if sub_op > 2:
        raise ValueError(f"unknown_schema_sub_op: sub_op {sub_op} is reserved")
    if sub_op == SCHEMA_SUB_OP.COLUMN_ADD:
        col_id    = r.read_leb128()
        type_byte = r.read_byte()
        ctype     = type_byte & 0x1F
        nullable  = ((type_byte >> 5) & 1) == 1
        if ctype > 16:
            raise ValueError(f"unknown_ctype: ctype {ctype} >= 17 is reserved")
        name_len = r.read_leb128()
        if name_len == 0:
            raise ValueError("invalid_col_name: empty name")
        name_bytes = r.read_bytes(name_len)
        name = name_bytes.decode("utf-8")
        return {"op": OP.SCHEMA_EVOLVE, "subOp": sub_op, "colId": col_id,
                "ctype": ctype, "nullable": nullable, "name": name}
    elif sub_op == SCHEMA_SUB_OP.COLUMN_DROP:
        col_id = r.read_leb128()
        return {"op": OP.SCHEMA_EVOLVE, "subOp": sub_op, "colId": col_id}
    else:  # COLUMN_RENAME
        col_id   = r.read_leb128()
        name_len = r.read_leb128()
        if name_len == 0:
            raise ValueError("invalid_col_name: empty name")
        name_bytes = r.read_bytes(name_len)
        name = name_bytes.decode("utf-8")
        return {"op": OP.SCHEMA_EVOLVE, "subOp": sub_op, "colId": col_id, "name": name}


def _read_cursor_checkpoint(r: _ByteReader) -> dict:
    seq      = r.read_leb128_big()
    name_len = r.read_leb128()
    if name_len == 0:
        raise ValueError("invalid_cursor_name: empty cursor name")
    name_bytes = r.read_bytes(name_len)
    name = name_bytes.decode("utf-8")
    return {"op": OP.CURSOR_CHECKPOINT, "seq": seq, "name": name}


def _read_op(r: _ByteReader) -> dict:
    op_code = r.read_byte()
    if op_code == OP.EVENT_APPEND:
        return _read_event_append(r)
    elif op_code == OP.FIELD_UPDATE:
        return _read_field_update(r)
    elif op_code == OP.EVENT_EXPIRE:
        return _read_event_expire(r)
    elif op_code == OP.SCHEMA_EVOLVE:
        return _read_schema_evolve(r)
    elif op_code == OP.CURSOR_CHECKPOINT:
        return _read_cursor_checkpoint(r)
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved")


# ── Public: decode delta chain ─────────────────────────────────────────────────────────────


def decode_chain(data: bytes) -> dict:
    """Decode a delta chain frame.

    Returns { 'schemaHash': bytes, 'ops': list }.
    """
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag != FRAME_DELTA:
        raise ValueError(f"expected delta chain (0x01), got 0x{flag:02x}")

    schema_hash = r.read_bytes(SCHEMA_HASH_BYTES)
    num_ops = r.read_leb128()
    ops = [_read_op(r) for _ in range(num_ops)]

    return {"schemaHash": schema_hash, "ops": ops}
