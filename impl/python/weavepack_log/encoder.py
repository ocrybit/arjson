"""weavepack-log — pure-Python encoder (event batches + stream headers + delta chains).

Profile isolation: imports only from .types. No JSON/tensor/wire/tabular profile code.

Wire format:
  Snapshot: 0x00 + schema_hash(32B) + LEB128(num_events)
            + seq_block + ts_block + LEB128(num_user_cols) + column_block[*]
  Delta:    0x01 + schema_hash(32B) + LEB128(num_ops) + op[*]
  Header:   0x02 + stream_id(16B) + LEB128(source_len) + source
            + schema_hash(32B) + LEB128(seq_start)

Column block:
  LEB128(col_id) + type_byte + [null_bitmap] + value_data
  type_byte = (nullable << 5) | (ctype & 0x1F)   [5-bit ctype, log-profile specific]
"""

import struct
from .types import (
    CTYPE, OP, SCHEMA_SUB_OP,
    FRAME_SNAPSHOT, FRAME_DELTA, FRAME_STREAM_HEADER,
    SCHEMA_HASH_BYTES, STREAM_ID_BYTES, MAX_STRING_BYTES,
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


def _write_zigzag64(w: _ByteWriter, v: int):
    v = int(v)
    enc = ((v << 1) ^ (v >> 63)) & 0xFFFFFFFFFFFFFFFF
    w.write_leb128_big(enc)


def _write_seq_block(w: _ByteWriter, seqs: list):
    if not seqs:
        return
    w.write_leb128_big(int(seqs[0]))
    prev = int(seqs[0])
    for i in range(1, len(seqs)):
        cur = int(seqs[i])
        delta = cur - prev
        if delta < 1:
            raise ValueError(f"duplicate_seq: seq delta must be >=1; got {delta} at index {i}")
        w.write_leb128_big(delta)
        prev = cur


def _write_ts_block(w: _ByteWriter, tss: list):
    if not tss:
        return
    _write_zigzag64(w, int(tss[0]))
    prev = int(tss[0])
    for i in range(1, len(tss)):
        cur = int(tss[i])
        delta = cur - prev
        if delta < 0:
            raise ValueError(f"non_monotone_timestamp: ts delta must be >=0; got {delta} at index {i}")
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
    elif ctype in (CTYPE.INT64, CTYPE.TIMESTAMP64):
        w.write_int64_le(int(value))
    elif ctype == CTYPE.UINT8:
        w.write_byte(int(value) & 0xFF)
    elif ctype == CTYPE.UINT16:
        v = int(value) & 0xFFFF
        w.write_byte(v & 0xFF)
        w.write_byte((v >> 8) & 0xFF)
    elif ctype == CTYPE.UINT32:
        v = int(value) & 0xFFFFFFFF
        w.write_bytes(struct.pack("<I", v))
    elif ctype == CTYPE.UINT64:
        w.write_int64_le(int(value))
    elif ctype == CTYPE.FLOAT32:
        w.write_bytes(struct.pack("<f", float(value)))
    elif ctype == CTYPE.FLOAT64:
        w.write_bytes(struct.pack("<d", float(value)))
    elif ctype == CTYPE.STRING:
        b = str(value).encode("utf-8")
        if len(b) > MAX_STRING_BYTES:
            raise ValueError("string exceeds 256 MiB limit")
        w.write_leb128(len(b))
        w.write_bytes(b)
    elif ctype == CTYPE.BYTES:
        b = bytes(value)
        if len(b) > MAX_STRING_BYTES:
            raise ValueError("bytes exceeds 256 MiB limit")
        w.write_leb128(len(b))
        w.write_bytes(b)
    elif ctype == CTYPE.DATE32:
        v = int(value)
        u = v + 0x100000000 if v < 0 else v
        w.write_bytes(struct.pack("<I", u & 0xFFFFFFFF))
    elif ctype == CTYPE.LEVEL:
        v = int(value)
        if v < 0 or v > 5:
            raise ValueError(f"unknown_level: level value {v} is reserved (must be 0-5)")
        w.write_byte(v)
    else:
        raise ValueError(f"unknown_ctype: ctype {ctype}")


def _write_bool_column(w: _ByteWriter, values: list):
    n = len(values)
    buf = bytearray((n + 7) // 8)
    for i, v in enumerate(values):
        if v:
            buf[i >> 3] |= (1 << (7 - (i & 7)))
    w.write_bytes(buf)


def _write_level_column(w: _ByteWriter, values: list):
    n = len(values)
    n_bytes = (n * 3 + 7) // 8
    buf = bytearray(n_bytes)
    for i, v in enumerate(values):
        v = int(v)
        if v < 0 or v > 5:
            raise ValueError(f"unknown_level: level value {v} is reserved (must be 0-5)")
        bit_base = i * 3
        for b in range(3):
            if (v >> b) & 1:
                pos = bit_base + b
                buf[pos >> 3] |= (1 << (pos & 7))
    w.write_bytes(buf)


def _write_null_bitmap(w: _ByteWriter, values: list, num_events: int):
    buf = bytearray(null_bitmap_bytes(num_events))
    for i in range(num_events):
        if values[i] is None:
            set_null_bit(buf, i)
    w.write_bytes(buf)


def _write_value_column(w: _ByteWriter, ctype: int, values: list):
    non_null = [v for v in values if v is not None]
    if ctype == CTYPE.BOOL:
        _write_bool_column(w, non_null)
    elif ctype == CTYPE.LEVEL:
        _write_level_column(w, non_null)
    else:
        for v in non_null:
            _write_value(w, ctype, v)


def _write_column_block(w: _ByteWriter, col_id: int, ctype: int, nullable: bool, values: list, num_events: int):
    if col_id < 2:
        raise ValueError(f"reserved_col_id: col_id {col_id} is reserved (must be >= 2)")
    if ctype > 16:
        raise ValueError(f"unknown_ctype: ctype {ctype} >= 17 is reserved")
    w.write_leb128(col_id)
    type_byte = ((1 if nullable else 0) << 5) | (ctype & 0x1F)
    w.write_byte(type_byte)
    if nullable:
        _write_null_bitmap(w, values, num_events)
    _write_value_column(w, ctype, values)


# ── Public: encode event batch (snapshot frame) ──────────────────────────────────────────


def encode_batch(batch: dict) -> bytes:
    """Encode an event batch to a snapshot frame.

    batch = {
        'schemaHash': bytes (32 bytes; omit -> all-zero),
        'seqs': list of int,
        'tss':  list of int,
        'columns': [{'colId', 'ctype', 'nullable', 'values'}, ...],
    }
    """
    w = _ByteWriter()
    seqs = batch.get("seqs") or []
    tss  = batch.get("tss")  or []
    cols = batch.get("columns") or []
    num_events = len(seqs)

    if len(tss) != num_events:
        raise ValueError(f"tss length ({len(tss)}) must equal seqs length ({num_events})")

    schema_hash = batch.get("schemaHash") or bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")

    w.write_byte(FRAME_SNAPSHOT)
    w.write_bytes(schema_hash)
    w.write_leb128_big(num_events)
    _write_seq_block(w, seqs)
    _write_ts_block(w, tss)
    w.write_leb128(len(cols))
    for col in cols:
        if len(col["values"]) != num_events:
            raise ValueError(
                f"column {col['colId']} has {len(col['values'])} values but batch has {num_events} events"
            )
        _write_column_block(w, col["colId"], col["ctype"], col.get("nullable", False), col["values"], num_events)

    return w.to_bytes()


# ── Public: encode stream header ──────────────────────────────────────────────────


def encode_stream_header(header: dict) -> bytes:
    """Encode a stream header frame.

    header = {
        'streamId':   bytes (16 bytes),
        'source':     str,
        'schemaHash': bytes (32 bytes; omit -> all-zero),
        'seqStart':   int,
    }
    """
    w = _ByteWriter()
    w.write_byte(FRAME_STREAM_HEADER)

    stream_id = header.get("streamId") or bytes(STREAM_ID_BYTES)
    if len(stream_id) != STREAM_ID_BYTES:
        raise ValueError(f"stream_id must be exactly {STREAM_ID_BYTES} bytes")
    w.write_bytes(stream_id)

    source_bytes = (header.get("source") or "").encode("utf-8")
    w.write_leb128(len(source_bytes))
    w.write_bytes(source_bytes)

    schema_hash = header.get("schemaHash") or bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    w.write_bytes(schema_hash)

    w.write_leb128_big(int(header.get("seqStart") or 0))

    return w.to_bytes()


# ── Op encoding ──────────────────────────────────────────────────────────────────────


def _write_event_append(w: _ByteWriter, op: dict):
    seqs = op.get("seqs") or []
    tss  = op.get("tss")  or []
    num_events = len(seqs)
    if len(tss) != num_events:
        raise ValueError(f"event_append: tss length ({len(tss)}) must equal seqs length ({num_events})")
    w.write_leb128_big(num_events)
    _write_seq_block(w, seqs)
    _write_ts_block(w, tss)
    cols = op.get("columns") or []
    w.write_leb128(len(cols))
    for col in cols:
        if len(col["values"]) != num_events:
            raise ValueError(
                f"event_append column {col['colId']} has {len(col['values'])} values but op has {num_events} events"
            )
        _write_column_block(w, col["colId"], col["ctype"], col.get("nullable", False), col["values"], num_events)


def _write_field_update(w: _ByteWriter, op: dict):
    w.write_leb128_big(int(op["seq"]))
    cols = op.get("columns") or []
    w.write_leb128(len(cols))
    for col in cols:
        col_id = col["colId"]
        ctype  = col["ctype"]
        if col_id < 2:
            raise ValueError(f"reserved_col_id: col_id {col_id} is reserved")
        if ctype > 16:
            raise ValueError(f"unknown_ctype: ctype {ctype} >= 17 is reserved")
        value = col.get("value")
        has_value = value is not None
        w.write_leb128(col_id)
        type_byte = ((1 if has_value else 0) << 5) | (ctype & 0x1F)
        w.write_byte(type_byte)
        if has_value:
            _write_value(w, ctype, value)


def _write_event_expire(w: _ByteWriter, op: dict):
    lo = int(op["seqLo"])
    hi = int(op["seqHi"])
    if lo > hi:
        raise ValueError(f"invalid_seq_range: seq_lo ({lo}) > seq_hi ({hi})")
    w.write_leb128_big(lo)
    w.write_leb128_big(hi)


def _write_schema_evolve(w: _ByteWriter, op: dict):
    sub = op.get("subOp", 0)
    if sub > 2:
        raise ValueError(f"unknown_schema_sub_op: sub_op {sub} is reserved")
    w.write_byte(sub)
    if sub == SCHEMA_SUB_OP.COLUMN_ADD:
        col_id  = op["colId"]
        ctype   = op["ctype"]
        nullable = bool(op.get("nullable", False))
        name_bytes = (op.get("name") or "").encode("utf-8")
        if col_id < 2:
            raise ValueError(f"reserved_col_id: col_id {col_id} is reserved")
        if ctype > 16:
            raise ValueError(f"unknown_ctype: ctype {ctype} >= 17 is reserved")
        if len(name_bytes) == 0:
            raise ValueError("invalid_col_name: empty name")
        w.write_leb128(col_id)
        type_byte = ((1 if nullable else 0) << 5) | (ctype & 0x1F)
        w.write_byte(type_byte)
        w.write_leb128(len(name_bytes))
        w.write_bytes(name_bytes)
    elif sub == SCHEMA_SUB_OP.COLUMN_DROP:
        w.write_leb128(op["colId"])
    elif sub == SCHEMA_SUB_OP.COLUMN_RENAME:
        name_bytes = (op.get("name") or "").encode("utf-8")
        if len(name_bytes) == 0:
            raise ValueError("invalid_col_name: empty name")
        w.write_leb128(op["colId"])
        w.write_leb128(len(name_bytes))
        w.write_bytes(name_bytes)


def _write_cursor_checkpoint(w: _ByteWriter, op: dict):
    name_bytes = (op.get("name") or "").encode("utf-8")
    if len(name_bytes) == 0:
        raise ValueError("invalid_cursor_name: empty cursor name")
    w.write_leb128_big(int(op["seq"]))
    w.write_leb128(len(name_bytes))
    w.write_bytes(name_bytes)


def _write_op(w: _ByteWriter, op: dict):
    op_code = op["op"]
    if op_code > 4:
        raise ValueError(f"unknown_delta_op: op code {op_code} is reserved")
    w.write_byte(op_code)
    if op_code == OP.EVENT_APPEND:
        _write_event_append(w, op)
    elif op_code == OP.FIELD_UPDATE:
        _write_field_update(w, op)
    elif op_code == OP.EVENT_EXPIRE:
        _write_event_expire(w, op)
    elif op_code == OP.SCHEMA_EVOLVE:
        _write_schema_evolve(w, op)
    elif op_code == OP.CURSOR_CHECKPOINT:
        _write_cursor_checkpoint(w, op)
    else:
        raise ValueError(f"unknown_delta_op: op code {op_code}")


# ── Public: encode delta chain ─────────────────────────────────────────────────────────────


def encode_chain(schema_hash: bytes, ops: list) -> bytes:
    """Encode a delta chain frame.

    schema_hash: bytes (32 bytes; pass bytes(32) for no-schema)
    ops: list of op dicts
    """
    w = _ByteWriter()
    if schema_hash is None:
        schema_hash = bytes(SCHEMA_HASH_BYTES)
    if len(schema_hash) != SCHEMA_HASH_BYTES:
        raise ValueError(f"schema_hash must be exactly {SCHEMA_HASH_BYTES} bytes")
    w.write_byte(FRAME_DELTA)
    w.write_bytes(schema_hash)
    w.write_leb128(len(ops))
    for op in ops:
        _write_op(w, op)
    return w.to_bytes()
