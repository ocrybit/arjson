// weavepack-geo — type constants and data structures.
// See weavepack/profiles/geo/01-types.md for the normative spec.
//
// Profile isolation: no imports from other profiles.

// ── Profile / block constants ─────────────────────────────────────────────────

pub const PROFILE_NUM: u8 = 8;

pub const BLOCK_FEATURE:             u8 = 0x00;
pub const BLOCK_GEOMETRY_COLLECTION: u8 = 0x01;
pub const BLOCK_DELTA:               u8 = 0x02;

// ── Column type codes ────────────────────────────────────────────────────

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

// ── Geometry types ───────────────────────────────────────────────────────

pub const GEOM_POINT:               u8 = 0;
pub const GEOM_LINESTRING:          u8 = 1;
pub const GEOM_POLYGON:             u8 = 2;
pub const GEOM_MULTIPOINT:          u8 = 3;
pub const GEOM_MULTILINESTRING:     u8 = 4;
pub const GEOM_MULTIPOLYGON:        u8 = 5;
pub const GEOM_GEOMETRY_COLLECTION: u8 = 6;
pub const GEOM_NULL:                u8 = 7;

// ── Coordinate precision ──────────────────────────────────────────────────

pub const COORD_FLOAT64: u8 = 0;
pub const COORD_FLOAT32: u8 = 1;

// ── FID kinds ──────────────────────────────────────────────────────────────

pub const FID_ABSENT: u8 = 0;
pub const FID_STRING: u8 = 1;
pub const FID_UINT64: u8 = 2;

// ── Delta op codes (upper 5 bits of op-header byte = code << 3) ────────────────

pub const OP_FEATURE_INSERT:     u8 = 0;
pub const OP_FEATURE_DELETE:     u8 = 1;
pub const OP_GEOMETRY_REPLACE:   u8 = 2;
pub const OP_PROP_SET:           u8 = 3;
pub const OP_PROP_DELETE:        u8 = 4;
pub const OP_COLLECTION_REPLACE: u8 = 5;

// ── Path kind discriminants (upper 4 bits of path-header byte = kind << 4) ─

pub const PATH_BY_IDX:     u8 = 0;
pub const PATH_BY_STR_FID: u8 = 1;
pub const PATH_BY_INT_FID: u8 = 2;
pub const PATH_GEOMETRY:   u8 = 3;
pub const PATH_PROP_NAME:  u8 = 4;
pub const PATH_PROP_IDX:   u8 = 5;

// ── Cell value ─────────────────────────────────────────────────────────────

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
}

// ── Property column ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PropCol {
    pub name:     String,
    pub ctype:    u8,
    pub nullable: bool,
    pub values:   Vec<Option<CellValue>>,
}

// ── Geometry data (columnar; fields populated per geom_type) ─────────────────
//
// Field usage by geom_type:
//   POINT:               x, y, [z]
//   LINESTRING:          coord_counts, x, y, [z]
//   POLYGON:             rings_per_feature, ring_counts, x, y, [z]
//   MULTIPOINT:          part_counts, x, y, [z]
//   MULTILINESTRING:     part_counts, coord_counts, x, y, [z]
//   MULTIPOLYGON:        part_counts, rings_per_part, ring_counts, x, y, [z]
//   NULL_GEOMETRY:       (empty)
//
// Coordinates stored as f64 regardless of wire precision; the FeatureBlock's
// coord_precision field drives encode/decode rounding.

#[derive(Debug, Clone, Default)]
pub struct Geom {
    pub coord_counts:      Vec<u32>,
    pub rings_per_feature: Vec<u32>,
    pub ring_counts:       Vec<u32>,
    pub part_counts:       Vec<u32>,
    pub rings_per_part:    Vec<u32>,
    pub x:                 Vec<f64>,
    pub y:                 Vec<f64>,
    pub z:                 Option<Vec<f64>>,
}

// ── FID ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Fid {
    Str(String),
    Int(u64),
}

// ── Sub-geometry (used inside GC blocks) ────────────────────────────────

#[derive(Debug, Clone)]
pub struct SubGeom {
    pub geom_type: u8,
    pub geom:      Geom,
}

// ── Feature block ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FeatureBlock {
    pub geom_type:       u8,
    pub coord_precision: u8,
    pub has_z:           bool,
    pub fid_kind:        u8,
    pub num_features:    usize,
    pub fids:            Option<Vec<Fid>>,
    pub geom:            Geom,
    pub prop_cols:       Vec<PropCol>,
}

// ── Geometry-collection block ───────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GcBlock {
    pub coord_precision: u8,
    pub has_z:           bool,
    pub fid_kind:        u8,
    pub num_features:    usize,
    pub fids:            Option<Vec<Fid>>,
    pub sub_geom_counts: Vec<u32>,
    pub sub_geoms:       Vec<SubGeom>,
    pub prop_cols:       Vec<PropCol>,
}

// ── Inner path (feature selector) ────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum InnerPath {
    ByIdx(u32),
    ByStrFid(String),
    ByIntFid(u64),
}

// ── Outer path ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Path {
    ByIdx(u32),
    ByStrFid(String),
    ByIntFid(u64),
    Geometry(InnerPath),
    PropName { inner: InnerPath, name: String },
    PropIdx  { inner: InnerPath, col_idx: u32 },
}

// ── Feature block or GC block (used as op payload) ──────────────────────────

#[derive(Debug, Clone)]
pub enum Block {
    Feature(FeatureBlock),
    Gc(GcBlock),
}

// ── Delta op ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Op {
    FeatureInsert  { block: Block },
    FeatureDelete  { mode: u8, paths: Vec<Path>, start: u32, count: u32 },
    GeometryReplace { path: Path, block: FeatureBlock },
    PropSet        { path: Path, ctype: u8, value: CellValue },
    PropDelete     { path: Path },
    CollectionReplace { blocks: Vec<Block> },
}

// ── Delta frame ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DeltaFrame {
    pub name: String,
    pub ops:  Vec<Op>,
}

// ── Top-level document block ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum DocBlock {
    Feature(FeatureBlock),
    Gc(GcBlock),
    Delta(DeltaFrame),
}

// ── Geo document ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GeoDocument {
    pub name:   String,
    pub blocks: Vec<DocBlock>,
}
