// weavepack-tensor schema hashing.
// See weavepack/profiles/tensor/06-schemas.md.
//
// The schema hash is SHA-256 of the canonical JSON encoding of the schema
// object.  Canonical form: all keys sorted alphabetically at every level,
// no extra whitespace, UTF-8 encoded.  This matches the JS reference in
// sdk/src/profiles/tensor/schema.js (sortedObject → JSON.stringify).
//
// Key sort order for a tensor entry with quantization params:
//   dtype < scale < shape < zero_point  (all alphabetical)
// When scale/zero_point are absent they are omitted.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::types::SchemaEntry;

/// Format an f64 the same way JS JSON.stringify does for the scale values
/// used in weavepack-tensor schemas (all are exact binary fractions or
/// integers).  Integer-valued floats are emitted without a decimal point to
/// match JS (which emits 2.0 as "2").
fn format_f64_json(f: f64) -> String {
    if f.fract() == 0.0 && f.is_finite() && f >= i64::MIN as f64 && f <= i64::MAX as f64 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// Compute the canonical JSON string for a schema.
///
/// Schema structure: { "<name>": SchemaEntry, … }
/// The outer map is sorted by name (BTreeMap guarantees this).
/// Each entry serializes as:
///   {"dtype":<u8>,"shape":[…]}
///   {"dtype":<u8>,"scale":<f64>,"shape":[…]}
///   {"dtype":<u8>,"scale":<f64>,"shape":[…],"zero_point":<i64>}
pub fn canonicalize_schema(schema: &BTreeMap<String, SchemaEntry>) -> String {
    let mut s = String::from("{");
    for (i, (name, entry)) in schema.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        json_escape_into(&mut s, name);
        s.push_str("\":{\"dtype\":");
        s.push_str(&entry.dtype.to_string());
        if let Some(scale) = entry.scale {
            s.push_str(",\"scale\":");
            s.push_str(&format_f64_json(scale));
        }
        s.push_str(",\"shape\":[");
        for (j, &d) in entry.shape.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            s.push_str(&d.to_string());
        }
        s.push(']');
        if let Some(zp) = entry.zero_point {
            s.push_str(",\"zero_point\":");
            s.push_str(&zp.to_string());
        }
        s.push('}');
    }
    s.push('}');
    s
}

/// SHA-256 of `canonicalize_schema(schema)` encoded as UTF-8.
pub fn schema_hash(schema: &BTreeMap<String, SchemaEntry>) -> [u8; 32] {
    let canonical = canonicalize_schema(schema);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.finalize().into()
}

pub fn schema_hash_hex(schema: &BTreeMap<String, SchemaEntry>) -> String {
    schema_hash(schema).iter().map(|b| format!("{b:02x}")).collect()
}

fn json_escape_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}
