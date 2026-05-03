// weavepack-tensor — Rust reference implementation (Phase 6).
//
// Profile isolation: this crate imports no weavepack-json code.
// All wire format knowledge lives in this crate alone.

pub mod bits;
pub mod decode;
pub mod delta;
pub mod encode;
pub mod schema;
pub mod types;

/// A single tensor entry: dtype code, shape, and raw little-endian data bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TensorData {
    pub dtype: u8,
    pub shape: Vec<u64>,
    /// Raw element bytes in little-endian order.
    pub data: Vec<u8>,
}
