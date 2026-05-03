// weavepack-tensor schema hashing.
// See weavepack/profiles/tensor/06-schemas.md.
//
// The schema hash is SHA-256 of the canonical JSON encoding of the schema
// object.  Canonical form: all keys sorted alphabetically at every level,
// no extra whitespace, UTF-8 encoded.  This matches the JS reference in
// sdk/src/profiles/tensor/schema.js.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Compute the canonical JSON string for a schema.
///
/// Schema structure: { "<name>": { "dtype": <u8>, "shape": [<u64>…] }, … }
/// The outer map is sorted by name (BTreeMap guarantees this).
pub fn canonicalize_schema(schema: &BTreeMap<String, (u8, Vec<u64>)>) -> String {
    // Build a minimal sorted-key JSON string by hand so we don't
    // depend on serde_json's key ordering (which sorts for BTreeMap).
    let mut s = String::from("{");
    for (i, (name, (dtype, shape))) in schema.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        // Escape name as a JSON string key.
        s.push('"');
        json_escape_into(&mut s, name);
        s.push_str("\":{\"dtype\":");
        s.push_str(&dtype.to_string());
        s.push_str(",\"shape\":[");
        for (j, &d) in shape.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            s.push_str(&d.to_string());
        }
        s.push_str("]}");
    }
    s.push('}');
    s
}

/// SHA-256 of `canonicalize_schema(schema)` encoded as UTF-8.
pub fn schema_hash(schema: &BTreeMap<String, (u8, Vec<u64>)>) -> [u8; 32] {
    let canonical = canonicalize_schema(schema);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.finalize().into()
}

pub fn schema_hash_hex(schema: &BTreeMap<String, (u8, Vec<u64>)>) -> String {
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
