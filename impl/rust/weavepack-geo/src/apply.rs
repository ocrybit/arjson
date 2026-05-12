// weavepack-geo — delta application.
//
// Mirrors sdk/src/profiles/geo/apply.js.
// Profile isolation: only imports from crate::types.

use crate::types::{
    Block, CellValue, DocBlock, FeatureBlock, Fid, GeoDocument, Geom,
    InnerPath, Op, Path,
    FID_ABSENT, FID_STRING, FID_UINT64,
    GEOM_LINESTRING, GEOM_MULTILINESTRING, GEOM_MULTIPOINT, GEOM_MULTIPOLYGON,
    GEOM_NULL, GEOM_POINT, GEOM_POLYGON,
};

// ── Live property entry ───────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LiveProp {
    pub ctype: u8,
    pub value: CellValue,
}

// ── Live feature ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LiveFeature {
    pub fid:             Option<Fid>,
    pub geom_type:       u8,
    pub coord_precision: u8,
    pub has_z:           bool,
    pub geom:            Geom,
    pub props:           Vec<(String, LiveProp)>,  // insertion-ordered
}

// ── Live state ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GeoState {
    pub name:     String,
    pub fid_kind: i8,   // -1 = unset, 0/1/2 = established
    pub features: Vec<LiveFeature>,
}

// ── Geometry slicing (columnar → per-feature) ────────────────────────────────

fn sum_u32(arr: &[u32]) -> usize { arr.iter().map(|&v| v as usize).sum() }

fn slice_f64(v: &[f64], start: usize, len: usize) -> Vec<f64> {
    v[start..start + len].to_vec()
}

fn extract_single_feature_geom(blk: &FeatureBlock, i: usize) -> Geom {
    let g = &blk.geom;
    match blk.geom_type {
        GEOM_POINT => Geom {
            x: vec![g.x[i]],
            y: vec![g.y[i]],
            z: blk.has_z.then(|| vec![g.z.as_ref().unwrap()[i]]),
            ..Default::default()
        },
        GEOM_LINESTRING => {
            let cnt    = g.coord_counts[i] as usize;
            let offset = sum_u32(&g.coord_counts[..i]);
            Geom {
                coord_counts: vec![g.coord_counts[i]],
                x: slice_f64(&g.x, offset, cnt),
                y: slice_f64(&g.y, offset, cnt),
                z: blk.has_z.then(|| slice_f64(g.z.as_deref().unwrap(), offset, cnt)),
                ..Default::default()
            }
        }
        GEOM_POLYGON => {
            let rings_for_feat = g.rings_per_feature[i] as usize;
            let ring_offset    = sum_u32(&g.rings_per_feature[..i]);
            let my_ring_counts = g.ring_counts[ring_offset..ring_offset + rings_for_feat].to_vec();
            let vertex_offset  = sum_u32(&g.ring_counts[..ring_offset]);
            let total_v        = sum_u32(&my_ring_counts);
            Geom {
                rings_per_feature: vec![rings_for_feat as u32],
                ring_counts: my_ring_counts,
                x: slice_f64(&g.x, vertex_offset, total_v),
                y: slice_f64(&g.y, vertex_offset, total_v),
                z: blk.has_z.then(|| slice_f64(g.z.as_deref().unwrap(), vertex_offset, total_v)),
                ..Default::default()
            }
        }
        GEOM_MULTIPOINT => {
            let cnt    = g.part_counts[i] as usize;
            let offset = sum_u32(&g.part_counts[..i]);
            Geom {
                part_counts: vec![g.part_counts[i]],
                x: slice_f64(&g.x, offset, cnt),
                y: slice_f64(&g.y, offset, cnt),
                z: blk.has_z.then(|| slice_f64(g.z.as_deref().unwrap(), offset, cnt)),
                ..Default::default()
            }
        }
        GEOM_MULTILINESTRING => {
            let line_cnt    = g.part_counts[i] as usize;
            let line_offset = sum_u32(&g.part_counts[..i]);
            let my_coord_counts = g.coord_counts[line_offset..line_offset + line_cnt].to_vec();
            let vertex_offset   = sum_u32(&g.coord_counts[..line_offset]);
            let total_v         = sum_u32(&my_coord_counts);
            Geom {
                part_counts:  vec![g.part_counts[i]],
                coord_counts: my_coord_counts,
                x: slice_f64(&g.x, vertex_offset, total_v),
                y: slice_f64(&g.y, vertex_offset, total_v),
                z: blk.has_z.then(|| slice_f64(g.z.as_deref().unwrap(), vertex_offset, total_v)),
                ..Default::default()
            }
        }
        GEOM_MULTIPOLYGON => {
            let poly_cnt    = g.part_counts[i] as usize;
            let poly_offset = sum_u32(&g.part_counts[..i]);
            let my_rings_per_part = g.rings_per_part[poly_offset..poly_offset + poly_cnt].to_vec();
            let ring_offset       = sum_u32(&g.rings_per_part[..poly_offset]);
            let total_rings       = sum_u32(&my_rings_per_part);
            let my_ring_counts    = g.ring_counts[ring_offset..ring_offset + total_rings].to_vec();
            let vertex_offset     = sum_u32(&g.ring_counts[..ring_offset]);
            let total_v           = sum_u32(&my_ring_counts);
            Geom {
                part_counts:   vec![g.part_counts[i]],
                rings_per_part: my_rings_per_part,
                ring_counts:   my_ring_counts,
                x: slice_f64(&g.x, vertex_offset, total_v),
                y: slice_f64(&g.y, vertex_offset, total_v),
                z: blk.has_z.then(|| slice_f64(g.z.as_deref().unwrap(), vertex_offset, total_v)),
                ..Default::default()
            }
        }
        GEOM_NULL | _ => Geom::default(),
    }
}

// ── Block → Vec<LiveFeature> ────────────────────────────────────────────────────

fn features_from_block(block: &Block) -> Result<(Vec<LiveFeature>, u8), String> {
    match block {
        Block::Feature(blk) => {
            let n = blk.num_features;
            let mut features = Vec::with_capacity(n);
            for i in 0..n {
                let fid = blk.fids.as_ref().map(|fids| fids[i].clone());
                let geom = extract_single_feature_geom(blk, i);
                let mut props: Vec<(String, LiveProp)> = Vec::new();
                for col in &blk.prop_cols {
                    if let Some(val) = &col.values[i] {
                        props.push((col.name.clone(), LiveProp { ctype: col.ctype, value: val.clone() }));
                    }
                }
                features.push(LiveFeature {
                    fid,
                    geom_type:       blk.geom_type,
                    coord_precision: blk.coord_precision,
                    has_z:           blk.has_z,
                    geom,
                    props,
                });
            }
            Ok((features, blk.fid_kind))
        }
        Block::Gc(blk) => {
            let n = blk.num_features;
            let mut features = Vec::with_capacity(n);
            for i in 0..n {
                let fid = blk.fids.as_ref().map(|fids| fids[i].clone());
                let mut props: Vec<(String, LiveProp)> = Vec::new();
                for col in &blk.prop_cols {
                    if let Some(val) = &col.values[i] {
                        props.push((col.name.clone(), LiveProp { ctype: col.ctype, value: val.clone() }));
                    }
                }
                features.push(LiveFeature {
                    fid,
                    geom_type:       6, // GEOM_GEOMETRY_COLLECTION
                    coord_precision: blk.coord_precision,
                    has_z:           blk.has_z,
                    geom:            Geom::default(),
                    props,
                });
            }
            Ok((features, blk.fid_kind))
        }
    }
}

// ── Feature resolution ───────────────────────────────────────────────────────────

fn resolve_inner_path(state: &GeoState, ip: &InnerPath) -> Result<usize, String> {
    match ip {
        InnerPath::ByIdx(idx) => {
            let i = *idx as usize;
            if i >= state.features.len() {
                return Err(format!("feature_index_out_of_bounds: {idx}"));
            }
            Ok(i)
        }
        InnerPath::ByStrFid(fid) => {
            if state.fid_kind != FID_STRING as i8 {
                return Err("fid_kind_mismatch".into());
            }
            state.features.iter().position(|f| {
                matches!(&f.fid, Some(Fid::Str(s)) if s == fid)
            }).ok_or_else(|| format!("feature_not_found: {fid}"))
        }
        InnerPath::ByIntFid(fid) => {
            if state.fid_kind != FID_UINT64 as i8 {
                return Err("fid_kind_mismatch".into());
            }
            let target = *fid;
            state.features.iter().position(|f| {
                matches!(&f.fid, Some(Fid::Int(n)) if *n == target)
            }).ok_or_else(|| format!("feature_not_found: {fid}"))
        }
    }
}

// ── Insert helper ─────────────────────────────────────────────────────────────

fn insert_features(state: &mut GeoState, block: &Block) -> Result<(), String> {
    let (inserted, new_fk) = features_from_block(block)?;
    if state.fid_kind == -1 {
        state.fid_kind = new_fk as i8;
    } else if state.fid_kind != new_fk as i8 {
        return Err("fid_kind_mismatch".into());
    }
    // Duplicate FID check
    if new_fk != FID_ABSENT {
        for ins in &inserted {
            if let Some(ref fid) = ins.fid {
                let dup = if new_fk == FID_UINT64 {
                    let target = match fid { Fid::Int(n) => *n, _ => 0 };
                    state.features.iter().any(|f| matches!(&f.fid, Some(Fid::Int(n)) if *n == target))
                        || inserted.iter().take_while(|x| !std::ptr::eq(*x, ins)).any(|f|
                            matches!(&f.fid, Some(Fid::Int(n)) if *n == {match fid { Fid::Int(n) => *n, _ => 1 }}))
                } else {
                    let s = match fid { Fid::Str(s) => s.as_str(), _ => "" };
                    state.features.iter().any(|f| matches!(&f.fid, Some(Fid::Str(t)) if t == s))
                };
                if dup { return Err("duplicate_fid".into()); }
            }
        }
    }
    state.features.extend(inserted);
    Ok(())
}

// ── Op application ─────────────────────────────────────────────────────────────

fn apply_op(state: &mut GeoState, op: &Op) -> Result<(), String> {
    match op {
        Op::FeatureInsert { block } => {
            insert_features(state, block)?;
        }

        Op::FeatureDelete { mode, paths, start, count } => {
            if *mode == 0 {
                let mut indices: Vec<usize> = paths.iter()
                    .map(|p| match p {
                        Path::ByIdx(i)     => resolve_inner_path(state, &InnerPath::ByIdx(*i)),
                        Path::ByStrFid(s)  => resolve_inner_path(state, &InnerPath::ByStrFid(s.clone())),
                        Path::ByIntFid(n)  => resolve_inner_path(state, &InnerPath::ByIntFid(*n)),
                        _ => Err("feature_delete: expected direct feature path".into()),
                    })
                    .collect::<Result<_, _>>()?;
                indices.sort_unstable_by(|a, b| b.cmp(a));  // descending
                for idx in indices { state.features.remove(idx); }
            } else if *mode == 1 {
                let start = *start as usize;
                let count = *count as usize;
                if start + count > state.features.len() {
                    return Err("feature_index_out_of_bounds".into());
                }
                state.features.drain(start..start + count);
            } else {
                return Err(format!("unknown_feature_delete_mode: {mode}"));
            }
        }

        Op::GeometryReplace { path, block } => {
            let inner = match path {
                Path::Geometry(ip) => ip,
                _ => return Err("geometry_replace: expected FEAT_GEOMETRY path".into()),
            };
            let idx  = resolve_inner_path(state, inner)?;
            let feat = &mut state.features[idx];
            let dummy = FeatureBlock {
                geom_type:       block.geom_type,
                coord_precision: block.coord_precision,
                has_z:           block.has_z,
                fid_kind:        block.fid_kind,
                num_features:    1,
                fids:            None,
                geom:            block.geom.clone(),
                prop_cols:       Vec::new(),
            };
            let new_geom = extract_single_feature_geom(&dummy, 0);
            feat.geom_type       = block.geom_type;
            feat.coord_precision = block.coord_precision;
            feat.has_z           = block.has_z;
            feat.geom            = new_geom;
        }

        Op::PropSet { path, ctype, value } => {
            let (feat_idx, prop_key) = resolve_prop_path(state, path)?;
            let feat = &mut state.features[feat_idx];
            if let Some(e) = feat.props.iter_mut().find(|(k, _)| k == &prop_key) {
                e.1 = LiveProp { ctype: *ctype, value: value.clone() };
            } else {
                feat.props.push((prop_key, LiveProp { ctype: *ctype, value: value.clone() }));
            }
        }

        Op::PropDelete { path } => {
            let (feat_idx, prop_key) = resolve_prop_path(state, path)?;
            let feat = &mut state.features[feat_idx];
            feat.props.retain(|(k, _)| k != &prop_key);
        }

        Op::CollectionReplace { blocks } => {
            state.features.clear();
            state.fid_kind = -1;
            for blk in blocks {
                insert_features(state, blk)?;
            }
            if state.fid_kind == -1 { state.fid_kind = FID_ABSENT as i8; }
        }
    }
    Ok(())
}

fn resolve_prop_path(state: &GeoState, path: &Path) -> Result<(usize, String), String> {
    match path {
        Path::PropName { inner, name } => {
            let idx = resolve_inner_path(state, inner)?;
            Ok((idx, name.clone()))
        }
        Path::PropIdx { inner, col_idx } => {
            let idx  = resolve_inner_path(state, inner)?;
            let cidx = *col_idx as usize;
            let keys: Vec<&str> = state.features[idx].props.iter().map(|(k, _)| k.as_str()).collect();
            if cidx >= keys.len() {
                return Err("col_idx_out_of_bounds".into());
            }
            Ok((idx, keys[cidx].to_owned()))
        }
        _ => Err(format!("prop_set/delete: unsupported path kind")),
    }
}

// ── Public: init_state ──────────────────────────────────────────────────────────

pub fn init_state(doc: &GeoDocument) -> Result<GeoState, String> {
    let mut state = GeoState {
        name:     doc.name.clone(),
        fid_kind: -1,
        features: Vec::new(),
    };
    for blk in &doc.blocks {
        let block = match blk {
            DocBlock::Feature(b) => Block::Feature(b.clone()),
            DocBlock::Gc(b)      => Block::Gc(b.clone()),
            DocBlock::Delta(_)   => continue,
        };
        insert_features(&mut state, &block)?;
    }
    if state.fid_kind == -1 { state.fid_kind = FID_ABSENT as i8; }
    Ok(state)
}

// ── Public: apply_chain ──────────────────────────────────────────────────────────

pub fn apply_chain(mut state: GeoState, ops: &[Op]) -> Result<GeoState, String> {
    for op in ops { apply_op(&mut state, op)?; }
    Ok(state)
}
