// weavepack-wire — type constants.
// See weavepack/profiles/wire/01-types.md and 02-containers.md for the normative spec.

// Scalar value types (4-bit tag when bit 4 = 0).
pub const VTYPE_BOOL:    u8 = 0;
pub const VTYPE_INT32:   u8 = 1;
pub const VTYPE_INT64:   u8 = 2;
pub const VTYPE_UINT32:  u8 = 3;
pub const VTYPE_UINT64:  u8 = 4;
pub const VTYPE_SINT32:  u8 = 5;
pub const VTYPE_SINT64:  u8 = 6;
pub const VTYPE_FLOAT32: u8 = 7;
pub const VTYPE_FLOAT64: u8 = 8;
pub const VTYPE_STRING:  u8 = 9;
pub const VTYPE_BYTES:   u8 = 10;
pub const VTYPE_ENUM:    u8 = 11;

// Container types (2-bit tag when bit 4 = 1).
pub const CTYPE_MESSAGE:  u8 = 0;
pub const CTYPE_REPEATED: u8 = 1;
pub const CTYPE_MAP:      u8 = 2;
pub const CTYPE_ONEOF:    u8 = 3;

// Delta op codes (byte 0 of each op).
pub const OP_FIELD_SET:       u8 = 0;
pub const OP_FIELD_DELETE:    u8 = 1;
pub const OP_MESSAGE_REPLACE: u8 = 2;
pub const OP_REPEATED_APPEND: u8 = 3;
pub const OP_REPEATED_SPLICE: u8 = 4;
pub const OP_MAP_SET:         u8 = 5;
pub const OP_MAP_DELETE:      u8 = 6;
pub const OP_ONEOF_SWITCH:    u8 = 7;

// Path component types.
pub const PC_FIELD: u8 = 0;
pub const PC_MAP:   u8 = 1;
pub const PC_INDEX: u8 = 2;
pub const PC_END:   u8 = 3;

// Document flags (byte 0 of a document/chain payload).
pub const FLAG_SCHEMALESS: u8 = 0x00;
pub const FLAG_DELTA:      u8 = 0x01;
pub const FLAG_SCHEMAFUL:  u8 = 0x02;

// Maximum string/bytes payload the decoder will accept (256 MiB).
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;

pub fn scalar_tag(vtype: u8) -> u8 { vtype & 0x0F }
pub fn container_tag(ctype: u8) -> u8 { 0x10 | (ctype & 0x03) }
pub fn is_container(tag: u8) -> bool { (tag & 0x10) != 0 }
pub fn get_vtype(tag: u8) -> u8 { tag & 0x0F }
pub fn get_ctype(tag: u8) -> u8 { tag & 0x03 }

// Decoded representation of a single field.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Scalar(ScalarValue),
    Message(Vec<Field>),
    Repeated { elem_type: u8, values: Vec<ScalarValue> },
    Map { key_type: MapKeyType, value_type: u8, entries: Vec<(MapKey, ScalarValue)> },
    Oneof { active_field: u32, value_type: u8, value: ScalarValue },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub num: u32,
    pub value: FieldValue,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScalarValue {
    Bool(bool),
    Int32(i32),
    Int64(i64),
    Uint32(u32),
    Uint64(u64),
    Sint32(i32),
    Sint64(i64),
    Float32(f32),
    Float64(f64),
    String(String),
    Bytes(Vec<u8>),
    Enum(i32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MapKeyType { Str, Uint32 }

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum MapKey { Str(String), Uint32(u32) }

// Path component for delta ops.
#[derive(Debug, Clone, PartialEq)]
pub enum PathComp {
    Field(u32),
    Map(MapKey),
    Index(u32),
}

// A decoded delta op.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    FieldSet   { path: Vec<PathComp>, value: FieldValue },
    FieldDelete { path: Vec<PathComp> },
    MessageReplace { path: Vec<PathComp>, message: Vec<Field> },
    RepeatedAppend { path: Vec<PathComp>, elem_type: u8, values: Vec<ScalarValue> },
    RepeatedSplice { path: Vec<PathComp>, index: u32, delete_count: u32, elem_type: u8, insert_values: Vec<ScalarValue> },
    MapSet  { path: Vec<PathComp>, key_type: MapKeyType, key: MapKey, value_type: u8, value: ScalarValue },
    MapDelete { path: Vec<PathComp>, key_type: MapKeyType, key: MapKey },
    OneofSwitch { path: Vec<PathComp>, active_field: u32, value_type: u8, value: ScalarValue },
}
