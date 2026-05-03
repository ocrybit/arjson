// weavepack-tensor — Rust reference implementation (Phase 6).
//
// Profile isolation: this crate imports no weavepack-json code.
// All wire format knowledge lives in this crate alone.

pub mod bits;
pub mod decode;
pub mod delta;
pub mod encode;
pub mod half_dtype;
pub mod schema;
pub mod types;

/// Re-export of the protocol-level chain helpers from weavepack-core, so
/// callers depending only on weavepack-tensor can split a chain buffer
/// into its constituent payloads (and re-emit any prefix) without taking
/// a separate dependency on the core crate.
pub use weavepack_core::chain;

/// A single tensor entry: dtype code, shape, and raw little-endian data bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TensorData {
    pub dtype: u8,
    pub shape: Vec<u64>,
    /// Raw element bytes in little-endian order.
    pub data: Vec<u8>,
}
