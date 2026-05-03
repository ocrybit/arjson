// weavepack-tensor bit helpers — thin wrapper over weavepack-core.
//
// Shared primitives (BitWriter, BitReader, write_leb128, write_short) live in
// weavepack-core.  Only the tensor-specific finalize trailer is defined here.

pub use weavepack_core::bits::{BitReader, BitWriter, write_leb128, write_short};

/// Append the finalize trailer (1 bit + short(0)) and pad to byte boundary.
/// Must be called once after all tensor payload bits have been written.
pub fn finalize(mut w: BitWriter) -> Vec<u8> {
    w.write_bits(0, 1); // trailer bit
    w.write_bits(0, 2); // short(0) prefix
    w.write_bits(0, 2); // short(0) value
    w.finish()
}
