// weavepack-wire decoder (schemaless snapshots + delta chains).

use crate::types::{
    Field, FieldValue, MapKey, MapKeyType, Op, PathComp, ScalarValue,
    FLAG_DELTA, FLAG_SCHEMALESS, FLAG_SCHEMAFUL,
    PC_END, PC_FIELD, PC_INDEX, PC_MAP,
    get_ctype, get_vtype, is_container,
    CTYPE_MAP, CTYPE_MESSAGE, CTYPE_ONEOF, CTYPE_REPEATED,
    VTYPE_BOOL, VTYPE_BYTES, VTYPE_ENUM, VTYPE_FLOAT32, VTYPE_FLOAT64,
    VTYPE_INT32, VTYPE_INT64, VTYPE_SINT32, VTYPE_SINT64,
    VTYPE_STRING, VTYPE_UINT32, VTYPE_UINT64,
    MAX_PAYLOAD_BYTES,
};

struct ByteReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    fn new(buf: &'a [u8]) -> Self { ByteReader { buf, pos: 0 } }

    fn read_byte(&mut self) -> Result<u8, String> {
        if self.pos >= self.buf.len() {
            return Err("unexpected end of input".into());
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() {
            return Err("unexpected end of input".into());
        }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn read_leb128_u32(&mut self) -> Result<u32, String> {
        let mut result: u32 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.read_byte()?;
            result |= ((b & 0x7F) as u32) << shift;
            shift += 7;
            if (b & 0x80) == 0 { break; }
            if shift >= 35 { return Err("LEB128 overflow for uint32".into()); }
        }
        Ok(result)
    }

    fn read_leb128_u64(&mut self) -> Result<u64, String> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.read_byte()?;
            result |= ((b & 0x7F) as u64) << shift;
            shift += 7;
            if (b & 0x80) == 0 { break; }
            if shift >= 70 { return Err("LEB128 overflow for uint64".into()); }
        }
        Ok(result)
    }
}

fn read_scalar(r: &mut ByteReader, vtype: u8) -> Result<ScalarValue, String> {
    match vtype {
        VTYPE_BOOL => Ok(ScalarValue::Bool(r.read_byte()? != 0)),
        VTYPE_INT32 => {
            let u = r.read_leb128_u32()?;
            Ok(ScalarValue::Int32(u as i32))
        }
        VTYPE_INT64 => {
            let u = r.read_leb128_u64()?;
            Ok(ScalarValue::Int64(u as i64))
        }
        VTYPE_UINT32 => Ok(ScalarValue::Uint32(r.read_leb128_u32()?)),
        VTYPE_UINT64 => Ok(ScalarValue::Uint64(r.read_leb128_u64()?)),
        VTYPE_SINT32 => {
            let z = r.read_leb128_u32()?;
            let v = ((z >> 1) as i32) ^ -((z & 1) as i32);
            Ok(ScalarValue::Sint32(v))
        }
        VTYPE_SINT64 => {
            let z = r.read_leb128_u64()?;
            let v = ((z >> 1) as i64) ^ -((z & 1) as i64);
            Ok(ScalarValue::Sint64(v))
        }
        VTYPE_FLOAT32 => {
            let b = r.read_bytes(4)?;
            Ok(ScalarValue::Float32(f32::from_le_bytes(b.try_into().unwrap())))
        }
        VTYPE_FLOAT64 => {
            let b = r.read_bytes(8)?;
            Ok(ScalarValue::Float64(f64::from_le_bytes(b.try_into().unwrap())))
        }
        VTYPE_STRING => {
            let len = r.read_leb128_u64()? as usize;
            if len > MAX_PAYLOAD_BYTES { return Err("string exceeds 256 MiB limit".into()); }
            let bytes = r.read_bytes(len)?;
            String::from_utf8(bytes.to_vec()).map(ScalarValue::String)
                .map_err(|e| format!("string UTF-8 error: {e}"))
        }
        VTYPE_BYTES => {
            let len = r.read_leb128_u64()? as usize;
            if len > MAX_PAYLOAD_BYTES { return Err("bytes exceeds 256 MiB limit".into()); }
            Ok(ScalarValue::Bytes(r.read_bytes(len)?.to_vec()))
        }
        VTYPE_ENUM => {
            let u = r.read_leb128_u32()?;
            Ok(ScalarValue::Enum(u as i32))
        }
        _ => Err(format!("unknown vtype {vtype}")),
    }
}

fn read_map_key(r: &mut ByteReader, key_type: &MapKeyType) -> Result<MapKey, String> {
    match key_type {
        MapKeyType::Str => {
            let len = r.read_leb128_u64()? as usize;
            let bytes = r.read_bytes(len)?;
            let s = String::from_utf8(bytes.to_vec())
                .map_err(|e| format!("map key UTF-8 error: {e}"))?;
            Ok(MapKey::Str(s))
        }
        MapKeyType::Uint32 => Ok(MapKey::Uint32(r.read_leb128_u32()?)),
    }
}

fn read_field_value(r: &mut ByteReader, field_num: u32) -> Result<Field, String> {
    let tag = r.read_byte()?;
    if !is_container(tag) {
        let vtype = get_vtype(tag);
        let sv = read_scalar(r, vtype)?;
        return Ok(Field { num: field_num, value: FieldValue::Scalar(sv) });
    }
    let ctype = get_ctype(tag);
    match ctype {
        CTYPE_MESSAGE => {
            let fields = read_message_body(r)?;
            Ok(Field { num: field_num, value: FieldValue::Message(fields) })
        }
        CTYPE_REPEATED => {
            let elem_tag = r.read_byte()?;
            let elem_type = get_vtype(elem_tag);
            let count = r.read_leb128_u64()? as usize;
            let mut values = Vec::with_capacity(count);
            for _ in 0..count { values.push(read_scalar(r, elem_type)?); }
            Ok(Field { num: field_num, value: FieldValue::Repeated { elem_type, values } })
        }
        CTYPE_MAP => {
            let key_type_byte = r.read_byte()?;
            let key_type = if key_type_byte == 0 { MapKeyType::Str } else { MapKeyType::Uint32 };
            let value_tag = r.read_byte()?;
            let value_type = get_vtype(value_tag);
            let count = r.read_leb128_u64()? as usize;
            let mut entries = Vec::with_capacity(count);
            for _ in 0..count {
                let k = read_map_key(r, &key_type)?;
                let v = read_scalar(r, value_type)?;
                entries.push((k, v));
            }
            Ok(Field { num: field_num, value: FieldValue::Map { key_type, value_type, entries } })
        }
        CTYPE_ONEOF => {
            let active_field = r.read_leb128_u32()?;
            let value_tag = r.read_byte()?;
            let value_type = get_vtype(value_tag);
            let value = read_scalar(r, value_type)?;
            Ok(Field { num: field_num, value: FieldValue::Oneof { active_field, value_type, value } })
        }
        _ => Err(format!("unknown ctype {ctype}")),
    }
}

fn read_message_body(r: &mut ByteReader) -> Result<Vec<Field>, String> {
    let count = r.read_leb128_u64()? as usize;
    let mut fields = Vec::with_capacity(count);
    let mut last_num: i64 = -1;
    for _ in 0..count {
        let num = r.read_leb128_u32()?;
        if (num as i64) <= last_num {
            return Err(format!("field_order_violation: field {num} after {last_num}"));
        }
        last_num = num as i64;
        fields.push(read_field_value(r, num)?);
    }
    Ok(fields)
}

fn read_path(r: &mut ByteReader) -> Result<Vec<PathComp>, String> {
    let mut path = Vec::new();
    loop {
        let comp_type = r.read_byte()?;
        match comp_type {
            PC_END => break,
            PC_FIELD => {
                let n = r.read_leb128_u32()?;
                path.push(PathComp::Field(n));
            }
            PC_MAP => {
                let key_type_byte = r.read_byte()?;
                if key_type_byte == 0 {
                    let len = r.read_leb128_u64()? as usize;
                    let bytes = r.read_bytes(len)?;
                    let s = String::from_utf8(bytes.to_vec())
                        .map_err(|e| format!("map path key UTF-8 error: {e}"))?;
                    path.push(PathComp::Map(MapKey::Str(s)));
                } else {
                    let n = r.read_leb128_u32()?;
                    path.push(PathComp::Map(MapKey::Uint32(n)));
                }
            }
            PC_INDEX => {
                let i = r.read_leb128_u32()?;
                path.push(PathComp::Index(i));
            }
            _ => return Err(format!("unknown path component type {comp_type}")),
        }
    }
    Ok(path)
}

fn read_op(r: &mut ByteReader) -> Result<Op, String> {
    let op_code = r.read_byte()?;
    let path = read_path(r)?;

    match op_code {
        crate::types::OP_FIELD_SET => {
            let tag = r.read_byte()?;
            let value = if is_container(tag) {
                let ctype = get_ctype(tag);
                if ctype == CTYPE_MESSAGE {
                    FieldValue::Message(read_message_body(r)?)
                } else {
                    return Err(format!("container field_set only supports MESSAGE in v0.1"));
                }
            } else {
                let vtype = get_vtype(tag);
                FieldValue::Scalar(read_scalar(r, vtype)?)
            };
            Ok(Op::FieldSet { path, value })
        }
        crate::types::OP_FIELD_DELETE => Ok(Op::FieldDelete { path }),
        crate::types::OP_MESSAGE_REPLACE => {
            let message = read_message_body(r)?;
            Ok(Op::MessageReplace { path, message })
        }
        crate::types::OP_REPEATED_APPEND => {
            let elem_tag = r.read_byte()?;
            let elem_type = get_vtype(elem_tag);
            let count = r.read_leb128_u64()? as usize;
            let mut values = Vec::with_capacity(count);
            for _ in 0..count { values.push(read_scalar(r, elem_type)?); }
            Ok(Op::RepeatedAppend { path, elem_type, values })
        }
        crate::types::OP_REPEATED_SPLICE => {
            let index = r.read_leb128_u32()?;
            let delete_count = r.read_leb128_u32()?;
            let elem_tag = r.read_byte()?;
            let elem_type = get_vtype(elem_tag);
            let insert_count = r.read_leb128_u64()? as usize;
            let mut insert_values = Vec::with_capacity(insert_count);
            for _ in 0..insert_count { insert_values.push(read_scalar(r, elem_type)?); }
            Ok(Op::RepeatedSplice { path, index, delete_count, elem_type, insert_values })
        }
        crate::types::OP_MAP_SET => {
            let key_type_byte = r.read_byte()?;
            let key_type = if key_type_byte == 0 { MapKeyType::Str } else { MapKeyType::Uint32 };
            let key = read_map_key(r, &key_type)?;
            let value_tag = r.read_byte()?;
            let value_type = get_vtype(value_tag);
            let value = read_scalar(r, value_type)?;
            Ok(Op::MapSet { path, key_type, key, value_type, value })
        }
        crate::types::OP_MAP_DELETE => {
            let key_type_byte = r.read_byte()?;
            let key_type = if key_type_byte == 0 { MapKeyType::Str } else { MapKeyType::Uint32 };
            let key = read_map_key(r, &key_type)?;
            Ok(Op::MapDelete { path, key_type, key })
        }
        crate::types::OP_ONEOF_SWITCH => {
            let active_field = r.read_leb128_u32()?;
            let value_tag = r.read_byte()?;
            let value_type = get_vtype(value_tag);
            let value = read_scalar(r, value_type)?;
            Ok(Op::OneofSwitch { path, active_field, value_type, value })
        }
        _ => Err(format!("unknown op code {op_code}")),
    }
}

pub fn decode_document(bytes: &[u8]) -> Result<Vec<Field>, String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag != FLAG_SCHEMALESS {
        if flag == FLAG_DELTA    { return Err("expected snapshot, got delta chain".into()); }
        if flag == FLAG_SCHEMAFUL { return Err("schemaful decoding not yet implemented".into()); }
        return Err(format!("unknown document flag 0x{flag:02x}"));
    }
    read_message_body(&mut r)
}

pub fn decode_chain(bytes: &[u8]) -> Result<Vec<Op>, String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag != FLAG_DELTA {
        return Err(format!("expected delta chain (flag 0x01), got 0x{flag:02x}"));
    }
    let count = r.read_leb128_u64()? as usize;
    let mut ops = Vec::with_capacity(count);
    for _ in 0..count { ops.push(read_op(&mut r)?); }
    Ok(ops)
}
