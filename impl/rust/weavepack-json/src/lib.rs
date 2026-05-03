// weavepack-json — Rust reference implementation (Phase 6.2 v0.1).
//
// Initial scope: single-payload mode only. Covers null, true, false,
// empty string, empty array, empty object, positive int (small + leb128
// extension), negative int, float (positive + negative with precision),
// single-character A–Z/a–z (via strmap alphabet tag), single non-base64url
// character, multi-character base64url string, multi-character fallback
// string. This is the entire 64-tag space defined in
// weavepack/profiles/json/01-types.md (Single-payload mode section).
//
// Structured mode (objects, arrays, deltas, strmap dedup) is deferred
// to a subsequent stage of Phase 6.2.

pub mod bits;
pub mod types;
pub mod encode;
pub mod decode;

pub use bits::{BitReader, BitWriter};
pub use types::{Value, decode_single_payload_tag};
pub use encode::encode;
pub use decode::decode;
