// weavepack-tensor — Rust reference implementation (Phase 6).
//
// Profile isolation: this crate imports no weavepack-json code.
// All wire format knowledge lives in this crate alone.

pub mod bits;
pub mod decode;
pub mod delta;
pub mod encode;
pub mod fp8_dtype;
pub mod half_dtype;
pub mod schema;
pub mod types;

/// Re-export of the protocol-level chain helpers from weavepack-core, so
/// callers depending only on weavepack-tensor can split a chain buffer
/// into its constituent payloads (and re-emit any prefix) without taking
/// a separate dependency on the core crate.
pub use weavepack_core::chain;

pub use types::SchemaEntry;
pub use decode::{iterate_tensors_schemaful, SchemafulIter};

/// A single tensor entry: dtype code, shape, raw little-endian data bytes,
/// and (for quantized dtypes QINT8/QINT4/QFP8) the quantization parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct TensorData {
    pub dtype: u8,
    pub shape: Vec<u64>,
    /// Raw element bytes in little-endian order.
    pub data: Vec<u8>,
    /// Quantization scale (QINT8/QINT4/QFP8 only). None for non-quantized dtypes.
    pub scale: Option<f64>,
    /// Quantization zero-point (QINT8/QINT4 only). None for QFP8 and non-quantized dtypes.
    pub zero_point: Option<i64>,
}

impl Default for TensorData {
    fn default() -> Self {
        TensorData { dtype: 0, shape: Vec::new(), data: Vec::new(), scale: None, zero_point: None }
    }
}
