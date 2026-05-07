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
from weavepack_json import decode, encode, decode_chain, wrap_payload, peek_header, PID

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "weavepack" / "profiles" / "json" / "test-vectors"

passes = 0
fails = 0
skips = 0
encode_passes = 0
encode_skips = 0
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

    is_v12 = rel_str.startswith("v1.2/") or rel_str.startswith("v1.2\\")

    for v in vectors:
        name = v.get("name", "(unnamed)")
        chain_hex = v.get("expected_chain_bytes_hex", "")
        hex_str = v.get("expected_bytes_hex", "")

        # ── v1.2 envelope vectors ──────────────────────────────────────────────
        if is_v12:
            if not hex_str:
                skips += 1
                continue
            try:
                # Encode the inner payload and wrap with the v1.2 JSON header.
                inner = encode(v["input"])
                wrapped = wrap_payload(inner, PID["JSON"])
                if wrapped.hex() != hex_str:
                    fails += 1
                    failures.append(
                        f"{rel_str} :: {name}: v1.2 wrap mismatch\n"
                        f"    expected: {hex_str}\n"
                        f"    actual:   {wrapped.hex()}"
                    )
                    continue
                # Decode by stripping the header then decoding the inner payload.
                result = peek_header(bytes.fromhex(hex_str))
                if result is None:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: peek_header returned None for v1.2 bytes")
                    continue
                if result["profile_id"] != PID["JSON"]:
                    fails += 1
                    failures.append(f"{rel_str} :: {name}: wrong profile_id: {result['profile_id']}")
                    continue
                decoded = decode(result["payload"])
                target = v.get("expected_decoded")
                if target is None:
                    target = v.get("input")
                if not values_equal(decoded, target):
                    fails += 1
                    failures.append(
                        f"{rel_str} :: {name}: v1.2 decode mismatch\n"
                        f"    expected: {target!r}\n"
                        f"    actual:   {decoded!r}"
                    )
                    continue
                encode_passes += 1
                passes += 1
            except Exception as e:
                fails += 1
                failures.append(f"{rel_str} :: {name}: v1.2 exception: {e}")
            continue

        # ── delta chain vectors ────────────────────────────────────────────────
        if chain_hex:
            try:
                chain_data = bytes.fromhex(chain_hex)
                decoded = decode_chain(chain_data)
            except Exception as e:
                fails += 1
                failures.append(f"{rel_str} :: {name}: chain decode exception: {e}")
                continue

            target = v.get("expected_final")
            if not values_equal(decoded, target):
                fails += 1
                failures.append(
                    f"{rel_str} :: {name}: chain decode mismatch\n"
                    f"    expected: {target!r}\n"
                    f"    actual:   {decoded!r}"
                )
                continue
            passes += 1
            continue

        if not hex_str:
            skips += 1
            continue

        try:
            data = bytes.fromhex(hex_str)
            decoded = decode(data)
        except NotImplementedError:
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
            encode_passes += 1
        except NotImplementedError:
            encode_skips += 1
        except Exception as e:
            fails += 1
            failures.append(f"{rel_str} :: {name}: encode exception: {e}")
            continue
        passes += 1

# ── core security adversarial vectors ─────────────────────────────────────────
SECURITY_ROOT = REPO_ROOT / "weavepack" / "core" / "test-vectors" / "security"

if SECURITY_ROOT.exists():
    for vec_file in sorted(SECURITY_ROOT.glob("*.json")):
        rel = "core/security/" + vec_file.name
        with open(vec_file) as f:
            sec_vectors = json.load(f)
        for v in sec_vectors:
            name = v.get("name", "(unnamed)")
            hex_str = v.get("input_bytes_hex", "")
            expected = v.get("expected_behavior", "refusal")
            if not hex_str:
                skips += 1
                continue
            try:
                decode(bytes.fromhex(hex_str))
                if expected == "refusal":
                    fails += 1
                    failures.append(f"{rel} :: {name}: expected refusal but decoded successfully")
                else:
                    passes += 1
            except Exception:
                if expected == "refusal":
                    passes += 1
                else:
                    fails += 1
                    failures.append(f"{rel} :: {name}: unexpected decode error")

print(f"Pass: {passes}")
print(f"Fail: {fails}")
print(f"Skip: {skips} (structured-mode or non-byte-vectored)")
print(f"  encoder verified byte-exact for {encode_passes} of {encode_passes + encode_skips} vectors "
      f"({encode_skips} skipped via NotImplementedError)")

if fails:
    print("\nFailures:")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
