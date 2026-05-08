"""weavepack-wire — pure-Python encoder (schemaless snapshots + delta chains).

Profile isolation: imports only from .types. No JSON/tensor profile code.
"""

import struct
from .types import (
    VTYPE, CTYPE, OP, PC,
    FLAG_SCHEMALESS, FLAG_DELTA,
    scalar_tag, container_tag, is_container,
    TAG_MESSAGE, TAG_REPEATED, TAG_MAP, TAG_ONEOF,
    MAX_PAYLOAD_BYTES,
)


class _ByteWriter:
    def __init__(self):
        self._buf = bytearray()

    def write_byte(self, b: int):
        self._buf.append(b & 0xFF)

    def write_bytes(self, src: bytes | bytearray | memoryview):
        self._buf.extend(src)

    def write_leb128(self, v: int):
        if isinstance(v, int) and v < 0:
            raise ValueError(f"write_leb128: negative value {v}")
        v = int(v)
        while v >= 128:
            self._buf.append((v & 0x7F) | 0x80)
            v >>= 7
        self._buf.append(v)

    def to_bytes(self) -> bytes:
        return bytes(self._buf)


def _write_scalar(w: _ByteWriter, vtype: int, value):
    if vtype == VTYPE.BOOL:
        w.write_byte(1 if value else 0)
    elif vtype == VTYPE.INT32:
        v = int(value) & 0xFFFFFFFF
        w.write_leb128(v)
    elif vtype == VTYPE.INT64:
        v = int(value)
        if v < 0:
            v = v + (1 << 64)
        w.write_leb128(v)
    elif vtype == VTYPE.UINT32:
        w.write_leb128(int(value) & 0xFFFFFFFF)
    elif vtype == VTYPE.UINT64:
        w.write_leb128(int(value))
    elif vtype == VTYPE.SINT32:
        v = int(value) & 0xFFFFFFFF if int(value) >= 0 else int(value)
        # Zigzag: small negatives → small positives.
        v = int(value)
        z = ((v << 1) ^ (v >> 31)) & 0xFFFFFFFF
        w.write_leb128(z)
    elif vtype == VTYPE.SINT64:
        v = int(value)
        z = ((v << 1) ^ (v >> 63)) & 0xFFFFFFFFFFFFFFFF
        w.write_leb128(z)
    elif vtype == VTYPE.FLOAT32:
        w.write_bytes(struct.pack("<f", float(value)))
    elif vtype == VTYPE.FLOAT64:
        w.write_bytes(struct.pack("<d", float(value)))
    elif vtype == VTYPE.STRING:
        utf8 = str(value).encode("utf-8")
        if len(utf8) > MAX_PAYLOAD_BYTES:
            raise ValueError("string exceeds 256 MiB limit")
        w.write_leb128(len(utf8))
        w.write_bytes(utf8)
    elif vtype == VTYPE.BYTES:
        if isinstance(value, (bytes, bytearray)):
            src = bytes(value)
        elif isinstance(value, list):
            src = bytes(value)
        else:
            src = bytes(value)
        if len(src) > MAX_PAYLOAD_BYTES:
            raise ValueError("bytes exceeds 256 MiB limit")
        w.write_leb128(len(src))
        w.write_bytes(src)
    elif vtype == VTYPE.ENUM:
        v = int(value) & 0xFFFFFFFF
        w.write_leb128(v)
    else:
        raise ValueError(f"unknown vtype {vtype}")


def _write_path(w: _ByteWriter, path: list):
    for comp in path:
        if "field" in comp:
            w.write_byte(PC.FIELD)
            w.write_leb128(int(comp["field"]) & 0xFFFFFFFF)
        elif "map" in comp:
            w.write_byte(PC.MAP)
            key = comp["map"]
            if isinstance(key, str):
                w.write_byte(0)  # string key
                utf8 = key.encode("utf-8")
                w.write_leb128(len(utf8))
                w.write_bytes(utf8)
            else:
                w.write_byte(1)  # uint32 key
                w.write_leb128(int(key) & 0xFFFFFFFF)
        elif "index" in comp:
            w.write_byte(PC.INDEX)
            w.write_leb128(int(comp["index"]) & 0xFFFFFFFF)
    w.write_byte(PC.END)


def _write_field_body(w: _ByteWriter, field: dict):
    if "message" in field:
        w.write_byte(TAG_MESSAGE)
        _write_message_body(w, field["message"])
    elif "repeated" in field:
        w.write_byte(TAG_REPEATED)
        r = field["repeated"]
        elem_type = r["elemType"]
        values = r["values"]
        w.write_byte(scalar_tag(elem_type))
        w.write_leb128(len(values))
        for v in values:
            _write_scalar(w, elem_type, v)
    elif "map" in field:
        w.write_byte(TAG_MAP)
        m = field["map"]
        key_type = m["keyType"]
        value_type = m["valueType"]
        entries = m["entries"]
        w.write_byte(0 if key_type == "string" else 1)
        w.write_byte(scalar_tag(value_type))
        w.write_leb128(len(entries))
        for k, v in entries:
            if key_type == "string":
                utf8 = str(k).encode("utf-8")
                w.write_leb128(len(utf8))
                w.write_bytes(utf8)
            else:
                w.write_leb128(int(k) & 0xFFFFFFFF)
            _write_scalar(w, value_type, v)
    elif "oneof" in field:
        w.write_byte(TAG_ONEOF)
        o = field["oneof"]
        w.write_leb128(int(o["activeField"]) & 0xFFFFFFFF)
        w.write_byte(scalar_tag(o["valueType"]))
        _write_scalar(w, o["valueType"], o["value"])
    else:
        vtype = field["vtype"]
        value = field["value"]
        w.write_byte(scalar_tag(vtype))
        _write_scalar(w, vtype, value)


def _write_message_body(w: _ByteWriter, fields: list):
    sorted_fields = sorted(fields, key=lambda f: f["num"])
    w.write_leb128(len(sorted_fields))
    for f in sorted_fields:
        w.write_leb128(int(f["num"]) & 0xFFFFFFFF)
        _write_field_body(w, f)


def encode_document(fields: list) -> bytes:
    """Encode a schemaless snapshot from a list of field dicts."""
    w = _ByteWriter()
    w.write_byte(FLAG_SCHEMALESS)
    _write_message_body(w, fields)
    return w.to_bytes()


def _write_op(w: _ByteWriter, op: dict):
    w.write_byte(op["op"])
    _write_path(w, op.get("path") or [])

    op_code = op["op"]
    if op_code == OP.FIELD_SET:
        _write_field_body(w, {"num": 0, **op["value"]})
    elif op_code == OP.FIELD_DELETE:
        pass  # path only
    elif op_code == OP.MESSAGE_REPLACE:
        _write_message_body(w, op["message"])
    elif op_code == OP.REPEATED_APPEND:
        elems = op["elements"]
        elem_type = elems["elemType"]
        values = elems["values"]
        w.write_byte(scalar_tag(elem_type))
        w.write_leb128(len(values))
        for v in values:
            _write_scalar(w, elem_type, v)
    elif op_code == OP.REPEATED_SPLICE:
        w.write_leb128(int(op["index"]) & 0xFFFFFFFF)
        w.write_leb128(int(op["deleteCount"]) & 0xFFFFFFFF)
        elem_type = op["elemType"]
        insert_values = op["insertValues"]
        w.write_byte(scalar_tag(elem_type))
        w.write_leb128(len(insert_values))
        for v in insert_values:
            _write_scalar(w, elem_type, v)
    elif op_code == OP.MAP_SET:
        key_type = op["keyType"]
        key = op["key"]
        value_type = op["valueType"]
        value = op["value"]
        w.write_byte(0 if key_type == "string" else 1)
        if key_type == "string":
            utf8 = str(key).encode("utf-8")
            w.write_leb128(len(utf8))
            w.write_bytes(utf8)
        else:
            w.write_leb128(int(key) & 0xFFFFFFFF)
        w.write_byte(scalar_tag(value_type))
        _write_scalar(w, value_type, value)
    elif op_code == OP.MAP_DELETE:
        key_type = op["keyType"]
        key = op["key"]
        w.write_byte(0 if key_type == "string" else 1)
        if key_type == "string":
            utf8 = str(key).encode("utf-8")
            w.write_leb128(len(utf8))
            w.write_bytes(utf8)
        else:
            w.write_leb128(int(key) & 0xFFFFFFFF)
    elif op_code == OP.ONEOF_SWITCH:
        w.write_leb128(int(op["activeField"]) & 0xFFFFFFFF)
        value_type = op["valueType"]
        w.write_byte(scalar_tag(value_type))
        _write_scalar(w, value_type, op["value"])
    else:
        raise ValueError(f"unknown op {op_code}")


def encode_chain(ops: list) -> bytes:
    """Encode a delta chain from a list of op dicts."""
    w = _ByteWriter()
    w.write_byte(FLAG_DELTA)
    w.write_leb128(len(ops))
    for op in ops:
        _write_op(w, op)
    return w.to_bytes()
