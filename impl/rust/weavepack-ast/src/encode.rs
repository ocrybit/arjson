// weavepack-ast — encoder (AST documents + delta chains).
//
// Wire layout mirrors sdk/src/profiles/ast/encoder.js exactly.
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

// ── ByteWriter ──────────────────────────────────────────────────────────────

struct ByteWriter {
    buf: Vec<u8>,
}

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

// ── Single value encoding ───────────────────────────────────────────────────

fn write_value(w: &mut ByteWriter, ctype: u8, val: &CellValue) -> Result<(), String> {
    match (ctype, val) {
        (CTYPE_BOOL, CellValue::Bool(b)) => {
            w.write_byte(if *b { 1 } else { 0 });
        }
        (CTYPE_INT8, CellValue::Int8(v)) => {
            w.write_byte(*v as u8);
        }
        (CTYPE_INT16, CellValue::Int16(v)) => {
            w.write_bytes(&(*v as u16).to_le_bytes());
        }
        (CTYPE_INT32, CellValue::Int32(v)) => {
            w.write_bytes(&(*v as u32).to_le_bytes());
        }
        (CTYPE_INT64, CellValue::Int64(v)) | (CTYPE_TIMESTAMP64, CellValue::Timestamp64(v)) => {
            w.write_bytes(&(*v as u64).to_le_bytes());
        }
        (CTYPE_UINT8, CellValue::Uint8(v)) => {
            w.write_byte(*v);
        }
        (CTYPE_UINT16, CellValue::Uint16(v)) => {
            w.write_bytes(&v.to_le_bytes());
        }
        (CTYPE_UINT32, CellValue::Uint32(v)) => {
            w.write_bytes(&v.to_le_bytes());
        }
        (CTYPE_UINT64, CellValue::Uint64(v)) | (CTYPE_NODE_ID, CellValue::NodeId(v)) => {
            w.write_bytes(&v.to_le_bytes());
        }
        (CTYPE_FLOAT32, CellValue::Float32(v)) => {
            w.write_bytes(&v.to_le_bytes());
        }
        (CTYPE_FLOAT64, CellValue::Float64(v)) => {
            w.write_bytes(&v.to_le_bytes());
        }
        (CTYPE_STRING, CellValue::String(s)) => {
            let bytes = s.as_bytes();
            if bytes.len() > MAX_PAYLOAD_BYTES {
                return Err("string_too_large: string exceeds 1 GiB limit".into());
            }
            w.write_leb128_u32(bytes.len() as u32);
            w.write_bytes(bytes);
        }
        (CTYPE_BYTES, CellValue::Bytes(b)) => {
            if b.len() > MAX_PAYLOAD_BYTES {
                return Err("string_too_large: bytes exceeds 1 GiB limit".into());
            }
            w.write_leb128_u32(b.len() as u32);
            w.write_bytes(b);
        }
        (CTYPE_DATE32, CellValue::Date32(v)) => {
            w.write_bytes(&(*v as u32).to_le_bytes());
        }
        _ => {
            return Err(format!("type mismatch: ctype={ctype} value={val:?}"));
        }
    }
    Ok(())
}

// ── Bool column (bit-packed, one bit per value, non-null only) ──────────────

fn write_bool_column(w: &mut ByteWriter, values: &[Option<CellValue>]) -> Result<(), String> {
    let non_null: Vec<bool> = values.iter()
        .filter_map(|v| if let Some(CellValue::Bool(b)) = v { Some(*b) } else if v.is_none() { None } else { None })
        .collect();
    let n = non_null.len();
    let nbytes = (n + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, b) in non_null.iter().enumerate() {
        if *b { bytes[i >> 3] |= 1 << (i & 7); }
    }
    w.write_bytes(&bytes);
    Ok(())
}

// ── Null bitmap: MSB-first (bit i set = NULL at index i) ───────────────────

fn write_null_bitmap(w: &mut ByteWriter, values: &[Option<CellValue>]) {
    let n = values.len();
    let nbytes = (n + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, v) in values.iter().enumerate() {
        if v.is_none() {
            bytes[i >> 3] |= 1 << (7 - (i & 7));
        }
    }
    w.write_bytes(&bytes);
}

fn write_parent_nid_null_bitmap(w: &mut ByteWriter, parent_nids: &[Option<u64>]) {
    let n = parent_nids.len();
    let nbytes = (n + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, p) in parent_nids.iter().enumerate() {
        if p.is_none() {
            bytes[i >> 3] |= 1 << (7 - (i & 7));
        }
    }
    w.write_bytes(&bytes);
}

// ── Value column (non-null values only) ────────────────────────────────────

fn write_value_column(w: &mut ByteWriter, ctype: u8, values: &[Option<CellValue>]) -> Result<(), String> {
    if ctype == CTYPE_BOOL {
        return write_bool_column(w, values);
    }
    for v in values {
        if let Some(val) = v {
            write_value(w, ctype, val)?;
        }
    }
    Ok(())
}

// ── NID delta-packed column ─────────────────────────────────────────────────

fn write_nid_delta_column(w: &mut ByteWriter, nids: &[u64]) -> Result<(), String> {
    if nids.is_empty() { return Ok(()); }
    w.write_leb128_u64(nids[0]);
    for i in 1..nids.len() {
        if nids[i] <= nids[i - 1] {
            return Err(format!("duplicate_element_id: nid delta must be ≥1 at index {i}"));
        }
        w.write_leb128_u64(nids[i] - nids[i - 1]);
    }
    Ok(())
}

// ── parent_nid nullable column (null bitmap + plain uint64 LE) ─────────────

fn write_parent_nid_column(w: &mut ByteWriter, parent_nids: &[Option<u64>]) {
    write_parent_nid_null_bitmap(w, parent_nids);
    for p in parent_nids {
        if let Some(nid) = p {
            w.write_bytes(&nid.to_le_bytes());
        }
    }
}

// ── child_index column (LEB128 per value) ──────────────────────────────────

fn write_child_index_column(w: &mut ByteWriter, child_indices: &[u32]) {
    for &ci in child_indices {
        w.write_leb128_u32(ci);
    }
}

// ── per-row kind column (mixed_block only) ──────────────────────────────────

fn write_kind_column(w: &mut ByteWriter, kinds: &[String]) -> Result<(), String> {
    for k in kinds {
        let bytes = k.as_bytes();
        w.write_leb128_u32(bytes.len() as u32);
        w.write_bytes(bytes);
    }
    Ok(())
}

// ── User column schema ──────────────────────────────────────────────────────

fn write_user_col_schema(w: &mut ByteWriter, col: &PropCol) -> Result<(), String> {
    if col.col_id < 4 {
        return Err(format!("reserved_col_id: col_id {} is reserved (must be ≥ 4)", col.col_id));
    }
    if col.ctype > 15 {
        return Err(format!("unknown_ctype: ctype {} ≥ 16 is reserved", col.ctype));
    }
    w.write_leb128_u32(col.col_id);
    w.write_byte(((if col.nullable { 1u8 } else { 0u8 }) << 4) | (col.ctype & 0xF));
    Ok(())
}

fn write_user_col_data(w: &mut ByteWriter, col: &PropCol, num_elems: usize) -> Result<(), String> {
    if col.values.len() != num_elems {
        return Err(format!("column {} has {} values but block has {} elements",
            col.col_id, col.values.len(), num_elems));
    }
    if col.nullable {
        write_null_bitmap(w, &col.values);
    }
    write_value_column(w, col.ctype, &col.values)?;
    Ok(())
}

// ── node_block / mixed_block encoding ──────────────────────────────────────

fn write_node_block_payload(w: &mut ByteWriter, b: &NodeBlock) -> Result<(), String> {
    let kind_bytes = b.kind.as_bytes();
    w.write_leb128_u32(kind_bytes.len() as u32);
    w.write_bytes(kind_bytes);

    let num_nodes = b.nids.len();
    w.write_leb128_u32(num_nodes as u32);
    w.write_leb128_u32(b.columns.len() as u32);
    for col in &b.columns { write_user_col_schema(w, col)?; }

    write_nid_delta_column(w, &b.nids)?;
    write_parent_nid_column(w, &b.parent_nids);
    write_child_index_column(w, &b.child_indices);

    for col in &b.columns { write_user_col_data(w, col, num_nodes)?; }
    Ok(())
}

fn write_mixed_block_payload(w: &mut ByteWriter, b: &MixedBlock) -> Result<(), String> {
    // kind_len = 0 for mixed
    w.write_leb128_u32(0);

    let num_nodes = b.nids.len();
    w.write_leb128_u32(num_nodes as u32);
    w.write_leb128_u32(b.columns.len() as u32);
    for col in &b.columns { write_user_col_schema(w, col)?; }

    write_nid_delta_column(w, &b.nids)?;
    write_parent_nid_column(w, &b.parent_nids);
    write_child_index_column(w, &b.child_indices);
    write_kind_column(w, &b.kinds)?;

    for col in &b.columns { write_user_col_data(w, col, num_nodes)?; }
    Ok(())
}

fn write_block(w: &mut ByteWriter, block: &Block) -> Result<(), String> {
    match block {
        Block::Node(b) => {
            w.write_byte(BLOCK_TYPE_NODE);
            write_node_block_payload(w, b)?;
        }
        Block::Mixed(b) => {
            w.write_byte(BLOCK_TYPE_MIXED);
            write_mixed_block_payload(w, b)?;
        }
    }
    Ok(())
}

// ── Document header ─────────────────────────────────────────────────────────

fn write_doc_header(w: &mut ByteWriter, schema_hash: &[u8; SCHEMA_HASH_BYTES]) {
    w.write_leb128_u32(AST_VERSION);
    w.write_leb128_u32(PROFILE_NUM);
    w.write_bytes(schema_hash);
}

// ── Public: AST document (snapshot) ────────────────────────────────────────

pub fn encode_tree(doc: &AstDoc) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    write_doc_header(&mut w, &doc.schema_hash);
    w.write_leb128_u32(doc.blocks.len() as u32);
    for block in &doc.blocks {
        write_block(&mut w, block)?;
    }
    Ok(w.into_bytes())
}

// ── Path encoding ───────────────────────────────────────────────────────────

fn write_path(w: &mut ByteWriter, path: &Path) -> Result<(), String> {
    match path {
        Path::Node { nid } => {
            w.write_byte(PATH_NODE << 4);
            w.write_leb128_u64(*nid);
        }
        Path::NodeCol { nid, col_id } => {
            w.write_byte(PATH_NODE_COL << 4);
            w.write_leb128_u64(*nid);
            w.write_leb128_u32(*col_id);
        }
        Path::NodeKind { node_kind } => {
            w.write_byte(PATH_NODE_KIND << 4);
            let bytes = node_kind.as_bytes();
            w.write_leb128_u32(bytes.len() as u32);
            w.write_bytes(bytes);
        }
        Path::AtNid         => { w.write_byte(PATH_AT_NID         << 4); }
        Path::AtParent      => { w.write_byte(PATH_AT_PARENT      << 4); }
        Path::AtChildIndex  => { w.write_byte(PATH_AT_CHILD_INDEX << 4); }
        Path::AtKind        => { w.write_byte(PATH_AT_KIND        << 4); }
        Path::NodeProp { nid, prop } => {
            w.write_byte(PATH_NODE_PROP << 4);
            w.write_leb128_u64(*nid);
            let bytes = prop.as_bytes();
            w.write_leb128_u32(bytes.len() as u32);
            w.write_bytes(bytes);
        }
    }
    Ok(())
}

// ── Op encoding ─────────────────────────────────────────────────────────────

fn write_op(w: &mut ByteWriter, op: &Op) -> Result<(), String> {
    match op {
        Op::NodeInsert { block } => {
            w.write_byte(OP_NODE_INSERT & 0x7);
            write_block(w, block)?;
        }
        Op::NodeDelete { nids } => {
            w.write_byte(OP_NODE_DELETE & 0x7);
            w.write_leb128_u64(nids.len() as u64);
            for &nid in nids {
                w.write_leb128_u64(nid);
            }
        }
        Op::NodeMove { nid, new_parent_nid, new_child_index } => {
            w.write_byte(OP_NODE_MOVE & 0x7);
            w.write_leb128_u64(*nid);
            w.write_leb128_u64(*new_parent_nid);
            w.write_leb128_u32(*new_child_index);
        }
        Op::PropSet { path, ctype, nullable, is_null, value } => {
            w.write_byte(OP_PROP_SET & 0x7);
            write_path(w, path)?;
            w.write_byte(ctype & 0xF);
            let nullable_bit = if *nullable { 1u8 } else { 0u8 };
            let is_null_effective = *nullable && *is_null;
            let is_null_bit = if is_null_effective { 1u8 } else { 0u8 };
            w.write_byte(nullable_bit | (is_null_bit << 1));
            if !is_null_effective {
                if let Some(val) = value {
                    write_value(w, *ctype, val)?;
                }
            }
        }
        Op::KindRename { old_kind, new_kind } => {
            w.write_byte(OP_KIND_RENAME & 0x7);
            let old_bytes = old_kind.as_bytes();
            w.write_leb128_u32(old_bytes.len() as u32);
            w.write_bytes(old_bytes);
            let new_bytes = new_kind.as_bytes();
            w.write_leb128_u32(new_bytes.len() as u32);
            w.write_bytes(new_bytes);
        }
        Op::SubtreeReplace { root_nid, block } => {
            w.write_byte(OP_SUBTREE_REPLACE & 0x7);
            w.write_leb128_u64(*root_nid);
            write_block(w, block)?;
        }
    }
    Ok(())
}

// ── Public: delta chain ─────────────────────────────────────────────────────

pub fn encode_chain(chain: &AstChain) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    write_doc_header(&mut w, &chain.schema_hash);
    w.write_leb128_u32(chain.ops.len() as u32);
    for op in &chain.ops {
        write_op(&mut w, op)?;
    }
    Ok(w.into_bytes())
}
