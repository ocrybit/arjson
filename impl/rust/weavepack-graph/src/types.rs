// weavepack-graph — type constants and data structures.
// See weavepack/profiles/graph/01-types.md for the normative spec.

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
pub const CTYPE_NODE_ID:     u8 = 15; // wire-identical to uint64; semantic: node reference

// Delta op codes (3 bits, 0–5; codes 6–7 reserved).
pub const OP_NODE_INSERT:      u8 = 0;
pub const OP_NODE_DELETE:      u8 = 1;
pub const OP_EDGE_INSERT:      u8 = 2;
pub const OP_EDGE_DELETE:      u8 = 3;
pub const OP_PROP_SET:         u8 = 4;
pub const OP_SUBGRAPH_REPLACE: u8 = 5;

// Wire path_kind discriminants (4 bits, packed in high nibble of path byte).
pub const PATH_NODE:           u8 = 0;
pub const PATH_NODE_COL:       u8 = 1;
pub const PATH_EDGE:           u8 = 2;
pub const PATH_EDGE_COL:       u8 = 3;
pub const PATH_NODE_LABEL:     u8 = 4;
pub const PATH_NODE_LABEL_COL: u8 = 5;
pub const PATH_EDGE_LABEL:     u8 = 6;
pub const PATH_EDGE_LABEL_COL: u8 = 7;
pub const PATH_AT_NID:         u8 = 8;
pub const PATH_AT_EID:         u8 = 9;
pub const PATH_AT_SRC:         u8 = 10;
pub const PATH_AT_DST:         u8 = 11;
pub const PATH_AT_LABEL:       u8 = 12;
pub const PATH_NODE_PROP:      u8 = 13;
pub const PATH_EDGE_PROP:      u8 = 14;
// 15 = reserved

pub const BLOCK_TYPE_NODE: u8 = 0;
pub const BLOCK_TYPE_EDGE: u8 = 1;

pub const GRAPH_VERSION: u32 = 1;
pub const PROFILE_NUM:   u32 = 6;

pub const SCHEMA_HASH_BYTES: usize = 32;

// 1 GiB safety limit for string/bytes payloads (matching JS impl).
pub const MAX_PAYLOAD_BYTES: usize = 1 * 1024 * 1024 * 1024;

// ── Cell value ──────────────────────────────────────────────────────────────

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
    Uint64(u64),   // also used for CTYPE_NODE_ID and CTYPE_TIMESTAMP64 (unsigned side)
    Float32(f32),
    Float64(f64),
    String(String),
    Bytes(Vec<u8>),
    Date32(i32),
    Timestamp64(i64),
    NodeId(u64),   // ctype 15; same wire encoding as uint64
}

// ── Property column ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PropCol {
    pub col_id:   u32,
    pub ctype:    u8,
    pub nullable: bool,
    pub values:   Vec<Option<CellValue>>,
}

// ── Block types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NodeBlock {
    pub label:   Option<String>,
    pub nids:    Vec<u64>,
    pub columns: Vec<PropCol>,
}

#[derive(Debug, Clone)]
pub struct EdgeBlock {
    pub label:   Option<String>,
    pub eids:    Vec<u64>,
    pub srcs:    Vec<u64>,
    pub dsts:    Vec<u64>,
    pub columns: Vec<PropCol>,
}

#[derive(Debug, Clone)]
pub enum Block {
    Node(NodeBlock),
    Edge(EdgeBlock),
}

// ── Graph document (snapshot) ───────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GraphDoc {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub blocks:      Vec<Block>,
}

// ── Path (for delta ops) ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Path {
    Node           { nid: u64 },
    NodeCol        { nid: u64, col_id: u32 },
    Edge           { eid: u64 },
    EdgeCol        { eid: u64, col_id: u32 },
    NodeLabel      { label: String },
    NodeLabelCol   { label: String, col_id: u32 },
    EdgeLabel      { label: String },
    EdgeLabelCol   { label: String, col_id: u32 },
    AtNid,
    AtEid,
    AtSrc,
    AtDst,
    AtLabel        { label: String },
    NodeProp       { nid: u64, prop: String },
    EdgeProp       { eid: u64, prop: String },
}

// ── Delta ops ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Op {
    NodeInsert {
        block: NodeBlock,
    },
    NodeDelete {
        nids: Vec<u64>,
    },
    EdgeInsert {
        block: EdgeBlock,
    },
    EdgeDelete {
        eids: Vec<u64>,
    },
    PropSet {
        path:     Path,
        ctype:    u8,
        nullable: bool,
        is_null:  bool,
        value:    Option<CellValue>,
    },
    SubgraphReplace {
        label:      Option<String>,
        node_block: Option<NodeBlock>,
        edge_block: Option<EdgeBlock>,
    },
}
