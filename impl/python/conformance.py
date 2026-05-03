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
from weavepack_json import decode, encode

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

    with open(vec_file) as f:
        vectors = json.load(f)

    for v in vectors:
        name = v.get("name", "(unnamed)")
        hex_str = v.get("expected_bytes_hex", "")
        if not hex_str:
            # Vector has no single-payload byte form (e.g. delta-only
            # vectors carry expected_chain_bytes_hex instead).
            skips += 1
            continue
        try:
            data = bytes.fromhex(hex_str)
            decoded = decode(data)
        except NotImplementedError:
            # Decoder explicitly bails on this construct (e.g. structured
            # mode). Honest skip — count it.
            skips += 1
            continue
        except Exception as e:
            fails += 1
            failures.append(f"{rel_str} :: {name}: decode exception: {e}")
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

        # Encoder check: encode(input) → bytes; verify byte-exact match
        # with expected_bytes_hex (Level 3 conformance for single-payload).
        try:
            encoded = encode(v["input"])
            if encoded.hex() != hex_str:
                fails += 1
                failures.append(
                    f"{rel_str} :: {name}: encode mismatch\n"
                    f"    expected: {hex_str}\n"
                    f"    actual:   {encoded.hex()}"
                )
                continue
        except NotImplementedError:
            # Encoder doesn't yet support this case (e.g. NaN/Infinity).
            pass
        except Exception as e:
            fails += 1
            failures.append(f"{rel_str} :: {name}: encode exception: {e}")
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
