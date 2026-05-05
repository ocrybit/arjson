// weavepack-json — snapshot encoder (single-payload + structured mode).

use crate::bits::BitWriter;
use crate::struct_encode::encode_structured;
use crate::types::{
    base64url_index, get_precision, is_base64url, single_tag, strmap_index, Value,
};
use serde_json::Value as Json;

/// Encode a JSON value.  Single-payload mode for primitives and empty
/// containers; structured mode for non-empty arrays/objects.
pub fn encode(v: &Value) -> Result<Vec<u8>, String> {
    // NaN coercion: mirrors JS `if (typeof v === "number" && v - v !== 0) v = null`.
    let coerced;
    let v = if let Json::Number(n) = v {
        if n.as_f64().map(|f| !f.is_finite()).unwrap_or(false) {
            coerced = Json::Null;
            &coerced
        } else { v }
    } else { v };

    match v {
        Json::Array(arr) if !arr.is_empty()   => return encode_structured(v),
        Json::Object(obj) if !obj.is_empty()  => return encode_structured(v),
        _ => {}
    }

    let mut w = BitWriter::new();
    encode_into(&mut w, v)?;
    Ok(w.finish())
}

fn encode_into(w: &mut BitWriter, v: &Value) -> Result<(), String> {
    // Mode bit = 1 (single-payload).
    w.write_bits(1, 1);

    match v {
        Json::Null => {
            // selector = 0, tag = 0
            w.write_bits(0, 1);
            w.write_bits(single_tag::NULL as u32, 6);
        }
        Json::Bool(true) => {
            w.write_bits(0, 1);
            w.write_bits(single_tag::TRUE as u32, 6);
        }
        Json::Bool(false) => {
            w.write_bits(0, 1);
            w.write_bits(single_tag::FALSE as u32, 6);
        }
        Json::String(s) => encode_string(w, s)?,
        Json::Array(arr) if arr.is_empty() => {
            w.write_bits(0, 1);
            w.write_bits(single_tag::EMPTY_ARRAY as u32, 6);
        }
        Json::Object(obj) if obj.is_empty() => {
            w.write_bits(0, 1);
            w.write_bits(single_tag::EMPTY_OBJECT as u32, 6);
        }
        Json::Array(_) | Json::Object(_) => {
            return Err("structured (non-empty container) encoding not implemented in v0.1".into());
        }
        Json::Number(n) => encode_number(w, n)?,
    }
    Ok(())
}

fn encode_number(w: &mut BitWriter, n: &serde_json::Number) -> Result<(), String> {
    // Coerce non-finite to null per JSON spec, but serde_json never
    // produces non-finite numbers (it rejects NaN/Inf at parse time).
    if let Some(i) = n.as_i64() {
        if i >= 0 {
            encode_positive_int(w, i as u64);
        } else {
            encode_negative_int(w, (-i) as u64);
        }
        return Ok(());
    }
    if let Some(u) = n.as_u64() {
        encode_positive_int(w, u);
        return Ok(());
    }
    let f = n.as_f64().ok_or_else(|| "number not convertible to f64".to_string())?;
    if !f.is_finite() {
        // Coerce to null. selector = 0, tag = NULL.
        w.write_bits(0, 1);
        w.write_bits(single_tag::NULL as u32, 6);
        return Ok(());
    }
    // Integer in disguise (e.g. 1.0)?
    let limit = (1u64 << 53) as f64;
    if f.fract() == 0.0 && f >= -limit && f <= limit {
        if f >= 0.0 {
            encode_positive_int(w, f as u64);
        } else {
            encode_negative_int(w, (-f) as u64);
        }
        return Ok(());
    }
    encode_float(w, f);
    Ok(())
}

fn encode_positive_int(w: &mut BitWriter, v: u64) {
    // selector = 1: positive int fast path
    w.write_bits(1, 1);
    if v < 63 {
        w.write_bits(v as u32, 6);
    } else {
        w.write_bits(63, 6);
        leb128_write(w, v - 63);
    }
}

fn encode_negative_int(w: &mut BitWriter, magnitude: u64) {
    // selector = 0, tag = INT_NEGATIVE, then uint(magnitude).
    w.write_bits(0, 1);
    w.write_bits(single_tag::INT_NEGATIVE as u32, 6);
    uint_write(w, magnitude);
}

fn encode_float(w: &mut BitWriter, f: f64) {
    let neg = f < 0.0;
    let abs = if neg { -f } else { f };
    let prec = get_precision(abs).min(308);
    let scale = 10f64.powi(prec as i32);
    let mantissa = (abs * scale).round() as u64;
    w.write_bits(0, 1);
    let tag = if neg { single_tag::FLOAT_NEGATIVE } else { single_tag::FLOAT_POSITIVE };
    w.write_bits(tag as u32, 6);
    uint_write(w, prec as u64);
    uint_write(w, mantissa);
}

fn encode_string(w: &mut BitWriter, s: &str) -> Result<(), String> {
    if s.is_empty() {
        w.write_bits(0, 1);
        w.write_bits(single_tag::EMPTY_STRING as u32, 6);
        return Ok(());
    }
    // Single-character handling — but "single" means UTF-16 code units,
    // not Unicode scalars (matches JS string.length semantics). A non-BMP
    // char like 😀 has 2 UTF-16 units and falls through to multi-char.
    let utf16_units: Vec<u16> = s.encode_utf16().collect();
    let chars: Vec<char> = s.chars().collect();
    if utf16_units.len() == 1 {
        let c = chars[0];
        if let Some(idx) = strmap_index(c) {
            // Tag 9..60.
            w.write_bits(0, 1);
            w.write_bits((single_tag::CHAR_RANGE_LO + idx) as u32, 6);
            return Ok(());
        }
        // Outside [A-Za-z]: tag = CHAR_NON_ALPHA + leb128(charCode).
        w.write_bits(0, 1);
        w.write_bits(single_tag::CHAR_NON_ALPHA as u32, 6);
        // JS reference uses UTF-16 code units; for BMP chars these
        // match Unicode scalar values. Non-BMP single chars (rare for
        // length-1 strings) would be a surrogate pair in JS but a
        // single scalar value in Rust. We emit the scalar value;
        // round-trip with the JS reference is exact for BMP code
        // points.
        leb128_write(w, c as u64);
        return Ok(());
    }
    // Multi-character. Length is UTF-16 code unit count (matches JS).
    if is_base64url(s) {
        w.write_bits(0, 1);
        w.write_bits(single_tag::STR_BASE64URL as u32, 6);
        // For base64url-eligible strings, all chars are ASCII so
        // utf16 length == char count. Per-char is 6-bit alphabet
        // index.
        short_write(w, utf16_units.len() as u64);
        for c in &chars {
            let idx = base64url_index(*c).unwrap();
            w.write_bits(idx as u32, 6);
        }
    } else {
        w.write_bits(0, 1);
        w.write_bits(single_tag::STR_FALLBACK as u32, 6);
        short_write(w, utf16_units.len() as u64);
        for u in &utf16_units {
            leb128_write(w, *u as u64);
        }
    }
    Ok(())
}

// ── short / uint / leb128 — bit primitives matching the JS reference ─────

pub fn leb128_write(w: &mut BitWriter, mut v: u64) {
    while v >= 128 {
        w.write_bits(((v & 0x7f) | 0x80) as u32, 8);
        v >>= 7;
    }
    w.write_bits(v as u32, 8);
}

pub fn short_write(w: &mut BitWriter, v: u64) {
    if v < 4 {
        w.write_bits(0, 2);
        w.write_bits(v as u32, 2);
    } else if v < 8 {
        w.write_bits(1, 2);
        w.write_bits(v as u32, 3);
    } else if v < 16 {
        w.write_bits(2, 2);
        w.write_bits(v as u32, 4);
    } else {
        w.write_bits(3, 2);
        leb128_write(w, v);
    }
}

pub fn uint_write(w: &mut BitWriter, v: u64) {
    if v < 8 {
        w.write_bits(0, 2);
        w.write_bits(v as u32, 3);
    } else if v < 16 {
        w.write_bits(1, 2);
        w.write_bits(v as u32, 4);
    } else if v < 64 {
        w.write_bits(2, 2);
        w.write_bits(v as u32, 6);
    } else {
        w.write_bits(3, 2);
        leb128_write(w, v);
    }
}
