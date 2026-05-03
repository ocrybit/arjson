// weavepack-tensor encoder (schemaless and schemaful).
// See weavepack/profiles/tensor/02-containers.md and 05-conformance.md.

use crate::bits::{BitWriter, finalize, write_leb128, write_short};
use crate::schema::schema_hash;
use crate::types::{data_bytes, DTYPE_BITS};
use crate::TensorData;
use std::collections::BTreeMap;

fn write_name(w: &mut BitWriter, name: &str) {
    let bytes = name.as_bytes();
    write_short(w, bytes.len() as u64);
    for &b in bytes {
        w.write_bits(b as u32, 8);
    }
}

fn write_data_block(w: &mut BitWriter, t: &TensorData) {
    let n = data_bytes(t.dtype, &t.shape) as usize;
    for i in 0..n {
        w.write_bits(t.data[i] as u32, 8);
    }
}

/// Encode a schemaless tensor document.
///
/// `tensors` is an ordered slice: the encoding preserves the given order
/// (insertion order from the wire or the caller's JSON input order).
///
/// Wire: [0][0][leb128-count][per tensor: name + dtype + shape + data]
/// Followed by the finalize trailer (5 bits) and byte padding.
pub fn encode_document(tensors: &[(String, TensorData)]) -> Vec<u8> {
    let mut w = BitWriter::new();

    w.write_bits(0, 1); // bit 0: document
    w.write_bits(0, 1); // bit 1: no schema

    write_leb128(&mut w, tensors.len() as u64);

    for (name, t) in tensors {
        write_name(&mut w, name);
        w.write_bits(t.dtype as u32, DTYPE_BITS);
        write_short(&mut w, t.shape.len() as u64);
        for &dim in &t.shape {
            write_leb128(&mut w, dim);
        }
        write_data_block(&mut w, t);
    }

    finalize(w)
}

/// Encode a schemaful tensor document.
///
/// Wire: [0][1][256-bit hash][per tensor in sorted name order: data only]
/// Followed by the finalize trailer (5 bits) and byte padding.
///
/// Panics if a tensor named in the schema is absent from `tensors`, or if
/// dtype/shape mismatch between schema and tensor data.
pub fn encode_document_schemaful(
    tensors: &BTreeMap<String, TensorData>,
    schema: &BTreeMap<String, (u8, Vec<u64>)>,
) -> Result<Vec<u8>, String> {
    let hash = schema_hash(schema);

    let mut w = BitWriter::new();

    w.write_bits(0, 1); // bit 0: document
    w.write_bits(1, 1); // bit 1: schema present

    // Emit 256-bit hash (32 bytes).
    for &b in &hash {
        w.write_bits(b as u32, 8);
    }

    // Tensors are written in sorted schema-key order (BTreeMap is already sorted).
    for (name, (s_dtype, s_shape)) in schema {
        let t = tensors.get(name).ok_or_else(|| {
            format!("schema requires tensor \"{name}\" but it is absent")
        })?;
        if t.dtype != *s_dtype {
            return Err(format!(
                "tensor \"{name}\": schema dtype {} != document dtype {}",
                s_dtype, t.dtype
            ));
        }
        if t.shape != *s_shape {
            return Err(format!(
                "tensor \"{name}\": schema shape {:?} != document shape {:?}",
                s_shape, t.shape
            ));
        }
        write_data_block(&mut w, t);
    }

    Ok(finalize(w))
}
