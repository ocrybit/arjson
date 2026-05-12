// weavepack-ast conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// Defaults to ../../../weavepack/profiles/ast/test-vectors relative to
// CARGO_MANIFEST_DIR.  Exit 0 = all pass; exit 1 = one or more failures.

use std::{fs, path::PathBuf};

use serde_json::Value;
use weavepack_ast::{
    apply::{apply_chain, init_state, AstState, ColId},
    decode::{decode_chain, decode_tree},
    encode::{encode_chain, encode_tree},
    types::{
        AstChain, AstDoc, Block, CellValue, MixedBlock, NodeBlock, Op, Path, PropCol,
        CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64, CTYPE_INT16,
        CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_NODE_ID, CTYPE_STRING, CTYPE_TIMESTAMP64,
        CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64, CTYPE_UINT8, SCHEMA_HASH_BYTES,
    },
};

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Value parsing from JSON spec ──────────────────────────────────────────────

fn parse_cell_value(ctype: u8, v: &Value) -> Result<CellValue, String> {
    if v.is_null() { return Err("null value where non-null expected".into()); }
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
            let arr = v.get("_bytes").and_then(|b| b.as_array())
                .ok_or("bytes: expected {_bytes:[...]}")?;
            let bytes: Vec<u8> = arr.iter()
                .map(|b| b.as_u64().map(|n| n as u8).ok_or("byte: not u64"))
                .collect::<Result<_, _>>()?;
            Ok(CellValue::Bytes(bytes))
        }
        CTYPE_DATE32 => Ok(CellValue::Date32(v.as_i64().ok_or("date32: not i64")? as i32)),
        CTYPE_TIMESTAMP64 => {
            let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
            Ok(CellValue::Timestamp64(s.parse().map_err(|e| format!("timestamp64: {e}"))?))
        }
        CTYPE_NODE_ID => {
            let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
            Ok(CellValue::NodeId(s.parse().map_err(|e| format!("node_id: {e}"))?))
        }
        _ => Err(format!("unknown ctype {ctype}")),
    }
}

fn parse_prop_col(spec: &Value) -> Result<PropCol, String> {
    let col_id   = spec["colId"].as_u64().ok_or("colId missing")? as u32;
    let ctype    = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
    let nullable = spec["nullable"].as_bool().unwrap_or(false);
    let vals_arr = spec["values"].as_array().ok_or("values missing")?;
    let mut values = Vec::with_capacity(vals_arr.len());
    for v in vals_arr {
        if v.is_null() { values.push(None); }
        else { values.push(Some(parse_cell_value(ctype, v)?)); }
    }
    Ok(PropCol { col_id, ctype, nullable, values })
}

fn parse_nid(v: &Value) -> Result<u64, String> {
    let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
    s.parse::<u64>().map_err(|e| format!("nid: {e}"))
}

fn parse_node_block(spec: &Value) -> Result<NodeBlock, String> {
    let kind = spec["kind"].as_str().unwrap_or("").to_owned();
    let nids: Vec<u64> = spec["nids"].as_array().ok_or("nids missing")?
        .iter().map(parse_nid).collect::<Result<_, _>>()?;
    let parent_nids: Vec<Option<u64>> = spec["parentNids"].as_array()
        .ok_or("parentNids missing")?
        .iter().map(|v| {
            if v.is_null() { Ok(None) }
            else { parse_nid(v).map(Some) }
        }).collect::<Result<_, _>>()?;
    let child_indices: Vec<u32> = spec["childIndices"].as_array()
        .unwrap_or(&vec![])
        .iter().map(|v| v.as_u64().ok_or("childIndex: not u64".to_string()).map(|n| n as u32))
        .collect::<Result<_, _>>()?;
    let columns: Vec<PropCol> = spec["columns"].as_array().unwrap_or(&vec![])
        .iter().map(parse_prop_col).collect::<Result<_, _>>()?;
    Ok(NodeBlock { kind, nids, parent_nids, child_indices, columns })
}

fn parse_mixed_block(spec: &Value) -> Result<MixedBlock, String> {
    let nids: Vec<u64> = spec["nids"].as_array().ok_or("nids missing")?
        .iter().map(parse_nid).collect::<Result<_, _>>()?;
    let parent_nids: Vec<Option<u64>> = spec["parentNids"].as_array()
        .ok_or("parentNids missing")?
        .iter().map(|v| {
            if v.is_null() { Ok(None) }
            else { parse_nid(v).map(Some) }
        }).collect::<Result<_, _>>()?;
    let child_indices: Vec<u32> = spec["childIndices"].as_array()
        .unwrap_or(&vec![])
        .iter().map(|v| v.as_u64().ok_or("childIndex: not u64".to_string()).map(|n| n as u32))
        .collect::<Result<_, _>>()?;
    let kinds: Vec<String> = spec["kinds"].as_array().unwrap_or(&vec![])
        .iter().map(|v| Ok(v.as_str().unwrap_or("").to_owned())).collect::<Result<_, String>>()?;
    let columns: Vec<PropCol> = spec["columns"].as_array().unwrap_or(&vec![])
        .iter().map(parse_prop_col).collect::<Result<_, _>>()?;
    Ok(MixedBlock { kinds, nids, parent_nids, child_indices, columns })
}

fn parse_block(spec: &Value) -> Result<Block, String> {
    match spec["type"].as_str().ok_or("block type missing")? {
        "node"  => Ok(Block::Node(parse_node_block(spec)?)),
        "mixed" => Ok(Block::Mixed(parse_mixed_block(spec)?)),
        t       => Err(format!("unknown block type: {t}")),
    }
}

fn parse_schema_hash(spec: &Value) -> Result<[u8; SCHEMA_HASH_BYTES], String> {
    if let Some(sh) = spec.get("schemaHash") {
        let arr = sh.get("_bytes").and_then(|b| b.as_array())
            .ok_or("schemaHash: expected {_bytes:[...]}")?;
        let bytes: Vec<u8> = arr.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
        if bytes.len() != SCHEMA_HASH_BYTES {
            return Err(format!("schemaHash must be {SCHEMA_HASH_BYTES} bytes"));
        }
        let mut out = [0u8; SCHEMA_HASH_BYTES];
        out.copy_from_slice(&bytes);
        Ok(out)
    } else {
        Ok([0u8; SCHEMA_HASH_BYTES])
    }
}

fn parse_ast_doc(spec: &Value) -> Result<AstDoc, String> {
    let schema_hash = parse_schema_hash(spec)?;
    let blocks: Vec<Block> = spec["blocks"].as_array().unwrap_or(&vec![])
        .iter().map(parse_block).collect::<Result<_, _>>()?;
    Ok(AstDoc { schema_hash, blocks })
}

fn parse_path(spec: &Value) -> Result<Path, String> {
    let kind = spec["kind"].as_u64().ok_or("path kind missing")? as u8;
    match kind {
        0 => {
            let nid = parse_nid(&spec["nid"])?;
            Ok(Path::Node { nid })
        }
        1 => {
            let nid    = parse_nid(&spec["nid"])?;
            let col_id = spec["colId"].as_u64().ok_or("colId missing")? as u32;
            Ok(Path::NodeCol { nid, col_id })
        }
        2 => {
            let node_kind = spec["nodeKind"].as_str().unwrap_or("").to_owned();
            Ok(Path::NodeKind { node_kind })
        }
        3 => Ok(Path::AtNid),
        4 => Ok(Path::AtParent),
        5 => Ok(Path::AtChildIndex),
        6 => Ok(Path::AtKind),
        7 => {
            let nid  = parse_nid(&spec["nid"])?;
            let prop = spec["prop"].as_str().unwrap_or("").to_owned();
            Ok(Path::NodeProp { nid, prop })
        }
        k => Err(format!("unknown path kind {k}")),
    }
}

fn parse_op(spec: &Value) -> Result<Op, String> {
    let op_code = spec["op"].as_u64().ok_or("op code missing")? as u8;
    match op_code {
        0 => {
            let block = parse_block(&spec["block"])?;
            Ok(Op::NodeInsert { block })
        }
        1 => {
            let nids: Vec<u64> = spec["nids"].as_array().ok_or("nids missing")?
                .iter().map(parse_nid).collect::<Result<_, _>>()?;
            Ok(Op::NodeDelete { nids })
        }
        2 => {
            let nid = parse_nid(&spec["nid"])?;
            let new_parent_nid = {
                let v = &spec["newParentNid"];
                if v.is_null() || v.as_u64() == Some(0) { 0u64 }
                else { parse_nid(v)? }
            };
            let new_child_index = spec["newChildIndex"].as_u64().unwrap_or(0) as u32;
            Ok(Op::NodeMove { nid, new_parent_nid, new_child_index })
        }
        3 => {
            let path     = parse_path(&spec["path"])?;
            let ctype    = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
            let nullable = spec["nullable"].as_bool().unwrap_or(false);
            let val_v    = &spec["value"];
            let is_null  = val_v.is_null();
            let value    = if is_null { None } else { Some(parse_cell_value(ctype, val_v)?) };
            Ok(Op::PropSet { path, ctype, nullable, is_null, value })
        }
        4 => {
            let old_kind = spec["oldKind"].as_str().unwrap_or("").to_owned();
            let new_kind = spec["newKind"].as_str().unwrap_or("").to_owned();
            Ok(Op::KindRename { old_kind, new_kind })
        }
        5 => {
            let root_nid = parse_nid(&spec["rootNid"])?;
            let block    = parse_block(&spec["block"])?;
            Ok(Op::SubtreeReplace { root_nid, block })
        }
        c => Err(format!("unknown op code {c}")),
    }
}

// ── State → JSON (matching astStateToSpec in verify-test-vectors.js) ────────

fn cell_value_to_json(ctype: u8, val: &Option<CellValue>) -> Value {
    let Some(v) = val else { return Value::Null; };
    match v {
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
            let arr: Vec<Value> = b.iter().map(|by| Value::from(*by as u64)).collect();
            serde_json::json!({ "_bytes": arr })
        }
        CellValue::Date32(n)      => Value::from(*n as i64),
        CellValue::Timestamp64(n) => Value::String(n.to_string()),
        CellValue::NodeId(n)      => Value::String(n.to_string()),
    }
}

fn state_to_json(state: &AstState) -> Value {
    let nodes_json: Vec<Value> = state.nodes.iter()
        .map(|(nid, node)| {
            let parent_nid_json = match node.parent_nid {
                None    => Value::Null,
                Some(p) => Value::String(p.to_string()),
            };
            let props_json: Vec<Value> = node.props.iter()
                .map(|(col_id, entry)| {
                    let col_id_json = match col_id {
                        ColId::Num(n)   => Value::from(*n as u64),
                        ColId::Named(s) => Value::String(s.clone()),
                    };
                    serde_json::json!({
                        "colId": col_id_json,
                        "ctype": entry.ctype,
                        "value": cell_value_to_json(entry.ctype, &entry.value),
                    })
                })
                .collect();
            serde_json::json!({
                "nid":        nid.to_string(),
                "kind":       node.kind,
                "parentNid":  parent_nid_json,
                "childIndex": node.child_index,
                "props":      props_json,
            })
        })
        .collect();
    serde_json::json!({ "nodes": nodes_json })
}

// ── Test vector file walker ──────────────────────────────────────────────────

fn walk_json_files(dir: &PathBuf) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() { files.extend(walk_json_files(&path)); }
            else if path.extension().map(|e| e == "json").unwrap_or(false) { files.push(path); }
        }
    }
    files
}

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let default_root = PathBuf::from(&manifest_dir)
        .join("../../../weavepack/profiles/ast/test-vectors");
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
                // ── Delta chain vector ───────────────────────────────────────────────────
                let chain_hex = v["expected_chain_bytes_hex"].as_str().unwrap();
                let result = (|| -> Result<(), String> {
                    // Encode chain; compare bytes.
                    let ops: Vec<Op> = v["ops"].as_array().unwrap_or(&vec![])
                        .iter().map(parse_op).collect::<Result<_, _>>()?;
                    let chain = AstChain { schema_hash: [0u8; SCHEMA_HASH_BYTES], ops: ops.clone() };
                    let encoded = encode_chain(&chain)?;
                    let got_hex = to_hex(&encoded);
                    if got_hex != chain_hex {
                        return Err(format!("chain bytes mismatch\n  expected: {chain_hex}\n  got:      {got_hex}"));
                    }

                    // Decode chain and re-encode for round-trip.
                    let dc = decode_chain(&encoded)?;
                    let re_chain = AstChain { schema_hash: dc.schema_hash, ops: dc.ops };
                    if to_hex(&encode_chain(&re_chain)?) != chain_hex {
                        return Err("chain decode+re-encode mismatch".into());
                    }

                    // Apply chain to initial state; compare final.
                    let initial_doc = parse_ast_doc(&v["initial"])?;
                    let initial_enc = encode_tree(&initial_doc)?;
                    let initial_dec = decode_tree(&initial_enc)?;
                    let state = init_state(&initial_dec)?;
                    let final_state = apply_chain(state, &ops)?;
                    let final_json = state_to_json(&final_state);

                    if &final_json != &v["expected_final"] {
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
                // ── Snapshot tree vector ────────────────────────────────────────────────
                let expected_hex = v["expected_bytes_hex"].as_str().unwrap();
                let result = (|| -> Result<(), String> {
                    let doc = parse_ast_doc(&v["input"])?;
                    let encoded = encode_tree(&doc)?;
                    let got_hex = to_hex(&encoded);
                    if got_hex != expected_hex {
                        return Err(format!("encode bytes mismatch\n  expected: {expected_hex}\n  got:      {got_hex}"));
                    }
                    let decoded = decode_tree(&encoded)?;
                    if to_hex(&encode_tree(&decoded)?) != expected_hex {
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

    println!("\n{pass}/{} Rust AST conformance pass.", pass + fail);
    if fail > 0 { std::process::exit(1); }
}
