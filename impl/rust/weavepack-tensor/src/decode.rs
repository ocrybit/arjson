// weavepack-tensor decoder (schemaless and schemaful).

use crate::bits::BitReader;
use crate::types::{data_bytes, DTYPE_BITS};
use crate::TensorData;
use std::collections::BTreeMap;

/// Decode a schemaless tensor document.
/// Returns tensors in wire order (the order they were encoded).
pub fn decode_document(bytes: &[u8]) -> Result<Vec<(String, TensorData)>, String> {
    let mut r = BitReader::new(bytes);

    let kind = r.read_bits(1);
    if kind != 0 {
        return Err("expected document (bit 0 = 0), got delta".into());
    }
    let has_schema = r.read_bits(1);
    if has_schema != 0 {
        return Err(
            "payload is schemaful; use decode_document_schemaful() with a schema registry".into(),
        );
    }

    let tensor_count = r.read_leb128() as usize;
    let mut tensors = Vec::with_capacity(tensor_count);

    for _ in 0..tensor_count {
        let name_len = r.read_short() as usize;
        let mut name_bytes = vec![0u8; name_len];
        for b in &mut name_bytes {
            *b = r.read_byte();
        }
        let name = String::from_utf8(name_bytes)
            .map_err(|e| format!("tensor name UTF-8 error: {e}"))?;

        let dtype = r.read_bits(DTYPE_BITS) as u8;
        let rank = r.read_short() as usize;
        let mut shape = Vec::with_capacity(rank);
        for _ in 0..rank {
            shape.push(r.read_leb128());
        }

        let byte_count = data_bytes(dtype, &shape) as usize;
        let mut data = vec![0u8; byte_count];
        for b in &mut data {
            *b = r.read_byte();
        }

        tensors.push((name, TensorData { dtype, shape, data }));
    }

    Ok(tensors)
}

/// Decode a schemaful tensor document.
/// Returns tensors in schema (alphabetical) order.
pub fn decode_document_schemaful(
    bytes: &[u8],
    registry: &BTreeMap<String, BTreeMap<String, (u8, Vec<u64>)>>,
) -> Result<Vec<(String, TensorData)>, String> {
    let mut r = BitReader::new(bytes);

    let kind = r.read_bits(1);
    if kind != 0 {
        return Err("expected document (bit 0 = 0), got delta".into());
    }
    let has_schema = r.read_bits(1);
    if has_schema != 1 {
        return Err("payload is schemaless; use decode_document() instead".into());
    }

    let mut hash_bytes = [0u8; 32];
    for b in &mut hash_bytes {
        *b = r.read_byte();
    }
    let hex: String = hash_bytes.iter().map(|b| format!("{b:02x}")).collect();

    let schema = registry
        .get(&hex)
        .ok_or_else(|| format!("unknown schema-id {hex}; register the schema before decoding"))?;

    let mut tensors = Vec::with_capacity(schema.len());
    for (name, (dtype, shape)) in schema {
        let byte_count = data_bytes(*dtype, shape) as usize;
        let mut data = vec![0u8; byte_count];
        for b in &mut data {
            *b = r.read_byte();
        }
        tensors.push((
            name.clone(),
            TensorData { dtype: *dtype, shape: shape.clone(), data },
        ));
    }

    Ok(tensors)
}
