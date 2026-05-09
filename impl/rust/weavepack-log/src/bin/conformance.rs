// weavepack-log conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// Defaults to ../../../weavepack/profiles/log/test-vectors relative to CARGO_MANIFEST_DIR.
// Exit 0 = all pass; exit 1 = one or more failures.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use weavepack_log::{
    apply::{apply_chain, init_state},
    decode::{decode_batch, decode_chain, decode_stream_header},
    encode::{encode_batch, encode_chain, encode_stream_header},
    types::{
        AppendColumn, Batch, CellValue, Column, Op, StreamHeader, UpdateField,
        CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
        CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_LEVEL,
        CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32,
        CTYPE_UINT64, CTYPE_UINT8, SCHEMA_HASH_BYTES, STREAM_ID_BYTES,
    },
};

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── JSON → Rust type parsing ─────────────────────────────────────────────────────────────────────────────

fn parse_cell_value(ctype: u8, v: &Value) -> Result<CellValue, String> {
    if v.is_null() { return Err("null value where non-null expected".into()); }
    match ctype {
        CTYPE_BOOL  => Ok(CellValue::Bool(v.as_bool().ok_or("bool: not bool")?)),
        CTYPE_INT8  => {
            let n = v.as_i64().ok_or("int8: not i64")?;
            Ok(CellValue::Int8(n as i8))
        }
        CTYPE_INT16 => {
            let n = v.as_i64().ok_or("int16: not i64")?;
            Ok(CellValue::Int16(n as i16))
        }
        CTYPE_INT32 => {
            let n = v.as_i64().ok_or("int32: not i64")?;
            Ok(CellValue::Int32(n as i32))
        }
        CTYPE_INT64 => {
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: i64 = s.parse().map_err(|e| format!("int64 parse: {e}"))?;
            Ok(CellValue::Int64(n))
        }
        CTYPE_UINT8  => Ok(CellValue::Uint8(v.as_u64().ok_or("uint8: not u64")? as u8)),
        CTYPE_UINT16 => Ok(CellValue::Uint16(v.as_u64().ok_or("uint16: not u64")? as u16)),
        CTYPE_UINT32 => Ok(CellValue::Uint32(v.as_u64().ok_or("uint32: not u64")? as u32)),
        CTYPE_UINT64 => {
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: u64 = s.parse().map_err(|e| format!("uint64 parse: {e}"))?;
            Ok(CellValue::Uint64(n))
        }
        CTYPE_FLOAT32 => Ok(CellValue::Float32(v.as_f64().ok_or("float32: not f64")? as f32)),
        CTYPE_FLOAT64 => Ok(CellValue::Float64(v.as_f64().ok_or("float64: not f64")?)),
        CTYPE_STRING  => Ok(CellValue::String(v.as_str().ok_or("string: not str")?.to_owned())),
        CTYPE_BYTES   => {
            let arr = v.get("_bytes").and_then(|b| b.as_array())
                .ok_or("bytes: expected {_bytes:[...]}")?;
            let bytes: Result<Vec<u8>, _> = arr.iter()
                .map(|b| b.as_u64().map(|n| n as u8).ok_or("byte not u64"))
                .collect();
            Ok(CellValue::Bytes(bytes?))
        }
        CTYPE_DATE32 => {
            let n = v.as_i64().ok_or("date32: not i64")?;
            Ok(CellValue::Date32(n as i32))
        }
        CTYPE_TIMESTAMP64 => {
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: i64 = s.parse().map_err(|e| format!("timestamp64 parse: {e}"))?;
            Ok(CellValue::Timestamp64(n))
        }
        CTYPE_LEVEL => {
            let n = v.as_u64().ok_or("level: not u64")?;
            Ok(CellValue::Level(n as u8))
        }
        _ => Err(format!("unknown ctype {ctype}")),
    }
}

fn parse_column(spec: &Value) -> Result<Column, String> {
    let col_id   = spec["colId"].as_u64().ok_or("colId missing")? as u32;
    let ctype    = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
    let nullable = spec["nullable"].as_bool().unwrap_or(false);
    let vals_arr = spec["values"].as_array().ok_or("values missing")?;
    let mut values = Vec::with_capacity(vals_arr.len());
    for v in vals_arr {
        if v.is_null() {
            values.push(None);
        } else {
            values.push(Some(parse_cell_value(ctype, v)?));
        }
    }
    Ok(Column { col_id, ctype, nullable, values })
}

fn parse_batch(spec: &Value) -> Result<Batch, String> {
    // schema_hash: optional
    let schema_hash = if let Some(sh) = spec.get("schemaHash") {
        let arr = sh.get("_bytes").and_then(|b| b.as_array())
            .ok_or("schemaHash: expected {_bytes:[...]}")?;
        let bytes: Vec<u8> = arr.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
        if bytes.len() != SCHEMA_HASH_BYTES {
            return Err(format!("schemaHash must be {SCHEMA_HASH_BYTES} bytes"));
        }
        let mut arr = [0u8; SCHEMA_HASH_BYTES];
        arr.copy_from_slice(&bytes);
        arr
    } else {
        [0u8; SCHEMA_HASH_BYTES]
    };

    let seqs_arr = spec["seqs"].as_array().ok_or("seqs missing")?;
    let seqs: Result<Vec<u64>, _> = seqs_arr.iter().map(|v| {
        let s = v.as_str().unwrap_or(&v.to_string()).to_owned();
        s.parse::<u64>().map_err(|e| format!("seq parse: {e}"))
    }).collect();
    let seqs = seqs?;

    let tss_arr = spec["tss"].as_array().ok_or("tss missing")?;
    let tss: Result<Vec<i64>, _> = tss_arr.iter().map(|v| {
        let s = v.as_str().unwrap_or(&v.to_string()).to_owned();
        s.parse::<i64>().map_err(|e| format!("ts parse: {e}"))
    }).collect();
    let tss = tss?;

    let cols_arr = spec["columns"].as_array().ok_or("columns missing")?;
    let columns: Result<Vec<Column>, _> = cols_arr.iter().map(|c| parse_column(c)).collect();
    let columns = columns?;

    Ok(Batch { schema_hash, seqs, tss, columns })
}

fn parse_append_column(spec: &Value) -> Result<AppendColumn, String> {
    let col = parse_column(spec)?;
    Ok(AppendColumn { col_id: col.col_id, ctype: col.ctype, nullable: col.nullable, values: col.values })
}

fn parse_seq_u64(v: &Value) -> Result<u64, String> {
    let s = v.as_str().unwrap_or(&v.to_string()).to_owned();
    s.parse::<u64>().map_err(|e| format!("seq u64 parse: {e}"))
}

fn parse_ts_i64(v: &Value) -> Result<i64, String> {
    let s = v.as_str().unwrap_or(&v.to_string()).to_owned();
    s.parse::<i64>().map_err(|e| format!("ts i64 parse: {e}"))
}

fn parse_op(spec: &Value) -> Result<Op, String> {
    let op_code = spec["op"].as_u64().ok_or("op code missing")? as u8;
    match op_code {
        0 => {
            // EVENT_APPEND
            let seqs_arr = spec["seqs"].as_array().ok_or("seqs missing")?;
            let seqs: Result<Vec<u64>, _> = seqs_arr.iter().map(|v| parse_seq_u64(v)).collect();
            let seqs = seqs?;
            let tss_arr = spec["tss"].as_array().ok_or("tss missing")?;
            let tss: Result<Vec<i64>, _> = tss_arr.iter().map(|v| parse_ts_i64(v)).collect();
            let tss = tss?;
            let cols_arr = spec["columns"].as_array().ok_or("columns missing")?;
            let columns: Result<Vec<AppendColumn>, _> = cols_arr.iter().map(|c| parse_append_column(c)).collect();
            Ok(Op::EventAppend { seqs, tss, columns: columns? })
        }
        1 => {
            // FIELD_UPDATE
            let seq = parse_seq_u64(&spec["seq"])?;
            let cols_arr = spec["columns"].as_array().ok_or("columns missing")?;
            let mut columns = Vec::new();
            for col_spec in cols_arr {
                let col_id    = col_spec["colId"].as_u64().ok_or("colId missing")? as u32;
                let ctype     = col_spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
                let val_v     = col_spec.get("value").unwrap_or(&Value::Null);
                let has_value = !val_v.is_null();
                let value = if has_value {
                    Some(parse_cell_value(ctype, val_v)?)
                } else { None };
                columns.push(UpdateField { col_id, ctype, has_value, value });
            }
            Ok(Op::FieldUpdate { seq, columns })
        }
        2 => {
            // EVENT_EXPIRE
            let seq_lo = parse_seq_u64(&spec["seqLo"])?;
            let seq_hi = parse_seq_u64(&spec["seqHi"])?;
            Ok(Op::EventExpire { seq_lo, seq_hi })
        }
        3 => {
            // SCHEMA_EVOLVE — sub_op determined by presence of fields
            let sub_op = spec["subOp"].as_u64().ok_or("subOp missing")? as u8;
            match sub_op {
                0 => {
                    let col_id   = spec["colId"].as_u64().ok_or("colId missing")? as u32;
                    let ctype    = spec["ctype"].as_u64().ok_or("ctype missing")? as u8;
                    let nullable = spec["nullable"].as_bool().unwrap_or(false);
                    let name     = spec["name"].as_str().ok_or("name missing")?.to_owned();
                    Ok(Op::SchemaColumnAdd { col_id, ctype, nullable, name })
                }
                1 => {
                    let col_id = spec["colId"].as_u64().ok_or("colId missing")? as u32;
                    Ok(Op::SchemaColumnDrop { col_id })
                }
                2 => {
                    let col_id = spec["colId"].as_u64().ok_or("colId missing")? as u32;
                    let name   = spec["name"].as_str().ok_or("name missing")?.to_owned();
                    Ok(Op::SchemaColumnRename { col_id, name })
                }
                _ => Err(format!("unknown schema sub_op {sub_op}")),
            }
        }
        4 => {
            // CURSOR_CHECKPOINT
            let seq  = parse_seq_u64(&spec["seq"])?;
            let name = spec["name"].as_str().ok_or("cursor name missing")?.to_owned();
            Ok(Op::CursorCheckpoint { seq, name })
        }
        _ => Err(format!("unknown op code {op_code}")),
    }
}

fn parse_stream_header(spec: &Value) -> Result<StreamHeader, String> {
    let id_arr = spec["streamId"].get("_bytes").and_then(|b| b.as_array())
        .ok_or("streamId: expected {_bytes:[...]}")?;
    let id_bytes: Vec<u8> = id_arr.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
    if id_bytes.len() != STREAM_ID_BYTES {
        return Err(format!("stream_id must be {STREAM_ID_BYTES} bytes"));
    }
    let mut stream_id = [0u8; STREAM_ID_BYTES];
    stream_id.copy_from_slice(&id_bytes);

    let source = spec["source"].as_str().unwrap_or("").to_owned();

    let schema_hash = if let Some(sh) = spec.get("schemaHash") {
        let arr = sh.get("_bytes").and_then(|b| b.as_array())
            .ok_or("schemaHash: expected {_bytes:[...]}")?;
        let bytes: Vec<u8> = arr.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
        if bytes.len() != SCHEMA_HASH_BYTES {
            return Err(format!("schemaHash must be {SCHEMA_HASH_BYTES} bytes"));
        }
        let mut arr = [0u8; SCHEMA_HASH_BYTES];
        arr.copy_from_slice(&bytes);
        arr
    } else {
        [0u8; SCHEMA_HASH_BYTES]
    };

    let seq_start_v = spec.get("seqStart").unwrap_or(&Value::Null);
    let seq_start = if seq_start_v.is_null() {
        0u64
    } else {
        let s = seq_start_v.as_str().unwrap_or(&seq_start_v.to_string()).to_owned();
        s.parse::<u64>().map_err(|e| format!("seqStart parse: {e}"))?
    };

    Ok(StreamHeader { stream_id, source, schema_hash, seq_start })
}

// ── State comparison ──────────────────────────────────────────────────────────────────────────────

fn cell_val_to_json(_ctype: u8, val: &Option<CellValue>) -> Value {
    match val {
        None => Value::Null,
        Some(cv) => match cv {
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
                if let Some(n) = serde_json::Number::from_f64(*f as f64) {
                    Value::Number(n)
                } else { Value::Null }
            }
            CellValue::Float64(f)     => {
                if let Some(n) = serde_json::Number::from_f64(*f) {
                    Value::Number(n)
                } else { Value::Null }
            }
            CellValue::String(s)      => Value::String(s.clone()),
            CellValue::Bytes(b)       => {
                let arr: Vec<Value> = b.iter().map(|&x| Value::from(x as u64)).collect();
                serde_json::json!({ "_bytes": arr })
            }
            CellValue::Date32(n)      => Value::from(*n as i64),
            CellValue::Timestamp64(n) => Value::String(n.to_string()),
            CellValue::Level(l)       => Value::from(*l as u64),
        },
    }
}

fn state_to_spec(state: &weavepack_log::types::StreamState) -> Value {
    let seqs: Vec<Value> = state.seqs.iter().map(|s| Value::String(s.to_string())).collect();
    let tss: Vec<Value>  = state.tss.iter().map(|s| Value::String(s.to_string())).collect();
    let columns: Vec<Value> = state.columns.iter().map(|col| {
        let values: Vec<Value> = col.values.iter()
            .map(|v| cell_val_to_json(col.ctype, v))
            .collect();
        serde_json::json!({
            "colId":    col.col_id,
            "ctype":    col.ctype,
            "nullable": col.nullable,
            "values":   values,
        })
    }).collect();

    let mut spec = serde_json::Map::new();
    spec.insert("seqs".into(), Value::Array(seqs));
    spec.insert("tss".into(),  Value::Array(tss));
    spec.insert("columns".into(), Value::Array(columns));

    if !state.schema.is_empty() {
        let schema: Vec<Value> = state.schema.iter().map(|s| serde_json::json!({
            "colId":    s.col_id,
            "ctype":    s.ctype,
            "nullable": s.nullable,
            "name":     s.name,
        })).collect();
        spec.insert("schema".into(), Value::Array(schema));
    }

    if !state.expired.is_empty() {
        let mut exp: Vec<String> = state.expired.iter().map(|s| s.to_string()).collect();
        exp.sort_by_key(|s| s.parse::<u64>().unwrap_or(0));
        let exp_vals: Vec<Value> = exp.into_iter().map(Value::String).collect();
        spec.insert("expired".into(), Value::Array(exp_vals));
    }

    if !state.cursors.is_empty() {
        let mut map = serde_json::Map::new();
        for (k, v) in &state.cursors {
            map.insert(k.clone(), Value::String(v.to_string()));
        }
        spec.insert("cursors".into(), Value::Object(map));
    }

    Value::Object(spec)
}

// Normalize BigInt/number values for comparison — the spec may store
// seq/ts as string or number; we compare as normalized JSON.
fn normalize_spec(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut out = serde_json::Map::new();
            for (k, val) in m {
                out.insert(k.clone(), normalize_spec(val));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(normalize_spec).collect()),
        Value::String(s)  => {
            // Keep strings as-is (seqs/tss are already strings).
            Value::String(s.clone())
        }
        _ => v.clone(),
    }
}

fn states_equal(actual: &Value, expected: &Value) -> bool {
    normalize_spec(actual) == normalize_spec(expected)
}

// ── Test runner ────────────────────────────────────────────────────────────────────────────────────

struct Runner {
    pass:     usize,
    fail:     usize,
    failures: Vec<String>,
}

impl Runner {
    fn new() -> Self { Runner { pass: 0, fail: 0, failures: vec![] } }

    fn ok(&mut self) { self.pass += 1; }

    fn err(&mut self, name: &str, reason: &str) {
        self.fail += 1;
        self.failures.push(format!("  {name}\n    {reason}"));
    }

    fn run_snapshot_vector(&mut self, rel: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{rel}::{name}");

        let expected_hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "missing 'expected_bytes_hex'"),
        };

        let batch = match parse_batch(&v["input"]) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("parse error: {e}")),
        };

        let bytes = match encode_batch(&batch) {
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
        let decoded = match decode_batch(&bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        };
        let reenc_hex = match encode_batch(&decoded) {
            Ok(b) => to_hex(&b),
            Err(e) => return self.err(&full, &format!("re-encode error: {e}")),
        };
        if reenc_hex != hex {
            return self.err(&full, "decode+re-encode round-trip mismatch");
        }

        self.ok();
    }

    fn run_header_vector(&mut self, rel: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{rel}::{name}");

        let expected_hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "missing 'expected_bytes_hex'"),
        };

        let hdr = match parse_stream_header(&v["input"]) {
            Ok(h) => h,
            Err(e) => return self.err(&full, &format!("parse error: {e}")),
        };

        let bytes = match encode_stream_header(&hdr) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("encode error: {e}")),
        };
        let hex = to_hex(&bytes);

        if hex != expected_hex {
            return self.err(&full, &format!(
                "encode bytes mismatch\n    expected: {expected_hex}\n    actual:   {hex}"
            ));
        }

        // Round-trip: decode and check key fields.
        let decoded = match decode_stream_header(&bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        };
        if decoded.source != hdr.source {
            return self.err(&full, &format!(
                "header source mismatch\n    expected: {}\n    actual:   {}",
                hdr.source, decoded.source
            ));
        }
        if decoded.seq_start != hdr.seq_start {
            return self.err(&full, &format!(
                "header seqStart mismatch\n    expected: {}\n    actual:   {}",
                hdr.seq_start, decoded.seq_start
            ));
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

        let ops_arr = match v["ops"].as_array() {
            Some(a) => a,
            None => return self.err(&full, "missing 'ops'"),
        };
        let ops: Vec<Op> = match ops_arr.iter().map(|o| parse_op(o)).collect::<Result<Vec<_>, _>>() {
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

        // Parse initial batch, apply chain, compare final state.
        let initial_batch = match parse_batch(&v["initial"]) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("parse initial: {e}")),
        };
        let initial_state = init_state(initial_batch);
        let final_state = match apply_chain(initial_state, &ops) {
            Ok(s) => s,
            Err(e) => return self.err(&full, &format!("apply_chain error: {e}")),
        };

        let actual_spec = state_to_spec(&final_state);
        if !states_equal(&actual_spec, &v["expected_final"]) {
            return self.err(&full, &format!(
                "final state mismatch\n    expected: {}\n    actual:   {}",
                v["expected_final"], actual_spec
            ));
        }

        self.ok();
    }
}

// ── Directory walker ─────────────────────────────────────────────────────────────────────────────────

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

// ── Main ────────────────────────────────────────────────────────────────────────────────────

fn main() {
    let vectors_root: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let manifest = env!("CARGO_MANIFEST_DIR");
            PathBuf::from(manifest)
                .join("../../../weavepack/profiles/log/test-vectors")
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

        let is_delta  = rel.starts_with("deltas/");
        let is_header = rel == "containers/stream_header.json";

        for v in &vectors {
            if v.get("status").and_then(|s| s.as_str()) == Some("pending") { continue; }
            if is_header {
                runner.run_header_vector(&rel, v);
            } else if is_delta {
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
