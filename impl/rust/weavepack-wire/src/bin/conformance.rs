// weavepack-wire conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// The path defaults to ../../../weavepack/profiles/wire/test-vectors
// relative to CARGO_MANIFEST_DIR.
//
// Exit code 0 = all pass; exit code 1 = one or more failures.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use weavepack_wire::{
    apply::apply_chain,
    decode::{decode_chain, decode_document},
    encode::{encode_chain, encode_document},
    types::{Field, FieldValue, MapKey, MapKeyType, Op, PathComp, ScalarValue},
};

// ── helpers ───────────────────────────────────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── JSON → Rust type parsing ──────────────────────────────────────────────────

fn parse_scalar(vtype: u8, v: &Value) -> Result<ScalarValue, String> {
    match vtype {
        0  => Ok(ScalarValue::Bool(v.as_bool().ok_or("bool not bool")?)),
        1  => {
            let n = v.as_i64().ok_or("int32 not i64")?;
            Ok(ScalarValue::Int32(n as i32))
        }
        2  => {
            // int64 stored as string in JSON to preserve precision.
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: i64 = s.parse().map_err(|e| format!("int64 parse error: {e}"))?;
            Ok(ScalarValue::Int64(n))
        }
        3  => {
            let n = v.as_u64().ok_or("uint32 not u64")?;
            Ok(ScalarValue::Uint32(n as u32))
        }
        4  => {
            // uint64 stored as string.
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: u64 = s.parse().map_err(|e| format!("uint64 parse error: {e}"))?;
            Ok(ScalarValue::Uint64(n))
        }
        5  => {
            let n = v.as_i64().ok_or("sint32 not i64")?;
            Ok(ScalarValue::Sint32(n as i32))
        }
        6  => {
            // sint64 stored as string.
            let s = if let Some(s) = v.as_str() { s.to_owned() } else { v.to_string() };
            let n: i64 = s.parse().map_err(|e| format!("sint64 parse error: {e}"))?;
            Ok(ScalarValue::Sint64(n))
        }
        7  => {
            let n = v.as_f64().ok_or("float32 not f64")?;
            Ok(ScalarValue::Float32(n as f32))
        }
        8  => {
            let n = v.as_f64().ok_or("float64 not f64")?;
            Ok(ScalarValue::Float64(n))
        }
        9  => Ok(ScalarValue::String(v.as_str().ok_or("string not str")?.to_owned())),
        10 => {
            // bytes stored as {_bytes: [...]}
            let arr = v.get("_bytes").and_then(|b| b.as_array())
                .ok_or("bytes not {_bytes:[...]}")?;
            let bytes: Result<Vec<u8>, _> = arr.iter()
                .map(|b| b.as_u64().map(|n| n as u8).ok_or("byte not u64"))
                .collect();
            Ok(ScalarValue::Bytes(bytes?))
        }
        11 => {
            let n = v.as_i64().ok_or("enum not i64")?;
            Ok(ScalarValue::Enum(n as i32))
        }
        _ => Err(format!("unknown vtype {vtype}")),
    }
}

fn parse_field(fv: &Value) -> Result<Field, String> {
    let num = fv["num"].as_u64().ok_or("field missing 'num'")? as u32;

    // Nested message.
    if let Some(msg) = fv.get("message") {
        if let Some(arr) = msg.as_array() {
            let fields = parse_fields(arr)?;
            return Ok(Field { num, value: FieldValue::Message(fields) });
        }
    }

    // Repeated.
    if let Some(rep) = fv.get("repeated") {
        let elem_type = rep["elemType"].as_u64().ok_or("repeated missing elemType")? as u8;
        let values_arr = rep["values"].as_array().ok_or("repeated missing values")?;
        let values: Result<Vec<ScalarValue>, _> = values_arr.iter()
            .map(|v| parse_scalar(elem_type, v))
            .collect();
        return Ok(Field { num, value: FieldValue::Repeated { elem_type, values: values? } });
    }

    // Map.
    if let Some(map) = fv.get("map") {
        let key_type_str = map["keyType"].as_str().ok_or("map missing keyType")?;
        let key_type = if key_type_str == "string" { MapKeyType::Str } else { MapKeyType::Uint32 };
        let value_type = map["valueType"].as_u64().ok_or("map missing valueType")? as u8;
        let entries_arr = map["entries"].as_array().ok_or("map missing entries")?;
        let mut entries = Vec::new();
        for e in entries_arr {
            let pair = e.as_array().ok_or("map entry not array")?;
            if pair.len() < 2 { return Err("map entry too short".into()); }
            let key = match &key_type {
                MapKeyType::Str => MapKey::Str(pair[0].as_str().ok_or("map str key not str")?.to_owned()),
                MapKeyType::Uint32 => MapKey::Uint32(pair[0].as_u64().ok_or("map uint32 key not u64")? as u32),
            };
            let val = parse_scalar(value_type, &pair[1])?;
            entries.push((key, val));
        }
        return Ok(Field { num, value: FieldValue::Map { key_type, value_type, entries } });
    }

    // Oneof.
    if let Some(oneof) = fv.get("oneof") {
        let active_field = oneof["activeField"].as_u64().ok_or("oneof missing activeField")? as u32;
        let value_type = oneof["valueType"].as_u64().ok_or("oneof missing valueType")? as u8;
        let value = parse_scalar(value_type, &oneof["value"])?;
        return Ok(Field { num, value: FieldValue::Oneof { active_field, value_type, value } });
    }

    // Scalar.
    let vtype = fv["vtype"].as_u64().ok_or("scalar field missing 'vtype'")? as u8;
    let sv = parse_scalar(vtype, &fv["value"])?;
    Ok(Field { num, value: FieldValue::Scalar(sv) })
}

fn parse_fields(arr: &[Value]) -> Result<Vec<Field>, String> {
    arr.iter().map(parse_field).collect()
}

fn parse_path(path_arr: &[Value]) -> Result<Vec<PathComp>, String> {
    let mut path = Vec::new();
    for comp in path_arr {
        if let Some(n) = comp.get("field") {
            path.push(PathComp::Field(n.as_u64().ok_or("field comp not u64")? as u32));
        } else if let Some(k) = comp.get("map") {
            if let Some(s) = k.as_str() {
                path.push(PathComp::Map(MapKey::Str(s.to_owned())));
            } else {
                path.push(PathComp::Map(MapKey::Uint32(k.as_u64().ok_or("map comp not u64")? as u32)));
            }
        } else if let Some(i) = comp.get("index") {
            path.push(PathComp::Index(i.as_u64().ok_or("index comp not u64")? as u32));
        } else {
            return Err(format!("unknown path component: {comp}"));
        }
    }
    Ok(path)
}

fn parse_op(ov: &Value) -> Result<Op, String> {
    let op_code = ov["op"].as_u64().ok_or("op missing 'op'")? as u8;
    let path_arr = ov["path"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
    let path = parse_path(path_arr)?;

    match op_code {
        0 => {
            // field_set: value is either {vtype, value} or {message:[...]}
            let fv = &ov["value"];
            let field_value = if let Some(msg_arr) = fv.get("message").and_then(|m| m.as_array()) {
                FieldValue::Message(parse_fields(msg_arr)?)
            } else {
                let vtype = fv["vtype"].as_u64().ok_or("field_set missing vtype")? as u8;
                FieldValue::Scalar(parse_scalar(vtype, &fv["value"])?)
            };
            Ok(Op::FieldSet { path, value: field_value })
        }
        1 => Ok(Op::FieldDelete { path }),
        2 => {
            let msg_arr = ov["message"].as_array().ok_or("message_replace missing message")?;
            Ok(Op::MessageReplace { path, message: parse_fields(msg_arr)? })
        }
        3 => {
            let elems = &ov["elements"];
            let elem_type = elems["elemType"].as_u64().ok_or("repeated_append missing elemType")? as u8;
            let vals_arr = elems["values"].as_array().ok_or("repeated_append missing values")?;
            let values: Result<Vec<_>, _> = vals_arr.iter().map(|v| parse_scalar(elem_type, v)).collect();
            Ok(Op::RepeatedAppend { path, elem_type, values: values? })
        }
        4 => {
            let index = ov["index"].as_u64().ok_or("repeated_splice missing index")? as u32;
            let delete_count = ov["deleteCount"].as_u64().ok_or("repeated_splice missing deleteCount")? as u32;
            let elem_type = ov["elemType"].as_u64().ok_or("repeated_splice missing elemType")? as u8;
            let iv_arr = ov["insertValues"].as_array().ok_or("repeated_splice missing insertValues")?;
            let insert_values: Result<Vec<_>, _> = iv_arr.iter().map(|v| parse_scalar(elem_type, v)).collect();
            Ok(Op::RepeatedSplice { path, index, delete_count, elem_type, insert_values: insert_values? })
        }
        5 => {
            let key_type_str = ov["keyType"].as_str().ok_or("map_set missing keyType")?;
            let key_type = if key_type_str == "string" { MapKeyType::Str } else { MapKeyType::Uint32 };
            let key = match &key_type {
                MapKeyType::Str => MapKey::Str(ov["key"].as_str().ok_or("map_set key not str")?.to_owned()),
                MapKeyType::Uint32 => MapKey::Uint32(ov["key"].as_u64().ok_or("map_set key not u64")? as u32),
            };
            let value_type = ov["valueType"].as_u64().ok_or("map_set missing valueType")? as u8;
            let value = parse_scalar(value_type, &ov["value"])?;
            Ok(Op::MapSet { path, key_type, key, value_type, value })
        }
        6 => {
            let key_type_str = ov["keyType"].as_str().ok_or("map_delete missing keyType")?;
            let key_type = if key_type_str == "string" { MapKeyType::Str } else { MapKeyType::Uint32 };
            let key = match &key_type {
                MapKeyType::Str => MapKey::Str(ov["key"].as_str().ok_or("map_delete key not str")?.to_owned()),
                MapKeyType::Uint32 => MapKey::Uint32(ov["key"].as_u64().ok_or("map_delete key not u64")? as u32),
            };
            Ok(Op::MapDelete { path, key_type, key })
        }
        7 => {
            let active_field = ov["activeField"].as_u64().ok_or("oneof_switch missing activeField")? as u32;
            let value_type = ov["valueType"].as_u64().ok_or("oneof_switch missing valueType")? as u8;
            let value = parse_scalar(value_type, &ov["value"])?;
            Ok(Op::OneofSwitch { path, active_field, value_type, value })
        }
        _ => Err(format!("unknown op code {op_code}")),
    }
}

fn parse_ops(arr: &[Value]) -> Result<Vec<Op>, String> {
    arr.iter().map(parse_op).collect()
}

// ── equality comparison (round-trip) ──────────────────────────────────────────

// We compare via re-encoding to canonical hex (encode_document is deterministic).
fn fields_equal(a: &[Field], b: &[Field]) -> bool {
    encode_document(a) == encode_document(b)
}

fn ops_equal(a: &[Op], b: &[Op]) -> bool {
    if a.len() != b.len() { return false; }
    a.iter().zip(b.iter()).all(|(x, y)| encode_chain(&[x.clone()]) == encode_chain(&[y.clone()]))
}

// ── runner ────────────────────────────────────────────────────────────────────

struct Runner {
    pass: usize,
    fail: usize,
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

        let input_arr = match v["input"].as_array() {
            Some(a) => a,
            None => return self.err(&full, "missing 'input'"),
        };
        let expected_hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "missing 'expected_bytes_hex'"),
        };

        let fields = match parse_fields(input_arr) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("parse error: {e}")),
        };

        let bytes = encode_document(&fields);
        let hex = to_hex(&bytes);

        if hex != expected_hex {
            return self.err(&full, &format!(
                "encode bytes mismatch\n    expected: {expected_hex}\n    actual:   {hex}"
            ));
        }

        // Round-trip: decode and compare.
        let decoded = match decode_document(&bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        };

        // Compare via re-encoding (canonical form).
        let expected_decoded = if let Some(exp) = v.get("expected_decoded") {
            match exp.as_array().map(|a| parse_fields(a)) {
                Some(Ok(f)) => f,
                Some(Err(e)) => return self.err(&full, &format!("parse expected_decoded: {e}")),
                None => return self.err(&full, "expected_decoded not array"),
            }
        } else {
            fields.clone()
        };

        if !fields_equal(&decoded, &expected_decoded) {
            return self.err(&full, "decode round-trip mismatch");
        }

        self.ok();
    }

    fn run_delta_vector(&mut self, rel: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{rel}::{name}");

        let initial_arr = match v["initial"].as_array() {
            Some(a) => a,
            None => return self.err(&full, "missing 'initial'"),
        };
        let ops_arr = match v["ops"].as_array() {
            Some(a) => a,
            None => return self.err(&full, "missing 'ops'"),
        };
        let expected_chain_hex = match v["expected_chain_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "missing 'expected_chain_bytes_hex'"),
        };

        let initial = match parse_fields(initial_arr) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("parse initial: {e}")),
        };
        let ops = match parse_ops(ops_arr) {
            Ok(o) => o,
            Err(e) => return self.err(&full, &format!("parse ops: {e}")),
        };

        // Encode chain, compare hex.
        let chain_bytes = encode_chain(&ops);
        let chain_hex = to_hex(&chain_bytes);
        if chain_hex != expected_chain_hex {
            return self.err(&full, &format!(
                "chain bytes mismatch\n    expected: {expected_chain_hex}\n    actual:   {chain_hex}"
            ));
        }

        // Decode chain, round-trip.
        let decoded_ops = match decode_chain(&chain_bytes) {
            Ok(o) => o,
            Err(e) => return self.err(&full, &format!("decode chain error: {e}")),
        };
        if !ops_equal(&decoded_ops, &ops) {
            return self.err(&full, "ops round-trip mismatch");
        }

        // Apply chain to initial, compare final.
        let final_state = match apply_chain(initial.clone(), &ops) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("apply_chain error: {e}")),
        };
        let expected_final_arr = match v["expected_final"].as_array() {
            Some(a) => a,
            None => return self.err(&full, "missing 'expected_final'"),
        };
        let expected_final = match parse_fields(expected_final_arr) {
            Ok(f) => f,
            Err(e) => return self.err(&full, &format!("parse expected_final: {e}")),
        };
        if !fields_equal(&final_state, &expected_final) {
            return self.err(&full, "final state mismatch");
        }

        // Snapshot round-trip on final state.
        let snap_bytes = encode_document(&final_state);
        let snap_decoded = match decode_document(&snap_bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("snapshot round-trip decode error: {e}")),
        };
        if !fields_equal(&snap_decoded, &final_state) {
            return self.err(&full, "snapshot round-trip mismatch");
        }

        self.ok();
    }
}

// ── directory walker ──────────────────────────────────────────────────────────

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

// ── main ──────────────────────────────────────────────────────────────────────

fn main() {
    let vectors_root: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let manifest = env!("CARGO_MANIFEST_DIR");
            PathBuf::from(manifest)
                .join("../../../weavepack/profiles/wire/test-vectors")
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
            Err(e) => {
                runner.err(&rel, &format!("read error: {e}"));
                continue;
            }
        };
        let vectors: Vec<Value> = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                runner.err(&rel, &format!("JSON parse error: {e}"));
                continue;
            }
        };

        let is_delta  = rel.starts_with("deltas/");
        let is_schema = rel.starts_with("schemas/");

        for v in &vectors {
            // Skip pending placeholder vectors.
            if v.get("status").and_then(|s| s.as_str()) == Some("pending") {
                continue;
            }
            if is_schema {
                // Schemaful encoding deferred — skip.
                continue;
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
        for f in &runner.failures {
            println!("{f}");
        }
        std::process::exit(1);
    }
}
