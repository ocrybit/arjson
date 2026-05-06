// weavepack-tensor decoder (schemaless and schemaful).

use crate::bits::BitReader;
use crate::types::{data_bytes, SchemaEntry, DTYPE_BITS};
use crate::TensorData;
use std::collections::BTreeMap;

// ── shared header parser ──────────────────────────────────────────────────

fn parse_schemaful_header<'a>(
    r: &mut BitReader,
    registry: &'a BTreeMap<String, BTreeMap<String, SchemaEntry>>,
) -> Result<&'a BTreeMap<String, SchemaEntry>, String> {
    if r.read(1)? != 0 {
        return Err("expected document (bit 0 = 0), got delta".into());
    }
    if r.read(1)? != 1 {
        return Err("payload is schemaless; use decode_document() instead".into());
    }

    let mut hash_bytes = [0u8; 32];
    for b in &mut hash_bytes {
        *b = r.read(8)? as u8;
    }
    let hex: String = hash_bytes.iter().map(|b| format!("{b:02x}")).collect();

    registry
        .get(&hex)
        .ok_or_else(|| format!("unknown schema-id {hex}; register the schema before decoding"))
}

/// Decode a schemaless tensor document.
/// Returns tensors in wire order (the order they were encoded).
pub fn decode_document(bytes: &[u8]) -> Result<Vec<(String, TensorData)>, String> {
    let mut r = BitReader::new(bytes);

    if r.read(1)? != 0 {
        return Err("expected document (bit 0 = 0), got delta".into());
    }
    if r.read(1)? != 0 {
        return Err(
            "payload is schemaful; use decode_document_schemaful() with a schema registry".into(),
        );
    }

    let tensor_count = r.leb128()? as usize;
    let mut tensors = Vec::with_capacity(tensor_count);

    for _ in 0..tensor_count {
        let name_len = r.short()? as usize;
        let mut name_bytes = vec![0u8; name_len];
        for b in &mut name_bytes {
            *b = r.read(8)? as u8;
        }
        let name = String::from_utf8(name_bytes)
            .map_err(|e| format!("tensor name UTF-8 error: {e}"))?;

        let dtype = r.read(DTYPE_BITS as usize)? as u8;
        let rank = r.short()? as usize;
        let mut shape = Vec::with_capacity(rank);
        for _ in 0..rank {
            shape.push(r.leb128()?);
        }

        let byte_count = data_bytes(dtype, &shape) as usize;
        let mut data = vec![0u8; byte_count];
        for b in &mut data {
            *b = r.read(8)? as u8;
        }

        tensors.push((name, TensorData { dtype, shape, data }));
    }

    Ok(tensors)
}

/// Decode a schemaful tensor document.
/// Returns tensors in schema (alphabetical) order.
pub fn decode_document_schemaful(
    bytes: &[u8],
    registry: &BTreeMap<String, BTreeMap<String, SchemaEntry>>,
) -> Result<Vec<(String, TensorData)>, String> {
    let mut r = BitReader::new(bytes);
    let schema = parse_schemaful_header(&mut r, registry)?;

    let mut tensors = Vec::with_capacity(schema.len());
    for (name, entry) in schema {
        let byte_count = data_bytes(entry.dtype, &entry.shape) as usize;
        let mut data = vec![0u8; byte_count];
        for b in &mut data {
            *b = r.read(8)? as u8;
        }
        tensors.push((
            name.clone(),
            TensorData { dtype: entry.dtype, shape: entry.shape.clone(), data },
        ));
    }

    Ok(tensors)
}

/// A.4 — Returns tensor names in canonical (alphabetical) order.
/// Reads only the header; no tensor data is decoded.
pub fn list_tensors_schemaful(
    bytes: &[u8],
    registry: &BTreeMap<String, BTreeMap<String, SchemaEntry>>,
) -> Result<Vec<String>, String> {
    let mut r = BitReader::new(bytes);
    let schema = parse_schemaful_header(&mut r, registry)?;
    Ok(schema.keys().cloned().collect())
}

/// A.4 — Decodes exactly one named tensor from a schemaful document.
/// Skips preceding tensors using data_bytes arithmetic (no preceding data parsed).
pub fn decode_tensor_schemaful(
    bytes: &[u8],
    name: &str,
    registry: &BTreeMap<String, BTreeMap<String, SchemaEntry>>,
) -> Result<TensorData, String> {
    let mut r = BitReader::new(bytes);
    let schema = parse_schemaful_header(&mut r, registry)?;

    for (k, entry) in schema {
        if k == name {
            let byte_count = data_bytes(entry.dtype, &entry.shape) as usize;
            let mut data = vec![0u8; byte_count];
            for b in &mut data {
                *b = r.read(8)? as u8;
            }
            return Ok(TensorData { dtype: entry.dtype, shape: entry.shape.clone(), data });
        }
        // Skip this tensor's data block.
        let byte_count = data_bytes(entry.dtype, &entry.shape) as usize;
        for _ in 0..byte_count {
            r.read(8)?;
        }
    }

    let available: Vec<&str> = schema.keys().map(String::as_str).collect();
    Err(format!("tensor \"{name}\" not found in schema; available: {}", available.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::encode_document_schemaful;
    use crate::schema::schema_hash_hex;
    use crate::types::{SchemaEntry, DTYPE_FP32, DTYPE_INT8};
    use crate::TensorData;

    fn registry(schema: BTreeMap<String, SchemaEntry>) -> BTreeMap<String, BTreeMap<String, SchemaEntry>> {
        let hex = schema_hash_hex(&schema);
        let mut reg = BTreeMap::new();
        reg.insert(hex, schema);
        reg
    }

    fn fp32_entry(shape: Vec<u64>) -> SchemaEntry {
        SchemaEntry { dtype: DTYPE_FP32, shape, scale: None, zero_point: None }
    }

    fn fp32_data(vals: &[f32]) -> Vec<u8> {
        vals.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    // Three-tensor schema used across several tests (alpha, beta, gamma).
    fn make_three() -> (BTreeMap<String, BTreeMap<String, SchemaEntry>>, Vec<u8>) {
        let mut schema = BTreeMap::new();
        schema.insert("alpha".into(), fp32_entry(vec![4]));
        schema.insert("beta".into(),  fp32_entry(vec![2, 3]));
        schema.insert("gamma".into(), fp32_entry(vec![1]));

        let mut tensors = BTreeMap::new();
        tensors.insert("alpha".into(), TensorData { dtype: DTYPE_FP32, shape: vec![4], data: fp32_data(&[1.0, 2.0, 3.0, 4.0]) });
        tensors.insert("beta".into(),  TensorData { dtype: DTYPE_FP32, shape: vec![2, 3], data: fp32_data(&[10.0, 20.0, 30.0, 40.0, 50.0, 60.0]) });
        tensors.insert("gamma".into(), TensorData { dtype: DTYPE_FP32, shape: vec![1], data: fp32_data(&[999.0]) });

        let bytes = encode_document_schemaful(&tensors, &schema).unwrap();
        let reg = registry(schema);
        (reg, bytes)
    }

    #[test]
    fn list_returns_sorted_names() {
        let (reg, bytes) = make_three();
        let names = list_tensors_schemaful(&bytes, &reg).unwrap();
        assert_eq!(names, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn skip_load_first_tensor() {
        let (reg, bytes) = make_three();
        let full = decode_document_schemaful(&bytes, &reg).unwrap();
        let single = decode_tensor_schemaful(&bytes, "alpha", &reg).unwrap();
        assert_eq!(single.dtype, DTYPE_FP32);
        assert_eq!(single.shape, vec![4]);
        assert_eq!(single.data, full.iter().find(|(n, _)| n == "alpha").unwrap().1.data);
    }

    #[test]
    fn skip_load_middle_tensor() {
        let (reg, bytes) = make_three();
        let full = decode_document_schemaful(&bytes, &reg).unwrap();
        let single = decode_tensor_schemaful(&bytes, "beta", &reg).unwrap();
        assert_eq!(single.shape, vec![2, 3]);
        assert_eq!(single.data, full.iter().find(|(n, _)| n == "beta").unwrap().1.data);
    }

    #[test]
    fn skip_load_last_tensor() {
        let (reg, bytes) = make_three();
        let full = decode_document_schemaful(&bytes, &reg).unwrap();
        let single = decode_tensor_schemaful(&bytes, "gamma", &reg).unwrap();
        assert_eq!(single.shape, vec![1]);
        assert_eq!(single.data, full.iter().find(|(n, _)| n == "gamma").unwrap().1.data);
    }

    #[test]
    fn skip_load_unknown_name_errors() {
        let (reg, bytes) = make_three();
        let err = decode_tensor_schemaful(&bytes, "delta", &reg).unwrap_err();
        assert!(err.contains("not found in schema"), "unexpected error: {err}");
    }

    #[test]
    fn skip_load_single_tensor_doc() {
        let mut schema = BTreeMap::new();
        schema.insert("w".into(), fp32_entry(vec![3]));
        let mut tensors = BTreeMap::new();
        tensors.insert("w".into(), TensorData { dtype: DTYPE_FP32, shape: vec![3], data: fp32_data(&[0.1, 0.2, 0.3]) });
        let bytes = encode_document_schemaful(&tensors, &schema).unwrap();
        let reg = registry(schema);

        let names = list_tensors_schemaful(&bytes, &reg).unwrap();
        assert_eq!(names, vec!["w"]);
        let t = decode_tensor_schemaful(&bytes, "w", &reg).unwrap();
        assert_eq!(t.shape, vec![3]);
        assert_eq!(t.data.len(), 12);
    }

    #[test]
    fn skip_load_mixed_dtypes() {
        let mut schema = BTreeMap::new();
        schema.insert("a".into(), fp32_entry(vec![2]));
        schema.insert("b".into(), SchemaEntry { dtype: DTYPE_INT8, shape: vec![4], scale: None, zero_point: None });
        let mut tensors = BTreeMap::new();
        tensors.insert("a".into(), TensorData { dtype: DTYPE_FP32, shape: vec![2], data: fp32_data(&[1.0, -1.0]) });
        tensors.insert("b".into(), TensorData { dtype: DTYPE_INT8, shape: vec![4], data: vec![10u8, 20, 30, 40] });
        let bytes = encode_document_schemaful(&tensors, &schema).unwrap();
        let reg = registry(schema);

        let tb = decode_tensor_schemaful(&bytes, "b", &reg).unwrap();
        assert_eq!(tb.dtype, DTYPE_INT8);
        assert_eq!(tb.data, vec![10u8, 20, 30, 40]);
    }
}
