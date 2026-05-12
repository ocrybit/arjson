// weavepack-ast — type constants and data structures.
// See weavepack/profiles/ast/01-types.md for the normative spec.

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
pub const CTYPE_NODE_ID:     u8 = 15;

// Delta op codes (bits 2–0 of the op header byte; codes 6–7 reserved).
pub const OP_NODE_INSERT:     u8 = 0;
pub const OP_NODE_DELETE:     u8 = 1;
pub const OP_NODE_MOVE:       u8 = 2;
pub const OP_PROP_SET:        u8 = 3;
pub const OP_KIND_RENAME:     u8 = 4;
pub const OP_SUBTREE_REPLACE: u8 = 5;

// Wire path_kind discriminants (4 bits in high nibble of path byte).
pub const PATH_NODE:           u8 = 0;
pub const PATH_NODE_COL:       u8 = 1;
pub const PATH_NODE_KIND:      u8 = 2;
pub const PATH_AT_NID:         u8 = 3;
pub const PATH_AT_PARENT:      u8 = 4;
pub const PATH_AT_CHILD_INDEX: u8 = 5;
pub const PATH_AT_KIND:        u8 = 6;
pub const PATH_NODE_PROP:      u8 = 7;
// 8–15 = reserved

pub const BLOCK_TYPE_NODE:  u8 = 0x00;
pub const BLOCK_TYPE_MIXED: u8 = 0x01;

pub const AST_VERSION: u32 = 1;
pub const PROFILE_NUM: u32 = 7;

pub const SCHEMA_HASH_BYTES: usize = 32;

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
    Uint64(u64),
    Float32(f32),
    Float64(f64),
    String(String),
    Bytes(Vec<u8>),
    Date32(i32),
    Timestamp64(i64),
    NodeId(u64),
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
    pub kind:          String,
    pub nids:          Vec<u64>,
    pub parent_nids:   Vec<Option<u64>>,
    pub child_indices: Vec<u32>,
    pub columns:       Vec<PropCol>,
}

#[derive(Debug, Clone)]
pub struct MixedBlock {
    pub kinds:         Vec<String>,
    pub nids:          Vec<u64>,
    pub parent_nids:   Vec<Option<u64>>,
    pub child_indices: Vec<u32>,
    pub columns:       Vec<PropCol>,
}

#[derive(Debug, Clone)]
pub enum Block {
    Node(NodeBlock),
    Mixed(MixedBlock),
}

impl Block {
    pub fn nids(&self) -> &[u64] {
        match self { Block::Node(b) => &b.nids, Block::Mixed(b) => &b.nids }
    }
    pub fn parent_nids(&self) -> &[Option<u64>] {
        match self { Block::Node(b) => &b.parent_nids, Block::Mixed(b) => &b.parent_nids }
    }
    pub fn child_indices(&self) -> &[u32] {
        match self { Block::Node(b) => &b.child_indices, Block::Mixed(b) => &b.child_indices }
    }
    pub fn columns(&self) -> &[PropCol] {
        match self { Block::Node(b) => &b.columns, Block::Mixed(b) => &b.columns }
    }
}

// ── AST document (snapshot) ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AstDoc {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub blocks:      Vec<Block>,
}

// ── Path (for delta ops) ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Path {
    Node          { nid: u64 },
    NodeCol       { nid: u64, col_id: u32 },
    NodeKind      { node_kind: String },
    AtNid,
    AtParent,
    AtChildIndex,
    AtKind,
    NodeProp      { nid: u64, prop: String },
}

// ── Delta ops ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Op {
    NodeInsert {
        block: Block,
    },
    NodeDelete {
        nids: Vec<u64>,
    },
    NodeMove {
        nid:             u64,
        new_parent_nid:  u64,
        new_child_index: u32,
    },
    PropSet {
        path:     Path,
        ctype:    u8,
        nullable: bool,
        is_null:  bool,
        value:    Option<CellValue>,
    },
    KindRename {
        old_kind: String,
        new_kind: String,
    },
    SubtreeReplace {
        root_nid: u64,
        block:    Block,
    },
}

// ── Chain ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AstChain {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub ops:         Vec<Op>,
}
