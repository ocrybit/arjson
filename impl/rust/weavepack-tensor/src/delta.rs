// weavepack-tensor delta encoder and applicator.
// See weavepack/profiles/tensor/04-deltas.md.
//
// Wire: [1][leb128-op-count][ops...]
// Followed by the finalize trailer (5 bits) and byte padding.

use crate::bits::{finalize, write_leb128, write_short, BitReader, BitWriter};
use crate::types::{
    data_bytes, dtype_bits_per_elem, DTYPE_BITS, OP_BITS, OP_ELEMENT_SET, OP_TENSOR_ADD,
    OP_TENSOR_REMOVE, OP_TENSOR_REPLACE,
};
use crate::TensorData;
use std::collections::BTreeMap;

/// Convert an ordered tensor slice to a BTreeMap for O(log n) lookup.
fn to_map(tensors: &[(String, TensorData)]) -> BTreeMap<&str, &TensorData> {
    tensors.iter().map(|(k, v)| (k.as_str(), v)).collect()
}

const DENSITY_THRESHOLD: f64 = 0.3;

// ── op emission helpers ───────────────────────────────────────────────────────

fn write_name(w: &mut BitWriter, name: &str) {
    let bytes = name.as_bytes();
    write_short(w, bytes.len() as u64);
    for &b in bytes {
        w.write_bits(b as u32, 8);
    }
}

fn write_tensor_body(w: &mut BitWriter, t: &TensorData) {
    w.write_bits(t.dtype as u32, DTYPE_BITS);
    write_short(w, t.shape.len() as u64);
    for &dim in &t.shape {
        write_leb128(w, dim);
    }
    let n = data_bytes(t.dtype, &t.shape) as usize;
    for i in 0..n {
        w.write_bits(t.data[i] as u32, 8);
    }
}

// ── element-level helpers ─────────────────────────────────────────────────────

fn bytes_per_elem(dtype: u8) -> usize {
    let bits = dtype_bits_per_elem(dtype).unwrap_or(0);
    ((bits + 7) / 8) as usize
}

fn flat_to_indices(mut flat: usize, shape: &[u64]) -> Vec<u64> {
    let mut idx = vec![0u64; shape.len()];
    for i in (0..shape.len()).rev() {
        idx[i] = (flat % shape[i] as usize) as u64;
        flat /= shape[i] as usize;
    }
    idx
}

fn changed_elements(base: &TensorData, new: &TensorData) -> Option<Vec<(usize, Vec<u64>)>> {
    // Only supported for byte-aligned dtypes (not bool/int4/uint4).
    let bpe = bytes_per_elem(base.dtype);
    if bpe == 0 {
        return None;
    }
    let total: usize = base.shape.iter().product::<u64>() as usize;
    let mut changed = Vec::new();
    for i in 0..total {
        let start = i * bpe;
        let end = start + bpe;
        if base.data.get(start..end) != new.data.get(start..end) {
            changed.push((i, flat_to_indices(i, &base.shape)));
        }
    }
    Some(changed)
}

// ── delta computation ─────────────────────────────────────────────────────────

enum DeltaOp<'a> {
    TensorRemove { name: &'a str },
    TensorAdd { name: &'a str, t: &'a TensorData },
    TensorReplace { name: &'a str, t: &'a TensorData },
    ElementSet { name: &'a str, t: &'a TensorData, elements: Vec<(Vec<u64>, &'a [u8])> },
}

fn compute_ops<'a>(
    base_slice: &'a [(String, TensorData)],
    new_slice: &'a [(String, TensorData)],
) -> Vec<DeltaOp<'a>> {
    let base = to_map(base_slice);
    let new = to_map(new_slice);
    let mut ops = Vec::new();

    for (name, _) in base_slice {
        if !new.contains_key(name.as_str()) {
            ops.push(DeltaOp::TensorRemove { name });
        }
    }

    for (name, new_t) in new_slice {
        if !base.contains_key(name.as_str()) {
            ops.push(DeltaOp::TensorAdd { name, t: new_t });
            continue;
        }
        let base_t = base[name.as_str()];
        if base_t.dtype != new_t.dtype || base_t.shape != new_t.shape {
            ops.push(DeltaOp::TensorRemove { name });
            ops.push(DeltaOp::TensorAdd { name, t: new_t });
            continue;
        }

        let expected = data_bytes(base_t.dtype, &base_t.shape) as usize;
        if base_t.data[..expected] == new_t.data[..expected] {
            continue; // unchanged
        }

        let total: usize = base_t.shape.iter().product::<u64>() as usize;
        let bpe = bytes_per_elem(base_t.dtype);

        if let Some(changed) = changed_elements(base_t, new_t) {
            if bpe > 0 && (changed.len() as f64) / (total as f64) < DENSITY_THRESHOLD {
                let elements: Vec<(Vec<u64>, &'a [u8])> = changed
                    .into_iter()
                    .map(|(flat, indices)| {
                        let start = flat * bpe;
                        let val = &new_t.data[start..start + bpe];
                        (indices, val)
                    })
                    .collect();
                ops.push(DeltaOp::ElementSet { name, t: new_t, elements });
                continue;
            }
        }

        ops.push(DeltaOp::TensorReplace { name, t: new_t });
    }

    ops
}

/// Encode a delta between two ordered tensor slices.
/// Returns `None` if the documents are identical.
pub fn encode_delta(
    base: &[(String, TensorData)],
    new: &[(String, TensorData)],
) -> Option<Vec<u8>> {
    let ops = compute_ops(base, new);
    if ops.is_empty() {
        return None;
    }

    let mut w = BitWriter::new();
    w.write_bits(1, 1); // bit 0: delta

    write_leb128(&mut w, ops.len() as u64);

    for op in &ops {
        match op {
            DeltaOp::TensorRemove { name } => {
                w.write_bits(OP_TENSOR_REMOVE as u32, OP_BITS);
                write_name(&mut w, name);
            }
            DeltaOp::TensorAdd { name, t } => {
                w.write_bits(OP_TENSOR_ADD as u32, OP_BITS);
                write_name(&mut w, name);
                write_tensor_body(&mut w, t);
            }
            DeltaOp::TensorReplace { name, t } => {
                w.write_bits(OP_TENSOR_REPLACE as u32, OP_BITS);
                write_name(&mut w, name);
                write_tensor_body(&mut w, t);
            }
            DeltaOp::ElementSet { name, t, elements } => {
                w.write_bits(OP_ELEMENT_SET as u32, OP_BITS);
                write_name(&mut w, name);
                w.write_bits(t.dtype as u32, DTYPE_BITS);
                write_short(&mut w, t.shape.len() as u64);
                for &dim in &t.shape {
                    write_leb128(&mut w, dim);
                }
                write_leb128(&mut w, elements.len() as u64);
                let bpe = bytes_per_elem(t.dtype);
                for (indices, val) in elements {
                    for &idx in indices {
                        write_leb128(&mut w, idx);
                    }
                    for b in &val[..bpe] {
                        w.write_bits(*b as u32, 8);
                    }
                }
            }
        }
    }

    Some(finalize(w))
}

/// Apply a delta payload to an ordered base tensor slice, producing a new ordered slice.
///
/// Additions are appended at the end; removals delete in place; replacements
/// and element_set preserve the original tensor's position.
pub fn apply_delta(
    base: &[(String, TensorData)],
    delta: &[u8],
) -> Result<Vec<(String, TensorData)>, String> {
    let mut r = BitReader::new(delta);

    let kind = r.read_bits(1);
    if kind != 1 {
        return Err("expected delta (bit 0 = 1), got document (bit 0 = 0)".into());
    }

    let op_count = r.read_leb128() as usize;
    // Use a Vec of Option to allow in-place removal while preserving order.
    let mut tensors: Vec<Option<(String, TensorData)>> =
        base.iter().cloned().map(Some).collect();

    // Index from name to position in `tensors`.
    let mut name_to_idx: BTreeMap<String, usize> =
        tensors.iter().enumerate().filter_map(|(i, t)| {
            t.as_ref().map(|(n, _)| (n.clone(), i))
        }).collect();

    for _ in 0..op_count {
        let op_code = r.read_bits(OP_BITS) as u8;

        if op_code == OP_TENSOR_REMOVE {
            let name = read_name(&mut r)?;
            if let Some(idx) = name_to_idx.remove(&name) {
                tensors[idx] = None;
            }
        } else if op_code == OP_TENSOR_ADD || op_code == OP_TENSOR_REPLACE {
            let name = read_name(&mut r)?;
            let t = read_tensor_body(&mut r)?;
            if let Some(&idx) = name_to_idx.get(&name) {
                tensors[idx] = Some((name, t));
            } else {
                let idx = tensors.len();
                name_to_idx.insert(name.clone(), idx);
                tensors.push(Some((name, t)));
            }
        } else if op_code == OP_ELEMENT_SET {
            let name = read_name(&mut r)?;
            let dtype = r.read_bits(DTYPE_BITS) as u8;
            let rank = r.read_short() as usize;
            let mut shape = Vec::with_capacity(rank);
            for _ in 0..rank {
                shape.push(r.read_leb128());
            }
            let elem_count = r.read_leb128() as usize;

            let idx = *name_to_idx
                .get(&name)
                .ok_or_else(|| format!("element_set on unknown tensor \"{name}\""))?;
            let base_t = tensors[idx]
                .as_ref()
                .ok_or_else(|| format!("element_set on removed tensor \"{name}\""))?;
            let mut new_data = base_t.1.data.clone();
            let bpe = bytes_per_elem(dtype);

            for _ in 0..elem_count {
                let mut flat = 0usize;
                for &dim in &shape {
                    let idx2 = r.read_leb128() as usize;
                    flat = flat * dim as usize + idx2;
                }
                let start = flat * bpe;
                for b in &mut new_data[start..start + bpe] {
                    *b = r.read_byte();
                }
            }
            tensors[idx] = Some((name, TensorData { dtype, shape, data: new_data }));
        } else {
            return Err(format!("unsupported op code {op_code} (region/quant ops not in v0.1)"));
        }
    }

    Ok(tensors.into_iter().flatten().collect())
}

fn read_name(r: &mut BitReader) -> Result<String, String> {
    let len = r.read_short() as usize;
    let mut bytes = vec![0u8; len];
    for b in &mut bytes {
        *b = r.read_byte();
    }
    String::from_utf8(bytes).map_err(|e| format!("name UTF-8 error: {e}"))
}

fn read_tensor_body(r: &mut BitReader) -> Result<TensorData, String> {
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
    Ok(TensorData { dtype, shape, data })
}
