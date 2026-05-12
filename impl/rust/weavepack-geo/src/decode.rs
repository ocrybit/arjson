// weavepack-geo — decoder.
//
// Wire layout mirrors sdk/src/profiles/geo/decoder.js exactly.
// Profile isolation: only imports from crate::types.

use crate::types::{
    Block, CellValue, DocBlock, DeltaFrame, FeatureBlock, Fid, GcBlock, GeoDocument, Geom,
    InnerPath, Op, Path, PropCol, SubGeom,
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

// ── ByteReader ─────────────────────────────────────────────────────────────

struct ByteReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    fn new(buf: &'a [u8]) -> Self { ByteReader { buf, pos: 0 } }

    fn byte(&mut self) -> Result<u8, String> {
        if self.pos >= self.buf.len() { return Err("unexpected_end_of_input".into()); }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() { return Err("unexpected_end_of_input".into()); }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn leb128_u32(&mut self) -> Result<u32, String> {
        let mut r = 0u32;
        let mut shift = 0u32;
        loop {
            let b = self.byte()?;
            r |= ((b & 0x7F) as u32) << shift;
            shift += 7;
            if b & 0x80 == 0 { break; }
            if shift >= 35 { return Err("leb128_overflow".into()); }
        }
        Ok(r)
    }

    fn f32_le(&mut self) -> Result<f32, String> {
        let b = self.bytes(4)?;
        Ok(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f64_le(&mut self) -> Result<f64, String> {
        let b = self.bytes(8)?;
        Ok(f64::from_le_bytes(b.try_into().unwrap()))
    }

    fn u64_le(&mut self) -> Result<u64, String> {
        let b = self.bytes(8)?;
        Ok(u64::from_le_bytes(b.try_into().unwrap()))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn read_str(r: &mut ByteReader<'_>) -> Result<String, String> {
    let len = r.leb128_u32()? as usize;
    if len == 0 { return Ok(String::new()); }
    let b = r.bytes(len)?;
    std::str::from_utf8(b)
        .map(|s| s.to_owned())
        .map_err(|_| "invalid_utf8".into())
}

fn read_leb128_array(r: &mut ByteReader<'_>, n: usize) -> Result<Vec<u32>, String> {
    let mut arr = Vec::with_capacity(n);
    for _ in 0..n { arr.push(r.leb128_u32()?); }
    Ok(arr)
}

fn read_coord_col(r: &mut ByteReader<'_>, n: usize, cp: u8) -> Result<Vec<f64>, String> {
    let mut col = Vec::with_capacity(n);
    for _ in 0..n {
        let v = if cp == COORD_FLOAT32 { r.f32_le()? as f64 } else { r.f64_le()? };
        col.push(v);
    }
    Ok(col)
}

fn sum_u32(arr: &[u32]) -> usize { arr.iter().map(|&v| v as usize).sum() }

// ── Null bitmap (LSB-first) ──────────────────────────────────────────────────

fn get_null_bit(bm: &[u8], idx: usize) -> bool {
    (bm[idx >> 3] >> (idx & 7)) & 1 == 1
}

// ── Cell value ─────────────────────────────────────────────────────────────

fn read_value(r: &mut ByteReader<'_>, ctype: u8) -> Result<CellValue, String> {
    match ctype {
        CTYPE_BOOL  => Ok(CellValue::Bool(r.byte()? != 0)),
        CTYPE_INT8  => Ok(CellValue::Int8(r.byte()? as i8)),
        CTYPE_INT16 => {
            let b = r.bytes(2)?;
            Ok(CellValue::Int16(i16::from_le_bytes([b[0], b[1]])))
        }
        CTYPE_INT32 => {
            let b = r.bytes(4)?;
            Ok(CellValue::Int32(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_INT64 => Ok(CellValue::Int64(r.u64_le()? as i64)),
        CTYPE_UINT8  => Ok(CellValue::Uint8(r.byte()?)),
        CTYPE_UINT16 => {
            let b = r.bytes(2)?;
            Ok(CellValue::Uint16(u16::from_le_bytes([b[0], b[1]])))
        }
        CTYPE_UINT32 => {
            let b = r.bytes(4)?;
            Ok(CellValue::Uint32(u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_UINT64 => Ok(CellValue::Uint64(r.u64_le()?)),
        CTYPE_FLOAT32 => Ok(CellValue::Float32(r.f32_le()?)),
        CTYPE_FLOAT64 => Ok(CellValue::Float64(r.f64_le()?)),
        CTYPE_STRING  => Ok(CellValue::String(read_str(r)?)),
        CTYPE_BYTES  => {
            let len = r.leb128_u32()? as usize;
            Ok(CellValue::Bytes(r.bytes(len)?.to_vec()))
        }
        CTYPE_DATE32 => {
            let b = r.bytes(4)?;
            Ok(CellValue::Date32(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_TIMESTAMP64 => Ok(CellValue::Timestamp64(r.u64_le()? as i64)),
        _ => Err(format!("unknown_ctype: {ctype}")),
    }
}

// ── PropCols ───────────────────────────────────────────────────────────────

fn read_prop_cols(r: &mut ByteReader<'_>, num_features: usize, num_cols: usize) -> Result<Vec<PropCol>, String> {
    let mut cols = Vec::with_capacity(num_cols);
    for _ in 0..num_cols {
        let name     = read_str(r)?;
        let ctype    = r.byte()?;
        let nullable = r.byte()? != 0;

        let nbytes = (num_features + 7) / 8;
        let null_bm = if nullable {
            r.bytes(nbytes)?.to_vec()
        } else {
            vec![]
        };

        let mut values: Vec<Option<CellValue>> = vec![None; num_features];
        let mut nn_indices: Vec<usize> = Vec::new();
        for i in 0..num_features {
            if nullable && get_null_bit(&null_bm, i) {
                values[i] = None;
            } else {
                nn_indices.push(i);
            }
        }

        if ctype == CTYPE_BOOL {
            let bm_bytes = (nn_indices.len() + 7) / 8;
            let bm = r.bytes(bm_bytes)?.to_vec();
            for (j, &i) in nn_indices.iter().enumerate() {
                values[i] = Some(CellValue::Bool((bm[j >> 3] >> (j & 7)) & 1 == 1));
            }
        } else {
            for &i in &nn_indices {
                values[i] = Some(read_value(r, ctype)?);
            }
        }

        cols.push(PropCol { name, ctype, nullable, values });
    }
    Ok(cols)
}

// ── FID column ────────────────────────────────────────────────────────────

fn read_fid_column(r: &mut ByteReader<'_>, fid_kind: u8, num_features: usize) -> Result<Option<Vec<Fid>>, String> {
    if fid_kind == FID_ABSENT { return Ok(None); }
    let mut fids = Vec::with_capacity(num_features);
    for _ in 0..num_features {
        let fid = match fid_kind {
            FID_STRING => Fid::Str(read_str(r)?),
            FID_UINT64 => Fid::Int(r.u64_le()?),
            k          => return Err(format!("unknown_fid_kind: {k}")),
        };
        fids.push(fid);
    }
    Ok(Some(fids))
}

// ── Geometry section ──────────────────────────────────────────────────────────

fn read_geom_section(r: &mut ByteReader<'_>, geom_type: u8, num_features: usize, has_z: bool, cp: u8) -> Result<Geom, String> {
    let mut g = Geom::default();
    match geom_type {
        GEOM_POINT => {
            g.x = read_coord_col(r, num_features, cp)?;
            g.y = read_coord_col(r, num_features, cp)?;
            if has_z { g.z = Some(read_coord_col(r, num_features, cp)?); }
        }
        GEOM_LINESTRING => {
            g.coord_counts = read_leb128_array(r, num_features)?;
            let nv = sum_u32(&g.coord_counts);
            g.x = read_coord_col(r, nv, cp)?;
            g.y = read_coord_col(r, nv, cp)?;
            if has_z { g.z = Some(read_coord_col(r, nv, cp)?); }
        }
        GEOM_POLYGON => {
            g.rings_per_feature = read_leb128_array(r, num_features)?;
            let total_rings = sum_u32(&g.rings_per_feature);
            g.ring_counts = read_leb128_array(r, total_rings)?;
            let nv = sum_u32(&g.ring_counts);
            g.x = read_coord_col(r, nv, cp)?;
            g.y = read_coord_col(r, nv, cp)?;
            if has_z { g.z = Some(read_coord_col(r, nv, cp)?); }
        }
        GEOM_MULTIPOINT => {
            g.part_counts = read_leb128_array(r, num_features)?;
            let nv = sum_u32(&g.part_counts);
            g.x = read_coord_col(r, nv, cp)?;
            g.y = read_coord_col(r, nv, cp)?;
            if has_z { g.z = Some(read_coord_col(r, nv, cp)?); }
        }
        GEOM_MULTILINESTRING => {
            g.part_counts = read_leb128_array(r, num_features)?;
            let total_lines = sum_u32(&g.part_counts);
            g.coord_counts = read_leb128_array(r, total_lines)?;
            let nv = sum_u32(&g.coord_counts);
            g.x = read_coord_col(r, nv, cp)?;
            g.y = read_coord_col(r, nv, cp)?;
            if has_z { g.z = Some(read_coord_col(r, nv, cp)?); }
        }
        GEOM_MULTIPOLYGON => {
            g.part_counts = read_leb128_array(r, num_features)?;
            let total_parts = sum_u32(&g.part_counts);
            g.rings_per_part = read_leb128_array(r, total_parts)?;
            let total_rings = sum_u32(&g.rings_per_part);
            g.ring_counts = read_leb128_array(r, total_rings)?;
            let nv = sum_u32(&g.ring_counts);
            g.x = read_coord_col(r, nv, cp)?;
            g.y = read_coord_col(r, nv, cp)?;
            if has_z { g.z = Some(read_coord_col(r, nv, cp)?); }
        }
        GEOM_NULL => {}
        t => return Err(format!("unknown_geom_type: {t}")),
    }
    Ok(g)
}

// ── Feature block ───────────────────────────────────────────────────────────

fn read_feature_block_payload(r: &mut ByteReader<'_>) -> Result<FeatureBlock, String> {
    let geom_type       = r.byte()?;
    let coord_precision = r.byte()?;
    let has_z           = r.byte()? != 0;
    let fid_kind        = r.byte()?;
    let num_features    = r.leb128_u32()? as usize;
    let num_prop_cols   = r.leb128_u32()? as usize;
    let fids            = read_fid_column(r, fid_kind, num_features)?;
    let geom            = read_geom_section(r, geom_type, num_features, has_z, coord_precision)?;
    let prop_cols       = read_prop_cols(r, num_features, num_prop_cols)?;
    Ok(FeatureBlock { geom_type, coord_precision, has_z, fid_kind, num_features, fids, geom, prop_cols })
}

// ── GC block ──────────────────────────────────────────────────────────────

fn read_gc_block_payload(r: &mut ByteReader<'_>) -> Result<GcBlock, String> {
    let coord_precision = r.byte()?;
    let has_z           = r.byte()? != 0;
    let fid_kind        = r.byte()?;
    let num_features    = r.leb128_u32()? as usize;
    let num_prop_cols   = r.leb128_u32()? as usize;
    let fids            = read_fid_column(r, fid_kind, num_features)?;
    let total_sub_geoms = r.leb128_u32()? as usize;
    let sub_geom_counts = read_leb128_array(r, num_features)?;

    let mut sg_types = Vec::with_capacity(total_sub_geoms);
    for _ in 0..total_sub_geoms { sg_types.push(r.byte()?); }

    let mut sub_geoms = Vec::with_capacity(total_sub_geoms);
    for &gt in &sg_types {
        let geom = read_geom_section(r, gt, 1, has_z, coord_precision)?;
        sub_geoms.push(SubGeom { geom_type: gt, geom });
    }

    let prop_cols = read_prop_cols(r, num_features, num_prop_cols)?;
    Ok(GcBlock { coord_precision, has_z, fid_kind, num_features, fids, sub_geom_counts, sub_geoms, prop_cols })
}

// ── Path / inner path ─────────────────────────────────────────────────────────

fn read_inner_path(r: &mut ByteReader<'_>) -> Result<InnerPath, String> {
    let kind = (r.byte()? >> 4) & 0xF;
    match kind {
        PATH_BY_IDX     => Ok(InnerPath::ByIdx(r.leb128_u32()?)),
        PATH_BY_STR_FID => Ok(InnerPath::ByStrFid(read_str(r)?)),
        PATH_BY_INT_FID => Ok(InnerPath::ByIntFid(r.u64_le()?)),
        k               => Err(format!("invalid_inner_path_kind: {k}")),
    }
}

fn read_path(r: &mut ByteReader<'_>) -> Result<Path, String> {
    let kind = (r.byte()? >> 4) & 0xF;
    match kind {
        PATH_BY_IDX     => Ok(Path::ByIdx(r.leb128_u32()?)),
        PATH_BY_STR_FID => Ok(Path::ByStrFid(read_str(r)?)),
        PATH_BY_INT_FID => Ok(Path::ByIntFid(r.u64_le()?)),
        PATH_GEOMETRY   => Ok(Path::Geometry(read_inner_path(r)?)),
        PATH_PROP_NAME  => {
            let inner = read_inner_path(r)?;
            Ok(Path::PropName { inner, name: read_str(r)? })
        }
        PATH_PROP_IDX   => {
            let inner   = read_inner_path(r)?;
            let col_idx = r.leb128_u32()?;
            Ok(Path::PropIdx { inner, col_idx })
        }
        k => Err(format!("unknown_path_kind: {k}")),
    }
}

// ── Op ────────────────────────────────────────────────────────────────────

fn read_block(r: &mut ByteReader<'_>) -> Result<Block, String> {
    let bt = r.byte()?;
    match bt {
        BLOCK_FEATURE             => Ok(Block::Feature(read_feature_block_payload(r)?)),
        BLOCK_GEOMETRY_COLLECTION => Ok(Block::Gc(read_gc_block_payload(r)?)),
        t                         => Err(format!("unexpected_block_type_in_op: {t}")),
    }
}

fn read_op(r: &mut ByteReader<'_>) -> Result<Op, String> {
    let code = r.byte()? >> 3;
    match code {
        OP_FEATURE_INSERT => Ok(Op::FeatureInsert { block: read_block(r)? }),
        OP_FEATURE_DELETE => {
            let mode = r.byte()?;
            if mode == 0 {
                let n = r.leb128_u32()? as usize;
                let mut paths = Vec::with_capacity(n);
                for _ in 0..n { paths.push(read_path(r)?); }
                Ok(Op::FeatureDelete { mode, paths, start: 0, count: 0 })
            } else if mode == 1 {
                let start = r.leb128_u32()?;
                let count = r.leb128_u32()?;
                Ok(Op::FeatureDelete { mode, paths: Vec::new(), start, count })
            } else {
                Err(format!("unknown_feature_delete_mode: {mode}"))
            }
        }
        OP_GEOMETRY_REPLACE => {
            let path  = read_path(r)?;
            let bt    = r.byte()?;
            if bt != BLOCK_FEATURE { return Err(format!("geometry_replace expects feature block, got {bt}")); }
            let block = read_feature_block_payload(r)?;
            Ok(Op::GeometryReplace { path, block })
        }
        OP_PROP_SET => {
            let path  = read_path(r)?;
            let ctype = r.byte()?;
            let value = read_value(r, ctype)?;
            Ok(Op::PropSet { path, ctype, value })
        }
        OP_PROP_DELETE => Ok(Op::PropDelete { path: read_path(r)? }),
        OP_COLLECTION_REPLACE => {
            let n = r.leb128_u32()? as usize;
            let mut blocks = Vec::with_capacity(n);
            for _ in 0..n { blocks.push(read_block(r)?); }
            Ok(Op::CollectionReplace { blocks })
        }
        c => Err(format!("unknown_delta_op: {c}")),
    }
}

// ── Delta frame ─────────────────────────────────────────────────────────────

fn read_delta_frame(r: &mut ByteReader<'_>) -> Result<DeltaFrame, String> {
    let name   = read_str(r)?;
    let n_ops  = r.leb128_u32()? as usize;
    let mut ops = Vec::with_capacity(n_ops);
    for _ in 0..n_ops { ops.push(read_op(r)?); }
    Ok(DeltaFrame { name, ops })
}

// ── Public: decode_document ───────────────────────────────────────────────

pub fn decode_document(bytes: &[u8]) -> Result<GeoDocument, String> {
    let mut r = ByteReader::new(bytes);
    let pid = r.byte()?;
    if pid != PROFILE_NUM {
        return Err(format!("wrong_profile: expected {PROFILE_NUM}, got {pid}"));
    }
    let name        = read_str(&mut r)?;
    let block_count = r.leb128_u32()? as usize;
    let mut blocks  = Vec::with_capacity(block_count);
    for _ in 0..block_count {
        let bt = r.byte()?;
        let blk = match bt {
            BLOCK_FEATURE             => DocBlock::Feature(read_feature_block_payload(&mut r)?),
            BLOCK_GEOMETRY_COLLECTION => DocBlock::Gc(read_gc_block_payload(&mut r)?),
            BLOCK_DELTA               => DocBlock::Delta(read_delta_frame(&mut r)?),
            t                         => return Err(format!("unknown_block_type: {t}")),
        };
        blocks.push(blk);
    }
    Ok(GeoDocument { name, blocks })
}
