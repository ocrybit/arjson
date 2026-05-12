// weavepack-ast — decoder (AST documents + delta chains).
//
// Wire layout mirrors sdk/src/profiles/ast/decoder.js exactly.
// Profile isolation: only imports from crate::types.

use crate::types::{
    AstChain, AstDoc, Block, CellValue, MixedBlock, NodeBlock, Op, Path, PropCol,
    AST_VERSION, BLOCK_TYPE_MIXED, BLOCK_TYPE_NODE, CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32,
    CTYPE_FLOAT32, CTYPE_FLOAT64, CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8,
    CTYPE_NODE_ID, CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64,
    CTYPE_UINT8, MAX_PAYLOAD_BYTES, OP_KIND_RENAME, OP_NODE_DELETE, OP_NODE_INSERT,
    OP_NODE_MOVE, OP_PROP_SET, OP_SUBTREE_REPLACE, PATH_AT_CHILD_INDEX, PATH_AT_KIND,
    PATH_AT_NID, PATH_AT_PARENT, PATH_NODE, PATH_NODE_COL, PATH_NODE_KIND, PATH_NODE_PROP,
    PROFILE_NUM, SCHEMA_HASH_BYTES,
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

// ── Null bitmap reading (MSB-first) ────────────────────────────────────────

fn get_null_bit(bitmap: &[u8], idx: usize) -> bool {
    (bitmap[idx >> 3] >> (7 - (idx & 7))) & 1 == 1
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
            Ok(CellValue::Int16(i16::from_le_bytes([bytes[0], bytes[1]])))
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
            std::str::from_utf8(bytes)
                .map(|s| CellValue::String(s.to_owned()))
                .map_err(|_| "invalid_utf8: string column contains invalid UTF-8".into())
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

// ── Bool column (bit-packed) ────────────────────────────────────────────────

fn read_bool_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<Option<CellValue>>, String> {
    let nbytes = (count + 7) / 8;
    let bytes = r.read_bytes(nbytes)?;
    let mut values = Vec::with_capacity(count);
    for i in 0..count {
        let bit = (bytes[i >> 3] >> (i & 7)) & 1 == 1;
        values.push(Some(CellValue::Bool(bit)));
    }
    Ok(values)
}

// ── Nullable column (null bitmap + non-null values) ─────────────────────────

fn read_nullable_column(r: &mut ByteReader<'_>, ctype: u8, num_elems: usize)
    -> Result<Vec<Option<CellValue>>, String>
{
    let nbytes = (num_elems + 7) / 8;
    let bitmap = r.read_bytes(nbytes)?.to_vec();

    let mut null_flags = Vec::with_capacity(num_elems);
    for i in 0..num_elems {
        null_flags.push(get_null_bit(&bitmap, i));
    }

    let non_null_count = null_flags.iter().filter(|&&n| !n).count();
    let non_null_vals = if ctype == CTYPE_BOOL {
        read_bool_column(r, non_null_count)?
    } else {
        let mut vals = Vec::with_capacity(non_null_count);
        for _ in 0..non_null_count {
            vals.push(Some(read_value(r, ctype)?));
        }
        vals
    };

    let mut result = Vec::with_capacity(num_elems);
    let mut vi = 0;
    for i in 0..num_elems {
        if null_flags[i] {
            result.push(None);
        } else {
            result.push(non_null_vals[vi].clone());
            vi += 1;
        }
    }
    Ok(result)
}

fn read_value_column(r: &mut ByteReader<'_>, ctype: u8, count: usize)
    -> Result<Vec<Option<CellValue>>, String>
{
    if ctype == CTYPE_BOOL {
        return read_bool_column(r, count);
    }
    let mut vals = Vec::with_capacity(count);
    for _ in 0..count {
        vals.push(Some(read_value(r, ctype)?));
    }
    Ok(vals)
}

// ── NID delta-packed column ─────────────────────────────────────────────────

fn read_nid_delta_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<u64>, String> {
    if count == 0 { return Ok(Vec::new()); }
    let mut ids = Vec::with_capacity(count);
    let first = r.read_leb128_u64()?;
    ids.push(first);
    let mut prev = first;
    for _ in 1..count {
        let delta = r.read_leb128_u64()?;
        if delta < 1 {
            return Err("duplicate_element_id: nid delta must be ≥1".into());
        }
        prev = prev + delta;
        ids.push(prev);
    }
    Ok(ids)
}

// ── parent_nid nullable column (null bitmap + plain uint64 LE) ─────────────

fn read_parent_nid_column(r: &mut ByteReader<'_>, num_nodes: usize)
    -> Result<Vec<Option<u64>>, String>
{
    let nbytes = (num_nodes + 7) / 8;
    let bitmap = r.read_bytes(nbytes)?.to_vec();

    let mut values = Vec::with_capacity(num_nodes);
    for i in 0..num_nodes {
        if get_null_bit(&bitmap, i) {
            values.push(None);
        } else {
            let bytes = r.read_bytes(8)?;
            values.push(Some(u64::from_le_bytes(bytes.try_into().unwrap())));
        }
    }
    Ok(values)
}

// ── child_index column (LEB128 per value) ──────────────────────────────────

fn read_child_index_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<u32>, String> {
    let mut vals = Vec::with_capacity(count);
    for _ in 0..count {
        vals.push(r.read_leb128_u32()?);
    }
    Ok(vals)
}

// ── per-row kind column (mixed_block only) ──────────────────────────────────

fn read_kind_column(r: &mut ByteReader<'_>, count: usize) -> Result<Vec<String>, String> {
    let mut vals = Vec::with_capacity(count);
    for _ in 0..count {
        let len = r.read_leb128_u32()? as usize;
        let bytes = r.read_bytes(len)?;
        let s = std::str::from_utf8(bytes).map_err(|_| "invalid_utf8: kind contains invalid UTF-8".to_string())?;
        vals.push(s.to_owned());
    }
    Ok(vals)
}

// ── User column schema ──────────────────────────────────────────────────────

struct ColSchema {
    col_id:   u32,
    ctype:    u8,
    nullable: bool,
}

fn read_user_col_schema(r: &mut ByteReader<'_>) -> Result<ColSchema, String> {
    let col_id = r.read_leb128_u32()?;
    if col_id < 4 {
        return Err(format!("reserved_col_id: col_id {col_id} is reserved (must be ≥ 4)"));
    }
    let type_byte = r.read_byte()?;
    let ctype    = type_byte & 0xF;
    let nullable = (type_byte >> 4) & 1 == 1;
    if ctype > 15 {
        return Err(format!("unknown_ctype: ctype {ctype} ≥ 16 is reserved"));
    }
    Ok(ColSchema { col_id, ctype, nullable })
}

// ── node_block / mixed_block decoding ──────────────────────────────────────

fn read_node_block_payload(r: &mut ByteReader<'_>) -> Result<NodeBlock, String> {
    let kind_len = r.read_leb128_u32()? as usize;
    let kind = if kind_len > 0 {
        let bytes = r.read_bytes(kind_len)?;
        std::str::from_utf8(bytes)
            .map(|s| s.to_owned())
            .map_err(|_| "invalid_utf8: kind contains invalid UTF-8".to_string())?
    } else {
        String::new()
    };

    let num_nodes = r.read_leb128_u32()? as usize;
    let num_cols  = r.read_leb128_u32()? as usize;

    let mut schemas = Vec::with_capacity(num_cols);
    for _ in 0..num_cols {
        schemas.push(read_user_col_schema(r)?);
    }

    let nids          = read_nid_delta_column(r, num_nodes)?;
    let parent_nids   = read_parent_nid_column(r, num_nodes)?;
    let child_indices = read_child_index_column(r, num_nodes)?;

    let mut columns = Vec::with_capacity(num_cols);
    for s in &schemas {
        let values = if s.nullable {
            read_nullable_column(r, s.ctype, num_nodes)?
        } else {
            read_value_column(r, s.ctype, num_nodes)?
        };
        columns.push(PropCol { col_id: s.col_id, ctype: s.ctype, nullable: s.nullable, values });
    }

    Ok(NodeBlock { kind, nids, parent_nids, child_indices, columns })
}

fn read_mixed_block_payload(r: &mut ByteReader<'_>) -> Result<MixedBlock, String> {
    let kind_len = r.read_leb128_u32()? as usize;
    if kind_len > 0 {
        r.read_bytes(kind_len)?; // discard (should be 0 for mixed, but tolerate)
    }

    let num_nodes = r.read_leb128_u32()? as usize;
    let num_cols  = r.read_leb128_u32()? as usize;

    let mut schemas = Vec::with_capacity(num_cols);
    for _ in 0..num_cols {
        schemas.push(read_user_col_schema(r)?);
    }

    let nids          = read_nid_delta_column(r, num_nodes)?;
    let parent_nids   = read_parent_nid_column(r, num_nodes)?;
    let child_indices = read_child_index_column(r, num_nodes)?;
    let kinds         = read_kind_column(r, num_nodes)?;

    let mut columns = Vec::with_capacity(num_cols);
    for s in &schemas {
        let values = if s.nullable {
            read_nullable_column(r, s.ctype, num_nodes)?
        } else {
            read_value_column(r, s.ctype, num_nodes)?
        };
        columns.push(PropCol { col_id: s.col_id, ctype: s.ctype, nullable: s.nullable, values });
    }

    Ok(MixedBlock { kinds, nids, parent_nids, child_indices, columns })
}

fn read_block(r: &mut ByteReader<'_>) -> Result<Block, String> {
    let block_type = r.read_byte()?;
    match block_type {
        BLOCK_TYPE_NODE  => Ok(Block::Node(read_node_block_payload(r)?)),
        BLOCK_TYPE_MIXED => Ok(Block::Mixed(read_mixed_block_payload(r)?)),
        t                => Err(format!("unknown_block_type: block type {t}")),
    }
}

// ── Document header ─────────────────────────────────────────────────────────

fn read_doc_header(r: &mut ByteReader<'_>) -> Result<[u8; SCHEMA_HASH_BYTES], String> {
    let version = r.read_leb128_u32()?;
    if version != AST_VERSION {
        return Err(format!("unsupported_version: expected ast_version {AST_VERSION}, got {version}"));
    }
    let profile_id = r.read_leb128_u32()?;
    if profile_id != PROFILE_NUM {
        return Err(format!("wrong_profile: expected profile_id {PROFILE_NUM}, got {profile_id}"));
    }
    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    let mut schema_hash = [0u8; SCHEMA_HASH_BYTES];
    schema_hash.copy_from_slice(hash_bytes);
    Ok(schema_hash)
}

// ── Public: AST document (snapshot) ────────────────────────────────────────

pub fn decode_tree(bytes: &[u8]) -> Result<AstDoc, String> {
    let mut r = ByteReader::new(bytes);
    let schema_hash = read_doc_header(&mut r)?;
    let num_blocks = r.read_leb128_u32()? as usize;
    let mut blocks = Vec::with_capacity(num_blocks);
    for _ in 0..num_blocks {
        blocks.push(read_block(&mut r)?);
    }
    Ok(AstDoc { schema_hash, blocks })
}

// ── Path decoding ───────────────────────────────────────────────────────────

fn read_path(r: &mut ByteReader<'_>) -> Result<Path, String> {
    let path_byte = r.read_byte()?;
    let kind = (path_byte >> 4) & 0xF;
    match kind {
        k if k == PATH_NODE => {
            let nid = r.read_leb128_u64()?;
            Ok(Path::Node { nid })
        }
        k if k == PATH_NODE_COL => {
            let nid    = r.read_leb128_u64()?;
            let col_id = r.read_leb128_u32()?;
            Ok(Path::NodeCol { nid, col_id })
        }
        k if k == PATH_NODE_KIND => {
            let len = r.read_leb128_u32()? as usize;
            let bytes = r.read_bytes(len)?;
            let node_kind = std::str::from_utf8(bytes)
                .map(|s| s.to_owned())
                .map_err(|_| "invalid_utf8: node_kind".to_string())?;
            Ok(Path::NodeKind { node_kind })
        }
        k if k == PATH_AT_NID         => Ok(Path::AtNid),
        k if k == PATH_AT_PARENT      => Ok(Path::AtParent),
        k if k == PATH_AT_CHILD_INDEX => Ok(Path::AtChildIndex),
        k if k == PATH_AT_KIND        => Ok(Path::AtKind),
        k if k == PATH_NODE_PROP => {
            let nid = r.read_leb128_u64()?;
            let len = r.read_leb128_u32()? as usize;
            let bytes = r.read_bytes(len)?;
            let prop = std::str::from_utf8(bytes)
                .map(|s| s.to_owned())
                .map_err(|_| "invalid_utf8: prop name".to_string())?;
            Ok(Path::NodeProp { nid, prop })
        }
        k => Err(format!("unknown_path_kind: path kind {k} is reserved (must be 0–7)")),
    }
}

// ── Op decoding ─────────────────────────────────────────────────────────────

fn read_op(r: &mut ByteReader<'_>) -> Result<Op, String> {
    let op_byte = r.read_byte()?;
    let op_code = op_byte & 0x7;
    match op_code {
        OP_NODE_INSERT => {
            let block = read_block(r)?;
            Ok(Op::NodeInsert { block })
        }
        OP_NODE_DELETE => {
            let count = r.read_leb128_u64()? as usize;
            let mut nids = Vec::with_capacity(count);
            for _ in 0..count {
                nids.push(r.read_leb128_u64()?);
            }
            Ok(Op::NodeDelete { nids })
        }
        OP_NODE_MOVE => {
            let nid             = r.read_leb128_u64()?;
            let new_parent_nid  = r.read_leb128_u64()?;
            let new_child_index = r.read_leb128_u32()?;
            Ok(Op::NodeMove { nid, new_parent_nid, new_child_index })
        }
        OP_PROP_SET => {
            let path       = read_path(r)?;
            let ctype_byte = r.read_byte()?;
            let ctype      = ctype_byte & 0xF;
            let flags      = r.read_byte()?;
            let nullable   = (flags & 1) == 1;
            let is_null    = ((flags >> 1) & 1) == 1;
            let value      = if is_null { None } else { Some(read_value(r, ctype)?) };
            Ok(Op::PropSet { path, ctype, nullable, is_null, value })
        }
        OP_KIND_RENAME => {
            let old_len = r.read_leb128_u32()? as usize;
            let old_bytes = r.read_bytes(old_len)?;
            let old_kind = std::str::from_utf8(old_bytes)
                .map(|s| s.to_owned())
                .map_err(|_| "invalid_utf8: old_kind".to_string())?;
            let new_len = r.read_leb128_u32()? as usize;
            let new_bytes = r.read_bytes(new_len)?;
            let new_kind = std::str::from_utf8(new_bytes)
                .map(|s| s.to_owned())
                .map_err(|_| "invalid_utf8: new_kind".to_string())?;
            Ok(Op::KindRename { old_kind, new_kind })
        }
        OP_SUBTREE_REPLACE => {
            let root_nid = r.read_leb128_u64()?;
            let block    = read_block(r)?;
            Ok(Op::SubtreeReplace { root_nid, block })
        }
        c => Err(format!("unknown_delta_op: op code {c} is reserved (must be 0–5)")),
    }
}

// ── Public: delta chain ─────────────────────────────────────────────────────

pub fn decode_chain(bytes: &[u8]) -> Result<AstChain, String> {
    let mut r = ByteReader::new(bytes);
    let schema_hash = read_doc_header(&mut r)?;
    let num_ops = r.read_leb128_u32()? as usize;
    let mut ops = Vec::with_capacity(num_ops);
    for _ in 0..num_ops {
        ops.push(read_op(&mut r)?);
    }
    Ok(AstChain { schema_hash, ops })
}
