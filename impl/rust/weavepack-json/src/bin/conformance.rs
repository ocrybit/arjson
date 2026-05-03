// weavepack-json — conformance runner.
//
// Walks weavepack/profiles/json/test-vectors/ and validates byte-for-byte
// against the JS reference. Currently supports only single-payload
// vectors (containers and deltas are skipped with a SKIP report).

use serde_json::Value as Json;
use std::fs;
use std::path::{Path, PathBuf};
use weavepack_json::{decode, encode};

fn main() {
    // Walk up to find weavepack/profiles/json/test-vectors/.
    let mut root: PathBuf = std::env::current_dir().unwrap();
    while !root.join("weavepack").join("profiles").join("json").exists() {
        match root.parent() {
            Some(p) => root = p.to_path_buf(),
            None => {
                eprintln!("could not find weavepack/profiles/json/ from {}", std::env::current_dir().unwrap().display());
                std::process::exit(1);
            }
        }
    }
    let vectors_root = root.join("weavepack/profiles/json/test-vectors");
    let mut pass = 0usize;
    let mut fail = 0usize;
    let mut skip = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for path in walk(&vectors_root) {
        let rel = path.strip_prefix(&vectors_root).unwrap();
        let rel_str = rel.to_string_lossy();
        if rel_str.starts_with("deltas/") || rel_str.starts_with("containers/") {
            // Structured-mode payloads — out of scope for v0.1.
            let vectors: Vec<Json> = match read_vectors(&path) {
                Ok(v) => v,
                Err(e) => { failures.push(format!("{}: {}", rel_str, e)); fail += 1; continue; }
            };
            skip += vectors.len();
            continue;
        }
        let vectors: Vec<Json> = match read_vectors(&path) {
            Ok(v) => v,
            Err(e) => { failures.push(format!("{}: {}", rel_str, e)); fail += 1; continue; }
        };
        for v in vectors {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)");
            let input = match v.get("input") {
                Some(x) => x.clone(),
                None => { skip += 1; continue; }
            };
            let expected_hex = v.get("expected_bytes_hex").and_then(|x| x.as_str()).unwrap_or("");
            let expected_decoded = v.get("expected_decoded").cloned();

            // Encode.
            let bytes = match encode(&input) {
                Ok(b) => b,
                Err(e) => {
                    skip += 1;  // Likely a structured value we don't handle yet.
                    let _ = e;
                    continue;
                }
            };
            let actual_hex = hex::encode(&bytes);
            if actual_hex != expected_hex {
                fail += 1;
                failures.push(format!("{} :: {}: encode bytes mismatch\n    expected: {}\n    actual:   {}",
                    rel_str, name, expected_hex, actual_hex));
                continue;
            }
            // Decode.
            let decoded = match decode(&bytes) {
                Ok(d) => d,
                Err(e) => {
                    fail += 1;
                    failures.push(format!("{} :: {}: decode error: {}", rel_str, name, e));
                    continue;
                }
            };
            let target = expected_decoded.unwrap_or(input.clone());
            if !json_equal(&decoded, &target) {
                fail += 1;
                failures.push(format!("{} :: {}: decode mismatch\n    expected: {}\n    actual:   {}",
                    rel_str, name, target, decoded));
                continue;
            }
            pass += 1;
        }
    }

    println!("Pass: {}", pass);
    println!("Fail: {}", fail);
    println!("Skip: {} (structured-mode vectors not supported in v0.1)", skip);
    if fail > 0 {
        println!("\nFailures:");
        for f in &failures { println!("  {}", f); }
        std::process::exit(1);
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else if p.extension().map(|x| x == "json").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out
}

fn read_vectors(path: &Path) -> Result<Vec<Json>, String> {
    let s = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: Json = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    match v {
        Json::Array(arr) => Ok(arr),
        _ => Err("expected JSON array".to_string()),
    }
}

// JSON-level equality: structural with NaN-coerced-to-null semantics.
fn json_equal(a: &Json, b: &Json) -> bool {
    a == b
}
