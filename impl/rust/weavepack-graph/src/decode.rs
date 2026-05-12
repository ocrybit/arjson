// weavepack-graph — decoder (graph documents + delta chains).
//
// Profile isolation: only imports from crate::types.

use crate::types::{
    Block, CellValue, EdgeBlock, GraphDoc, NodeBlock, Op, Path, PropCol,
    BLOCK_TYPE_EDGE, BLOCK_TYPE_NODE, CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32,
    CTYPE_FLOAT32, CTYPE_FLOAT64, CTYPE_INT16, CTYPE_INT32, CTYPE_INT64,
    CTYPE_INT8, CTYPE_NODE_ID, CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16,
    CTYPE_UINT32, CTYPE_UINT64, CTYPE_UINT8, GRAPH_VERSION, MAX_PAYLOAD_BYTES,
    OP_EDGE_DELETE, OP_EDGE_INSERT, OP_NODE_DELETE, OP_NODE_INSERT, OP_PROP_SET,
    OP_SUBGRAPH_REPLACE, PATH_AT_DST, PATH_AT_EID, PATH_AT_LABEL, PATH_AT_NID,
    PATH_AT_SRC, PATH_EDGE, PATH_EDGE_COL, PATH_EDGE_LABEL, PATH_EDGE_LABEL_COL,
    PATH_EDGE_PROP, PATH_NODE, PATH_NODE_COL, PATH_NODE_LABEL, PATH_NODE_LABEL_COL,
    PATH_NODE_PROP, PROFILE_NUM, SCHEMA_HASH_BYTES,
};

// ── ByteReader ──────────────────────────────────────────────────────────────

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
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn read_leb128_u32(&mut self) -> Result<u32, String> {
        let mut result = 0u32;
        let mut shift = 0u32;
        loop {
            let b = self.read_byte()?;
            result |= ((b & 0x7F) as u32) << shift;
            shift += 7;
            if b & 0x80 == 0 { break; }
            if shift >= 35 { return Err("LEB128 overflow for uint32".into()); }
        }
        Ok(result)
    }

    fn read_leb128_u64(&mut self) -> Result<u64, String> {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let b = self.read_byte()?;
            result |= ((b & 0x7F) as u64) << shift;
            shift += 7;
            if b & 0x80 == 0 { break; }
            if shift >= 70 { return Err("LEB128 overflow for uint64".into()); }
        }
        Ok(result)
    }
}

// ── Single value decoding ───────────────────────────────────────────────────

fn read_value(r: &mut ByteReader<'_>, ctype: u8) -> Result<CellValue, String> {
    match ctype {
        CTYPE_BOOL => Ok(CellValue::Bool(r.read_byte()? != 0)),
        CTYPE_INT8 => {
            let b = r.read_byte()?;
            Ok(CellValue::Int8(b as i8))
        }
        CTYPE_INT16 => {
            let bytes = r.read_bytes(2)?;
            let u = u16::from_le_bytes([bytes[0], bytes[1]]);
            Ok(CellValue::Int16(u as i16))
        }
        CTYPE_INT32 => {
            let bytes = r.read_bytes(4)?;
            Ok(CellValue::Int32(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        CTYPE_INT64 => {
            let bytes = r.read_bytes(8)?;
            Ok(CellValue::Int64(i64::from_le_bytes(bytes.try_into().unwrap())))
        }
        CTYPE_UINT8 => Ok(CellValue::Uint8(r.read_byte()?)),
        CTYPE_UINT16 => {
            let bytes = r.read_bytes(2)?;
            Ok(CellValue::Uint16(u16::from_le_bytes([bytes[0], bytes[1]])))
        }
        CTYPE_UINT32 => {
            let bytes = r.read_bytes(4)?;
            Ok(CellValue::Uint32(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        CTYPE_UINT64 => {
            let bytes = r.read_bytes(8)?;
            Ok(CellValue::Uint64(u64::from_le_bytes(bytes.try_into().unwrap())))
        }
        CTYPE_FLOAT32 => {
            let bytes = r.read_bytes(4)?;
            Ok(CellValue::Float32(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        CTYPE_FLOAT64 => {
            let bytes = r.read_bytes(8)?;
            Ok(CellValue::Float64(f64::from_le_bytes(bytes.try_into().unwrap())))
        }
        CTYPE_STRING => {
            let len = r.read_leb128_u32()? as usize;
            if len > MAX_PAYLOAD_BYTES {
                return Err("string_too_large: string exceeds 1 GiB limit".into());
            }
            let bytes = r.read_bytes(len)?;
            let s = std::str::from_utf8(bytes)
                .map_err(|_| "invalid_utf8: string column contains invalid UTF-8")?;
            Ok(CellValue::String(s.to_owned()))
        }
        CTYPE_BYTES => {
            let len = r.read_leb128_u32()? as usize;
            if len > MAX_PAYLOAD_BYTES {
                return Err("string_too_large: bytes exceeds 1 GiB limit".into());
            }
            let bytes = r.read_bytes(len)?;
            Ok(CellValue::Bytes(bytes.to_vec()))
        }
        CTYPE_DATE32 => {
            let bytes = r.read_bytes(4)?;
            Ok(CellValue::Date32(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        CTYPE_TIMESTAMP64 => {
            let bytes = r.read_bytes(8)?;
            Ok(CellValue::Timestamp64(i64::from_le_bytes(bytes.try_into().unwrap())))
        }
        CTYPE_NODE_ID => {
            let bytes = r.read_bytes(8)?;
            Ok(CellValue::NodeId(u64::from_le_bytes(bytes.try_into().unwrap())))
        }
        _ => Err(format!("unknown_ctype: ctype {ctype}")),
    }
}

// ── Bool column: 1 bit per value, LSB-first ─────────────────────────────────

fn read_bool_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<CellValue>, String> {
    let nbytes = (count + 7) / 8;
    let bytes = r.read_bytes(nbytes)?;
    let mut values = Vec::with_capacity(count);
    for i in 0..count {
        values.push(CellValue::Bool(((bytes[i >> 3] >> (i & 7)) & 1) == 1));
    }
    Ok(values)
}

// ── Value column (non-nullable) ──────────────────────────────────────────────

fn read_value_column(r: &mut ByteReader<'_>, ctype: u8, count: usize) -> Result<Vec<CellValue>, String> {
    if ctype == CTYPE_BOOL { return read_bool_column(r, count); }
    let mut values = Vec::with_capacity(count);
    for _ in 0..count { values.push(read_value(r, ctype)?); }
    Ok(values)
}

// ── Nullable column (null bitmap + non-null values) ──────────────────────────

fn read_nullable_column(r: &mut ByteReader<'_>, ctype: u8, num_elems: usize) -> Result<Vec<Option<CellValue>>, String> {
    let nbytes = (num_elems + 7) / 8;
    let bitmap_bytes = r.read_bytes(nbytes)?;

    let rem = num_elems & 7;
    if rem != 0 {
        let last = bitmap_bytes[nbytes - 1];
        let mask = 0xFFu8 >> rem;
        if last & mask != 0 {
            return Err("invalid_null_bitmap: padding bits must be zero".into());
        }
    }

    let mut null_flags = Vec::with_capacity(num_elems);
    for i in 0..num_elems {
        null_flags.push(((bitmap_bytes[i >> 3] >> (7 - (i & 7))) & 1) == 1);
    }

    let non_null_count = null_flags.iter().filter(|&&n| !n).count();
    let non_null_vals = if ctype == CTYPE_BOOL {
        read_bool_column(r, non_null_count)?
    } else {
        read_value_column(r, ctype, non_null_count)?
    };

    let mut values = Vec::with_capacity(num_elems);
    let mut vi = 0;
    for is_null in null_flags {
        if is_null {
            values.push(None);
        } else {
            values.push(Some(non_null_vals[vi].clone()));
            vi += 1;
        }
    }
    Ok(values)
}

// ── NID / EID delta-pack column ─────────────────────────────────────────────

fn read_id_delta_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<u64>, String> {
    if count == 0 { return Ok(vec![]); }
    let first = r.read_leb128_u64()?;
    let mut ids = vec![first];
    let mut prev = first;
    for _ in 1..count {
        let delta = r.read_leb128_u64()?;
        if delta < 1 { return Err("duplicate_element_id: id delta must be \u{2265}1".into()); }
        prev = prev.checked_add(delta).ok_or("id overflow")?;
        ids.push(prev);
    }
    Ok(ids)
}

// ── SRC / DST plain uint64 column ───────────────────────────────────────────

fn read_plain_u64_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<u64>, String> {
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        let bytes = r.read_bytes(8)?;
        values.push(u64::from_le_bytes(bytes.try_into().unwrap()));
    }
    Ok(values)
}

// ── Property column schema ───────────────────────────────────────────────────

struct ColSchema { col_id: u32, ctype: u8, nullable: bool }

fn read_prop_col_schema(r: &mut ByteReader<'_>, min_col_id: u32) -> Result<ColSchema, String> {
    let col_id = r.read_leb128_u32()?;
    if col_id < min_col_id {
        return Err(format!("reserved_col_id: col_id {col_id} is reserved (must be \u{2265} {min_col_id})"));
    }
    let type_byte = r.read_byte()?;
    let ctype    = type_byte & 0xF;
    let nullable = ((type_byte >> 4) & 1) == 1;
    if ctype > 15 {
        return Err(format!("unknown_ctype: ctype {ctype} \u{2265} 16 is reserved"));
    }
    Ok(ColSchema { col_id, ctype, nullable })
}

fn read_prop_col_data(r: &mut ByteReader<'_>, schema: &ColSchema, num_elems: usize) -> Result<PropCol, String> {
    let values: Vec<Option<CellValue>> = if schema.nullable {
        read_nullable_column(r, schema.ctype, num_elems)?
    } else {
        read_value_column(r, schema.ctype, num_elems)?
            .into_iter().map(Some).collect()
    };
    Ok(PropCol {
        col_id:   schema.col_id,
        ctype:    schema.ctype,
        nullable: schema.nullable,
        values,
    })
}

// ── Node block ──────────────────────────────────────────────────────────────

fn read_node_block(r: &mut ByteReader<'_>) -> Result<NodeBlock, String> {
    let num_nodes = r.read_leb128_u64()? as usize;
    let label_len = r.read_leb128_u32()? as usize;
    let label = if label_len > 0 {
        let bytes = r.read_bytes(label_len)?;
        Some(std::str::from_utf8(bytes)
            .map_err(|_| "invalid_utf8: label")?
            .to_owned())
    } else {
        None
    };
    let num_cols = r.read_leb128_u32()? as usize;
    let mut schemas = Vec::with_capacity(num_cols);
    for _ in 0..num_cols { schemas.push(read_prop_col_schema(r, 2)?); }

    let nids    = read_id_delta_column(r, num_nodes)?;
    let mut columns = Vec::with_capacity(num_cols);
    for s in &schemas { columns.push(read_prop_col_data(r, s, num_nodes)?); }

    Ok(NodeBlock { label, nids, columns })
}

// ── Edge block ──────────────────────────────────────────────────────────────

fn read_edge_block(r: &mut ByteReader<'_>) -> Result<EdgeBlock, String> {
    let num_edges = r.read_leb128_u64()? as usize;
    let label_len = r.read_leb128_u32()? as usize;
    let label = if label_len > 0 {
        let bytes = r.read_bytes(label_len)?;
        Some(std::str::from_utf8(bytes)
            .map_err(|_| "invalid_utf8: label")?
            .to_owned())
    } else {
        None
    };
    let num_cols = r.read_leb128_u32()? as usize;
    let mut schemas = Vec::with_capacity(num_cols);
    for _ in 0..num_cols { schemas.push(read_prop_col_schema(r, 4)?); }

    let eids = read_id_delta_column(r, num_edges)?;
    let srcs = read_plain_u64_column(r, num_edges)?;
    let dsts = read_plain_u64_column(r, num_edges)?;
    let mut columns = Vec::with_capacity(num_cols);
    for s in &schemas { columns.push(read_prop_col_data(r, s, num_edges)?); }

    Ok(EdgeBlock { label, eids, srcs, dsts, columns })
}

// ── Document header ─────────────────────────────────────────────────────────

fn read_doc_header(r: &mut ByteReader<'_>) -> Result<[u8; SCHEMA_HASH_BYTES], String> {
    let version = r.read_leb128_u32()?;
    if version != GRAPH_VERSION {
        return Err(format!("unsupported_version: expected {GRAPH_VERSION}, got {version}"));
    }
    let profile_id = r.read_leb128_u32()?;
    if profile_id != PROFILE_NUM {
        return Err(format!("wrong_profile: expected profile_id {PROFILE_NUM}, got {profile_id}"));
    }
    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    Ok(hash_bytes.try_into().unwrap())
}

// ── Public: decode_graph ────────────────────────────────────────────────────

pub fn decode_graph(bytes: &[u8]) -> Result<GraphDoc, String> {
    let mut r = ByteReader::new(bytes);
    let schema_hash = read_doc_header(&mut r)?;
    let num_blocks = r.read_leb128_u32()? as usize;
    let mut blocks = Vec::with_capacity(num_blocks);
    for _ in 0..num_blocks {
        let block_type = r.read_byte()?;
        match block_type {
            BLOCK_TYPE_NODE => blocks.push(Block::Node(read_node_block(&mut r)?)),
            BLOCK_TYPE_EDGE => blocks.push(Block::Edge(read_edge_block(&mut r)?)),
            _ => return Err(format!("unknown_block_type: block type {block_type}")),
        }
    }
    Ok(GraphDoc { schema_hash, blocks })
}

// ── Path decoding ────────────────────────────────────────────────────────────

fn read_label_str(r: &mut ByteReader<'_>) -> Result<String, String> {
    let len = r.read_leb128_u32()? as usize;
    let bytes = r.read_bytes(len)?;
    std::str::from_utf8(bytes).map(|s| s.to_owned())
        .map_err(|_| "invalid_utf8: path label".into())
}

fn read_path(r: &mut ByteReader<'_>) -> Result<Path, String> {
    let path_byte = r.read_byte()?;
    let kind = (path_byte >> 4) & 0xF;
    if kind == 15 { return Err("unknown_path_kind: path kind 15 is reserved".into()); }
    match kind {
        PATH_NODE      => Ok(Path::Node { nid: r.read_leb128_u64()? }),
        PATH_NODE_COL  => {
            let nid = r.read_leb128_u64()?;
            let col_id = r.read_leb128_u32()?;
            Ok(Path::NodeCol { nid, col_id })
        }
        PATH_EDGE      => Ok(Path::Edge { eid: r.read_leb128_u64()? }),
        PATH_EDGE_COL  => {
            let eid = r.read_leb128_u64()?;
            let col_id = r.read_leb128_u32()?;
            Ok(Path::EdgeCol { eid, col_id })
        }
        PATH_NODE_LABEL      => Ok(Path::NodeLabel { label: read_label_str(r)? }),
        PATH_NODE_LABEL_COL  => {
            let label = read_label_str(r)?;
            let col_id = r.read_leb128_u32()?;
            Ok(Path::NodeLabelCol { label, col_id })
        }
        PATH_EDGE_LABEL      => Ok(Path::EdgeLabel { label: read_label_str(r)? }),
        PATH_EDGE_LABEL_COL  => {
            let label = read_label_str(r)?;
            let col_id = r.read_leb128_u32()?;
            Ok(Path::EdgeLabelCol { label, col_id })
        }
        PATH_AT_NID   => Ok(Path::AtNid),
        PATH_AT_EID   => Ok(Path::AtEid),
        PATH_AT_SRC   => Ok(Path::AtSrc),
        PATH_AT_DST   => Ok(Path::AtDst),
        PATH_AT_LABEL => Ok(Path::AtLabel { label: read_label_str(r)? }),
        PATH_NODE_PROP => {
            let nid = r.read_leb128_u64()?;
            let prop = read_label_str(r)?;
            Ok(Path::NodeProp { nid, prop })
        }
        PATH_EDGE_PROP => {
            let eid = r.read_leb128_u64()?;
            let prop = read_label_str(r)?;
            Ok(Path::EdgeProp { eid, prop })
        }
        _ => Err(format!("unknown_path_kind: path kind {kind}")),
    }
}

// ── Op decoding ─────────────────────────────────────────────────────────────

fn read_op(r: &mut ByteReader<'_>) -> Result<Op, String> {
    let op_byte = r.read_byte()?;
    let op_code = op_byte & 0x7;
    match op_code {
        OP_NODE_INSERT => {
            Ok(Op::NodeInsert { block: read_node_block(r)? })
        }
        OP_NODE_DELETE => {
            let count = r.read_leb128_u64()? as usize;
            let mut nids = Vec::with_capacity(count);
            for _ in 0..count { nids.push(r.read_leb128_u64()?); }
            Ok(Op::NodeDelete { nids })
        }
        OP_EDGE_INSERT => {
            Ok(Op::EdgeInsert { block: read_edge_block(r)? })
        }
        OP_EDGE_DELETE => {
            let count = r.read_leb128_u64()? as usize;
            let mut eids = Vec::with_capacity(count);
            for _ in 0..count { eids.push(r.read_leb128_u64()?); }
            Ok(Op::EdgeDelete { eids })
        }
        OP_PROP_SET => {
            let path      = read_path(r)?;
            let ctype     = r.read_byte()? & 0xF;
            let flags     = r.read_byte()?;
            let nullable  = (flags & 1) == 1;
            let is_null   = ((flags >> 1) & 1) == 1;
            let value     = if is_null { None } else { Some(read_value(r, ctype)?) };
            Ok(Op::PropSet { path, ctype, nullable, is_null, value })
        }
        OP_SUBGRAPH_REPLACE => {
            let flags     = r.read_byte()?;
            let has_node  = (flags & 1) == 1;
            let has_edge  = ((flags >> 1) & 1) == 1;
            let label_len = r.read_leb128_u32()? as usize;
            let label = if label_len > 0 {
                let bytes = r.read_bytes(label_len)?;
                Some(std::str::from_utf8(bytes)
                    .map_err(|_| "invalid_utf8: label")?
                    .to_owned())
            } else {
                None
            };
            let node_block = if has_node { Some(read_node_block(r)?) } else { None };
            let edge_block = if has_edge { Some(read_edge_block(r)?) } else { None };
            Ok(Op::SubgraphReplace { label, node_block, edge_block })
        }
        _ => Err(format!("unknown_delta_op: op code {op_code} is reserved (must be 0\u{2013}5)")),
    }
}

// ── Public: decode_chain ────────────────────────────────────────────────────

pub struct Chain {
    pub schema_hash: [u8; SCHEMA_HASH_BYTES],
    pub ops:         Vec<Op>,
}

pub fn decode_chain(bytes: &[u8]) -> Result<Chain, String> {
    let mut r = ByteReader::new(bytes);
    let schema_hash = read_doc_header(&mut r)?;
    let num_ops = r.read_leb128_u32()? as usize;
    let mut ops = Vec::with_capacity(num_ops);
    for _ in 0..num_ops { ops.push(read_op(&mut r)?); }
    Ok(Chain { schema_hash, ops })
}
