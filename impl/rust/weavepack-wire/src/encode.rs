// weavepack-wire encoder (schemaless snapshots + delta chains).
//
// Wire format (snapshot):
//   byte 0: FLAG_SCHEMALESS (0x00)
//   LEB128(field_count)
//   for each field (ascending field_number order):
//     LEB128(field_number)
//     1 byte type_tag
//     value bytes
//
// Wire format (delta chain):
//   byte 0: FLAG_DELTA (0x01)
//   LEB128(op_count)
//   for each op: 1 byte op_code + path bytes + value bytes

use crate::types::{
    Field, FieldValue, MapKey, MapKeyType, Op, PathComp, ScalarValue,
    FLAG_DELTA, FLAG_SCHEMALESS, PC_END, PC_FIELD, PC_INDEX, PC_MAP,
    container_tag, scalar_tag,
    CTYPE_MAP, CTYPE_MESSAGE, CTYPE_ONEOF, CTYPE_REPEATED,
    MAX_PAYLOAD_BYTES,
};

struct ByteWriter { buf: Vec<u8> }

impl ByteWriter {
    fn new() -> Self { ByteWriter { buf: Vec::new() } }

    fn write_byte(&mut self, b: u8) { self.buf.push(b); }

    fn write_bytes(&mut self, src: &[u8]) { self.buf.extend_from_slice(src); }

    fn write_leb128_u32(&mut self, mut v: u32) {
        loop {
            if v < 128 { self.buf.push(v as u8); break; }
            self.buf.push((v as u8 & 0x7F) | 0x80);
            v >>= 7;
        }
    }

    fn write_leb128_u64(&mut self, mut v: u64) {
        loop {
            if v < 128 { self.buf.push(v as u8); break; }
            self.buf.push((v as u8 & 0x7F) | 0x80);
            v >>= 7;
        }
    }

    fn into_bytes(self) -> Vec<u8> { self.buf }
}

fn write_scalar(w: &mut ByteWriter, _vtype: u8, val: &ScalarValue) {
    match val {
        ScalarValue::Bool(b) => w.write_byte(if *b { 1 } else { 0 }),
        ScalarValue::Int32(v) => {
            // Two's-complement as unsigned LEB128.
            w.write_leb128_u32(*v as u32)
        }
        ScalarValue::Int64(v) => {
            w.write_leb128_u64(*v as u64)
        }
        ScalarValue::Uint32(v) => w.write_leb128_u32(*v),
        ScalarValue::Uint64(v) => w.write_leb128_u64(*v),
        ScalarValue::Sint32(v) => {
            // Zigzag encoding.
            let z = ((*v << 1) ^ (*v >> 31)) as u32;
            w.write_leb128_u32(z)
        }
        ScalarValue::Sint64(v) => {
            let z = ((*v << 1) ^ (*v >> 63)) as u64;
            w.write_leb128_u64(z)
        }
        ScalarValue::Float32(v) => {
            w.write_bytes(&v.to_le_bytes())
        }
        ScalarValue::Float64(v) => {
            w.write_bytes(&v.to_le_bytes())
        }
        ScalarValue::String(s) => {
            let utf8 = s.as_bytes();
            if utf8.len() > MAX_PAYLOAD_BYTES { panic!("string exceeds 256 MiB limit") }
            w.write_leb128_u64(utf8.len() as u64);
            w.write_bytes(utf8);
        }
        ScalarValue::Bytes(b) => {
            if b.len() > MAX_PAYLOAD_BYTES { panic!("bytes exceeds 256 MiB limit") }
            w.write_leb128_u64(b.len() as u64);
            w.write_bytes(b);
        }
        ScalarValue::Enum(v) => {
            w.write_leb128_u32(*v as u32)
        }
    }
}

fn write_field_value(w: &mut ByteWriter, val: &FieldValue) {
    match val {
        FieldValue::Scalar(sv) => {
            let vtype = scalar_vtype(sv);
            w.write_byte(scalar_tag(vtype));
            write_scalar(w, vtype, sv);
        }
        FieldValue::Message(fields) => {
            w.write_byte(container_tag(CTYPE_MESSAGE));
            write_message_body(w, fields);
        }
        FieldValue::Repeated { elem_type, values } => {
            w.write_byte(container_tag(CTYPE_REPEATED));
            w.write_byte(scalar_tag(*elem_type));
            w.write_leb128_u64(values.len() as u64);
            for v in values { write_scalar(w, *elem_type, v); }
        }
        FieldValue::Map { key_type, value_type, entries } => {
            w.write_byte(container_tag(CTYPE_MAP));
            w.write_byte(if *key_type == MapKeyType::Str { 0 } else { 1 });
            w.write_byte(scalar_tag(*value_type));
            w.write_leb128_u64(entries.len() as u64);
            for (k, v) in entries {
                write_map_key(w, k);
                write_scalar(w, *value_type, v);
            }
        }
        FieldValue::Oneof { active_field, value_type, value } => {
            w.write_byte(container_tag(CTYPE_ONEOF));
            w.write_leb128_u32(*active_field);
            w.write_byte(scalar_tag(*value_type));
            write_scalar(w, *value_type, value);
        }
    }
}

fn write_map_key(w: &mut ByteWriter, key: &MapKey) {
    match key {
        MapKey::Str(s) => {
            let utf8 = s.as_bytes();
            w.write_leb128_u64(utf8.len() as u64);
            w.write_bytes(utf8);
        }
        MapKey::Uint32(n) => w.write_leb128_u32(*n),
    }
}

fn write_message_body(w: &mut ByteWriter, fields: &[Field]) {
    let mut sorted: Vec<&Field> = fields.iter().collect();
    sorted.sort_by_key(|f| f.num);
    w.write_leb128_u64(sorted.len() as u64);
    for f in sorted {
        w.write_leb128_u32(f.num);
        write_field_value(w, &f.value);
    }
}

fn write_path(w: &mut ByteWriter, path: &[PathComp]) {
    for comp in path {
        match comp {
            PathComp::Field(n) => {
                w.write_byte(PC_FIELD);
                w.write_leb128_u32(*n);
            }
            PathComp::Map(key) => {
                w.write_byte(PC_MAP);
                match key {
                    MapKey::Str(s) => {
                        w.write_byte(0);
                        let utf8 = s.as_bytes();
                        w.write_leb128_u64(utf8.len() as u64);
                        w.write_bytes(utf8);
                    }
                    MapKey::Uint32(n) => {
                        w.write_byte(1);
                        w.write_leb128_u32(*n);
                    }
                }
            }
            PathComp::Index(i) => {
                w.write_byte(PC_INDEX);
                w.write_leb128_u32(*i);
            }
        }
    }
    w.write_byte(PC_END);
}

fn write_op(w: &mut ByteWriter, op: &Op) {
    match op {
        Op::FieldSet { path, value } => {
            w.write_byte(crate::types::OP_FIELD_SET);
            write_path(w, path);
            write_field_value(w, value);
        }
        Op::FieldDelete { path } => {
            w.write_byte(crate::types::OP_FIELD_DELETE);
            write_path(w, path);
        }
        Op::MessageReplace { path, message } => {
            w.write_byte(crate::types::OP_MESSAGE_REPLACE);
            write_path(w, path);
            write_message_body(w, message);
        }
        Op::RepeatedAppend { path, elem_type, values } => {
            w.write_byte(crate::types::OP_REPEATED_APPEND);
            write_path(w, path);
            w.write_byte(scalar_tag(*elem_type));
            w.write_leb128_u64(values.len() as u64);
            for v in values { write_scalar(w, *elem_type, v); }
        }
        Op::RepeatedSplice { path, index, delete_count, elem_type, insert_values } => {
            w.write_byte(crate::types::OP_REPEATED_SPLICE);
            write_path(w, path);
            w.write_leb128_u32(*index);
            w.write_leb128_u32(*delete_count);
            w.write_byte(scalar_tag(*elem_type));
            w.write_leb128_u64(insert_values.len() as u64);
            for v in insert_values { write_scalar(w, *elem_type, v); }
        }
        Op::MapSet { path, key_type, key, value_type, value } => {
            w.write_byte(crate::types::OP_MAP_SET);
            write_path(w, path);
            w.write_byte(if *key_type == MapKeyType::Str { 0 } else { 1 });
            write_map_key(w, key);
            w.write_byte(scalar_tag(*value_type));
            write_scalar(w, *value_type, value);
        }
        Op::MapDelete { path, key_type, key } => {
            w.write_byte(crate::types::OP_MAP_DELETE);
            write_path(w, path);
            w.write_byte(if *key_type == MapKeyType::Str { 0 } else { 1 });
            write_map_key(w, key);
        }
        Op::OneofSwitch { path, active_field, value_type, value } => {
            w.write_byte(crate::types::OP_ONEOF_SWITCH);
            write_path(w, path);
            w.write_leb128_u32(*active_field);
            w.write_byte(scalar_tag(*value_type));
            write_scalar(w, *value_type, value);
        }
    }
}

pub fn encode_document(fields: &[Field]) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_byte(FLAG_SCHEMALESS);
    write_message_body(&mut w, fields);
    w.into_bytes()
}

pub fn encode_chain(ops: &[Op]) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_byte(FLAG_DELTA);
    w.write_leb128_u64(ops.len() as u64);
    for op in ops { write_op(&mut w, op); }
    w.into_bytes()
}

// Helper: infer the vtype u8 from a ScalarValue (for tag encoding).
pub fn scalar_vtype(sv: &ScalarValue) -> u8 {
    match sv {
        ScalarValue::Bool(_)    => crate::types::VTYPE_BOOL,
        ScalarValue::Int32(_)   => crate::types::VTYPE_INT32,
        ScalarValue::Int64(_)   => crate::types::VTYPE_INT64,
        ScalarValue::Uint32(_)  => crate::types::VTYPE_UINT32,
        ScalarValue::Uint64(_)  => crate::types::VTYPE_UINT64,
        ScalarValue::Sint32(_)  => crate::types::VTYPE_SINT32,
        ScalarValue::Sint64(_)  => crate::types::VTYPE_SINT64,
        ScalarValue::Float32(_) => crate::types::VTYPE_FLOAT32,
        ScalarValue::Float64(_) => crate::types::VTYPE_FLOAT64,
        ScalarValue::String(_)  => crate::types::VTYPE_STRING,
        ScalarValue::Bytes(_)   => crate::types::VTYPE_BYTES,
        ScalarValue::Enum(_)    => crate::types::VTYPE_ENUM,
    }
}
