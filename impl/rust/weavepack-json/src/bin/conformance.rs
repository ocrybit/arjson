// weavepack-json conformance test runner.
//
// Usage:
//   cargo run --bin conformance [path/to/test-vectors]
//
// Path defaults to ../../../weavepack/profiles/json/test-vectors relative to
// CARGO_MANIFEST_DIR.  Level 1 + Level 2: decode expected_bytes_hex and
// compare the result to the input JSON value.
//
// Exit code 0 = all pass; exit code 1 = one or more failures.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use weavepack_json::decode_snapshot;

// ── hex helper ────────────────────────────────────────────────────────────────

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err(format!("odd-length hex string: {s}"));
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
             .map_err(|_| format!("bad hex byte at {i}: {}", &s[i * 2..i * 2 + 2])))
        .collect()
}

// ── JSON equality (handles f64 approximation) ─────────────────────────────────

fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null,    Value::Null)    => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => {
            // Compare as f64 with a small tolerance for float representation.
            match (x.as_f64(), y.as_f64()) {
                (Some(xf), Some(yf)) => {
                    if xf == yf { return true; }
                    let max = xf.abs().max(yf.abs());
                    if max == 0.0 { return true; }
                    ((xf - yf) / max).abs() < 1e-9
                }
                _ => x.to_string() == y.to_string(),
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| json_eq(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.len() != b.len() { return false; }
            for (k, av) in a {
                match b.get(k) {
                    Some(bv) => if !json_eq(av, bv) { return false; },
                    None => return false,
                }
            }
            true
        }
        _ => false,
    }
}

// ── test runner ───────────────────────────────────────────────────────────────

struct Runner {
    pass:     usize,
    fail:     usize,
    failures: Vec<String>,
}

impl Runner {
    fn new() -> Self {
        Self { pass: 0, fail: 0, failures: Vec::new() }
    }

    fn ok(&mut self) {
        self.pass += 1;
    }

    fn err(&mut self, label: &str, reason: &str) {
        self.fail += 1;
        self.failures.push(format!("  {label}\n    reason: {reason}"));
    }

    // Snapshot vector: has `input` and `expected_bytes_hex`.
    // Level 1: decode expected_bytes_hex → must equal input (or expected_decoded).
    fn run_snapshot(&mut self, label: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{label} :: {name}");

        let hex = match v["expected_bytes_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "expected_bytes_hex missing"),
        };
        let bytes = match from_hex(hex) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("hex parse error: {e}")),
        };

        let decoded = match decode_snapshot(&bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        };

        // Compare against expected_decoded if present, otherwise against input.
        let expected = if !v["expected_decoded"].is_null() && v.get("expected_decoded").is_some() {
            &v["expected_decoded"]
        } else {
            &v["input"]
        };

        if !json_eq(&decoded, expected) {
            return self.err(
                &full,
                &format!(
                    "decode mismatch\n    expected: {expected}\n    actual:   {decoded}"
                ),
            );
        }
        self.ok();
    }

    // Delta vector: has `initial` and `initial_delta_hex`.
    // Level 1: decode initial_delta_hex → must equal initial.
    fn run_delta(&mut self, label: &str, v: &Value) {
        let name = v["name"].as_str().unwrap_or("?");
        let full = format!("{label}(delta) :: {name}");

        let hex = match v["initial_delta_hex"].as_str() {
            Some(h) => h,
            None => return self.err(&full, "initial_delta_hex missing"),
        };
        let bytes = match from_hex(hex) {
            Ok(b) => b,
            Err(e) => return self.err(&full, &format!("hex parse error: {e}")),
        };

        let decoded = match decode_snapshot(&bytes) {
            Ok(d) => d,
            Err(e) => return self.err(&full, &format!("decode error: {e}")),
        };

        let expected = &v["initial"];
        if !json_eq(&decoded, expected) {
            return self.err(
                &full,
                &format!(
                    "decode mismatch\n    expected: {expected}\n    actual:   {decoded}"
                ),
            );
        }
        self.ok();
    }
}

// ── directory walker ──────────────────────────────────────────────────────────

fn walk_json(dir: &Path, files: &mut Vec<PathBuf>) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            walk_json(&path, files);
        } else if path.extension().map_or(false, |e| e == "json") {
            files.push(path);
        }
    }
}

// ── main ──────────────────────────────────────────────────────────────────────

fn main() {
    let vectors_root: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let manifest = env!("CARGO_MANIFEST_DIR");
            PathBuf::from(manifest)
                .join("../../../weavepack/profiles/json/test-vectors")
        });

    let vectors_root = vectors_root
        .canonicalize()
        .unwrap_or_else(|_| vectors_root.clone());

    let mut files = Vec::new();
    walk_json(&vectors_root, &mut files);

    if files.is_empty() {
        eprintln!("No test vector files found under {}", vectors_root.display());
        std::process::exit(1);
    }

    let mut runner = Runner::new();

    for path in &files {
        let rel = path
            .strip_prefix(&vectors_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        // Skip the README.
        if rel == "README.md" { continue; }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                runner.err(&rel, &format!("read error: {e}"));
                continue;
            }
        };
        let vectors: Vec<Value> = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                runner.err(&rel, &format!("JSON parse error: {e}"));
                continue;
            }
        };

        let is_delta = rel.starts_with("deltas/");

        for v in &vectors {
            if is_delta {
                runner.run_delta(&rel, v);
            } else {
                runner.run_snapshot(&rel, v);
            }
        }
    }

    println!("Pass: {}", runner.pass);
    println!("Fail: {}", runner.fail);

    if !runner.failures.is_empty() {
        println!("\nFailures:");
        for f in &runner.failures {
            println!("{f}");
        }
        std::process::exit(1);
    }
}
