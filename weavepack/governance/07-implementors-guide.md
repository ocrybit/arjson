# weavepack — Getting Started for External Implementors

**Status:** Active. Phase 7 of the weavepack roadmap.

This document is for anyone who wants to write a new weavepack
implementation — in a new language, for a new runtime, or as an
independent verification of the spec.

## Why implement weavepack?

weavepack is a binary protocol for structured data and tensors.
If you need any of the following, an independent implementation
might be useful:

- Compact binary encoding for JSON-shaped data (weavepack-json)
- Efficient tensor storage + delta streaming (weavepack-tensor)
- A format with a genuine protocol/profile boundary, making it
  easy to add your own data types without forking the framing

## Before you start

Read, in order:

1. `weavepack/core/00-introduction.md` — design philosophy and goals
2. `weavepack/core/01-data-model.md` — the abstract data model
3. `weavepack/core/02-wire-format.md` — framing: header, columns, footer
4. `weavepack/core/03-bit-encoding.md` — bit-level primitives (LEB128,
   short-int, bit-packed columns)
5. `weavepack/core/04-strmap.md` — string deduplication table
6. `weavepack/core/05-deltas.md` — delta-update payloads
7. Then the profile spec you want to implement:
   - **weavepack-json**: `weavepack/profiles/json/01-types.md` …
     `05-conformance.md`
   - **weavepack-tensor**: `weavepack/profiles/tensor/00-overview.md` …
     `06-schemas.md`

The spec docs are prose-first and contain worked examples with
hex dumps. You should be able to implement from them without
reading the JS source. (The Python proof-of-concept in
`impl/python/` was written that way as a verification.)

## Choosing a starting point

### Decoder-only (Level 1)

Easiest entry point. Pick one profile and implement `decode`.
You do not need an encoder. You can drive your tests entirely from
the `expected_bytes_hex` field in the conformance corpus.

Good for: read-heavy pipelines (model serving, log analysis),
language environments where allocation costs make an encoder
impractical.

### Encoder + round-trip (Level 2)

Implement `encode` too. Your encoder does not have to produce the
same bytes as the reference; it just has to produce bytes that the
reference decoder round-trips correctly.

Good for: general use, storage backends that need to write payloads.

### Reference-equivalent (Level 3)

Your encoder must produce byte-for-byte the same output as the JS
reference for every input in the conformance corpus. This is the
highest claim and the hardest to achieve. Most of the existing
implementations are at this level because it's the easiest to
verify (compare hex strings).

Good for: cross-language interop testing, proving spec completeness.

## Conformance test corpus

The conformance corpora live in:

```
weavepack/profiles/json/test-vectors/    — 93 vectors (JSON profile)
weavepack/profiles/tensor/test-vectors/  — 55 vectors (tensor profile)
```

Each corpus directory contains `.json` files. Each file is an array
of vector objects. The vector shape is documented in:

- `weavepack/profiles/json/test-vectors/README.md`
- `weavepack/profiles/tensor/05-conformance.md`

### Round-trip vector schema (JSON profile)

```json
{
  "name": "human-readable name",
  "description": "what this tests",
  "input": <any JSON value>,
  "expected_bytes_hex": "NN NN NN ...",
  "expected_decoded": <only present when input ≠ decoded>
}
```

### Tensor vector schema

```json
{
  "name": "...",
  "kind": "roundtrip" | "delta" | "schemaful",
  "input": { "dtype": "...", "shape": [...], "data_b64": "..." },
  "expected_bytes_hex": "NN NN ...",
  "delta": { ... }
}
```

Some vectors use `"data_raw_bits"` instead of `"data_b64"` for
non-finite float values (NaN variants, ±Inf). The value is an
array of 32-bit unsigned integers representing the raw bit pattern
of each element.

### Minimum viable conformance runner

```python
import json, pathlib, binascii

corpus_dir = pathlib.Path("weavepack/profiles/json/test-vectors")

pass_count = fail_count = 0
for f in corpus_dir.rglob("*.json"):
    for v in json.loads(f.read_text()):
        expected = bytes.fromhex(v["expected_bytes_hex"].replace(" ", ""))
        actual   = your_encode(v["input"])
        if actual == expected:
            pass_count += 1
        else:
            print(f"FAIL {v['name']}")
            print(f"  expected: {expected.hex()}")
            print(f"  actual:   {actual.hex()}")
            fail_count += 1

print(f"Pass: {pass_count}  Fail: {fail_count}")
```

Replace `your_encode` with your encoder. For Level 1 (decoder only),
replace the comparison with a decode + deep-equal check instead.

## Reference implementation

The JS reference lives in `sdk/src/`. Entry points:

- **weavepack-json**: `sdk/src/arjson.js` (exports `ARJSON`, `enc`, `dec`)
- **weavepack-tensor**: `sdk/src/profiles/tensor/index.js`
  (exports `encodeDocument`, `decodeDocument`, `TensorPack`, `DTYPE`, …)

You can run the JS reference against the corpus:

```sh
node weavepack/tools/verify-test-vectors.js
# Pass: 148  Fail: 0
```

Use this as a cross-check when your implementation disagrees with
the corpus. If the corpus and the reference disagree, that is a
spec bug — file an issue.

## Existing implementations to read

These are all in-repo and all derived from the same JS source, but
useful for seeing how the spec maps to different languages:

| Language | Location | Profiles | Notes |
|----------|----------|----------|-------|
| JavaScript | `sdk/src/` | json + tensor | reference |
| Rust | `impl/rust/weavepack-tensor/` | tensor | uses `weavepack-core` crate |
| Rust | `impl/rust/weavepack-json/` | json | decoder only (L2); encoder pending |
| Python 3.10+ | `impl/python/` | json (partial) + tensor | pure-Python; conformance.py + conformance_tensor.py |
| Python via PyO3 | `impl/rust/weavepack-tensor-py/` | tensor | Rust crate with Python bindings |

The Python PoC (`impl/python/`) is the closest to "how a new
implementor would read the spec" — it was written from the spec
docs, not translated from the JS source. If you are implementing
from scratch, reading it alongside the spec may be helpful.

## Conformance badges

Once your implementation passes all vectors for a profile + level,
you can claim a conformance badge. Badge SVGs live at:

```
weavepack/badges/json/L3.svg
weavepack/badges/tensor/L2.svg
weavepack/badges/tensor/L3.svg
```

Add to your README:

```markdown
[![weavepack-json L3](https://raw.githubusercontent.com/weavedb/arjson/weavepack/weavepack/badges/json/L3.svg)](https://github.com/weavedb/arjson/blob/weavepack/weavepack/governance/04-conformance-certification.md)
```

For tensor L2 or L3, swap the path accordingly.

See `weavepack/governance/04-conformance-certification.md` for the
full claim format and what each level means.

## Registering your implementation

Once you have a working implementation:

1. Verify it passes the conformance corpus (exit code 0).
2. Write the conformance claim block in your README
   (template in `04-conformance-certification.md`).
3. Open an issue on this repository titled:
   `Implementation registration: <your-impl-name>`
   and fill in:
   - Implementation name + repo URL
   - Language(s) / platform(s)
   - Profiles supported with version + claimed level
   - Command to reproduce the conformance run
   - Last verified date
   - Maintainer GitHub handle
4. A maintainer will run the conformance check locally and add
   your entry to `weavepack/governance/05-implementation-registry.md`.

The bar is: your conformance command works on a clean checkout.
No other vetting.

## Getting help

- Read `weavepack/TROUBLESHOOTING.md` first.
- Open an issue on the spec repo for spec ambiguities. If two
  implementations disagree on what a spec passage means, that is
  a spec bug. See `weavepack/governance/06-spec-interpretation.md`
  for how spec disagreements are resolved.
- Open a discussion for design questions (e.g., "I want to add
  streaming support — is there a natural extension point?").

## Proposing changes (RFC)

If you find that the spec is missing something you need, and it
would require a wire-format change, propose an RFC:

```
weavepack/rfcs/NNNN-<short-name>.md
```

See `weavepack/governance/01-rfc-process.md` for the format and
process. RFC 0001 (`weavepack/rfcs/0001-tensor-fp16-bf16.md`) is
a concrete example.

## Checklist for a new implementation

- [ ] Read the relevant core + profile spec docs
- [ ] Implement decode (Level 1)
- [ ] Run the corpus decoder check: all vectors round-trip
- [ ] Implement encode (Level 2)
- [ ] Run the corpus encoder check: all `expected_bytes_hex` match
      OR reference decoder accepts your bytes and round-trips them
- [ ] (Optional) Achieve Level 3 byte-equivalence
- [ ] Write conformance claim in your README
- [ ] Register in `05-implementation-registry.md` via issue

That's it. The barrier is intentionally low so that implementations
accumulate and the protocol gains real multi-language coverage.
