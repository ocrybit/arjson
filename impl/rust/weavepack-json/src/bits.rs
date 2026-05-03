// weavepack-json bit helpers — thin wrapper over weavepack-core.
//
// Shared primitives (BitWriter, BitReader, write_leb128, write_short,
// write_uint) live in weavepack-core.  Only JSON-specific alphabet
// constants and helpers are defined here.

pub use weavepack_core::bits::{
    BitReader, BitWriter, write_leb128, write_short, write_uint,
};

// ── strmap alphabet: A-Za-z (52 chars) ─────────────────────────────────────
// strmap_rev[i] = char at index i.  Matches JS `strmap_rev`.
pub const STRMAP_CHARS: &[u8; 52] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ── base64url reverse table: index → char byte ─────────────────────────────
// Alphabet: A-Za-z0-9-_  (64 entries).  Matches JS `base64_rev_byte`.
pub fn base64url_char(idx: u64) -> u8 {
    const ALPHA: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    ALPHA[idx as usize]
}
