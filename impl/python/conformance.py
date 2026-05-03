"""weavepack-json Python conformance runner.

Walks weavepack/profiles/json/test-vectors/ and validates that the
Python decoder agrees with the JS reference's expected_decoded values
for single-payload vectors.

Run from the repo root:
    python3 impl/python/conformance.py

Exit code 0 = all pass; exit code 1 = at least one failure.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from weavepack_json import decode

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "weavepack" / "profiles" / "json" / "test-vectors"

passes = 0
fails = 0
skips = 0
failures = []


def walk(d: Path):
    for entry in sorted(d.iterdir()):
        if entry.is_dir():
            yield from walk(entry)
        elif entry.suffix == ".json":
            yield entry


def values_equal(a, b):
    """JSON-level equality. Floats compared exactly (corpus is reference-
    encoded, so values round-trip to specific representations)."""
    return a == b


for vec_file in walk(VECTORS):
    rel = vec_file.relative_to(VECTORS)
    rel_str = str(rel)
    if rel_str.startswith(("deltas/", "containers/")):
        # Structured-mode: out of scope for v0.0.1 Python decoder.
        with open(vec_file) as f:
            try:
                vectors = json.load(f)
                skips += len(vectors)
            except Exception:
                pass
        continue

    with open(vec_file) as f:
        vectors = json.load(f)

    for v in vectors:
        name = v.get("name", "(unnamed)")
        hex_str = v.get("expected_bytes_hex", "")
        if not hex_str:
            skips += 1
            continue
        try:
            data = bytes.fromhex(hex_str)
            decoded = decode(data)
        except NotImplementedError:
            # Vector requires structured mode.
            skips += 1
            continue
        except Exception as e:
            fails += 1
            failures.append(f"{rel_str} :: {name}: exception: {e}")
            continue

        target = v.get("expected_decoded")
        if target is None:
            target = v.get("input")

        if not values_equal(decoded, target):
            fails += 1
            failures.append(
                f"{rel_str} :: {name}: decode mismatch\n"
                f"    expected: {target!r}\n"
                f"    actual:   {decoded!r}"
            )
            continue
        passes += 1

print(f"Pass: {passes}")
print(f"Fail: {fails}")
print(f"Skip: {skips} (structured-mode or non-byte-vectored)")

if fails:
    print("\nFailures:")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
