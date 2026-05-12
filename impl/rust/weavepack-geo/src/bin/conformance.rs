// weavepack-geo conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// Defaults to ../../../weavepack/profiles/geo/test-vectors relative to
// CARGO_MANIFEST_DIR.  Exit 0 = all pass; exit 1 = one or more failures.

use std::{fs, path::PathBuf};
use serde_json::Value;
use weavepack_geo::{
    apply::{apply_chain, init_state, GeoState, LiveProp},
    decode::decode_document,
    encode::encode_document,
    types::{
        Block, CellValue, DocBlock, DeltaFrame, FeatureBlock, Fid, GcBlock, GeoDocument, Geom,
        InnerPath, Op, Path, PropCol, SubGeom,
        CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
        CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8,
        CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64, CTYPE_UINT8,
        FID_STRING, FID_UINT64,
        GEOM_LINESTRING, GEOM_MULTILINESTRING, GEOM_MULTIPOINT, GEOM_MULTIPOLYGON,
        GEOM_NULL, GEOM_POINT, GEOM_POLYGON,
    },
};

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Cell-value parsing ─────────────────────────────────────────────────────────

fn parse_cell_value(ctype: u8, v: &Value) -> Result<CellValue, String> {
    match ctype {
        CTYPE_BOOL  => Ok(CellValue::Bool(v.as_bool().ok_or("bool: not bool")?)),
        CTYPE_INT8  => Ok(CellValue::Int8(v.as_i64().ok_or("int8: not i64")? as i8)),
        CTYPE_INT16 => Ok(CellValue::Int16(v.as_i64().ok_or("int16: not i64")? as i16)),
        CTYPE_INT32 => Ok(CellValue::Int32(v.as_i64().ok_or("int32: not i64")? as i32)),
        CTYPE_INT64 => {
            let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
            Ok(CellValue::Int64(s.parse().map_err(|e| format!("int64: {e}"))?))
        }
        CTYPE_UINT8  => Ok(CellValue::Uint8(v.as_u64().ok_or("uint8: not u64")? as u8)),
        CTYPE_UINT16 => Ok(CellValue::Uint16(v.as_u64().ok_or("uint16: not u64")? as u16)),
        CTYPE_UINT32 => Ok(CellValue::Uint32(v.as_u64().ok_or("uint32: not u64")? as u32)),
        CTYPE_UINT64 => {
            let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
            Ok(CellValue::Uint64(s.parse().map_err(|e| format!("uint64: {e}"))?))
        }
        CTYPE_FLOAT32 => Ok(CellValue::Float32(v.as_f64().ok_or("float32: not f64")? as f32)),
        CTYPE_FLOAT64 => Ok(CellValue::Float64(v.as_f64().ok_or("float64: not f64")?)),
        CTYPE_STRING  => Ok(CellValue::String(v.as_str().ok_or("string: not str")?.to_owned())),
        CTYPE_BYTES   => {
            let arr = v.as_array().ok_or("bytes: expected array")?;
            let bytes: Vec<u8> = arr.iter()
                .map(|b| b.as_u64().map(|n| n as u8).ok_or("byte: not u64"))
                .collect::<Result<_, _>>()?;
            Ok(CellValue::Bytes(bytes))
        }
        CTYPE_DATE32      => Ok(CellValue::Date32(v.as_i64().ok_or("date32: not i64")? as i32)),
        CTYPE_TIMESTAMP64 => {
            let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
            Ok(CellValue::Timestamp64(s.parse().map_err(|e| format!("timestamp64: {e}"))?))
        }
        _ => Err(format!("unknown ctype {ctype}")),
    }
}

// ── PropCol parsing ────────────────────────────────────────────────────────────

fn parse_prop_col(spec: &Value) -> Result<PropCol, String> {
    let name     = spec["name"].as_str().ok_or("name missing")?.to_owned();
    let ctype    = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
    let nullable = spec["nullable"].as_bool().unwrap_or(false);
    let vals_arr = spec["values"].as_array().ok_or("values missing")?;
    let mut values = Vec::with_capacity(vals_arr.len());
    for v in vals_arr {
        if v.is_null() { values.push(None); }
        else { values.push(Some(parse_cell_value(ctype, v)?)); }
    }
    Ok(PropCol { name, ctype, nullable, values })
}

// ── Geom parsing ─────────────────────────────────────────────────────────────

fn parse_f64_array(v: &Value, key: &str) -> Result<Vec<f64>, String> {
    v[key].as_array()
        .ok_or_else(|| format!("{key} missing or not array"))?
        .iter()
        .map(|n| n.as_f64().ok_or_else(|| format!("{key}: element not f64")))
        .collect()
}

fn opt_f64_array(v: &Value, key: &str) -> Option<Vec<f64>> {
    v[key].as_array().map(|arr| {
        arr.iter().filter_map(|n| n.as_f64()).collect()
    })
}

fn parse_u32_array(v: &Value, key: &str) -> Result<Vec<u32>, String> {
    v[key].as_array()
        .ok_or_else(|| format!("{key} missing or not array"))?
        .iter()
        .map(|n| n.as_u64().map(|v| v as u32).ok_or_else(|| format!("{key}: element not u64")))
        .collect()
}

fn opt_u32_array(v: &Value, key: &str) -> Vec<u32> {
    v[key].as_array().map(|arr| {
        arr.iter().filter_map(|n| n.as_u64().map(|v| v as u32)).collect()
    }).unwrap_or_default()
}

fn parse_geom(spec: &Value, geom_type: u8) -> Result<Geom, String> {
    let mut g = Geom::default();
    match geom_type {
        GEOM_POINT => {
            g.x = parse_f64_array(spec, "xCol")?;
            g.y = parse_f64_array(spec, "yCol")?;
            g.z = opt_f64_array(spec, "zCol");
        }
        GEOM_LINESTRING => {
            g.coord_counts = parse_u32_array(spec, "coordCounts")?;
            g.x = parse_f64_array(spec, "xCol")?;
            g.y = parse_f64_array(spec, "yCol")?;
            g.z = opt_f64_array(spec, "zCol");
        }
        GEOM_POLYGON => {
            g.rings_per_feature = parse_u32_array(spec, "ringsPerFeature")?;
            g.ring_counts       = parse_u32_array(spec, "ringCounts")?;
            g.x = parse_f64_array(spec, "xCol")?;
            g.y = parse_f64_array(spec, "yCol")?;
            g.z = opt_f64_array(spec, "zCol");
        }
        GEOM_MULTIPOINT => {
            g.part_counts = parse_u32_array(spec, "partCounts")?;
            g.x = parse_f64_array(spec, "xCol")?;
            g.y = parse_f64_array(spec, "yCol")?;
            g.z = opt_f64_array(spec, "zCol");
        }
        GEOM_MULTILINESTRING => {
            g.part_counts  = parse_u32_array(spec, "partCounts")?;
            g.coord_counts = parse_u32_array(spec, "coordCounts")?;
            g.x = parse_f64_array(spec, "xCol")?;
            g.y = parse_f64_array(spec, "yCol")?;
            g.z = opt_f64_array(spec, "zCol");
        }
        GEOM_MULTIPOLYGON => {
            g.part_counts    = parse_u32_array(spec, "partCounts")?;
            g.rings_per_part = parse_u32_array(spec, "ringsPerPart")?;
            g.ring_counts    = parse_u32_array(spec, "ringCounts")?;
            g.x = parse_f64_array(spec, "xCol")?;
            g.y = parse_f64_array(spec, "yCol")?;
            g.z = opt_f64_array(spec, "zCol");
        }
        GEOM_NULL | _ => {}
    }
    Ok(g)
}

// ── FID parsing ──────────────────────────────────────────────────────────────

fn parse_fid(v: &Value, fid_kind: u8) -> Result<Fid, String> {
    match fid_kind {
        FID_STRING => Ok(Fid::Str(v.as_str().ok_or("fid: not str")?.to_owned())),
        FID_UINT64 => {
            let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
            Ok(Fid::Int(s.parse().map_err(|e| format!("fid uint64: {e}"))?))
        }
        _ => Err(format!("parse_fid: unexpected fid_kind {fid_kind}")),
    }
}

// ── Feature block parsing ────────────────────────────────────────────────────

fn parse_feature_block(spec: &Value) -> Result<FeatureBlock, String> {
    let geom_type       = spec["geomType"].as_u64().ok_or("geomType missing")? as u8;
    let coord_precision = spec["coordPrecision"].as_u64().unwrap_or(0) as u8;
    let has_z           = spec["hasZ"].as_bool().unwrap_or(false);
    let fid_kind        = spec["fidKind"].as_u64().unwrap_or(0) as u8;
    let num_features    = spec["numFeatures"].as_u64().ok_or("numFeatures missing")? as usize;
    let fids = if fid_kind > 0 {
        let arr = spec["fids"].as_array().ok_or("fids missing")?;
        let fids: Vec<Fid> = arr.iter()
            .map(|v| parse_fid(v, fid_kind))
            .collect::<Result<_, _>>()?;
        Some(fids)
    } else { None };
    let geom     = parse_geom(&spec["geom"], geom_type)?;
    let prop_cols = spec["propCols"].as_array().unwrap_or(&vec![])
        .iter().map(parse_prop_col).collect::<Result<_, _>>()?;
    Ok(FeatureBlock { geom_type, coord_precision, has_z, fid_kind, num_features, fids, geom, prop_cols })
}

// ── GC block parsing ──────────────────────────────────────────────────────────

fn parse_gc_block(spec: &Value) -> Result<GcBlock, String> {
    let coord_precision = spec["coordPrecision"].as_u64().unwrap_or(0) as u8;
    let has_z           = spec["hasZ"].as_bool().unwrap_or(false);
    let fid_kind        = spec["fidKind"].as_u64().unwrap_or(0) as u8;
    let num_features    = spec["numFeatures"].as_u64().ok_or("numFeatures missing")? as usize;
    let fids = if fid_kind > 0 {
        let arr = spec["fids"].as_array().ok_or("fids missing")?;
        Some(arr.iter().map(|v| parse_fid(v, fid_kind)).collect::<Result<_, _>>()?)
    } else { None };
    let sub_geom_counts = opt_u32_array(spec, "subGeomCounts");
    let sub_geoms_arr   = spec["subGeoms"].as_array().ok_or("subGeoms missing")?;
    let mut sub_geoms   = Vec::with_capacity(sub_geoms_arr.len());
    for sg in sub_geoms_arr {
        let gt   = sg["geomType"].as_u64().ok_or("subGeom geomType missing")? as u8;
        let geom = parse_geom(&sg["geom"], gt)?;
        sub_geoms.push(SubGeom { geom_type: gt, geom });
    }
    let prop_cols = spec["propCols"].as_array().unwrap_or(&vec![])
        .iter().map(parse_prop_col).collect::<Result<_, _>>()?;
    Ok(GcBlock { coord_precision, has_z, fid_kind, num_features, fids, sub_geom_counts, sub_geoms, prop_cols })
}

// ── Doc block parsing ────────────────────────────────────────────────────────────

fn parse_doc_block(spec: &Value) -> Result<DocBlock, String> {
    match spec["type"].as_str().ok_or("block type missing")? {
        "feature"             => Ok(DocBlock::Feature(parse_feature_block(spec)?)),
        "geometry_collection" => Ok(DocBlock::Gc(parse_gc_block(spec)?)),
        t                     => Err(format!("unknown block type: {t}")),
    }
}

fn parse_op_block(spec: &Value) -> Result<Block, String> {
    match spec["type"].as_str().ok_or("block type missing")? {
        "feature"             => Ok(Block::Feature(parse_feature_block(spec)?)),
        "geometry_collection" => Ok(Block::Gc(parse_gc_block(spec)?)),
        t                     => Err(format!("unknown op block type: {t}")),
    }
}

// ── Path / inner-path parsing ─────────────────────────────────────────────────────

fn parse_inner_path(spec: &Value) -> Result<InnerPath, String> {
    let kind = spec["kind"].as_u64().ok_or("inner path kind missing")? as u8;
    match kind {
        0 => Ok(InnerPath::ByIdx(spec["index"].as_u64().ok_or("index missing")? as u32)),
        1 => Ok(InnerPath::ByStrFid(spec["fid"].as_str().ok_or("fid missing")?.to_owned())),
        2 => {
            let s = spec["fid"].as_str().map(|s| s.to_owned())
                .unwrap_or_else(|| spec["fid"].to_string());
            Ok(InnerPath::ByIntFid(s.parse().map_err(|e| format!("int fid: {e}"))?))
        }
        k => Err(format!("unknown inner path kind {k}")),
    }
}

fn parse_path(spec: &Value) -> Result<Path, String> {
    let kind = spec["kind"].as_u64().ok_or("path kind missing")? as u8;
    match kind {
        0 => Ok(Path::ByIdx(spec["index"].as_u64().ok_or("index missing")? as u32)),
        1 => Ok(Path::ByStrFid(spec["fid"].as_str().ok_or("fid missing")?.to_owned())),
        2 => {
            let s = spec["fid"].as_str().map(|s| s.to_owned())
                .unwrap_or_else(|| spec["fid"].to_string());
            Ok(Path::ByIntFid(s.parse().map_err(|e| format!("int fid: {e}"))?))
        }
        3 => Ok(Path::Geometry(parse_inner_path(&spec["inner"])?)),
        4 => {
            let inner = parse_inner_path(&spec["inner"])?;
            let name  = spec["name"].as_str().ok_or("name missing")?.to_owned();
            Ok(Path::PropName { inner, name })
        }
        5 => {
            let inner   = parse_inner_path(&spec["inner"])?;
            let col_idx = spec["colIdx"].as_u64().ok_or("colIdx missing")? as u32;
            Ok(Path::PropIdx { inner, col_idx })
        }
        k => Err(format!("unknown path kind {k}")),
    }
}

// ── Op parsing ─────────────────────────────────────────────────────────────────

fn parse_op(spec: &Value) -> Result<Op, String> {
    let code = spec["op"].as_u64().ok_or("op code missing")? as u8;
    match code {
        0 => {
            let block = parse_op_block(&spec["block"])?;
            Ok(Op::FeatureInsert { block })
        }
        1 => {
            let mode = spec["mode"].as_u64().unwrap_or(0) as u8;
            if mode == 0 {
                let paths = spec["paths"].as_array().ok_or("paths missing")?
                    .iter().map(parse_path).collect::<Result<_, _>>()?;
                Ok(Op::FeatureDelete { mode, paths, start: 0, count: 0 })
            } else if mode == 1 {
                let start = spec["start"].as_u64().unwrap_or(0) as u32;
                let count = spec["count"].as_u64().unwrap_or(0) as u32;
                Ok(Op::FeatureDelete { mode, paths: Vec::new(), start, count })
            } else {
                Err(format!("unknown delete mode {mode}"))
            }
        }
        2 => {
            let path  = parse_path(&spec["path"])?;
            let block = parse_feature_block(&spec["block"])?;
            Ok(Op::GeometryReplace { path, block })
        }
        3 => {
            let path  = parse_path(&spec["path"])?;
            let ctype = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
            let value = parse_cell_value(ctype, &spec["value"])?;
            Ok(Op::PropSet { path, ctype, value })
        }
        4 => Ok(Op::PropDelete { path: parse_path(&spec["path"])? }),
        5 => {
            let blocks = spec["blocks"].as_array().ok_or("blocks missing")?
                .iter().map(parse_op_block).collect::<Result<_, _>>()?;
            Ok(Op::CollectionReplace { blocks })
        }
        c => Err(format!("unknown op code {c}")),
    }
}

// ── GeoDocument parsing ───────────────────────────────────────────────────────

fn parse_geo_doc(spec: &Value) -> Result<GeoDocument, String> {
    let name   = spec["name"].as_str().unwrap_or("").to_owned();
    let blocks = spec["blocks"].as_array().unwrap_or(&vec![])
        .iter().map(parse_doc_block).collect::<Result<_, _>>()?;
    Ok(GeoDocument { name, blocks })
}

// ── State → JSON (matching geoStateToSpec in verify-test-vectors.js) ─────────

fn cell_to_json(_ctype: u8, val: &CellValue) -> Value {
    match val {
        CellValue::Bool(b)        => Value::Bool(*b),
        CellValue::Int8(n)        => Value::from(*n as i64),
        CellValue::Int16(n)       => Value::from(*n as i64),
        CellValue::Int32(n)       => Value::from(*n as i64),
        CellValue::Int64(n)       => Value::String(n.to_string()),
        CellValue::Uint8(n)       => Value::from(*n as u64),
        CellValue::Uint16(n)      => Value::from(*n as u64),
        CellValue::Uint32(n)      => Value::from(*n as u64),
        CellValue::Uint64(n)      => Value::String(n.to_string()),
        CellValue::Float32(f)     => {
            let d = *f as f64;
            if f.is_finite() && f.fract() == 0.0 && d.abs() < 9.007_199_254_740_992e15 {
                Value::from(d as i64)
            } else { Value::from(d) }
        }
        CellValue::Float64(f)     => {
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
                Value::from(*f as i64)
            } else { Value::from(*f) }
        }
        CellValue::String(s)      => Value::String(s.clone()),
        CellValue::Bytes(b)       => {
            let arr: Vec<Value> = b.iter().map(|&by| Value::from(by as u64)).collect();
            serde_json::json!({ "_bytes": arr })
        }
        CellValue::Date32(n)      => Value::from(*n as i64),
        CellValue::Timestamp64(n) => Value::String(n.to_string()),
    }
}

fn prop_to_json(name: &str, p: &LiveProp) -> Value {
    serde_json::json!({
        "name":  name,
        "ctype": p.ctype,
        "value": cell_to_json(p.ctype, &p.value),
    })
}

fn state_to_json(state: &GeoState) -> Value {
    let features: Vec<Value> = state.features.iter().map(|f| {
        let fid_json: Value = match &f.fid {
            None            => Value::Null,
            Some(Fid::Str(s)) => Value::String(s.clone()),
            Some(Fid::Int(n)) => Value::String(n.to_string()),
        };
        let props_json: Vec<Value> = f.props.iter()
            .map(|(name, prop)| prop_to_json(name, prop))
            .collect();
        serde_json::json!({
            "fid":            fid_json,
            "geomType":       f.geom_type,
            "coordPrecision": f.coord_precision,
            "hasZ":           f.has_z,
            "props":          props_json,
        })
    }).collect();
    Value::Array(features)
}

// ── File walker ──────────────────────────────────────────────────────────────

fn walk_json_files(dir: &PathBuf) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir()       { files.extend(walk_json_files(&path)); }
            else if path.extension().map(|e| e == "json").unwrap_or(false) { files.push(path); }
        }
    }
    files
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let default_root = PathBuf::from(&manifest_dir)
        .join("../../../weavepack/profiles/geo/test-vectors");
    let root: PathBuf = std::env::args().nth(1).map(PathBuf::from).unwrap_or(default_root);

    let files = walk_json_files(&root);
    let mut pass = 0usize;
    let mut fail = 0usize;

    for file in &files {
        let rel = file.strip_prefix(&root).unwrap_or(file).to_string_lossy().into_owned();
        let content = match fs::read_to_string(file) {
            Ok(c) => c,
            Err(e) => { eprintln!("FAIL {rel}: read error: {e}"); fail += 1; continue; }
        };
        let vectors: Vec<Value> = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => { eprintln!("FAIL {rel}: json parse: {e}"); fail += 1; continue; }
        };

        for v in &vectors {
            if v.get("status").and_then(|s| s.as_str()) == Some("pending") { continue; }
            let name = v["name"].as_str().unwrap_or("<unnamed>");

            if v.get("expected_chain_bytes_hex").is_some() {
                // ── Delta chain vector ───────────────────────────────────────────────────────
                let chain_hex = v["expected_chain_bytes_hex"].as_str().unwrap();
                let result = (|| -> Result<(), String> {
                    let coll_name = v["initial"]["name"].as_str().unwrap_or("").to_owned();
                    let ops: Vec<Op> = v["ops"].as_array().unwrap_or(&vec![])
                        .iter().map(parse_op).collect::<Result<_, _>>()?;
                    let chain_doc = GeoDocument {
                        name: coll_name.clone(),
                        blocks: vec![DocBlock::Delta(DeltaFrame {
                            name: coll_name.clone(),
                            ops:  ops.clone(),
                        })],
                    };
                    let encoded = encode_document(&chain_doc)?;
                    let got_hex = to_hex(&encoded);
                    if got_hex != chain_hex {
                        return Err(format!(
                            "chain bytes mismatch\n  expected: {chain_hex}\n  got:      {got_hex}"
                        ));
                    }

                    let decoded = decode_document(&encoded)?;
                    let reenc   = encode_document(&decoded)?;
                    if to_hex(&reenc) != chain_hex {
                        return Err("chain decode+re-encode mismatch".into());
                    }

                    let init_doc   = parse_geo_doc(&v["initial"])?;
                    let init_enc   = encode_document(&init_doc)?;
                    let init_dec   = decode_document(&init_enc)?;
                    let state0     = init_state(&init_dec)?;
                    let final_state = apply_chain(state0, &ops)?;
                    let final_json  = state_to_json(&final_state);

                    if final_json != v["expected_final"] {
                        return Err(format!(
                            "final state mismatch\n  expected: {}\n  got:      {}",
                            serde_json::to_string(&v["expected_final"]).unwrap(),
                            serde_json::to_string(&final_json).unwrap(),
                        ));
                    }
                    Ok(())
                })();
                match result {
                    Ok(()) => { println!("ok  {rel} :: {name}"); pass += 1; }
                    Err(e) => { eprintln!("FAIL {rel} :: {name}\n     {e}"); fail += 1; }
                }
            } else if v.get("expected_bytes_hex").is_some() {
                // ── Snapshot vector ───────────────────────────────────────────────────────────
                let expected_hex = v["expected_bytes_hex"].as_str().unwrap();
                let result = (|| -> Result<(), String> {
                    let doc     = parse_geo_doc(&v["input"])?;
                    let encoded = encode_document(&doc)?;
                    let got_hex = to_hex(&encoded);
                    if got_hex != expected_hex {
                        return Err(format!(
                            "encode bytes mismatch\n  expected: {expected_hex}\n  got:      {got_hex}"
                        ));
                    }
                    let decoded = decode_document(&encoded)?;
                    let reenc   = encode_document(&decoded)?;
                    if to_hex(&reenc) != expected_hex {
                        return Err("decode+re-encode round-trip mismatch".into());
                    }
                    Ok(())
                })();
                match result {
                    Ok(()) => { println!("ok  {rel} :: {name}"); pass += 1; }
                    Err(e) => { eprintln!("FAIL {rel} :: {name}\n     {e}"); fail += 1; }
                }
            }
        }
    }

    println!("\n{pass}/{} Rust geo conformance pass.", pass + fail);
    if fail > 0 { std::process::exit(1); }
}
