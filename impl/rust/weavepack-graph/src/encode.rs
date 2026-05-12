// weavepack-graph — encoder (graph documents + delta chains).
//
// Wire layout:
//   Graph doc:  LEB128(version=1) + LEB128(profile=6) + 32-byte schema_hash
//               + LEB128(num_blocks) + block[*]
//   Delta chain: LEB128(version=1) + LEB128(profile=6) + 32-byte schema_hash
//               + LEB128(num_ops) + op[*]
//
// Profile isolation: only imports from crate::types.

use crate::types::{
    Block, CellValue, EdgeBlock, GraphDoc, NodeBlock, Op, Path,
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
            let u = *v as u16;
            w.write_byte((u & 0xFF) as u8);
            w.write_byte(((u >> 8) & 0xFF) as u8);
        }
        (CTYPE_INT32, CellValue::Int32(v)) => {
            let u = *v as u32;
            w.write_byte((u & 0xFF) as u8);
            w.write_byte(((u >> 8) & 0xFF) as u8);
            w.write_byte(((u >> 16) & 0xFF) as u8);
            w.write_byte(((u >> 24) & 0xFF) as u8);
        }
        (CTYPE_INT64, CellValue::Int64(v)) | (CTYPE_TIMESTAMP64, CellValue::Timestamp64(v)) => {
            let u = *v as u64;
            w.write_bytes(&u.to_le_bytes());
        }
        (CTYPE_UINT8, CellValue::Uint8(v)) => {
            w.write_byte(*v);
        }
        (CTYPE_UINT16, CellValue::Uint16(v)) => {
            w.write_byte((*v & 0xFF) as u8);
            w.write_byte((*v >> 8) as u8);
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
            let utf8 = s.as_bytes();
            if utf8.len() > MAX_PAYLOAD_BYTES {
                return Err("string_too_large: string exceeds 1 GiB limit".into());
            }
            w.write_leb128_u32(utf8.len() as u32);
            w.write_bytes(utf8);
        }
        (CTYPE_BYTES, CellValue::Bytes(b)) => {
            if b.len() > MAX_PAYLOAD_BYTES {
                return Err("string_too_large: bytes exceeds 1 GiB limit".into());
            }
            w.write_leb128_u32(b.len() as u32);
            w.write_bytes(b);
        }
        (CTYPE_DATE32, CellValue::Date32(v)) => {
            let u = *v as u32;
            w.write_bytes(&u.to_le_bytes());
        }
        _ => {
            return Err(format!("unknown_ctype: ctype {ctype} or value mismatch"));
        }
    }
    Ok(())
}

// ── Bool column: 1 bit per value, LSB-first within each byte ───────────────

fn write_bool_column(w: &mut ByteWriter, values: &[Option<CellValue>]) {
    let non_null: Vec<bool> = values.iter().filter_map(|v| {
        if let Some(CellValue::Bool(b)) = v { Some(*b) } else { None }
    }).collect();
    let n = non_null.len();
    let nbytes = (n + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, b) in non_null.iter().enumerate() {
        if *b { bytes[i >> 3] |= 1 << (i & 7); }
    }
    w.write_bytes(&bytes);
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

// ── Value column (non-bool, skipping nulls) ─────────────────────────────────

fn write_value_column(w: &mut ByteWriter, ctype: u8, values: &[Option<CellValue>]) -> Result<(), String> {
    if ctype == CTYPE_BOOL {
        write_bool_column(w, values);
        return Ok(());
    }
    for v in values {
        if let Some(val) = v {
            write_value(w, ctype, val)?;
        }
    }
    Ok(())
}

// ── NID / EID delta-pack column ─────────────────────────────────────────────

fn write_id_delta_column(w: &mut ByteWriter, ids: &[u64]) -> Result<(), String> {
    if ids.is_empty() { return Ok(()); }
    w.write_leb128_u64(ids[0]);
    for i in 1..ids.len() {
        if ids[i] <= ids[i - 1] {
            return Err(format!(
                "duplicate_element_id: id delta must be \u{2265}1; got non-increasing id at index {i}"
            ));
        }
        let delta = ids[i] - ids[i - 1];
        w.write_leb128_u64(delta);
    }
    Ok(())
}

// ── SRC / DST plain uint64 column ───────────────────────────────────────────

fn write_plain_u64_column(w: &mut ByteWriter, values: &[u64]) {
    for v in values {
        w.write_bytes(&v.to_le_bytes());
    }
}

// ── Property column schema + data ──────────────────────────────────────────

fn write_prop_col_schema(w: &mut ByteWriter, col_id: u32, ctype: u8, nullable: bool, min_col_id: u32) -> Result<(), String> {
    if col_id < min_col_id {
        return Err(format!("reserved_col_id: col_id {col_id} is reserved (must be \u{2265} {min_col_id})"));
    }
    if ctype > 15 {
        return Err(format!("unknown_ctype: ctype {ctype} \u{2265} 16 is reserved"));
    }
    w.write_leb128_u32(col_id);
    let type_byte = (if nullable { 1u8 } else { 0u8 } << 4) | (ctype & 0xF);
    w.write_byte(type_byte);
    Ok(())
}

fn write_prop_col_data(w: &mut ByteWriter, ctype: u8, nullable: bool, values: &[Option<CellValue>], num_elems: usize) -> Result<(), String> {
    if values.len() != num_elems {
        return Err(format!("column has {} values but block has {} elements", values.len(), num_elems));
    }
    if nullable {
        write_null_bitmap(w, values);
    }
    write_value_column(w, ctype, values)?;
    Ok(())
}

// ── Node block ──────────────────────────────────────────────────────────────

fn write_node_block(w: &mut ByteWriter, blk: &NodeBlock) -> Result<(), String> {
    let num_nodes = blk.nids.len();
    let label_bytes = blk.label.as_deref().map(|s| s.as_bytes()).unwrap_or(&[]);

    w.write_leb128_u64(num_nodes as u64);
    w.write_leb128_u32(label_bytes.len() as u32);
    if !label_bytes.is_empty() { w.write_bytes(label_bytes); }

    w.write_leb128_u32(blk.columns.len() as u32);
    for col in &blk.columns {
        write_prop_col_schema(w, col.col_id, col.ctype, col.nullable, 2)?;
    }

    write_id_delta_column(w, &blk.nids)?;

    for col in &blk.columns {
        write_prop_col_data(w, col.ctype, col.nullable, &col.values, num_nodes)?;
    }
    Ok(())
}

// ── Edge block ──────────────────────────────────────────────────────────────

fn write_edge_block(w: &mut ByteWriter, blk: &EdgeBlock) -> Result<(), String> {
    let num_edges = blk.eids.len();
    if blk.srcs.len() != num_edges {
        return Err(format!("srcs.len() ({}) must equal eids.len() ({})", blk.srcs.len(), num_edges));
    }
    if blk.dsts.len() != num_edges {
        return Err(format!("dsts.len() ({}) must equal eids.len() ({})", blk.dsts.len(), num_edges));
    }

    let label_bytes = blk.label.as_deref().map(|s| s.as_bytes()).unwrap_or(&[]);
    w.write_leb128_u64(num_edges as u64);
    w.write_leb128_u32(label_bytes.len() as u32);
    if !label_bytes.is_empty() { w.write_bytes(label_bytes); }

    w.write_leb128_u32(blk.columns.len() as u32);
    for col in &blk.columns {
        write_prop_col_schema(w, col.col_id, col.ctype, col.nullable, 4)?;
    }

    write_id_delta_column(w, &blk.eids)?;
    write_plain_u64_column(w, &blk.srcs);
    write_plain_u64_column(w, &blk.dsts);

    for col in &blk.columns {
        write_prop_col_data(w, col.ctype, col.nullable, &col.values, num_edges)?;
    }
    Ok(())
}

// ── Document header ─────────────────────────────────────────────────────────

fn write_doc_header(w: &mut ByteWriter, schema_hash: &[u8; SCHEMA_HASH_BYTES]) {
    w.write_leb128_u32(GRAPH_VERSION);
    w.write_leb128_u32(PROFILE_NUM);
    w.write_bytes(schema_hash);
}

// ── Public: encode_graph ────────────────────────────────────────────────────

pub fn encode_graph(doc: &GraphDoc) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    write_doc_header(&mut w, &doc.schema_hash);
    w.write_leb128_u32(doc.blocks.len() as u32);
    for blk in &doc.blocks {
        match blk {
            Block::Node(nb) => {
                w.write_byte(BLOCK_TYPE_NODE);
                write_node_block(&mut w, nb)?;
            }
            Block::Edge(eb) => {
                w.write_byte(BLOCK_TYPE_EDGE);
                write_edge_block(&mut w, eb)?;
            }
        }
    }
    Ok(w.into_bytes())
}

// ── Path encoding (for prop_set) ────────────────────────────────────────────

fn write_path(w: &mut ByteWriter, path: &Path) -> Result<(), String> {
    let kind: u8 = match path {
        Path::Node { .. }         => PATH_NODE,
        Path::NodeCol { .. }      => PATH_NODE_COL,
        Path::Edge { .. }         => PATH_EDGE,
        Path::EdgeCol { .. }      => PATH_EDGE_COL,
        Path::NodeLabel { .. }    => PATH_NODE_LABEL,
        Path::NodeLabelCol { .. } => PATH_NODE_LABEL_COL,
        Path::EdgeLabel { .. }    => PATH_EDGE_LABEL,
        Path::EdgeLabelCol { .. } => PATH_EDGE_LABEL_COL,
        Path::AtNid               => PATH_AT_NID,
        Path::AtEid               => PATH_AT_EID,
        Path::AtSrc               => PATH_AT_SRC,
        Path::AtDst               => PATH_AT_DST,
        Path::AtLabel { .. }      => PATH_AT_LABEL,
        Path::NodeProp { .. }     => PATH_NODE_PROP,
        Path::EdgeProp { .. }     => PATH_EDGE_PROP,
    };
    w.write_byte((kind & 0xF) << 4);
    match path {
        Path::Node { nid } => {
            w.write_leb128_u64(*nid);
        }
        Path::NodeCol { nid, col_id } => {
            w.write_leb128_u64(*nid);
            w.write_leb128_u32(*col_id);
        }
        Path::Edge { eid } => {
            w.write_leb128_u64(*eid);
        }
        Path::EdgeCol { eid, col_id } => {
            w.write_leb128_u64(*eid);
            w.write_leb128_u32(*col_id);
        }
        Path::NodeLabel { label } | Path::EdgeLabel { label } | Path::AtLabel { label } => {
            let lb = label.as_bytes();
            w.write_leb128_u32(lb.len() as u32);
            w.write_bytes(lb);
        }
        Path::NodeLabelCol { label, col_id } | Path::EdgeLabelCol { label, col_id } => {
            let lb = label.as_bytes();
            w.write_leb128_u32(lb.len() as u32);
            w.write_bytes(lb);
            w.write_leb128_u32(*col_id);
        }
        Path::AtNid | Path::AtEid | Path::AtSrc | Path::AtDst => {
            // no payload
        }
        Path::NodeProp { nid, prop } => {
            w.write_leb128_u64(*nid);
            let lb = prop.as_bytes();
            w.write_leb128_u32(lb.len() as u32);
            w.write_bytes(lb);
        }
        Path::EdgeProp { eid, prop } => {
            w.write_leb128_u64(*eid);
            let lb = prop.as_bytes();
            w.write_leb128_u32(lb.len() as u32);
            w.write_bytes(lb);
        }
    }
    Ok(())
}

// ── Op encoding ─────────────────────────────────────────────────────────────

fn write_op(w: &mut ByteWriter, op: &Op) -> Result<(), String> {
    match op {
        Op::NodeInsert { block } => {
            w.write_byte(OP_NODE_INSERT & 0x7);
            write_node_block(w, block)?;
        }
        Op::NodeDelete { nids } => {
            w.write_byte(OP_NODE_DELETE & 0x7);
            w.write_leb128_u64(nids.len() as u64);
            for nid in nids { w.write_leb128_u64(*nid); }
        }
        Op::EdgeInsert { block } => {
            w.write_byte(OP_EDGE_INSERT & 0x7);
            write_edge_block(w, block)?;
        }
        Op::EdgeDelete { eids } => {
            w.write_byte(OP_EDGE_DELETE & 0x7);
            w.write_leb128_u64(eids.len() as u64);
            for eid in eids { w.write_leb128_u64(*eid); }
        }
        Op::PropSet { path, ctype, nullable, is_null, value } => {
            w.write_byte(OP_PROP_SET & 0x7);
            write_path(w, path)?;
            w.write_byte(ctype & 0xF);
            let nullable_bit = if *nullable { 1u8 } else { 0u8 };
            let is_null_effective = *nullable && (*is_null || value.is_none());
            let is_null_bit = if is_null_effective { 1u8 } else { 0u8 };
            w.write_byte(nullable_bit | (is_null_bit << 1));
            if !is_null_effective {
                if let Some(val) = value {
                    write_value(w, *ctype, val)?;
                }
            }
        }
        Op::SubgraphReplace { label, node_block, edge_block } => {
            w.write_byte(OP_SUBGRAPH_REPLACE & 0x7);
            let has_node = node_block.is_some() as u8;
            let has_edge = edge_block.is_some() as u8;
            w.write_byte(has_node | (has_edge << 1));
            let label_bytes = label.as_deref().map(|s| s.as_bytes()).unwrap_or(&[]);
            w.write_leb128_u32(label_bytes.len() as u32);
            if !label_bytes.is_empty() { w.write_bytes(label_bytes); }
            if let Some(nb) = node_block { write_node_block(w, nb)?; }
            if let Some(eb) = edge_block { write_edge_block(w, eb)?; }
        }
    }
    Ok(())
}

// ── Public: encode_chain ────────────────────────────────────────────────────

pub fn encode_chain(schema_hash: &[u8; SCHEMA_HASH_BYTES], ops: &[Op]) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    write_doc_header(&mut w, schema_hash);
    w.write_leb128_u32(ops.len() as u32);
    for op in ops { write_op(&mut w, op)?; }
    Ok(w.into_bytes())
}
