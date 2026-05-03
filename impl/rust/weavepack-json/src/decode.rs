// weavepack-json — single-payload decoder.

use crate::bits::BitReader;
use crate::types::{base64url_char, single_tag, strmap_char, Value};
use serde_json::{json, Number, Value as Json};

pub fn decode(bytes: &[u8]) -> Result<Value, String> {
    let mut r = BitReader::new(bytes);
    let mode = r.read_bits(1);
    if mode != 1 {
        return Err("structured-mode decoding not implemented in v0.1".to_string());
    }
    let selector = r.read_bits(1);
    let tag = r.read_bits(6) as u8;

    if selector == 1 {
        // Positive integer fast path.
        if tag < 63 {
            return Ok(json!(tag as u64));
        }
        let extra = leb128_read(&mut r);
        return Ok(json!(63u64 + extra));
    }

    // selector == 0: tag table.
    match tag {
        single_tag::NULL          => Ok(Json::Null),
        single_tag::TRUE          => Ok(Json::Bool(true)),
        single_tag::FALSE         => Ok(Json::Bool(false)),
        single_tag::EMPTY_STRING  => Ok(json!("")),
        single_tag::EMPTY_ARRAY   => Ok(json!([])),
        single_tag::EMPTY_OBJECT  => Ok(json!({})),
        single_tag::INT_NEGATIVE  => {
            let m = uint_read(&mut r);
            // Negative integer: emit as i64 if it fits, else as f64.
            if m <= i64::MAX as u64 {
                Ok(json!(-(m as i64)))
            } else {
                Ok(json!(-(m as f64)))
            }
        }
        single_tag::FLOAT_POSITIVE | single_tag::FLOAT_NEGATIVE => {
            let prec = uint_read(&mut r) as i32;
            let mantissa = uint_read(&mut r);
            let mut f = mantissa as f64 / 10f64.powi(prec);
            if tag == single_tag::FLOAT_NEGATIVE { f = -f; }
            // serde_json::Number::from_f64 returns None for non-finite,
            // but our values are always finite by construction.
            Ok(Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null))
        }
        t @ 9..=60 => {
            let idx = t - single_tag::CHAR_RANGE_LO;
            let c = strmap_char(idx).ok_or("invalid strmap index")?;
            Ok(json!(c.to_string()))
        }
        single_tag::CHAR_NON_ALPHA => {
            let code = leb128_read(&mut r) as u32;
            let c = char::from_u32(code).ok_or("invalid char code")?;
            Ok(json!(c.to_string()))
        }
        single_tag::STR_BASE64URL => {
            let len = short_read(&mut r) as usize;
            let mut s = String::with_capacity(len);
            for _ in 0..len {
                let idx = r.read_bits(6) as u8;
                let c = base64url_char(idx).ok_or("invalid base64url index")?;
                s.push(c);
            }
            Ok(json!(s))
        }
        single_tag::STR_FALLBACK => {
            // JS emits UTF-16 code units; we read them into a Vec<u16>
            // and then decode to UTF-8. char::decode_utf16 handles
            // surrogate pairs correctly.
            let len = short_read(&mut r) as usize;
            let mut units: Vec<u16> = Vec::with_capacity(len);
            for _ in 0..len {
                units.push(leb128_read(&mut r) as u16);
            }
            let s: String = char::decode_utf16(units.iter().copied())
                .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
                .collect();
            Ok(json!(s))
        }
        _ => Err(format!("unknown single-payload tag {}", tag)),
    }
}

// ── decoder primitives ───────────────────────────────────────────────────

pub fn leb128_read(r: &mut BitReader) -> u64 {
    let mut result = 0u64;
    let mut shift = 0;
    loop {
        let byte = r.read_bits(8) as u64;
        result |= (byte & 0x7f) << shift;
        if byte & 0x80 == 0 { return result; }
        shift += 7;
        if shift >= 64 { return result; }
    }
}

pub fn short_read(r: &mut BitReader) -> u64 {
    let prefix = r.read_bits(2);
    match prefix {
        0 => r.read_bits(2) as u64,
        1 => r.read_bits(3) as u64,
        2 => r.read_bits(4) as u64,
        _ => leb128_read(r),
    }
}

pub fn uint_read(r: &mut BitReader) -> u64 {
    let prefix = r.read_bits(2);
    match prefix {
        0 => r.read_bits(3) as u64,
        1 => r.read_bits(4) as u64,
        2 => r.read_bits(6) as u64,
        _ => leb128_read(r),
    }
}
