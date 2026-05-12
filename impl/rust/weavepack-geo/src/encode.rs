// weavepack-geo — encoder.
//
// Wire layout mirrors sdk/src/profiles/geo/encoder.js exactly.
// Profile isolation: only imports from crate::types.

use crate::types::{
    Block, CellValue, DocBlock, DeltaFrame, FeatureBlock, Fid, GcBlock, GeoDocument, Geom,
    InnerPath, Op, Path, PropCol,
    BLOCK_DELTA, BLOCK_FEATURE, BLOCK_GEOMETRY_COLLECTION,
    COORD_FLOAT32,
    CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
    CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8,
    CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64, CTYPE_UINT8,
    FID_ABSENT, FID_STRING, FID_UINT64,
    GEOM_LINESTRING, GEOM_MULTILINESTRING, GEOM_MULTIPOINT, GEOM_MULTIPOLYGON,
    GEOM_NULL, GEOM_POINT, GEOM_POLYGON,
    OP_COLLECTION_REPLACE, OP_FEATURE_DELETE, OP_FEATURE_INSERT,
    OP_GEOMETRY_REPLACE, OP_PROP_DELETE, OP_PROP_SET,
    PATH_BY_IDX, PATH_BY_INT_FID, PATH_BY_STR_FID, PATH_GEOMETRY, PATH_PROP_IDX, PATH_PROP_NAME,
    PROFILE_NUM,
};

// ── ByteWriter ─────────────────────────────────────────────────────────────

struct ByteWriter {
    buf: Vec<u8>,
}

impl ByteWriter {
    fn new() -> Self { ByteWriter { buf: Vec::new() } }

    fn byte(&mut self, b: u8) { self.buf.push(b); }

    fn bytes(&mut self, src: &[u8]) { self.buf.extend_from_slice(src); }

    fn leb128_u32(&mut self, mut v: u32) {
        loop {
            if v < 128 { self.buf.push(v as u8); break; }
            self.buf.push((v as u8 & 0x7F) | 0x80);
            v >>= 7;
        }
    }

    fn f32_le(&mut self, v: f32)  { self.bytes(&v.to_le_bytes()); }
    fn f64_le(&mut self, v: f64)  { self.bytes(&v.to_le_bytes()); }
    fn u64_le(&mut self, v: u64)  { self.bytes(&v.to_le_bytes()); }

    fn into_bytes(self) -> Vec<u8> { self.buf }
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn write_str(w: &mut ByteWriter, s: &str) {
    let b = s.as_bytes();
    w.leb128_u32(b.len() as u32);
    if !b.is_empty() { w.bytes(b); }
}

fn write_coord_col(w: &mut ByteWriter, vals: &[f64], cp: u8) {
    for &v in vals {
        if cp == COORD_FLOAT32 { w.f32_le(v as f32); }
        else { w.f64_le(v); }
    }
}

fn write_leb128_array(w: &mut ByteWriter, arr: &[u32]) {
    for &v in arr { w.leb128_u32(v); }
}

// ── Cell value ─────────────────────────────────────────────────────────────

fn write_value(w: &mut ByteWriter, ctype: u8, val: &CellValue) -> Result<(), String> {
    match (ctype, val) {
        (CTYPE_BOOL,  CellValue::Bool(b))        => { w.byte(if *b { 1 } else { 0 }); }
        (CTYPE_INT8,  CellValue::Int8(v))         => { w.byte(*v as u8); }
        (CTYPE_INT16, CellValue::Int16(v))        => { w.bytes(&(*v as u16).to_le_bytes()); }
        (CTYPE_INT32, CellValue::Int32(v))        => { w.bytes(&(*v as u32).to_le_bytes()); }
        (CTYPE_INT64, CellValue::Int64(v))
        | (CTYPE_TIMESTAMP64, CellValue::Timestamp64(v)) => {
            w.bytes(&(*v as u64).to_le_bytes());
        }
        (CTYPE_UINT8,  CellValue::Uint8(v))       => { w.byte(*v); }
        (CTYPE_UINT16, CellValue::Uint16(v))      => { w.bytes(&v.to_le_bytes()); }
        (CTYPE_UINT32, CellValue::Uint32(v))      => { w.bytes(&v.to_le_bytes()); }
        (CTYPE_UINT64, CellValue::Uint64(v))      => { w.u64_le(*v); }
        (CTYPE_FLOAT32, CellValue::Float32(v))    => { w.f32_le(*v); }
        (CTYPE_FLOAT64, CellValue::Float64(v))    => { w.f64_le(*v); }
        (CTYPE_STRING, CellValue::String(s))      => {
            let b = s.as_bytes();
            w.leb128_u32(b.len() as u32);
            w.bytes(b);
        }
        (CTYPE_BYTES, CellValue::Bytes(b))        => {
            w.leb128_u32(b.len() as u32);
            w.bytes(b);
        }
        (CTYPE_DATE32, CellValue::Date32(v))      => { w.bytes(&(*v as u32).to_le_bytes()); }
        _ => return Err(format!("type_mismatch: ctype={ctype} val={val:?}")),
    }
    Ok(())
}

// ── Null bitmap (LSB-first per geo spec) ────────────────────────────────────

fn write_null_bitmap(w: &mut ByteWriter, values: &[Option<CellValue>]) {
    let n      = values.len();
    let nbytes = (n + 7) / 8;
    let mut bm = vec![0u8; nbytes];
    for (i, v) in values.iter().enumerate() {
        if v.is_none() { bm[i >> 3] |= 1 << (i & 7); }
    }
    w.bytes(&bm);
}

// ── Bool column (bit-packed, non-null values only) ───────────────────────────

fn write_bool_column(w: &mut ByteWriter, values: &[Option<CellValue>]) {
    let non_null: Vec<bool> = values.iter()
        .filter_map(|v| if let Some(CellValue::Bool(b)) = v { Some(*b) } else { None })
        .collect();
    let n      = non_null.len();
    let nbytes = (n + 7) / 8;
    let mut bm = vec![0u8; nbytes];
    for (i, &b) in non_null.iter().enumerate() {
        if b { bm[i >> 3] |= 1 << (i & 7); }
    }
    w.bytes(&bm);
}

// ── PropCols ───────────────────────────────────────────────────────────────

fn write_prop_cols(w: &mut ByteWriter, cols: &[PropCol], num_features: usize) -> Result<(), String> {
    for col in cols {
        if col.ctype > 14 { return Err(format!("unknown_ctype: {}", col.ctype)); }
        write_str(w, &col.name);
        w.byte(col.ctype);
        w.byte(if col.nullable { 1 } else { 0 });
        if col.nullable {
            write_null_bitmap(w, &col.values);
        }
        if col.values.len() != num_features {
            return Err(format!("col '{}': {} values but {} features",
                col.name, col.values.len(), num_features));
        }
        if col.ctype == CTYPE_BOOL {
            write_bool_column(w, &col.values);
        } else {
            for v in &col.values {
                if let Some(val) = v { write_value(w, col.ctype, val)?; }
            }
        }
    }
    Ok(())
}

// ── FID column ─────────────────────────────────────────────────────────────

fn write_fid_column(w: &mut ByteWriter, fid_kind: u8, fids: &Option<Vec<Fid>>, num_features: usize) -> Result<(), String> {
    if fid_kind == FID_ABSENT { return Ok(()); }
    let fids = fids.as_ref().ok_or("fids required for non-absent fid_kind")?;
    if fids.len() != num_features {
        return Err(format!("fids.len() {} != num_features {}", fids.len(), num_features));
    }
    for fid in fids {
        match (fid_kind, fid) {
            (FID_STRING, Fid::Str(s)) => write_str(w, s),
            (FID_UINT64, Fid::Int(n)) => w.u64_le(*n),
            _ => return Err(format!("fid_kind mismatch: kind={fid_kind} fid={fid:?}")),
        }
    }
    Ok(())
}

// ── Geometry section ──────────────────────────────────────────────────────────

fn write_geom_section(w: &mut ByteWriter, geom_type: u8, geom: &Geom, has_z: bool, cp: u8) -> Result<(), String> {
    match geom_type {
        GEOM_POINT => {
            write_coord_col(w, &geom.x, cp);
            write_coord_col(w, &geom.y, cp);
            if has_z { write_coord_col(w, geom.z.as_deref().unwrap_or(&[]), cp); }
        }
        GEOM_LINESTRING => {
            write_leb128_array(w, &geom.coord_counts);
            write_coord_col(w, &geom.x, cp);
            write_coord_col(w, &geom.y, cp);
            if has_z { write_coord_col(w, geom.z.as_deref().unwrap_or(&[]), cp); }
        }
        GEOM_POLYGON => {
            write_leb128_array(w, &geom.rings_per_feature);
            write_leb128_array(w, &geom.ring_counts);
            write_coord_col(w, &geom.x, cp);
            write_coord_col(w, &geom.y, cp);
            if has_z { write_coord_col(w, geom.z.as_deref().unwrap_or(&[]), cp); }
        }
        GEOM_MULTIPOINT => {
            write_leb128_array(w, &geom.part_counts);
            write_coord_col(w, &geom.x, cp);
            write_coord_col(w, &geom.y, cp);
            if has_z { write_coord_col(w, geom.z.as_deref().unwrap_or(&[]), cp); }
        }
        GEOM_MULTILINESTRING => {
            write_leb128_array(w, &geom.part_counts);
            write_leb128_array(w, &geom.coord_counts);
            write_coord_col(w, &geom.x, cp);
            write_coord_col(w, &geom.y, cp);
            if has_z { write_coord_col(w, geom.z.as_deref().unwrap_or(&[]), cp); }
        }
        GEOM_MULTIPOLYGON => {
            write_leb128_array(w, &geom.part_counts);
            write_leb128_array(w, &geom.rings_per_part);
            write_leb128_array(w, &geom.ring_counts);
            write_coord_col(w, &geom.x, cp);
            write_coord_col(w, &geom.y, cp);
            if has_z { write_coord_col(w, geom.z.as_deref().unwrap_or(&[]), cp); }
        }
        GEOM_NULL => {}
        t => return Err(format!("unknown_geom_type: {t}")),
    }
    Ok(())
}

// ── feature_block payload ─────────────────────────────────────────────────────

fn write_feature_block_payload(w: &mut ByteWriter, blk: &FeatureBlock) -> Result<(), String> {
    if blk.num_features < 1 { return Err("empty_feature_block".into()); }
    w.byte(blk.geom_type);
    w.byte(blk.coord_precision);
    w.byte(if blk.has_z { 1 } else { 0 });
    w.byte(blk.fid_kind);
    w.leb128_u32(blk.num_features as u32);
    w.leb128_u32(blk.prop_cols.len() as u32);
    write_fid_column(w, blk.fid_kind, &blk.fids, blk.num_features)?;
    write_geom_section(w, blk.geom_type, &blk.geom, blk.has_z, blk.coord_precision)?;
    write_prop_cols(w, &blk.prop_cols, blk.num_features)?;
    Ok(())
}

// ── gc_block payload ───────────────────────────────────────────────────────

fn write_gc_block_payload(w: &mut ByteWriter, blk: &GcBlock) -> Result<(), String> {
    if blk.num_features < 1 { return Err("empty_feature_block".into()); }
    w.byte(blk.coord_precision);
    w.byte(if blk.has_z { 1 } else { 0 });
    w.byte(blk.fid_kind);
    w.leb128_u32(blk.num_features as u32);
    w.leb128_u32(blk.prop_cols.len() as u32);
    write_fid_column(w, blk.fid_kind, &blk.fids, blk.num_features)?;
    w.leb128_u32(blk.sub_geoms.len() as u32);
    write_leb128_array(w, &blk.sub_geom_counts);
    for sg in &blk.sub_geoms { w.byte(sg.geom_type); }
    for sg in &blk.sub_geoms {
        write_geom_section(w, sg.geom_type, &sg.geom, blk.has_z, blk.coord_precision)?;
    }
    write_prop_cols(w, &blk.prop_cols, blk.num_features)?;
    Ok(())
}

fn write_block(w: &mut ByteWriter, block: &Block) -> Result<(), String> {
    match block {
        Block::Feature(b) => { w.byte(BLOCK_FEATURE); write_feature_block_payload(w, b) }
        Block::Gc(b)      => { w.byte(BLOCK_GEOMETRY_COLLECTION); write_gc_block_payload(w, b) }
    }
}

// ── Inner path ─────────────────────────────────────────────────────────────

fn write_inner_path(w: &mut ByteWriter, ip: &InnerPath) -> Result<(), String> {
    match ip {
        InnerPath::ByIdx(idx)    => { w.byte(PATH_BY_IDX << 4);     w.leb128_u32(*idx); }
        InnerPath::ByStrFid(fid) => { w.byte(PATH_BY_STR_FID << 4); write_str(w, fid); }
        InnerPath::ByIntFid(fid) => { w.byte(PATH_BY_INT_FID << 4); w.u64_le(*fid); }
    }
    Ok(())
}

// ── Path ───────────────────────────────────────────────────────────────────

fn write_path(w: &mut ByteWriter, path: &Path) -> Result<(), String> {
    match path {
        Path::ByIdx(idx)    => { w.byte(PATH_BY_IDX << 4);     w.leb128_u32(*idx); }
        Path::ByStrFid(fid) => { w.byte(PATH_BY_STR_FID << 4); write_str(w, fid); }
        Path::ByIntFid(fid) => { w.byte(PATH_BY_INT_FID << 4); w.u64_le(*fid); }
        Path::Geometry(ip)  => { w.byte(PATH_GEOMETRY << 4);   write_inner_path(w, ip)?; }
        Path::PropName { inner, name } => {
            w.byte(PATH_PROP_NAME << 4);
            write_inner_path(w, inner)?;
            write_str(w, name);
        }
        Path::PropIdx { inner, col_idx } => {
            w.byte(PATH_PROP_IDX << 4);
            write_inner_path(w, inner)?;
            w.leb128_u32(*col_idx);
        }
    }
    Ok(())
}

// ── Op ─────────────────────────────────────────────────────────────────────

fn write_op(w: &mut ByteWriter, op: &Op) -> Result<(), String> {
    match op {
        Op::FeatureInsert { block } => {
            w.byte(OP_FEATURE_INSERT << 3);
            write_block(w, block)?;
        }
        Op::FeatureDelete { mode, paths, start, count } => {
            w.byte(OP_FEATURE_DELETE << 3);
            w.byte(*mode);
            if *mode == 0 {
                w.leb128_u32(paths.len() as u32);
                for p in paths { write_path(w, p)?; }
            } else if *mode == 1 {
                w.leb128_u32(*start);
                w.leb128_u32(*count);
            } else {
                return Err(format!("unknown_feature_delete_mode: {mode}"));
            }
        }
        Op::GeometryReplace { path, block } => {
            w.byte(OP_GEOMETRY_REPLACE << 3);
            write_path(w, path)?;
            w.byte(BLOCK_FEATURE);
            write_feature_block_payload(w, block)?;
        }
        Op::PropSet { path, ctype, value } => {
            w.byte(OP_PROP_SET << 3);
            write_path(w, path)?;
            w.byte(*ctype);
            write_value(w, *ctype, value)?;
        }
        Op::PropDelete { path } => {
            w.byte(OP_PROP_DELETE << 3);
            write_path(w, path)?;
        }
        Op::CollectionReplace { blocks } => {
            w.byte(OP_COLLECTION_REPLACE << 3);
            w.leb128_u32(blocks.len() as u32);
            for b in blocks { write_block(w, b)?; }
        }
    }
    Ok(())
}

// ── Delta frame ─────────────────────────────────────────────────────────────

fn write_delta_frame(w: &mut ByteWriter, df: &DeltaFrame) -> Result<(), String> {
    write_str(w, &df.name);
    w.leb128_u32(df.ops.len() as u32);
    for op in &df.ops { write_op(w, op)?; }
    Ok(())
}

// ── Public: encode_document ───────────────────────────────────────────────

pub fn encode_document(doc: &GeoDocument) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    w.byte(PROFILE_NUM);
    write_str(&mut w, &doc.name);
    w.leb128_u32(doc.blocks.len() as u32);
    for blk in &doc.blocks {
        match blk {
            DocBlock::Feature(b) => { w.byte(BLOCK_FEATURE); write_feature_block_payload(&mut w, b)?; }
            DocBlock::Gc(b)      => { w.byte(BLOCK_GEOMETRY_COLLECTION); write_gc_block_payload(&mut w, b)?; }
            DocBlock::Delta(d)   => { w.byte(BLOCK_DELTA); write_delta_frame(&mut w, d)?; }
        }
    }
    Ok(w.into_bytes())
}
