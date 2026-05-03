// weavepack-json — type vocabulary and Value enum.
//
// Mirrors sdk/src/profiles/json/types.js. See
// weavepack/profiles/json/01-types.md for the normative spec.

use serde_json::Value as Json;

/// JSON value representation matching the wire format's value space.
/// We delegate to serde_json::Value for the actual structural shape;
/// this module supplies the encoder-side dispatch logic.
pub type Value = Json;

// ── Single-payload tag space (after the leading "1" mode bit + 1-bit
//    selector + 6-bit tag) ────────────────────────────────────────────────

/// Tag values when the 1-bit selector after the mode bit is `0`.
/// When the selector is `1`, the next 6 bits encode a positive integer
/// directly (or 63 + leb128 remainder for ≥ 63).
pub mod single_tag {
    pub const NULL:                u8 = 0;
    pub const TRUE:                u8 = 1;
    pub const FALSE:               u8 = 2;
    pub const EMPTY_STRING:        u8 = 3;
    pub const EMPTY_ARRAY:         u8 = 4;
    pub const EMPTY_OBJECT:        u8 = 5;
    pub const INT_NEGATIVE:        u8 = 6;
    pub const FLOAT_POSITIVE:      u8 = 7;
    pub const FLOAT_NEGATIVE:      u8 = 8;
    // 9..=60: single character A..Z, a..z (52 chars).
    pub const CHAR_RANGE_LO:       u8 = 9;
    pub const CHAR_RANGE_HI:       u8 = 60;
    pub const CHAR_NON_ALPHA:      u8 = 61;
    pub const STR_BASE64URL:       u8 = 62;
    pub const STR_FALLBACK:        u8 = 63;
}

// ── Alphabets ────────────────────────────────────────────────────────────

pub const STRMAP_ALPHABET: &str =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

pub const BASE64URL_ALPHABET: &str =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Convert a single character to its base64url alphabet index, or
/// None if it's not in the alphabet.
pub fn base64url_index(c: char) -> Option<u8> {
    let code = c as u32;
    if code >= 128 { return None; }
    let bytes = BASE64URL_ALPHABET.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b as u32 == code { return Some(i as u8); }
    }
    None
}

/// Convert a single character to its strmap alphabet (A-Za-z) index,
/// or None if outside the alphabet.
pub fn strmap_index(c: char) -> Option<u8> {
    let code = c as u32;
    if code >= 128 { return None; }
    let bytes = STRMAP_ALPHABET.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b as u32 == code { return Some(i as u8); }
    }
    None
}

/// Reverse: index → strmap character.
pub fn strmap_char(i: u8) -> Option<char> {
    let bytes = STRMAP_ALPHABET.as_bytes();
    if (i as usize) < bytes.len() {
        Some(bytes[i as usize] as char)
    } else {
        None
    }
}

/// Reverse: index → base64url character.
pub fn base64url_char(i: u8) -> Option<char> {
    let bytes = BASE64URL_ALPHABET.as_bytes();
    if (i as usize) < bytes.len() {
        Some(bytes[i as usize] as char)
    } else {
        None
    }
}

/// Detect whether all chars in `s` are in the base64url alphabet.
/// Empty strings are NOT base64url (they go via single_tag::EMPTY_STRING).
pub fn is_base64url(s: &str) -> bool {
    if s.is_empty() { return false; }
    s.chars().all(|c| base64url_index(c).is_some())
}

/// Compute the precision (number of significant fractional digits) of
/// a finite f64. Matches the JS reference's getPrecision logic, which
/// inspects the decimal string form. Returns 0 for integer-valued
/// floats. Capped at 308 (IEEE 754 binary64 effective precision).
pub fn get_precision(v: f64) -> u32 {
    if v == 0.0 { return 0; }
    let s = format!("{}", v);
    // Handle scientific notation.
    if let Some(e_pos) = s.find('e').or_else(|| s.find('E')) {
        let mantissa = &s[..e_pos];
        let exp: i32 = s[e_pos+1..].parse().unwrap_or(0);
        let dot = mantissa.find('.');
        let mantissa_prec = match dot {
            None => 0i32,
            Some(d) => (mantissa.len() - d - 1) as i32,
        };
        let p = (mantissa_prec - exp).max(0);
        return (p as u32).min(308);
    }
    match s.find('.') {
        None => 0,
        Some(d) => {
            let frac = s[d+1..].trim_end_matches('0');
            (frac.len() as u32).min(308)
        }
    }
}

/// Decode a 6-bit single-payload tag back into a serde_json::Value.
/// Returns the value plus the number of bits consumed beyond the
/// initial 8-bit (1 mode + 1 selector + 6 tag) header. Used by the
/// decoder for the `selector = 0` branch.
pub fn decode_single_payload_tag(_tag: u8) -> Option<Value> {
    None  // Detailed dispatch in decode.rs; this stub kept for re-exports.
}
