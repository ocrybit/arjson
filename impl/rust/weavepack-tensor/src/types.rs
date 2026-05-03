// weavepack-tensor — dtype/op constants.
// See weavepack/profiles/tensor/01-types.md for the normative spec.

pub const DTYPE_BITS: u8 = 5;
pub const OP_BITS: u8 = 3;

pub const DTYPE_BOOL: u8 = 0;
pub const DTYPE_INT4: u8 = 1;
pub const DTYPE_UINT4: u8 = 2;
pub const DTYPE_INT8: u8 = 3;
pub const DTYPE_UINT8: u8 = 4;
pub const DTYPE_INT16: u8 = 5;
pub const DTYPE_UINT16: u8 = 6;
pub const DTYPE_INT32: u8 = 7;
pub const DTYPE_UINT32: u8 = 8;
pub const DTYPE_INT64: u8 = 9;
pub const DTYPE_UINT64: u8 = 10;
pub const DTYPE_FP8E4M3: u8 = 11;
pub const DTYPE_FP8E5M2: u8 = 12;
pub const DTYPE_FP16: u8 = 13;
pub const DTYPE_BF16: u8 = 14;
pub const DTYPE_FP32: u8 = 15;
pub const DTYPE_FP64: u8 = 16;
pub const DTYPE_CFLOAT32: u8 = 17;
pub const DTYPE_CFLOAT64: u8 = 18;
pub const DTYPE_QINT4: u8 = 28;
pub const DTYPE_QINT8: u8 = 29;
pub const DTYPE_QFP8: u8 = 30;

pub const OP_TENSOR_REPLACE: u8 = 0;
pub const OP_TENSOR_ADD: u8 = 1;
pub const OP_TENSOR_REMOVE: u8 = 2;
pub const OP_ELEMENT_SET: u8 = 4;

/// Bits per element for each dtype code.
pub fn dtype_bits_per_elem(dtype: u8) -> Option<u32> {
    match dtype {
        0 => Some(1),    // bool
        1 => Some(4),    // int4
        2 => Some(4),    // uint4
        3 => Some(8),    // int8
        4 => Some(8),    // uint8
        5 => Some(16),   // int16
        6 => Some(16),   // uint16
        7 => Some(32),   // int32
        8 => Some(32),   // uint32
        9 => Some(64),   // int64
        10 => Some(64),  // uint64
        11 => Some(8),   // fp8e4m3
        12 => Some(8),   // fp8e5m2
        13 => Some(16),  // fp16
        14 => Some(16),  // bf16
        15 => Some(32),  // fp32
        16 => Some(64),  // fp64
        17 => Some(64),  // cfloat32
        18 => Some(128), // cfloat64
        28 => Some(4),   // qint4
        29 => Some(8),   // qint8
        30 => Some(8),   // qfp8
        _ => None,
    }
}

/// Data block size in bytes for a tensor with given dtype and shape.
pub fn data_bytes(dtype: u8, shape: &[u64]) -> u64 {
    let bpe = dtype_bits_per_elem(dtype).unwrap_or(0) as u64;
    let elements: u64 = shape.iter().product();
    let total_bits = elements * bpe;
    (total_bits + 7) / 8
}
