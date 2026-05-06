// weavepack-tensor conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// The path defaults to ../../../weavepack/profiles/tensor/test-vectors
// relative to CARGO_MANIFEST_DIR (i.e., the weavepack-tensor crate root).
//
// Exit code 0 = all pass; exit code 1 = one or more failures.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use weavepack_tensor::{
    chain::{chain_parse, chain_serialize}, // re-exported from weavepack-core
    decode::{decode_document, decode_document_schemaful},
    delta::{apply_delta, encode_delta},
    encode::{encode_document, encode_document_schemaful},
    fp8_dtype::{f32_to_fp8e4m3, f32_to_fp8e5m2},
    half_dtype::{f32_to_bf16_bits, f32_to_fp16_bits},
    schema::schema_hash_hex,
    types::{
        SchemaEntry, DTYPE_BOOL, DTYPE_FP32, DTYPE_FP64, DTYPE_INT16, DTYPE_INT32, DTYPE_INT64,
        DTYPE_INT8, DTYPE_QINT4, DTYPE_QINT8, DTYPE_QFP8, DTYPE_UINT16, DTYPE_UINT32,
        DTYPE_UINT64, DTYPE_UINT8,
    },
    TensorData,
};

const DTYPE_FP16: u8 = 13;
const DTYPE_BF16: u8 = 14;

// ── helpers ───────────────────────────────────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err(format!("odd-length hex string: {s}"));
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
             .map_err(|_| format!("bad hex byte at {i}")))
        .collect()
}

/// Convert a JSON test-vector data array to raw little-endian bytes.
fn json_data_to_bytes(dtype: u8, arr: &[Value]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    match dtype {
        DTYPE_BOOL => {
            // 1 bit per element, MSB-first packed, zero-padded to byte boundary.
            let mut byte = 0u8;
            let mut bit = 7i32;
            for v in arr {
                let b = v.as_u64().ok_or("bool element not u64")? != 0;
                if b {
                    byte |= 1 << bit;
                }
                bit -= 1;
                if bit < 0 {
                    out.push(byte);
                    byte = 0;
                    bit = 7;
                }
            }
            if bit < 7 {
                out.push(byte);
            }
        }
        1 => {
            // DTYPE_INT4: signed 4-bit, 2 elements per byte, high nibble = lower index.
            // int4 range -8..7; wire nibble = value & 0x0F.
            let mut packed = vec![0u8; (arr.len() + 1) / 2];
            for (i, v) in arr.iter().enumerate() {
                let n = v.as_i64().ok_or("int4 element not i64")?;
                let nibble = (n as u8) & 0x0F;
                if i % 2 == 0 {
                    packed[i / 2] |= nibble << 4;
                } else {
                    packed[i / 2] |= nibble;
                }
            }
            out.extend_from_slice(&packed);
        }
        2 => {
            // DTYPE_UINT4: unsigned 4-bit, 2 elements per byte, high nibble = lower index.
            let mut packed = vec![0u8; (arr.len() + 1) / 2];
            for (i, v) in arr.iter().enumerate() {
                let n = v.as_u64().ok_or("uint4 element not u64")? as u8;
                let nibble = n & 0x0F;
                if i % 2 == 0 {
                    packed[i / 2] |= nibble << 4;
                } else {
                    packed[i / 2] |= nibble;
                }
            }
            out.extend_from_slice(&packed);
        }
        DTYPE_INT8 => {
            for v in arr {
                let n = v.as_i64().ok_or("int8 element not i64")? as i8;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_UINT8 => {
            for v in arr {
                let n = v.as_u64().ok_or("uint8 element not u64")? as u8;
                out.push(n);
            }
        }
        DTYPE_INT16 => {
            for v in arr {
                let n = v.as_i64().ok_or("int16 element not i64")? as i16;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_UINT16 => {
            for v in arr {
                let n = v.as_u64().ok_or("uint16 element not u64")? as u16;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_INT32 => {
            for v in arr {
                let n = v.as_i64().ok_or("int32 element not i64")? as i32;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_UINT32 => {
            for v in arr {
                let n = v.as_u64().ok_or("uint32 element not u64")? as u32;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_INT64 => {
            // Elements stored as decimal strings in test vectors.
            for v in arr {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => return Err("int64 element not string or number".into()),
                };
                let n: i64 = s.parse().map_err(|_| format!("bad int64: {s}"))?;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_UINT64 => {
            for v in arr {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => return Err("uint64 element not string or number".into()),
                };
                let n: u64 = s.parse().map_err(|_| format!("bad uint64: {s}"))?;
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        DTYPE_FP32 => {
            for v in arr {
                let f = v.as_f64().ok_or("fp32 element not f64")? as f32;
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        DTYPE_FP64 => {
            for v in arr {
                let f = v.as_f64().ok_or("fp64 element not f64")?;
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        DTYPE_FP16 => {
            // Accept either f32 numbers (convert via half crate) or
            // raw u64 bit patterns. Numbers are detected via as_f64()
            // returning Some with a non-integer or in float-like range.
            for v in arr {
                let bits = if let Some(f) = v.as_f64() {
                    f32_to_fp16_bits(f as f32)
                } else if let Some(n) = v.as_u64() {
                    n as u16
                } else {
                    return Err("fp16 element not f64 or u64".into())
                };
                out.extend_from_slice(&bits.to_le_bytes());
            }
        }
        DTYPE_BF16 => {
            for v in arr {
                let bits = if let Some(f) = v.as_f64() {
                    f32_to_bf16_bits(f as f32)
                } else if let Some(n) = v.as_u64() {
                    n as u16
                } else {
                    return Err("bf16 element not f64 or u64".into())
                };
                out.extend_from_slice(&bits.to_le_bytes());
            }
        }
        11 => {
            // fp8e4m3: data contains f32 values; convert to 1-byte fp8 bits.
            for v in arr {
                let f = v.as_f64().ok_or("fp8e4m3 element not f64")? as f32;
                out.push(f32_to_fp8e4m3(f));
            }
        }
        12 => {
            // fp8e5m2: data contains f32 values; convert to 1-byte fp8 bits.
            for v in arr {
                let f = v.as_f64().ok_or("fp8e5m2 element not f64")? as f32;
                out.push(f32_to_fp8e5m2(f));
            }
        }
        17 => {
            // cfloat32: interleaved (real, imag) f32 pairs per complex element.
            // data array length = 2 × element_count; each entry is an f32.
            for v in arr {
                let f = v.as_f64().ok_or("cfloat32 element not f64")? as f32;
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        18 => {
            // cfloat64: interleaved (real, imag) f64 pairs per complex element.
            for v in arr {
                let f = v.as_f64().ok_or("cfloat64 element not f64")?;
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        d => {
            // Unknown dtypes: try to read as raw integer bit patterns.
            let bpe = weavepack_tensor::types::dtype_bits_per_elem(d)
                .ok_or_else(|| format!("unknown dtype {d}"))?;
            let bytes_each = ((bpe + 7) / 8) as usize;
            for v in arr {
                let n = v.as_u64().ok_or("element not u64")?;
                for i in 0..bytes_each {
                    out.push(((n >> (i * 8)) & 0xff) as u8);
                }
            }
        }
    }
    Ok(out)
}

/// Parse a tensor map from a JSON object (`{ "name": { dtype, shape, data } … }`).
/// The returned Vec preserves the JSON key insertion order.
fn parse_tensor_map(obj: &Value) -> Result<Vec<(String, TensorData)>, String> {
    let map = obj.as_object().ok_or("tensors is not an object")?;
    let mut tensors = Vec::new();
    for (name, tv) in map {
        let dtype = tv["dtype"].as_u64().ok_or("dtype missing")? as u8;
        let shape: Vec<u64> = tv["shape"]
            .as_array()
            .ok_or("shape missing")?
            .iter()
            .map(|v| v.as_u64().ok_or("shape dim not u64"))
            .collect::<Result<_, _>>()?;
        // Two paths: `data` is JSON values (numbers); `data_raw_bits` is
        // raw integer bit patterns used for non-finite values (NaN, ±Inf)
        // that cannot be expressed as JSON numbers.
        // fp16/bf16: u16 per element (2 bytes); fp8: u8 per element (1 byte).
        let data = if let Some(bits_arr) = tv["data_raw_bits"].as_array() {
            let bytes_per = match dtype {
                11 | 12 => 1usize, // fp8e4m3 / fp8e5m2
                _       => 2usize, // fp16 / bf16 (default)
            };
            let mut out = Vec::with_capacity(bits_arr.len() * bytes_per);
            for v in bits_arr {
                let n = v.as_u64().ok_or("data_raw_bits element not u64")?;
                for i in 0..bytes_per {
                    out.push(((n >> (i * 8)) & 0xff) as u8);
                }
            }
            out
        } else {
            let data_arr = tv["data"].as_array().ok_or("data or data_raw_bits missing")?;
            json_data_to_bytes(dtype, data_arr)?
        };
        tensors.push((name.clone(), TensorData { dtype, shape, data }));
    }
    Ok(tensors)
}

/// Convert an ordered tensor slice to a BTreeMap for structural comparison.
fn to_btree(v: &[(String, TensorData)]) -> BTreeMap<String, TensorData> {
    v.iter().cloned().collect()
}

/// Parse a schema object `{ "name": { "dtype": N, "shape": […], "scale"?: F, "zero_point"?: Z } }`.
/// Returns a BTreeMap so keys are in alphabetical order (as required by the spec).
fn parse_schema(obj: &Value) -> Result<BTreeMap<String, SchemaEntry>, String> {
    let map = obj.as_object().ok_or("schema is not an object")?;
    let mut schema = BTreeMap::new();
    for (name, tv) in map {
        let dtype = tv["dtype"].as_u64().ok_or("schema dtype missing")? as u8;
        let shape: Vec<u64> = tv["shape"]
            .as_array()
            .ok_or("schema shape missing")?
            .iter()
            .map(|v| v.as_u64().ok_or("schema shape dim not u64"))
            .collect::<Result<_, _>>()?;
        let scale = tv.get("scale").and_then(|v| v.as_f64());
        let zero_point = tv.get("zero_point").and_then(|v| v.as_i64());
        schema.insert(name.clone(), SchemaEntry { dtype, shape, scale, zero_point });
    }
    Ok(schema)
}

/// Quantize f32 values (read from a TensorData with fp32-encoded data) to
/// qint wire bytes using schema scale and zero_point.  Returns raw wire bytes.
fn quantize_f32_to_qint(
    dtype: u8,
    data_f32: &[f32],
    scale: f64,
    zero_point: i64,
) -> Vec<u8> {
    let scale = scale as f32;
    let zp = zero_point as i32;
    match dtype {
        DTYPE_QINT8 => {
            data_f32.iter().map(|&f| {
                let q = (f / scale + zp as f32).round() as i32;
                q.clamp(-128, 127) as i8 as u8
            }).collect()
        }
        DTYPE_QINT4 => {
            let total = data_f32.len();
            let mut out = vec![0u8; (total + 1) / 2];
            for (i, &f) in data_f32.iter().enumerate() {
                let q = (f / scale + zp as f32).round() as i32;
                let nibble = (q.clamp(-8, 7) as i8 as u8) & 0x0F;
                if i % 2 == 0 { out[i / 2] |= nibble << 4; } else { out[i / 2] |= nibble; }
            }
            out
        }
        DTYPE_QFP8 => {
            data_f32.iter().map(|&f| f32_to_fp8e4m3(f / scale)).collect()
        }
        _ => unreachable!("quantize_f32_to_qint called with non-qint dtype"),
    }
}

/// Structural tensor equality (order-independent BTreeMap comparison).
fn tensors_equal(
    a: &BTreeMap<String, TensorData>,
    b: &BTreeMap<String, TensorData>,
) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (name, ta) in a {
        match b.get(name) {
            Some(tb) => {
                if ta.dtype != tb.dtype || ta.shape != tb.shape || ta.data != tb.data {
                    return false;
                }
            }
            None => return false,
        }
    }
    true
}

// ── test runner ───────────────────────────────────────────────────────────────

struct Runner {
    pass: usize,
    fail: usize,
    failures: Vec<String>,
}

impl Runner {
    fn new() -> Self {
        Self { pass: 0, fail: 0, failures: Vec::new() }
    }

    fn ok(&mut self) {
        self.pass += 1;
    }

    fn err(&mut self, label: &str, reason: &str) {
        self.fail += 1;
        self.failures.push(format!("  {label}\n    reason: {reason}"));
    }

    fn run_document_vector(&mut self, label: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{label} :: {name}");

        let doc = match parse_tensor_map(&v["input"]["tensors"]) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("parse error: {e}")),
        };
        let expected_hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "expected_bytes_hex missing"),
        };

        // Encode (preserving JSON key order) and compare bytes.
        let encoded = encode_document(&doc);
        let hex = to_hex(&encoded);
        if hex != expected_hex {
            return self.err(
                &full,
                &format!("encode mismatch\n    expected: {expected_hex}\n    actual:   {hex}"),
            );
        }

        // Decode and verify round-trip (structural equality, order-independent).
        match decode_document(&encoded) {
            Ok(decoded) => {
                if !tensors_equal(&to_btree(&decoded), &to_btree(&doc)) {
                    return self.err(&full, "decode round-trip mismatch");
                }
            }
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        }

        self.ok();
    }

    fn run_schema_vector(&mut self, label: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{label} :: {name}");

        // Parse schema first so we can use scale/zero_point for qint tensors.
        let schema = match parse_schema(&v["schema"]) {
            Ok(s) => s,
            Err(e) => return self.err(&full, &format!("parse schema error: {e}")),
        };
        let expected_hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "expected_bytes_hex missing"),
        };
        let expected_schema_hash = match v["schema_hash_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "schema_hash_hex missing"),
        };

        // Verify schema hash.
        let computed_hash = schema_hash_hex(&schema);
        if computed_hash != expected_schema_hash {
            return self.err(
                &full,
                &format!(
                    "schema hash mismatch\n    expected: {expected_schema_hash}\n    actual:   {computed_hash}"
                ),
            );
        }

        // Build doc_map: for qint tensors, pre-quantize f32 input → wire bytes
        // using schema scale/zero_point. For non-qint tensors, use parse_tensor_map.
        let input_tensors = match v["input"]["tensors"].as_object() {
            Some(o) => o,
            None => return self.err(&full, "input.tensors is not an object"),
        };
        let mut doc_map: BTreeMap<String, TensorData> = BTreeMap::new();
        for (tname, tv) in input_tensors {
            let entry = match schema.get(tname) {
                Some(e) => e,
                None => return self.err(&full, &format!("tensor {tname:?} not in schema")),
            };
            let shape: Vec<u64> = match tv["shape"].as_array() {
                Some(a) => match a.iter().map(|x| x.as_u64().ok_or("dim")).collect::<Result<_,_>>() {
                    Ok(s) => s,
                    Err(_) => return self.err(&full, "shape dim not u64"),
                },
                None => return self.err(&full, "tensor shape missing"),
            };
            let data_arr = match tv["data"].as_array() {
                Some(a) => a,
                None => return self.err(&full, "tensor data missing"),
            };
            let dtype = entry.dtype;
            // Qint dtypes: input is f32 values that need quantization.
            let wire_bytes = if (dtype == DTYPE_QINT8 || dtype == DTYPE_QINT4 || dtype == DTYPE_QFP8)
                && entry.scale.is_some()
            {
                let scale = entry.scale.unwrap();
                let zp = entry.zero_point.unwrap_or(0);
                let f32s: Vec<f32> = match data_arr.iter()
                    .map(|x| x.as_f64().ok_or("qint element not f64").map(|f| f as f32))
                    .collect::<Result<_, _>>() {
                    Ok(v) => v,
                    Err(e) => return self.err(&full, &format!("qint data parse: {e}")),
                };
                quantize_f32_to_qint(dtype, &f32s, scale, zp)
            } else {
                match json_data_to_bytes(dtype, data_arr) {
                    Ok(b) => b,
                    Err(e) => return self.err(&full, &format!("parse tensor error: {e}")),
                }
            };
            doc_map.insert(tname.clone(), TensorData { dtype, shape, data: wire_bytes });
        }

        // Encode schemaful (schema keys are sorted by BTreeMap) and compare.
        let encoded = match encode_document_schemaful(&doc_map, &schema) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("encode error: {e}")),
        };
        let hex = to_hex(&encoded);
        if hex != expected_hex {
            return self.err(
                &full,
                &format!("encode mismatch\n    expected: {expected_hex}\n    actual:   {hex}"),
            );
        }

        // Round-trip: decode schemaful and compare raw wire bytes.
        let mut registry = BTreeMap::new();
        registry.insert(computed_hash, schema.clone());
        match decode_document_schemaful(&encoded, &registry) {
            Ok(decoded) => {
                if !tensors_equal(&to_btree(&decoded), &doc_map) {
                    return self.err(&full, "schemaful round-trip mismatch");
                }
            }
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        }

        self.ok();
    }

    fn run_delta_vector(&mut self, label: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{label} :: {name}");

        // Raw-delta vectors: initial + delta_bytes_hex + expected_final.
        // Tests the decoder against a manually-crafted delta (e.g. mode=1
        // delta-from-prior) without going through the encoder.
        if v["delta_bytes_hex"].is_string() {
            let init_doc = match parse_tensor_map(&v["initial"]["tensors"]) {
                Ok(d) => d,
                Err(e) => return self.err(&full, &format!("parse initial error: {e}")),
            };
            let delta_hex = v["delta_bytes_hex"].as_str().unwrap();
            let delta_bytes = match from_hex(delta_hex) {
                Ok(b) => b,
                Err(e) => return self.err(&full, &format!("hex parse error: {e}")),
            };
            let result = match apply_delta(&init_doc, &delta_bytes) {
                Ok(r) => r,
                Err(e) => return self.err(&full, &format!("apply_delta error: {e}")),
            };
            let expected_final = match parse_tensor_map(&v["expected_final"]["tensors"]) {
                Ok(d) => d,
                Err(e) => return self.err(&full, &format!("parse expected_final error: {e}")),
            };
            if !tensors_equal(&to_btree(&result), &to_btree(&expected_final)) {
                return self.err(&full, "raw-delta decode mismatch");
            }
            self.ok();
            return;
        }

        let init_doc = match parse_tensor_map(&v["initial"]["tensors"]) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("parse initial error: {e}")),
        };
        let upd_doc = match parse_tensor_map(&v["update"]["tensors"]) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("parse update error: {e}")),
        };
        let expected_chain = match v["expected_chain_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "expected_chain_bytes_hex missing"),
        };

        let init_bytes = encode_document(&init_doc);
        let maybe_delta = encode_delta(&init_doc, &upd_doc);

        // Build the chain: initial payload + optional delta.
        let chain_bytes = match &maybe_delta {
            Some(delta_bytes) => chain_serialize(&[init_bytes.clone(), delta_bytes.clone()]),
            None => chain_serialize(&[init_bytes.clone()]),
        };
        let chain_hex = to_hex(&chain_bytes);

        if chain_hex != expected_chain {
            return self.err(
                &full,
                &format!(
                    "chain bytes mismatch\n    expected: {expected_chain}\n    actual:   {chain_hex}"
                ),
            );
        }

        // Verify final state.
        let expected_final = match parse_tensor_map(&v["expected_final"]["tensors"]) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("parse expected_final error: {e}")),
        };
        let final_doc = match &maybe_delta {
            Some(delta_bytes) => match apply_delta(&init_doc, delta_bytes) {
                Ok(d) => d,
                Err(e) => return self.err(&full, &format!("apply_delta error: {e}")),
            },
            None => init_doc.clone(),
        };
        if !tensors_equal(&to_btree(&final_doc), &to_btree(&expected_final)) {
            return self.err(&full, "final state mismatch");
        }

        // Round-trip: restore from chain.
        let segments = chain_parse(&chain_bytes);
        if segments.is_empty() {
            return self.err(&full, "chain parse returned no segments");
        }
        let restored_init = match decode_document(&segments[0]) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("chain round-trip decode error: {e}")),
        };
        let restored = if segments.len() > 1 {
            match apply_delta(&restored_init, &segments[1]) {
                Ok(d) => d,
                Err(e) => return self.err(&full, &format!("chain round-trip apply error: {e}")),
            }
        } else {
            restored_init
        };
        if !tensors_equal(&to_btree(&restored), &to_btree(&expected_final)) {
            return self.err(&full, "chain round-trip mismatch");
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
                .join("../../../weavepack/profiles/tensor/test-vectors")
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

        let is_schema = rel.starts_with("schemas/");
        let is_delta = rel.starts_with("deltas/");

        for v in &vectors {
            if is_schema {
                runner.run_schema_vector(&rel, v);
            } else if is_delta {
                runner.run_delta_vector(&rel, v);
            } else {
                runner.run_document_vector(&rel, v);
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
