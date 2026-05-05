// weavepack-json — Rust reference implementation (Phase 6.2).
//
// Profile isolation: this crate imports no weavepack-tensor code.
// All JSON wire-format knowledge lives in this crate alone.

pub mod bits;
pub mod decode;
pub mod encode;
pub mod struct_encode;
pub mod types;

pub use decode::decode_snapshot;
pub use encode::encode;
