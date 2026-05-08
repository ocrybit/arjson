// weavepack-tabular conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// Defaults to ../../../weavepack/profiles/tabular/test-vectors relative to CARGO_MANIFEST_DIR.
// Exit 0 = all pass; exit 1 = one or more failures.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use weavepack_tabular::{
    apply::apply_chain,
    decode::{decode_chain, decode_frame},
    encode::{encode_chain, encode_frame},
    types::{CellValue, Column, Frame, Op, OpColumn, SCHEMA_HASH_BYTES},
};

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// ── JSON → Rust type parsing ──────────────────────────────────────────────────

fn parse_cell_value(ctype: u8, v: &Value) -> Result<CellValue, String> {
    if v.is_null() { return Err("null value where non-null expected".into()); }
    match ctype {
        0 => Ok(CellValue::Bool(v.as_bool().ok_or("bool: not bool")?)),
        1 => {
            let n = v.as_i64().ok_or("int8: not i64")?;
            Ok(CellValue::Int8(n as i8))
        }
        2 => {
            let n = v.as_i64().ok_or("int16: not i64")?;
            Ok(CellValue::Int16(n as i16))
        }
        3 => {
            let n = v.as_i64().ok_or("int32: not i64")?;
            Ok(CellValue::Int32(n as i32))
        }
        4 => {
            // int64 stored as string in JSON.
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: i64 = s.parse().map_err(|e| format!("int64 parse: {e}"))?;
            Ok(CellValue::Int64(n))
        }
        5 => Ok(CellValue::Uint8(v.as_u64().ok_or("uint8: not u64")? as u8)),
        6 => Ok(CellValue::Uint16(v.as_u64().ok_or("uint16: not u64")? as u16)),
        7 => Ok(CellValue::Uint32(v.as_u64().ok_or("uint32: not u64")? as u32)),
        8 => {
            // uint64 stored as string.
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: u64 = s.parse().map_err(|e| format!("uint64 parse: {e}"))?;
            Ok(CellValue::Uint64(n))
        }
        9  => Ok(CellValue::Float32(v.as_f64().ok_or("float32: not f64")? as f32)),
        10 => Ok(CellValue::Float64(v.as_f64().ok_or("float64: not f64")?)),
        11 => Ok(CellValue::String(v.as_str().ok_or("string: not str")?.to_owned())),
        12 => {
            let arr = v.get("_bytes").and_then(|b| b.as_array())
                .ok_or("bytes: expected {_bytes:[...]}")?;
            let bytes: Result<Vec<u8>, _> = arr.iter()
                .map(|b| b.as_u64().map(|n| n as u8).ok_or("byte not u64"))
                .collect();
            Ok(CellValue::Bytes(bytes?))
        }
        13 => {
            let n = v.as_i64().ok_or("date32: not i64")?;
            Ok(CellValue::Date32(n as i32))
        }
        14 => {
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: i64 = s.parse().map_err(|e| format!("timestamp64 parse: {e}"))?;
            Ok(CellValue::Timestamp64(n))
        }
        _ => Err(format!("unknown ctype {ctype}")),
    }
}

fn parse_cell_nullable(ctype: u8, v: &Value) -> Result<Option<CellValue>, String> {
    if v.is_null() { return Ok(None); }
    parse_cell_value(ctype, v).map(Some)
}

fn parse_row_id(v: &Value) -> Result<u64, String> {
    if let Some(s) = v.as_str() {
        s.parse::<u64>().map_err(|e| format!("row_id parse: {e}"))
    } else if let Some(n) = v.as_u64() {
        Ok(n)
    } else {
        Err("row_id: not string or u64".into())
    }
}

fn parse_column(col_v: &Value) -> Result<Column, String> {
    let col_id  = col_v["colId"].as_u64().ok_or("column missing colId")? as u32;
    let ctype   = col_v["ctype"].as_u64().ok_or("column missing ctype")? as u8;
    let nullable = col_v["nullable"].as_bool().ok_or("column missing nullable")?;
    let vals_arr = col_v["values"].as_array().ok_or("column missing values")?;
    let values: Result<Vec<Option<CellValue>>, _> = vals_arr.iter()
        .map(|v| parse_cell_nullable(ctype, v))
        .collect();
    let name = col_v.get("name").and_then(|n| n.as_str()).map(|s| s.to_owned());
    Ok(Column { col_id, ctype, nullable, values: values?, name })
}

fn parse_frame(spec: &Value) -> Result<Frame, String> {
    let row_ids_arr = spec["rowIds"].as_array().ok_or("frame missing rowIds")?;
    let row_ids: Result<Vec<u64>, _> = row_ids_arr.iter().map(parse_row_id).collect();

    let cols_arr = match spec.get("columns").and_then(|c| c.as_array()) {
        Some(a) => a.clone(),
        None    => vec![],
    };
    let columns: Result<Vec<Column>, _> = cols_arr.iter().map(parse_column).collect();

    let schema_hash = if let Some(h) = spec.get("schemaHash").and_then(|h| h.as_str()) {
        let raw = from_hex(h);
        if raw.len() != SCHEMA_HASH_BYTES {
            return Err(format!("schemaHash wrong length: {}", raw.len()));
        }
        let mut arr = [0u8; SCHEMA_HASH_BYTES];
        arr.copy_from_slice(&raw);
        arr
    } else {
        [0u8; SCHEMA_HASH_BYTES]
    };

    Ok(Frame { schema_hash, row_ids: row_ids?, columns: columns? })
}

fn parse_op_column(col_v: &Value) -> Result<OpColumn, String> {
    let col = parse_column(col_v)?;
    Ok(OpColumn { col_id: col.col_id, ctype: col.ctype, nullable: col.nullable, values: col.values })
}

fn parse_op(ov: &Value) -> Result<Op, String> {
    let op_code = ov["op"].as_u64().ok_or("op missing 'op'")? as u8;
    match op_code {
        0 | 1 | 6 => {
            let row_ids_arr = ov["rowIds"].as_array().ok_or("op missing rowIds")?;
            let row_ids: Result<Vec<u64>, _> = row_ids_arr.iter().map(parse_row_id).collect();
            let cols_arr = ov.get("columns").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            let columns: Result<Vec<OpColumn>, _> = cols_arr.iter().map(parse_op_column).collect();
            match op_code {
                0 => Ok(Op::RowInsert    { row_ids: row_ids?, columns: columns? }),
                1 => Ok(Op::RowUpdate    { row_ids: row_ids?, columns: columns? }),
                6 => Ok(Op::BatchUpsert  { row_ids: row_ids?, columns: columns? }),
                _ => unreachable!(),
            }
        }
        2 => {
            let row_ids_arr = ov["rowIds"].as_array().ok_or("row_delete missing rowIds")?;
            let row_ids: Result<Vec<u64>, _> = row_ids_arr.iter().map(parse_row_id).collect();
            Ok(Op::RowDelete { row_ids: row_ids? })
        }
        3 => {
            let col_id   = ov["colId"].as_u64().ok_or("column_add missing colId")? as u32;
            let ctype    = ov["ctype"].as_u64().ok_or("column_add missing ctype")? as u8;
            let nullable = ov["nullable"].as_bool().ok_or("column_add missing nullable")?;
            let has_default = ov.get("hasDefault").and_then(|b| b.as_bool()).unwrap_or(false);
            let default_value = if has_default {
                if let Some(dv) = ov.get("defaultValue") {
                    Some(parse_cell_value(ctype, dv)?)
                } else { None }
            } else { None };
            Ok(Op::ColumnAdd { col_id, ctype, nullable, has_default, default_value })
        }
        4 => {
            let col_id = ov["colId"].as_u64().ok_or("column_drop missing colId")? as u32;
            Ok(Op::ColumnDrop { col_id })
        }
        5 => {
            let col_id = ov["colId"].as_u64().ok_or("column_rename missing colId")? as u32;
            let name   = ov["name"].as_str().ok_or("column_rename missing name")?.to_owned();
            Ok(Op::ColumnRename { col_id, name })
        }
        _ => Err(format!("unknown op code {op_code}")),
    }
}

fn parse_ops(arr: &[Value]) -> Result<Vec<Op>, String> {
    arr.iter().map(parse_op).collect()
}

// ── Frame comparison (via re-encoding) ────────────────────────────────────────

fn frame_to_canonical(frame: &Frame) -> Vec<u8> {
    encode_frame(frame).unwrap_or_default()
}

fn frames_equal(a: &Frame, b: &Frame) -> bool {
    frame_to_canonical(a) == frame_to_canonical(b)
}

// ── Runner ────────────────────────────────────────────────────────────────────

struct Runner {
    pass:     usize,
    fail:     usize,
    failures: Vec<String>,
}

impl Runner {
    fn new() -> Self { Runner { pass: 0, fail: 0, failures: Vec::new() } }

    fn ok(&mut self) { self.pass += 1; }

    fn err(&mut self, name: &str, msg: &str) {
        self.fail += 1;
        self.failures.push(format!("  FAIL [{name}]: {msg}"));
    }

    fn run_snapshot_vector(&mut self, rel: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{rel}::{name}");

        let expected_hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "missing 'expected_bytes_hex'"),
        };

        let frame = match parse_frame(&v["input"]) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("parse error: {e}")),
        };

        let bytes = match encode_frame(&frame) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("encode error: {e}")),
        };
        let hex = to_hex(&bytes);

        if hex != expected_hex {
            return self.err(&full, &format!(
                "encode bytes mismatch\n    expected: {expected_hex}\n    actual:   {hex}"
            ));
        }

        // Round-trip: decode then re-encode.
        let decoded = match decode_frame(&bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        };
        let reenc_hex = match encode_frame(&decoded) {
            Ok(b) => to_hex(&b),
            Err(e) => return self.err(&full, &format!("re-encode error: {e}")),
        };
        if reenc_hex != hex {
            return self.err(&full, "decode+re-encode round-trip mismatch");
        }

        self.ok();
    }

    fn run_delta_vector(&mut self, rel: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{rel}::{name}");

        let expected_chain_hex = match v["expected_chain_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "missing 'expected_chain_bytes_hex'"),
        };

        let initial_frame = match parse_frame(&v["initial"]) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("parse initial: {e}")),
        };

        let ops_arr = match v["ops"].as_array() {
            Some(a) => a,
            None => return self.err(&full, "missing 'ops'"),
        };
        let ops = match parse_ops(ops_arr) {
            Ok(o) => o,
            Err(e) => return self.err(&full, &format!("parse ops: {e}")),
        };

        // Encode chain, compare hex.
        let null_hash = [0u8; SCHEMA_HASH_BYTES];
        let chain_bytes = match encode_chain(&null_hash, &ops) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("encode chain error: {e}")),
        };
        let chain_hex = to_hex(&chain_bytes);
        if chain_hex != expected_chain_hex {
            return self.err(&full, &format!(
                "chain bytes mismatch\n    expected: {expected_chain_hex}\n    actual:   {chain_hex}"
            ));
        }

        // Decode chain, round-trip.
        let (_, decoded_ops) = match decode_chain(&chain_bytes) {
            Ok(p) => p,
            Err(e) => return self.err(&full, &format!("decode chain error: {e}")),
        };
        let reenc_chain = match encode_chain(&null_hash, &decoded_ops) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("re-encode chain error: {e}")),
        };
        if to_hex(&reenc_chain) != chain_hex {
            return self.err(&full, "ops round-trip mismatch");
        }

        // Apply chain, compare final.
        let initial = match encode_frame(&initial_frame)
            .and_then(|b| decode_frame(&b).map_err(|e| e))
        {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("initial encode/decode: {e}")),
        };

        let final_state = match apply_chain(initial, &ops) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("apply_chain error: {e}")),
        };

        let expected_final = match parse_frame(&v["expected_final"]) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("parse expected_final: {e}")),
        };

        if !frames_equal(&final_state, &expected_final) {
            return self.err(&full, "final state mismatch");
        }

        self.ok();
    }
}

// ── Directory walker ──────────────────────────────────────────────────────────

fn walk_json(dir: &Path, files: &mut Vec<PathBuf>) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            walk_json(&path, files);
        } else if path.extension().map_or(false, |e| e == "json") {
            files.push(path);
        }
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let vectors_root: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let manifest = env!("CARGO_MANIFEST_DIR");
            PathBuf::from(manifest)
                .join("../../../weavepack/profiles/tabular/test-vectors")
        });

    let vectors_root = vectors_root
        .canonicalize()
        .unwrap_or_else(|_| vectors_root.clone());

    let mut files = Vec::new();
    walk_json(&vectors_root, &mut files);

    if files.is_empty() {
        eprintln!("No test vector files found under {}", vectors_root.display());
        std::process::exit(1);
    }

    let mut runner = Runner::new();

    for path in &files {
        let rel = path
            .strip_prefix(&vectors_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => { runner.err(&rel, &format!("read error: {e}")); continue; }
        };
        let vectors: Vec<Value> = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => { runner.err(&rel, &format!("JSON parse error: {e}")); continue; }
        };

        let is_delta = rel.starts_with("deltas/");

        for v in &vectors {
            if v.get("status").and_then(|s| s.as_str()) == Some("pending") { continue; }
            if is_delta {
                runner.run_delta_vector(&rel, v);
            } else {
                runner.run_snapshot_vector(&rel, v);
            }
        }
    }

    println!("Pass: {}", runner.pass);
    println!("Fail: {}", runner.fail);

    if !runner.failures.is_empty() {
        println!("\nFailures:");
        for f in &runner.failures { println!("{f}"); }
        std::process::exit(1);
    }
}
