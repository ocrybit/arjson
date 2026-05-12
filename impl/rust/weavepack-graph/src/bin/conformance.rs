// weavepack-graph conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// Defaults to ../../../weavepack/profiles/graph/test-vectors relative to
// CARGO_MANIFEST_DIR.  Exit 0 = all pass; exit 1 = one or more failures.

use std::{fs, path::PathBuf};

use serde_json::Value;
use weavepack_graph::{
    apply::{apply_chain, init_state, ColId},
    decode::{decode_chain, decode_graph},
    encode::{encode_chain, encode_graph},
    types::{
        Block, CellValue, EdgeBlock, GraphDoc, NodeBlock, Op, Path, PropCol,
        CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
        CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_NODE_ID,
        CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64,
        CTYPE_UINT8, SCHEMA_HASH_BYTES,
    },
};

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Cell value parsing ───────────────────────────────────────────────────────

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

fn parse_node_block(spec: &Value) -> Result<NodeBlock, String> {
    let label = spec["label"].as_str().map(|s| s.to_owned());
    let nids: Vec<u64> = spec["nids"].as_array().ok_or("nids missing")?.iter().map(|v| {
        let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
        s.parse::<u64>().map_err(|e| format!("nid: {e}"))
    }).collect::<Result<_, _>>()?;
    let columns: Vec<PropCol> = spec["columns"].as_array().ok_or("columns missing")?
        .iter().map(parse_prop_col).collect::<Result<_, _>>()?;
    Ok(NodeBlock { label, nids, columns })
}

fn parse_edge_block(spec: &Value) -> Result<EdgeBlock, String> {
    let label = spec["label"].as_str().map(|s| s.to_owned());
    let eids: Vec<u64> = spec["eids"].as_array().ok_or("eids missing")?.iter().map(|v| {
        let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
        s.parse::<u64>().map_err(|e| format!("eid: {e}"))
    }).collect::<Result<_, _>>()?;
    let srcs: Vec<u64> = spec["srcs"].as_array().ok_or("srcs missing")?.iter().map(|v| {
        let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
        s.parse::<u64>().map_err(|e| format!("src: {e}"))
    }).collect::<Result<_, _>>()?;
    let dsts: Vec<u64> = spec["dsts"].as_array().ok_or("dsts missing")?.iter().map(|v| {
        let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
        s.parse::<u64>().map_err(|e| format!("dst: {e}"))
    }).collect::<Result<_, _>>()?;
    let columns: Vec<PropCol> = spec["columns"].as_array().ok_or("columns missing")?
        .iter().map(parse_prop_col).collect::<Result<_, _>>()?;
    Ok(EdgeBlock { label, eids, srcs, dsts, columns })
}

fn parse_block(spec: &Value) -> Result<Block, String> {
    match spec["type"].as_str().ok_or("block type missing")? {
        "node" => Ok(Block::Node(parse_node_block(spec)?)),
        "edge" => Ok(Block::Edge(parse_edge_block(spec)?)),
        t      => Err(format!("unknown block type: {t}")),
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

fn parse_graph_doc(spec: &Value) -> Result<GraphDoc, String> {
    let schema_hash = parse_schema_hash(spec)?;
    let blocks: Vec<Block> = spec["blocks"].as_array().ok_or("blocks missing")?
        .iter().map(parse_block).collect::<Result<_, _>>()?;
    Ok(GraphDoc { schema_hash, blocks })
}

fn parse_path(spec: &Value) -> Result<Path, String> {
    let kind = spec["kind"].as_u64().ok_or("path kind missing")? as u8;
    let nid = || -> Result<u64, String> {
        let v = &spec["nid"];
        let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
        s.parse::<u64>().map_err(|e| format!("nid: {e}"))
    };
    let eid = || -> Result<u64, String> {
        let v = &spec["eid"];
        let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
        s.parse::<u64>().map_err(|e| format!("eid: {e}"))
    };
    let col_id = || spec["colId"].as_u64().ok_or("colId missing".to_string()).map(|n| n as u32);
    let label  = || spec["label"].as_str().map(|s| s.to_owned()).unwrap_or_default();
    let prop   = || spec["prop"].as_str().map(|s| s.to_owned()).unwrap_or_default();
    match kind {
        0  => Ok(Path::Node { nid: nid()? }),
        1  => Ok(Path::NodeCol { nid: nid()?, col_id: col_id()? }),
        2  => Ok(Path::Edge { eid: eid()? }),
        3  => Ok(Path::EdgeCol { eid: eid()?, col_id: col_id()? }),
        4  => Ok(Path::NodeLabel { label: label() }),
        5  => Ok(Path::NodeLabelCol { label: label(), col_id: col_id()? }),
        6  => Ok(Path::EdgeLabel { label: label() }),
        7  => Ok(Path::EdgeLabelCol { label: label(), col_id: col_id()? }),
        8  => Ok(Path::AtNid),
        9  => Ok(Path::AtEid),
        10 => Ok(Path::AtSrc),
        11 => Ok(Path::AtDst),
        12 => Ok(Path::AtLabel { label: label() }),
        13 => Ok(Path::NodeProp { nid: nid()?, prop: prop() }),
        14 => Ok(Path::EdgeProp { eid: eid()?, prop: prop() }),
        _  => Err(format!("unknown path kind {kind}")),
    }
}

fn parse_op(spec: &Value) -> Result<Op, String> {
    let op_code = spec["op"].as_u64().ok_or("op code missing")? as u8;
    match op_code {
        0 => Ok(Op::NodeInsert { block: parse_node_block(&spec["block"])? }),
        1 => {
            let nids: Vec<u64> = spec["nids"].as_array().ok_or("nids missing")?.iter().map(|v| {
                let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
                s.parse::<u64>().map_err(|e| format!("nid: {e}"))
            }).collect::<Result<_, _>>()?;
            Ok(Op::NodeDelete { nids })
        }
        2 => Ok(Op::EdgeInsert { block: parse_edge_block(&spec["block"])? }),
        3 => {
            let eids: Vec<u64> = spec["eids"].as_array().ok_or("eids missing")?.iter().map(|v| {
                let s = v.as_str().map(|s| s.to_owned()).unwrap_or_else(|| v.to_string());
                s.parse::<u64>().map_err(|e| format!("eid: {e}"))
            }).collect::<Result<_, _>>()?;
            Ok(Op::EdgeDelete { eids })
        }
        4 => {
            let path     = parse_path(&spec["path"])?;
            let ctype    = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
            let nullable = spec["nullable"].as_bool().unwrap_or(false);
            let val_v    = &spec["value"];
            let is_null  = val_v.is_null();
            let value    = if is_null { None } else { Some(parse_cell_value(ctype, val_v)?) };
            Ok(Op::PropSet { path, ctype, nullable, is_null, value })
        }
        5 => {
            let label = spec["label"].as_str().map(|s| s.to_owned());
            let node_block = spec.get("nodeBlock").filter(|v| !v.is_null())
                .map(parse_node_block).transpose()?;
            let edge_block = spec.get("edgeBlock").filter(|v| !v.is_null())
                .map(parse_edge_block).transpose()?;
            Ok(Op::SubgraphReplace { label, node_block, edge_block })
        }
        _ => Err(format!("unknown op code {op_code}")),
    }
}

// Float serialization matching JS JSON.stringify (whole numbers omit decimal).
fn cell_value_to_json(_ctype: u8, val: &Option<CellValue>) -> Value {
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

fn state_to_json(state: &weavepack_graph::apply::GraphState) -> Value {
    let mut nodes: Vec<_> = state.nodes.iter().collect();
    nodes.sort_by_key(|(nid, _)| *nid);
    let nodes_json: Vec<Value> = nodes.iter().map(|(nid, node)| {
        let mut props: Vec<_> = node.props.iter().collect();
        props.sort_by(|(a, _), (b, _)| match (a, b) {
            (ColId::Num(x), ColId::Num(y))     => x.cmp(y),
            (ColId::Named(x), ColId::Named(y)) => x.cmp(y),
            (ColId::Num(_), ColId::Named(_))   => std::cmp::Ordering::Less,
            (ColId::Named(_), ColId::Num(_))   => std::cmp::Ordering::Greater,
        });
        let props_json: Vec<Value> = props.iter().map(|(col_id, entry)| {
            let col_id_json = match col_id {
                ColId::Num(n)   => Value::from(*n as u64),
                ColId::Named(s) => Value::String(s.clone()),
            };
            serde_json::json!({
                "colId": col_id_json, "ctype": entry.ctype,
                "value": cell_value_to_json(entry.ctype, &entry.value),
            })
        }).collect();
        serde_json::json!({ "nid": nid.to_string(), "label": node.label, "props": props_json })
    }).collect();

    let mut edges: Vec<_> = state.edges.iter().collect();
    edges.sort_by_key(|(eid, _)| *eid);
    let edges_json: Vec<Value> = edges.iter().map(|(eid, edge)| {
        let mut props: Vec<_> = edge.props.iter().collect();
        props.sort_by(|(a, _), (b, _)| match (a, b) {
            (ColId::Num(x), ColId::Num(y))     => x.cmp(y),
            (ColId::Named(x), ColId::Named(y)) => x.cmp(y),
            (ColId::Num(_), ColId::Named(_))   => std::cmp::Ordering::Less,
            (ColId::Named(_), ColId::Num(_))   => std::cmp::Ordering::Greater,
        });
        let props_json: Vec<Value> = props.iter().map(|(col_id, entry)| {
            let col_id_json = match col_id {
                ColId::Num(n)   => Value::from(*n as u64),
                ColId::Named(s) => Value::String(s.clone()),
            };
            serde_json::json!({
                "colId": col_id_json, "ctype": entry.ctype,
                "value": cell_value_to_json(entry.ctype, &entry.value),
            })
        }).collect();
        serde_json::json!({
            "eid": eid.to_string(), "src": edge.src.to_string(),
            "dst": edge.dst.to_string(), "label": edge.label, "props": props_json,
        })
    }).collect();

    serde_json::json!({ "nodes": nodes_json, "edges": edges_json })
}

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
        .join("../../../weavepack/profiles/graph/test-vectors");
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
                let chain_hex = v["expected_chain_bytes_hex"].as_str().unwrap();
                let result = (|| -> Result<(), String> {
                    let ops: Vec<Op> = v["ops"].as_array().unwrap_or(&vec![])
                        .iter().map(parse_op).collect::<Result<_, _>>()?;
                    let schema_hash = [0u8; SCHEMA_HASH_BYTES];
                    let encoded = encode_chain(&schema_hash, &ops)?;
                    let got_hex = to_hex(&encoded);
                    if got_hex != chain_hex {
                        return Err(format!("chain bytes mismatch\n  expected: {chain_hex}\n  got:      {got_hex}"));
                    }
                    let dc = decode_chain(&encoded)?;
                    if to_hex(&encode_chain(&dc.schema_hash, &dc.ops)?) != chain_hex {
                        return Err("chain decode+re-encode mismatch".into());
                    }
                    let initial_doc = parse_graph_doc(&v["initial"])?;
                    let initial_decoded = decode_graph(&encode_graph(&initial_doc)?)?;
                    let state = init_state(&initial_decoded);
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
                let expected_hex = v["expected_bytes_hex"].as_str().unwrap();
                let result = (|| -> Result<(), String> {
                    let doc = parse_graph_doc(&v["input"])?;
                    let encoded = encode_graph(&doc)?;
                    let got_hex = to_hex(&encoded);
                    if got_hex != expected_hex {
                        return Err(format!("encode bytes mismatch\n  expected: {expected_hex}\n  got:      {got_hex}"));
                    }
                    let decoded = decode_graph(&encoded)?;
                    if to_hex(&encode_graph(&decoded)?) != expected_hex {
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

    println!("\n{pass}/{} Rust graph conformance pass.", pass + fail);
    if fail > 0 { std::process::exit(1); }
}
