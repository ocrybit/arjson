"""weavepack-tensor — pure-Python encoder.

Counterpart to decoder.py. Implements schemaless + schemaful encoding
for the dtypes the decoder supports. Round-trips byte-exactly with
the JS reference for every supported dtype.

Scope: encode_document (schemaless), encode_document_schemaful.
Delta encoding (compute_delta + encode_delta) deferred to a future
revision.
"""

import struct
from typing import Any

from .decoder import (
    DTYPE,
    _DTYPE_BITS,
    _data_bytes,
    schema_hash,
)


class _BitWriter:
    """MSB-first bit writer."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.cur = 0
        self.bits_used = 0

    def write_bits(self, val: int, n: int) -> None:
        if n == 0:
            return
        val &= (1 << n) - 1
        remaining = n
        while remaining > 0:
            free = 8 - self.bits_used
            if remaining <= free:
                shift = free - remaining
                self.cur |= (val & ((1 << remaining) - 1)) << shift
                self.bits_used += remaining
                if self.bits_used == 8:
                    self.buf.append(self.cur)
                    self.cur = 0
                    self.bits_used = 0
                return
            shift = remaining - free
            part = (val >> shift) & ((1 << free) - 1)
            self.cur |= part
            self.buf.append(self.cur)
            self.cur = 0
            self.bits_used = 0
            remaining -= free

    def write_byte(self, b: int) -> None:
        self.write_bits(b & 0xFF, 8)

    def finish(self) -> bytes:
        if self.bits_used > 0:
            self.buf.append(self.cur)
        return bytes(self.buf)


def _leb128(w: _BitWriter, v: int) -> None:
    while v >= 128:
        w.write_byte((v & 0x7F) | 0x80)
        v >>= 7
    w.write_byte(v)


def _short(w: _BitWriter, v: int) -> None:
    if v < 4:
        w.write_bits(0, 2); w.write_bits(v, 2)
    elif v < 8:
        w.write_bits(1, 2); w.write_bits(v, 3)
    elif v < 16:
        w.write_bits(2, 2); w.write_bits(v, 4)
    else:
        w.write_bits(3, 2); _leb128(w, v)


def _serialize_data(dtype: int, data: list, total: int) -> bytes:
    """Pack a Python data list into raw little-endian bytes per dtype."""
    fmt_map = {
        DTYPE.FP32: f"<{total}f",
        DTYPE.FP64: f"<{total}d",
        DTYPE.INT8: f"<{total}b",
        DTYPE.UINT8: f"<{total}B",
        DTYPE.INT16: f"<{total}h",
        DTYPE.UINT16: f"<{total}H",
        DTYPE.INT32: f"<{total}i",
        DTYPE.UINT32: f"<{total}I",
        DTYPE.INT64: f"<{total}q",
        DTYPE.UINT64: f"<{total}Q",
    }
    if dtype in fmt_map:
        if total == 0:
            return b""
        return struct.pack(fmt_map[dtype], *data[:total])
    if dtype == DTYPE.BOOL:
        nbytes = (total + 7) // 8
        out = bytearray(nbytes)
        for i in range(total):
            if data[i]:
                out[i >> 3] |= 1 << (7 - (i & 7))
        return bytes(out)
    if dtype == DTYPE.INT4:
        out = bytearray((total + 1) // 2)
        for i in range(total):
            nibble = int(data[i]) & 0x0F
            if i % 2 == 0:
                out[i >> 1] |= nibble << 4
            else:
                out[i >> 1] |= nibble
        return bytes(out)
    if dtype == DTYPE.UINT4:
        out = bytearray((total + 1) // 2)
        for i in range(total):
            nibble = int(data[i]) & 0x0F
            if i % 2 == 0:
                out[i >> 1] |= nibble << 4
            else:
                out[i >> 1] |= nibble
        return bytes(out)
    if dtype in (DTYPE.FP16, DTYPE.BF16):
        # data is a list of raw u16 bit patterns
        return struct.pack(f"<{total}H", *data[:total])
    raise ValueError(f"unsupported dtype {dtype} in encoder")


def _emit_data_block(w: _BitWriter, t: dict) -> None:
    total = 1
    for d in t["shape"]:
        total *= d
    raw = _serialize_data(t["dtype"], t["data"], total)
    expected = _data_bytes(t["dtype"], t["shape"])
    if len(raw) < expected:
        raise ValueError(f"data length {len(raw)} < expected {expected}")
    for i in range(expected):
        w.write_byte(raw[i])


def _emit_name(w: _BitWriter, name: str) -> None:
    name_bytes = name.encode("utf-8")
    _short(w, len(name_bytes))
    for b in name_bytes:
        w.write_byte(b)


def _emit_structured_trailer(w: _BitWriter) -> None:
    """JS Encoder.dump() emits this trailer when single=false:
        1 bit (0) + short(rcount=0).
    The tensor encoder uses single=false but pushes nothing to vlinks/
    klinks/nums, so rcount is 0 and the trailer is exactly 1 + 2 + 2 =
    5 bits."""
    w.write_bits(0, 1)
    _short(w, 0)


def encode_document(doc: dict) -> bytes:
    """Encode a schemaless tensor document."""
    w = _BitWriter()
    w.write_bits(0, 1)  # bit 0: document
    w.write_bits(0, 1)  # bit 1: no schema
    names = list(doc["tensors"].keys())
    _leb128(w, len(names))
    for name in names:
        t = doc["tensors"][name]
        _emit_name(w, name)
        w.write_bits(t["dtype"], 5)
        _short(w, len(t["shape"]))
        for dim in t["shape"]:
            _leb128(w, dim)
        _emit_data_block(w, t)
    _emit_structured_trailer(w)
    return w.finish()


def encode_document_schemaful(doc: dict, schema: dict) -> bytes:
    """Encode a schemaful tensor document. Tensors emitted in
    schema-canonical (sorted) name order; only data blocks on the
    wire."""
    sorted_names = sorted(schema.keys())
    h = schema_hash(schema)
    w = _BitWriter()
    w.write_bits(0, 1)  # bit 0: document
    w.write_bits(1, 1)  # bit 1: schema present
    for b in h:
        w.write_byte(b)
    for name in sorted_names:
        if name not in doc["tensors"]:
            raise ValueError(f"schema requires tensor {name!r} but document is missing it")
        t = doc["tensors"][name]
        sdef = schema[name]
        if t["dtype"] != sdef["dtype"]:
            raise ValueError(f"tensor {name!r}: dtype mismatch")
        if list(t["shape"]) != list(sdef["shape"]):
            raise ValueError(f"tensor {name!r}: shape mismatch")
        _emit_data_block(w, t)
    _emit_structured_trailer(w)
    return w.finish()
