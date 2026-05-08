"""weavepack-wire — pure-Python decoder (schemaless snapshots + delta chains).

Profile isolation: imports only from .types. No JSON/tensor profile code.
"""

import struct
from .types import (
    VTYPE, CTYPE, OP, PC,
    FLAG_SCHEMALESS, FLAG_DELTA, FLAG_SCHEMAFUL,
    is_container, get_vtype, get_ctype,
    MAX_PAYLOAD_BYTES,
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


def _read_scalar(r: _ByteReader, vtype: int):
    if vtype == VTYPE.BOOL:
        return r.read_byte() != 0
    elif vtype == VTYPE.INT32:
        u = r.read_leb128()
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    elif vtype == VTYPE.INT64:
        u = r.read_leb128_big()
        return u - (1 << 64) if u > 0x7FFFFFFFFFFFFFFF else u
    elif vtype == VTYPE.UINT32:
        return r.read_leb128()
    elif vtype == VTYPE.UINT64:
        return r.read_leb128_big()
    elif vtype == VTYPE.SINT32:
        z = r.read_leb128()
        # Undo zigzag.
        v = (z >> 1) ^ -(z & 1)
        return v
    elif vtype == VTYPE.SINT64:
        z = r.read_leb128_big()
        v = (z >> 1) ^ -(z & 1)
        return v
    elif vtype == VTYPE.FLOAT32:
        b = r.read_bytes(4)
        return struct.unpack_from("<f", b, 0)[0]
    elif vtype == VTYPE.FLOAT64:
        b = r.read_bytes(8)
        return struct.unpack_from("<d", b, 0)[0]
    elif vtype == VTYPE.STRING:
        length = r.read_leb128()
        if length > MAX_PAYLOAD_BYTES:
            raise ValueError("string exceeds 256 MiB limit")
        return r.read_bytes(length).decode("utf-8")
    elif vtype == VTYPE.BYTES:
        length = r.read_leb128()
        if length > MAX_PAYLOAD_BYTES:
            raise ValueError("bytes exceeds 256 MiB limit")
        return r.read_bytes(length)
    elif vtype == VTYPE.ENUM:
        u = r.read_leb128()
        return u - 0x100000000 if u > 0x7FFFFFFF else u
    else:
        raise ValueError(f"unknown vtype {vtype}")


def _read_path(r: _ByteReader) -> list:
    path = []
    while True:
        comp_type = r.read_byte()
        if comp_type == PC.END:
            break
        elif comp_type == PC.FIELD:
            path.append({"field": r.read_leb128()})
        elif comp_type == PC.MAP:
            key_type_byte = r.read_byte()
            if key_type_byte == 0:
                length = r.read_leb128()
                key = r.read_bytes(length).decode("utf-8")
                path.append({"map": key})
            else:
                path.append({"map": r.read_leb128()})
        elif comp_type == PC.INDEX:
            path.append({"index": r.read_leb128()})
        else:
            raise ValueError(f"unknown path component type {comp_type}")
    return path


def _read_field_body(r: _ByteReader, field_num: int) -> dict:
    tag = r.read_byte()
    if not is_container(tag):
        vtype = get_vtype(tag)
        return {"num": field_num, "vtype": vtype, "value": _read_scalar(r, vtype)}
    ctype = get_ctype(tag)
    if ctype == CTYPE.MESSAGE:
        return {"num": field_num, "message": _read_message_body(r)}
    elif ctype == CTYPE.REPEATED:
        elem_tag = r.read_byte()
        elem_type = get_vtype(elem_tag)
        count = r.read_leb128()
        values = [_read_scalar(r, elem_type) for _ in range(count)]
        return {"num": field_num, "repeated": {"elemType": elem_type, "values": values}}
    elif ctype == CTYPE.MAP:
        key_type_byte = r.read_byte()
        key_type = "string" if key_type_byte == 0 else "uint32"
        value_tag = r.read_byte()
        value_type = get_vtype(value_tag)
        count = r.read_leb128()
        entries = []
        for _ in range(count):
            if key_type == "string":
                length = r.read_leb128()
                key = r.read_bytes(length).decode("utf-8")
            else:
                key = r.read_leb128()
            entries.append([key, _read_scalar(r, value_type)])
        return {"num": field_num, "map": {"keyType": key_type, "valueType": value_type, "entries": entries}}
    elif ctype == CTYPE.ONEOF:
        active_field = r.read_leb128()
        value_tag = r.read_byte()
        value_type = get_vtype(value_tag)
        value = _read_scalar(r, value_type)
        return {"num": field_num, "oneof": {"activeField": active_field, "valueType": value_type, "value": value}}
    else:
        raise ValueError(f"unknown ctype {ctype}")


def _read_message_body(r: _ByteReader) -> list:
    count = r.read_leb128()
    fields = []
    last_num = -1
    for _ in range(count):
        num = r.read_leb128()
        if num <= last_num:
            raise ValueError(f"field_order_violation: field {num} after {last_num}")
        last_num = num
        fields.append(_read_field_body(r, num))
    return fields


def decode_document(data: bytes) -> list:
    """Decode a schemaless snapshot, returning a list of field dicts."""
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag != FLAG_SCHEMALESS:
        if flag == FLAG_DELTA:
            raise ValueError("expected snapshot, got delta chain")
        if flag == FLAG_SCHEMAFUL:
            raise ValueError("schemaful decoding not yet implemented")
        raise ValueError(f"unknown document flag 0x{flag:02x}")
    return _read_message_body(r)


def _read_op(r: _ByteReader) -> dict:
    op_code = r.read_byte()
    path = _read_path(r)

    if op_code == OP.FIELD_SET:
        tag = r.read_byte()
        if is_container(tag):
            ctype = get_ctype(tag)
            if ctype == CTYPE.MESSAGE:
                message = _read_message_body(r)
                return {"op": op_code, "path": path, "value": {"message": message}}
            raise ValueError(f"container field_set only supports MESSAGE in v0.1")
        vtype = get_vtype(tag)
        value = _read_scalar(r, vtype)
        return {"op": op_code, "path": path, "value": {"vtype": vtype, "value": value}}
    elif op_code == OP.FIELD_DELETE:
        return {"op": op_code, "path": path}
    elif op_code == OP.MESSAGE_REPLACE:
        message = _read_message_body(r)
        return {"op": op_code, "path": path, "message": message}
    elif op_code == OP.REPEATED_APPEND:
        elem_tag = r.read_byte()
        elem_type = get_vtype(elem_tag)
        count = r.read_leb128()
        values = [_read_scalar(r, elem_type) for _ in range(count)]
        return {"op": op_code, "path": path, "elements": {"elemType": elem_type, "values": values}}
    elif op_code == OP.REPEATED_SPLICE:
        index = r.read_leb128()
        delete_count = r.read_leb128()
        elem_tag = r.read_byte()
        elem_type = get_vtype(elem_tag)
        insert_count = r.read_leb128()
        insert_values = [_read_scalar(r, elem_type) for _ in range(insert_count)]
        return {"op": op_code, "path": path, "index": index, "deleteCount": delete_count,
                "elemType": elem_type, "insertValues": insert_values}
    elif op_code == OP.MAP_SET:
        key_type_byte = r.read_byte()
        key_type = "string" if key_type_byte == 0 else "uint32"
        if key_type == "string":
            length = r.read_leb128()
            key = r.read_bytes(length).decode("utf-8")
        else:
            key = r.read_leb128()
        value_tag = r.read_byte()
        value_type = get_vtype(value_tag)
        value = _read_scalar(r, value_type)
        return {"op": op_code, "path": path, "keyType": key_type, "key": key,
                "valueType": value_type, "value": value}
    elif op_code == OP.MAP_DELETE:
        key_type_byte = r.read_byte()
        key_type = "string" if key_type_byte == 0 else "uint32"
        if key_type == "string":
            length = r.read_leb128()
            key = r.read_bytes(length).decode("utf-8")
        else:
            key = r.read_leb128()
        return {"op": op_code, "path": path, "keyType": key_type, "key": key}
    elif op_code == OP.ONEOF_SWITCH:
        active_field = r.read_leb128()
        value_tag = r.read_byte()
        value_type = get_vtype(value_tag)
        value = _read_scalar(r, value_type)
        return {"op": op_code, "path": path, "activeField": active_field,
                "valueType": value_type, "value": value}
    else:
        raise ValueError(f"unknown op code {op_code}")


def decode_chain(data: bytes) -> list:
    """Decode a delta chain, returning a list of op dicts."""
    r = _ByteReader(data)
    flag = r.read_byte()
    if flag != FLAG_DELTA:
        raise ValueError(f"expected delta chain (flag 0x01), got 0x{flag:02x}")
    count = r.read_leb128()
    return [_read_op(r) for _ in range(count)]
