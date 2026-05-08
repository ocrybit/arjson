// weavepack-tabular — type constants and data structures.
// See weavepack/profiles/tabular/01-types.md for the normative spec.

// Column type codes (4 bits, lower nibble of type_byte).
pub const CTYPE_BOOL:        u8 = 0;
pub const CTYPE_INT8:        u8 = 1;
pub const CTYPE_INT16:       u8 = 2;
pub const CTYPE_INT32:       u8 = 3;
pub const CTYPE_INT64:       u8 = 4;
pub const CTYPE_UINT8:       u8 = 5;
pub const CTYPE_UINT16:      u8 = 6;
pub const CTYPE_UINT32:      u8 = 7;
pub const CTYPE_UINT64:      u8 = 8;
pub const CTYPE_FLOAT32:     u8 = 9;
pub const CTYPE_FLOAT64:     u8 = 10;
pub const CTYPE_STRING:      u8 = 11;
pub const CTYPE_BYTES:       u8 = 12;
pub const CTYPE_DATE32:      u8 = 13;
pub const CTYPE_TIMESTAMP64: u8 = 14;

// Delta op codes.
pub const OP_ROW_INSERT:    u8 = 0;
pub const OP_ROW_UPDATE:    u8 = 1;
pub const OP_ROW_DELETE:    u8 = 2;
pub const OP_COLUMN_ADD:    u8 = 3;
pub const OP_COLUMN_DROP:   u8 = 4;
pub const OP_COLUMN_RENAME: u8 = 5;
pub const OP_BATCH_UPSERT:  u8 = 6;

// Frame type flags (byte 0).
pub const FLAG_SNAPSHOT: u8 = 0x00;
pub const FLAG_DELTA:    u8 = 0x01;

pub const SCHEMA_HASH_BYTES: usize = 32;

// 256 MiB safety limit for string/bytes payloads.
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;

// ── Decoded value for a single cell ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Bool(bool),
    Int8(i8),
    Int16(i16),
    Int32(i32),
    Int64(i64),
    Uint8(u8),
    Uint16(u16),
    Uint32(u32),
    Uint64(u64),
    Float32(f32),
    Float64(f64),
    String(String),
    Bytes(Vec<u8>),
    Date32(i32),
    Timestamp64(i64),
    Null,
}

// A single column in a decoded frame.
#[derive(Debug, Clone)]
pub struct Column {
    pub col_id:   u32,
    pub ctype:    u8,
    pub nullable: bool,
    pub values:   Vec<Option<CellValue>>,
    pub name:     Option<String>,
}

// A decoded snapshot frame.
#[derive(Debug, Clone)]
pub struct Frame {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub row_ids:     Vec<u64>,
    pub columns:     Vec<Column>,
}

// ── Delta op types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct OpColumn {
    pub col_id:   u32,
    pub ctype:    u8,
    pub nullable: bool,
    pub values:   Vec<Option<CellValue>>,
}

#[derive(Debug, Clone)]
pub enum Op {
    RowInsert    { row_ids: Vec<u64>, columns: Vec<OpColumn> },
    RowUpdate    { row_ids: Vec<u64>, columns: Vec<OpColumn> },
    RowDelete    { row_ids: Vec<u64> },
    ColumnAdd    { col_id: u32, ctype: u8, nullable: bool, has_default: bool, default_value: Option<CellValue> },
    ColumnDrop   { col_id: u32 },
    ColumnRename { col_id: u32, name: String },
    BatchUpsert  { row_ids: Vec<u64>, columns: Vec<OpColumn> },
}
