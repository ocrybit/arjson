// weavepack-tensor delta encoder and applicator.
// See weavepack/profiles/tensor/04-deltas.md.
//
// Wire: [1][leb128-op-count][ops...]
// Followed by the finalize trailer (5 bits) and byte padding.

use crate::bits::{finalize, write_leb128, write_short, BitReader, BitWriter};
use crate::types::{
    data_bytes, dtype_bits_per_elem, DTYPE_BITS, OP_BITS, OP_ELEMENT_SET, OP_REGION_REPLACE,
    OP_TENSOR_ADD, OP_TENSOR_REMOVE, OP_TENSOR_REPLACE,
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

fn write_tensor_body_header(w: &mut BitWriter, t: &TensorData) {
    w.write_bits(t.dtype as u32, DTYPE_BITS);
    write_short(w, t.shape.len() as u64);
    for &dim in &t.shape {
        write_leb128(w, dim);
    }
}

fn write_tensor_body_data(w: &mut BitWriter, t: &TensorData) {
    let n = data_bytes(t.dtype, &t.shape) as usize;
    for i in 0..n {
        w.write_bits(t.data[i] as u32, 8);
    }
}

fn write_tensor_body(w: &mut BitWriter, t: &TensorData) {
    write_tensor_body_header(w, t);
    write_tensor_body_data(w, t);
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
    RegionReplace { name: &'a str, t: &'a TensorData, bbox: Vec<(u64, u64)>, region: Vec<u8> },
}

const REGION_DENSITY_THRESHOLD: f64 = 0.5;

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
                // Compute bounding box. If most of the bbox is touched,
                // region_replace beats element_set.
                let rank = base_t.shape.len();
                let mut mins = vec![u64::MAX; rank];
                let mut maxs = vec![0u64; rank];
                for (_, indices) in &changed {
                    for r in 0..rank {
                        if indices[r] < mins[r] { mins[r] = indices[r]; }
                        if indices[r] >= maxs[r] { maxs[r] = indices[r] + 1; }
                    }
                }
                let bbox: Vec<(u64, u64)> = (0..rank).map(|r| (mins[r], maxs[r])).collect();
                let bbox_size: u64 = bbox.iter().map(|(s, e)| e - s).product();
                if bbox_size > 0 && bbox_size < total as u64
                    && (changed.len() as f64) / (bbox_size as f64) > REGION_DENSITY_THRESHOLD
                {
                    // Extract region in row-major order.
                    let strides: Vec<usize> = {
                        let mut s = vec![1usize; rank];
                        for i in (0..rank.saturating_sub(1)).rev() {
                            s[i] = s[i + 1] * base_t.shape[i + 1] as usize;
                        }
                        s
                    };
                    let mut region = Vec::with_capacity(bbox_size as usize * bpe);
                    let mut idx_v = vec![0u64; rank];
                    fn walk(
                        dim: usize, rank: usize, bbox: &[(u64, u64)],
                        idx_v: &mut [u64], strides: &[usize],
                        src: &[u8], region: &mut Vec<u8>, bpe: usize,
                    ) {
                        if dim == rank {
                            let mut flat = 0usize;
                            for d in 0..rank { flat += idx_v[d] as usize * strides[d]; }
                            region.extend_from_slice(&src[flat * bpe..(flat + 1) * bpe]);
                            return;
                        }
                        let (s, e) = bbox[dim];
                        for i in s..e {
                            idx_v[dim] = i;
                            walk(dim + 1, rank, bbox, idx_v, strides, src, region, bpe);
                        }
                    }
                    walk(0, rank, &bbox, &mut idx_v, &strides, &new_t.data, &mut region, bpe);
                    ops.push(DeltaOp::RegionReplace { name, t: new_t, bbox, region });
                    continue;
                }

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
                write_tensor_body_header(&mut w, t);
                // mode bit: 0 = absolute values. The Rust encoder always
                // emits 0; the JS reference ships a mode=1 heuristic
                // (max abs delta ≤ 0.01 → emit delta-from-prior).
                // Porting that heuristic to Rust is V0.2 A.3 follow-up.
                // The Rust decoder DOES handle mode=1 chains from JS.
                w.write_bits(0, 1);
                write_tensor_body_data(&mut w, t);
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
            DeltaOp::RegionReplace { name, t, bbox, region } => {
                w.write_bits(OP_REGION_REPLACE as u32, OP_BITS);
                write_name(&mut w, name);
                w.write_bits(t.dtype as u32, DTYPE_BITS);
                write_short(&mut w, t.shape.len() as u64);
                for &dim in &t.shape {
                    write_leb128(&mut w, dim);
                }
                write_short(&mut w, bbox.len() as u64);
                for &(s, e) in bbox {
                    write_leb128(&mut w, s);
                    write_leb128(&mut w, e);
                }
                for b in region {
                    w.write_bits(*b as u32, 8);
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

    if r.read(1)? != 1 {
        return Err("expected delta (bit 0 = 1), got document (bit 0 = 0)".into());
    }

    let op_count = r.leb128()? as usize;
    // Use a Vec of Option to allow in-place removal while preserving order.
    let mut tensors: Vec<Option<(String, TensorData)>> =
        base.iter().cloned().map(Some).collect();

    // Index from name to position in `tensors`.
    let mut name_to_idx: BTreeMap<String, usize> =
        tensors.iter().enumerate().filter_map(|(i, t)| {
            t.as_ref().map(|(n, _)| (n.clone(), i))
        }).collect();

    for _ in 0..op_count {
        let op_code = r.read(OP_BITS as usize)? as u8;

        if op_code == OP_TENSOR_REMOVE {
            let name = read_name(&mut r)?;
            if let Some(idx) = name_to_idx.remove(&name) {
                tensors[idx] = None;
            }
        } else if op_code == OP_TENSOR_ADD || op_code == OP_TENSOR_REPLACE {
            let name = read_name(&mut r)?;
            let t = if op_code == OP_TENSOR_REPLACE {
                read_tensor_body_with_mode(&mut r, &name, &name_to_idx, &tensors)?
            } else {
                read_tensor_body(&mut r)?
            };
            if let Some(&idx) = name_to_idx.get(&name) {
                tensors[idx] = Some((name, t));
            } else {
                let idx = tensors.len();
                name_to_idx.insert(name.clone(), idx);
                tensors.push(Some((name, t)));
            }
        } else if op_code == OP_ELEMENT_SET {
            let name = read_name(&mut r)?;
            let dtype = r.read(DTYPE_BITS as usize)? as u8;
            let rank = r.short()? as usize;
            let mut shape = Vec::with_capacity(rank);
            for _ in 0..rank {
                shape.push(r.leb128()?);
            }
            let elem_count = r.leb128()? as usize;

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
                    let idx2 = r.leb128()? as usize;
                    flat = flat * dim as usize + idx2;
                }
                let start = flat * bpe;
                for b in &mut new_data[start..start + bpe] {
                    *b = r.read(8)? as u8;
                }
            }
            tensors[idx] = Some((name, TensorData { dtype, shape, data: new_data }));
        } else if op_code == OP_REGION_REPLACE {
            // Wire format: name + dtype + full shape + bbox-rank + per-dim
            // ranges (start, end) + region data block in row-major order.
            let name = read_name(&mut r)?;
            let dtype = r.read(DTYPE_BITS as usize)? as u8;
            let rank = r.short()? as usize;
            let mut shape = Vec::with_capacity(rank);
            for _ in 0..rank {
                shape.push(r.leb128()?);
            }
            let bbox_rank = r.short()? as usize;
            let mut bbox: Vec<(u64, u64)> = Vec::with_capacity(bbox_rank);
            let mut region_elements: u64 = 1;
            for _ in 0..bbox_rank {
                let s = r.leb128()?;
                let e = r.leb128()?;
                region_elements *= e - s;
                bbox.push((s, e));
            }
            let bpe = bytes_per_elem(dtype);
            let region_bytes = region_elements as usize * bpe;
            let mut region_data = vec![0u8; region_bytes];
            for b in &mut region_data {
                *b = r.read(8)? as u8;
            }

            let idx = *name_to_idx
                .get(&name)
                .ok_or_else(|| format!("region_replace on unknown tensor \"{name}\""))?;
            let base_t = tensors[idx]
                .as_ref()
                .ok_or_else(|| format!("region_replace on removed tensor \"{name}\""))?;
            let mut new_data = base_t.1.data.clone();

            // Iterate the bbox in row-major order, copy region into new_data.
            let strides: Vec<usize> = {
                let mut s = vec![1usize; rank];
                for i in (0..rank.saturating_sub(1)).rev() {
                    s[i] = s[i + 1] * shape[i + 1] as usize;
                }
                s
            };
            let mut idx_v = vec![0u64; bbox_rank];
            let mut region_ptr = 0usize;
            // Recursive descent inlined as a stack-based loop (Rust closures
            // can't easily recurse without boxing).
            fn walk(
                dim: usize,
                bbox_rank: usize,
                bbox: &[(u64, u64)],
                idx_v: &mut [u64],
                strides: &[usize],
                region_data: &[u8],
                region_ptr: &mut usize,
                new_data: &mut [u8],
                bpe: usize,
            ) {
                if dim == bbox_rank {
                    let mut flat = 0usize;
                    for d in 0..bbox_rank {
                        flat += idx_v[d] as usize * strides[d];
                    }
                    let dst = flat * bpe;
                    new_data[dst..dst + bpe]
                        .copy_from_slice(&region_data[*region_ptr..*region_ptr + bpe]);
                    *region_ptr += bpe;
                    return;
                }
                let (s, e) = bbox[dim];
                for i in s..e {
                    idx_v[dim] = i;
                    walk(
                        dim + 1, bbox_rank, bbox, idx_v, strides,
                        region_data, region_ptr, new_data, bpe,
                    );
                }
            }
            walk(
                0, bbox_rank, &bbox, &mut idx_v, &strides,
                &region_data, &mut region_ptr, &mut new_data, bpe,
            );
            tensors[idx] = Some((name, TensorData { dtype, shape, data: new_data }));
        } else {
            return Err(format!("unsupported op code {op_code} (quant_change not in v0.1)"));
        }
    }

    Ok(tensors.into_iter().flatten().collect())
}

fn read_name(r: &mut BitReader) -> Result<String, String> {
    let len = r.short()? as usize;
    let mut bytes = vec![0u8; len];
    for b in &mut bytes {
        *b = r.read(8)? as u8;
    }
    String::from_utf8(bytes).map_err(|e| format!("name UTF-8 error: {e}"))
}

fn read_tensor_body(r: &mut BitReader) -> Result<TensorData, String> {
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
    Ok(TensorData { dtype, shape, data })
}

// tensor_replace carries an extra 1-bit mode field between shape and
// data: 0 = absolute values, 1 = per-element arithmetic delta against
// the prior tensor at the same name. See spec
// weavepack/profiles/tensor/04-deltas.md "Compression beyond delta".
fn read_tensor_body_with_mode(
    r: &mut BitReader,
    name: &str,
    name_to_idx: &std::collections::BTreeMap<String, usize>,
    tensors: &[Option<(String, TensorData)>],
) -> Result<TensorData, String> {
    let dtype = r.read(DTYPE_BITS as usize)? as u8;
    let rank = r.short()? as usize;
    let mut shape = Vec::with_capacity(rank);
    for _ in 0..rank {
        shape.push(r.leb128()?);
    }
    let mode_bit = r.read(1)? as u8;
    let byte_count = data_bytes(dtype, &shape) as usize;
    let mut data = vec![0u8; byte_count];
    for b in &mut data {
        *b = r.read(8)? as u8;
    }
    if mode_bit == 0 {
        return Ok(TensorData { dtype, shape, data });
    }
    // mode=1: data is per-element delta. Look up base tensor and add.
    let base = name_to_idx
        .get(name)
        .and_then(|&i| tensors[i].as_ref())
        .ok_or_else(|| format!("tensor_replace mode=1 on unknown tensor '{name}'"))?;
    if base.1.dtype != dtype {
        return Err(format!(
            "tensor_replace mode=1 dtype mismatch: base={}, delta={}",
            base.1.dtype, dtype
        ));
    }
    let mut new_data = base.1.data.clone();
    apply_arithmetic_delta(dtype, &mut new_data, &data)?;
    Ok(TensorData { dtype, shape, data: new_data })
}

fn apply_arithmetic_delta(dtype: u8, base: &mut [u8], delta: &[u8]) -> Result<(), String> {
    use crate::types::{DTYPE_FP32, DTYPE_FP64, DTYPE_INT8, DTYPE_UINT8,
        DTYPE_INT16, DTYPE_UINT16, DTYPE_INT32, DTYPE_UINT32,
        DTYPE_INT64, DTYPE_UINT64};
    if base.len() != delta.len() {
        return Err(format!(
            "arithmetic delta length mismatch: base={} delta={}",
            base.len(), delta.len()
        ));
    }
    match dtype {
        d if d == DTYPE_FP32 => {
            for i in (0..base.len()).step_by(4) {
                let b = f32::from_le_bytes(base[i..i+4].try_into().unwrap());
                let d = f32::from_le_bytes(delta[i..i+4].try_into().unwrap());
                base[i..i+4].copy_from_slice(&(b + d).to_le_bytes());
            }
        }
        d if d == DTYPE_FP64 => {
            for i in (0..base.len()).step_by(8) {
                let b = f64::from_le_bytes(base[i..i+8].try_into().unwrap());
                let d = f64::from_le_bytes(delta[i..i+8].try_into().unwrap());
                base[i..i+8].copy_from_slice(&(b + d).to_le_bytes());
            }
        }
        d if d == DTYPE_INT8 => {
            for i in 0..base.len() { base[i] = (base[i] as i8).wrapping_add(delta[i] as i8) as u8; }
        }
        d if d == DTYPE_UINT8 => {
            for i in 0..base.len() { base[i] = base[i].wrapping_add(delta[i]); }
        }
        d if d == DTYPE_INT16 => {
            for i in (0..base.len()).step_by(2) {
                let b = i16::from_le_bytes(base[i..i+2].try_into().unwrap());
                let d = i16::from_le_bytes(delta[i..i+2].try_into().unwrap());
                base[i..i+2].copy_from_slice(&b.wrapping_add(d).to_le_bytes());
            }
        }
        d if d == DTYPE_UINT16 => {
            for i in (0..base.len()).step_by(2) {
                let b = u16::from_le_bytes(base[i..i+2].try_into().unwrap());
                let d = u16::from_le_bytes(delta[i..i+2].try_into().unwrap());
                base[i..i+2].copy_from_slice(&b.wrapping_add(d).to_le_bytes());
            }
        }
        d if d == DTYPE_INT32 => {
            for i in (0..base.len()).step_by(4) {
                let b = i32::from_le_bytes(base[i..i+4].try_into().unwrap());
                let d = i32::from_le_bytes(delta[i..i+4].try_into().unwrap());
                base[i..i+4].copy_from_slice(&b.wrapping_add(d).to_le_bytes());
            }
        }
        d if d == DTYPE_UINT32 => {
            for i in (0..base.len()).step_by(4) {
                let b = u32::from_le_bytes(base[i..i+4].try_into().unwrap());
                let d = u32::from_le_bytes(delta[i..i+4].try_into().unwrap());
                base[i..i+4].copy_from_slice(&b.wrapping_add(d).to_le_bytes());
            }
        }
        d if d == DTYPE_INT64 => {
            for i in (0..base.len()).step_by(8) {
                let b = i64::from_le_bytes(base[i..i+8].try_into().unwrap());
                let d = i64::from_le_bytes(delta[i..i+8].try_into().unwrap());
                base[i..i+8].copy_from_slice(&b.wrapping_add(d).to_le_bytes());
            }
        }
        d if d == DTYPE_UINT64 => {
            for i in (0..base.len()).step_by(8) {
                let b = u64::from_le_bytes(base[i..i+8].try_into().unwrap());
                let d = u64::from_le_bytes(delta[i..i+8].try_into().unwrap());
                base[i..i+8].copy_from_slice(&b.wrapping_add(d).to_le_bytes());
            }
        }
        _ => return Err(format!("arithmetic delta unsupported for dtype {dtype}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DTYPE_FP32, DTYPE_INT32, DTYPE_UINT8};

    #[test]
    fn arithmetic_delta_fp32_basic() {
        // base = [10.0, 20.0], delta = [0.5, -1.5] → [10.5, 18.5]
        let mut base = Vec::new();
        base.extend_from_slice(&10.0f32.to_le_bytes());
        base.extend_from_slice(&20.0f32.to_le_bytes());
        let mut delta = Vec::new();
        delta.extend_from_slice(&0.5f32.to_le_bytes());
        delta.extend_from_slice(&(-1.5f32).to_le_bytes());

        apply_arithmetic_delta(DTYPE_FP32, &mut base, &delta).unwrap();
        let v0 = f32::from_le_bytes(base[0..4].try_into().unwrap());
        let v1 = f32::from_le_bytes(base[4..8].try_into().unwrap());
        assert_eq!(v0, 10.5);
        assert_eq!(v1, 18.5);
    }

    #[test]
    fn arithmetic_delta_int32_wraps() {
        // base = i32::MAX, delta = 1 → wraps to i32::MIN.
        let mut base = i32::MAX.to_le_bytes().to_vec();
        let delta = 1i32.to_le_bytes().to_vec();
        apply_arithmetic_delta(DTYPE_INT32, &mut base, &delta).unwrap();
        let v = i32::from_le_bytes(base[0..4].try_into().unwrap());
        assert_eq!(v, i32::MIN, "wrapping add should overflow correctly");
    }

    #[test]
    fn arithmetic_delta_uint8_wraps() {
        // base = [255, 0], delta = [1, 255] → [0, 255] (modular).
        let mut base = vec![255u8, 0u8];
        let delta = vec![1u8, 255u8];
        apply_arithmetic_delta(DTYPE_UINT8, &mut base, &delta).unwrap();
        assert_eq!(base, vec![0u8, 255u8]);
    }

    #[test]
    fn arithmetic_delta_unsupported_dtype_errors() {
        let mut base = vec![0u8; 2];
        let delta = vec![0u8; 2];
        // BOOL (dtype 0) is not in apply_arithmetic_delta's match arms.
        let err = apply_arithmetic_delta(0, &mut base, &delta).unwrap_err();
        assert!(err.contains("unsupported"), "got: {err}");
    }

    #[test]
    fn decodes_mode1_chain_from_js_encoder() {
        // V0.2 A.3 verification: the JS encoder now picks mode=1 when
        // max abs delta ≤ 0.01. Rust decoder must handle that chain.
        // This is the actual delta payload (post-anchor) that JS emits
        // for base=[1.0, 2.0, 3.0, 4.0], updated=[1.001, 2.002, 3.003, 4.004]:
        let delta_hex = "8081777882400520ce800500cec027110ec00520cec0";
        let delta: Vec<u8> = (0..delta_hex.len() / 2)
            .map(|i| u8::from_str_radix(&delta_hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        let base = vec![("w".to_string(), TensorData {
            dtype: DTYPE_FP32, shape: vec![4],
            data: [1.0f32, 2.0, 3.0, 4.0].iter().flat_map(|f| f.to_le_bytes()).collect(),
        })];
        let result = apply_delta(&base, &delta).expect("Rust must decode JS mode=1 chain");
        let result_floats: Vec<f32> = (0..4)
            .map(|i| f32::from_le_bytes(result[0].1.data[i*4..i*4+4].try_into().unwrap()))
            .collect();
        let expected = [1.001f32, 2.002, 3.003, 4.004];
        for (i, (&got, &want)) in result_floats.iter().zip(expected.iter()).enumerate() {
            assert!((got - want).abs() < 1e-3,
                "elem {i}: got {got}, want {want}");
        }
    }

    #[test]
    fn encode_apply_round_trip_int32() {
        use crate::types::DTYPE_INT32;
        // Round-trip integer tensor through encode_delta + apply_delta.
        let base_data: Vec<u8> = (1i32..=4).flat_map(|v| v.to_le_bytes()).collect();
        let new_data: Vec<u8> = (10i32..=40).step_by(10).flat_map(|v| v.to_le_bytes()).collect();
        let base = vec![("m".to_string(), TensorData {
            dtype: DTYPE_INT32, shape: vec![4], data: base_data,
        })];
        let new = vec![("m".to_string(), TensorData {
            dtype: DTYPE_INT32, shape: vec![4], data: new_data,
        })];
        let delta = encode_delta(&base, &new).expect("delta should not be empty");
        let result = apply_delta(&base, &delta).expect("apply should succeed");
        assert_eq!(result, new);
    }

    #[test]
    fn encode_apply_round_trip_tensor_replace() {
        // Full round-trip: encoder builds a TENSOR_REPLACE delta (mode=0
        // is the only mode the encoder emits today), decoder applies
        // it back. Locks the mode-bit emit/read paths against drift.
        let base = vec![("w".to_string(), TensorData {
            dtype: DTYPE_FP32, shape: vec![3],
            data: 1.0f32.to_le_bytes().iter().chain(2.0f32.to_le_bytes().iter())
                  .chain(3.0f32.to_le_bytes().iter()).copied().collect(),
        })];
        let new = vec![("w".to_string(), TensorData {
            dtype: DTYPE_FP32, shape: vec![3],
            data: 10.0f32.to_le_bytes().iter().chain(20.0f32.to_le_bytes().iter())
                  .chain(30.0f32.to_le_bytes().iter()).copied().collect(),
        })];
        let delta_bytes = encode_delta(&base, &new).expect("delta should not be empty");
        let result = apply_delta(&base, &delta_bytes).expect("apply should succeed");
        assert_eq!(result, new, "round-trip should reproduce target tensor");
    }
}
