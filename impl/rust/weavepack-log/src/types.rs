// weavepack-log — type constants and data structures.
// See weavepack/profiles/log/01-types.md for the normative spec.

// Column type codes (5 bits, lower 5 bits of type_byte).
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
// ctype 15 = EXT (reserved extension, not implemented in v0.1)
pub const CTYPE_LEVEL:       u8 = 16;

// Delta op codes (0..4; 5-7 reserved).
pub const OP_EVENT_APPEND:      u8 = 0;
pub const OP_FIELD_UPDATE:      u8 = 1;
pub const OP_EVENT_EXPIRE:      u8 = 2;
pub const OP_SCHEMA_EVOLVE:     u8 = 3;
pub const OP_CURSOR_CHECKPOINT: u8 = 4;

// Schema-evolve sub-op codes (0..2; 3 reserved).
pub const SUB_COLUMN_ADD:    u8 = 0;
pub const SUB_COLUMN_DROP:   u8 = 1;
pub const SUB_COLUMN_RENAME: u8 = 2;

// Frame type flags (byte 0).
pub const FRAME_SNAPSHOT:      u8 = 0x00;
pub const FRAME_DELTA:         u8 = 0x01;
pub const FRAME_STREAM_HEADER: u8 = 0x02;

pub const SCHEMA_HASH_BYTES: usize = 32;
pub const STREAM_ID_BYTES:   usize = 16;

// 256 MiB safety limit for string/bytes payloads.
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;

// ── Cell value ──────────────────────────────────────────────────────────────────────────────

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
    Level(u8),   // 0-5 severity level
}

// A single user column in a decoded event batch.
#[derive(Debug, Clone)]
pub struct Column {
    pub col_id:   u32,
    pub ctype:    u8,
    pub nullable: bool,
    pub values:   Vec<Option<CellValue>>,
}

// A decoded event batch (snapshot frame).
#[derive(Debug, Clone)]
pub struct Batch {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub seqs:        Vec<u64>,   // strictly ascending seq numbers
    pub tss:         Vec<i64>,   // non-decreasing timestamps (microseconds)
    pub columns:     Vec<Column>,
}

// A decoded stream header.
#[derive(Debug, Clone)]
pub struct StreamHeader {
    pub stream_id:   [u8; STREAM_ID_BYTES],
    pub source:      String,
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub seq_start:   u64,
}

// ── Schema tracking ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SchemaCol {
    pub col_id:   u32,
    pub ctype:    u8,
    pub nullable: bool,
    pub name:     String,
}

// ── Delta op types ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AppendColumn {
    pub col_id:   u32,
    pub ctype:    u8,
    pub nullable: bool,
    pub values:   Vec<Option<CellValue>>,
}

#[derive(Debug, Clone)]
pub struct UpdateField {
    pub col_id:    u32,
    pub ctype:     u8,
    pub has_value: bool,
    pub value:     Option<CellValue>,
}

#[derive(Debug, Clone)]
pub enum Op {
    EventAppend {
        seqs:    Vec<u64>,
        tss:     Vec<i64>,
        columns: Vec<AppendColumn>,
    },
    FieldUpdate {
        seq:     u64,
        columns: Vec<UpdateField>,
    },
    EventExpire {
        seq_lo: u64,
        seq_hi: u64,
    },
    SchemaColumnAdd {
        col_id:   u32,
        ctype:    u8,
        nullable: bool,
        name:     String,
    },
    SchemaColumnDrop {
        col_id: u32,
    },
    SchemaColumnRename {
        col_id: u32,
        name:   String,
    },
    CursorCheckpoint {
        seq:  u64,
        name: String,
    },
}

// Full runtime state of a log stream (batch + metadata).
#[derive(Debug, Clone)]
pub struct StreamState {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub seqs:        Vec<u64>,
    pub tss:         Vec<i64>,
    pub columns:     Vec<Column>,
    pub expired:     std::collections::HashSet<u64>,
    pub cursors:     std::collections::HashMap<String, u64>,
    pub schema:      Vec<SchemaCol>,
}
