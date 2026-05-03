// weavepack-core — profile-agnostic protocol primitives.
//
// All weavepack profiles (json, tensor, …) share the same MSB-first bit
// layout and the same variable-length integer encodings defined in
// weavepack/core/03-bit-encoding.md.  This crate owns those primitives;
// profile crates import from here and add nothing to core in return.

pub mod bits;
pub mod chain;
