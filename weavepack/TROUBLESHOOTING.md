# Weavepack troubleshooting

Common pitfalls when first using weavepack, and how to fix them.

## "decode mismatch" between my implementation and the reference

Most likely causes (in order of probability):

1. **UTF-16 vs Unicode scalar emission for strings**: the JS
   reference uses `string.length` semantics (UTF-16 code units),
   not Unicode scalars. A single 😀 emoji is `length === 2` in
   JS but `chars().count() === 1` in Rust/Python. The wire format
   stores `length × 16-bit code units`; non-BMP chars become
   surrogate pairs.

   Fix: use `String.encode_utf16` (Rust) or `s.encode("utf-16-le")`
   (Python) for string emit. Use `char::decode_utf16` /
   `bytes.decode("utf-16-le")` for decode.

2. **Floating-point precision in delta vectors**: the corpus
   stores f32 values as JSON numbers (which are doubles in JSON).
   When verifying, convert input → f32 → compare to expected with
   tolerance, not exact equality.

   Fix: use a tolerance like `abs(x - y) < max(1e-6, 1e-6 * abs(y))`
   for fp32 comparisons. Bit-exact comparison only works if both
   sides went through f32.

3. **Trailing structured-mode trailer**: the JS encoder emits an
   extra 5 bits at the end of structured payloads (mode bit +
   short(rcount=0)) when `single=false`. Even tensor encoders
   that don't push to vlinks/klinks/nums emit this trailer.

   Fix: include `add_dc(0, 1) + short_dc(rcount)` at end of
   encode for structured mode. This is what makes a 79-bit
   payload become 88 bits on the wire.

4. **Cross-language type narrowing**: int64/uint64 values are
   stored as decimal strings in JSON (since JS Number can't
   represent values > 2^53 exactly). When parsing, convert
   strings back to BigInt / int64.

## "data missing" parse errors in conformance

The fp16/bf16 vectors with non-finite values (Inf/NaN) store
their data under `data_raw_bits` (raw u16 bit patterns) instead
of `data` (which would require JSON to support Inf/NaN).

Fix: in your conformance runner's parse function, check for
`data_raw_bits` first; fall back to `data`.

## Tests fail after pulling weavepack branch

Most likely: stale `node_modules` or `target/`. Clean:

```bash
cd sdk && rm -rf node_modules && npm install
cd impl/rust && cargo clean && cargo build
```

The cross-language check requires all three lanes to be set up:

```bash
cd sdk && npm install
# Rust deps install on first cargo build
# Python has no deps for the PoC
```

## "module not found: weavepack-tensor-rs"

The PyO3 binding requires `maturin develop` to install:

```bash
pipx install maturin
cd impl/rust/weavepack-tensor-py
maturin develop
```

Without this, the PyO3 lane is skipped (not failed) in the
cross-language check.

## Encoder outputs differ from reference (Level 3 fail)

Multiple valid encoders may produce different bytes for the same
input. Common reasons:

- **Different RLE thresholds** (run if count >= 4 vs >= 3)
- **Different strdiff thresholds** (when to use string fast-diff
  vs full replace)
- **Object key ordering** (alphabetical vs insertion order)

Level 2 conformance only requires round-trip via reference decoder,
not byte-exact match. If your encoder produces different bytes that
still decode correctly, you have Level 2 (which is fine for general
data interchange).

For Level 3 (canonical hashing, content-addressed storage), match
the exact thresholds documented in the JSON profile's
`05-conformance.md`.

## "schema hash mismatch" for tensor schemaful

The schema canonicalization sorts tensor names alphabetically and
serializes with `JSON.stringify` (no extra whitespace). Both
sides must use the same canonical form before SHA-256.

Fix: implementations should call a shared `canonicalize_schema`
helper that produces a deterministic byte sequence, not rely on
default JSON serialization.

## "region_replace on unknown tensor"

The decoder threw because the delta references a tensor name that
wasn't in the base document. This means either:

1. You applied the delta to the wrong base
2. A previous delta in the chain removed the tensor
3. The chain is corrupted (out of order)

Fix: replay the chain from the anchor; never skip deltas.

## Decoded JSON doesn't match either input state (silent corruption)

Symptom: you concatenate two encoder outputs into one chain
buffer, decode, and get junk that's neither input.

```js
const a1 = enc({ a: 1 })
const a2 = enc({ x: "different" })
const chain = ARJSON.toBuffer([a1, a2])
new ARJSON({ arj: chain }).json   // ⇒ {"a":{}} or throws
```

This chain is malformed. A weavepack chain MUST contain exactly
one initial anchor followed by zero or more deltas — multiple
standalone anchors in one buffer breaks the decoder's running-
ARTable model. The second anchor gets mis-applied as a delta
against the first, producing either a decode exception or junk.

Fix: store each chain blob independently. Snapshot
`arj.toBuffer()` between the updates that would re-anchor; each
snapshot is its own self-contained chain. To know when re-anchor
happened, check `arj.deltas.length` after each `update()` —
re-anchor reduces it to 1.

See `weavepack/core/05-deltas.md` §"Encoder buffer policy on
re-anchor" for the protocol-level rule.

## Chain decodes correctly but my custom delta application differs

Likely cause: your delta-application path doesn't reset the
ARTable when it encounters a re-anchor (single-payload mode
payload past position 0). Re-anchor is only legal at position 0;
if you see structurally-anchor payloads later, the chain is
malformed (see prior section).

Fix: validate chains before consumption — every payload past
position 0 must start with mode bit 0 (structured mode).

## Cross-language check shows "FAIL" for one lane

Run that lane's conformance binary directly to see the specific
vector + diff:

```bash
node weavepack/tools/verify-test-vectors.js              # JS
cd impl/rust && cargo run -p weavepack-tensor --bin conformance  # Rust tensor
cd impl/rust && cargo run -p weavepack-json --bin conformance    # Rust JSON
python3 impl/python/conformance.py                       # Python JSON
python3 impl/python/conformance_tensor.py                # Python tensor
```

The cross-language script tail-truncates; the per-lane binaries
show full output.

## Benchmark numbers don't match WEAVEPACK.md

The headline numbers (387 vectors, 579× sparse delta) are from
specific reproducible measurements. Different inputs / hardware /
Node versions will produce slightly different timings but the
**byte counts** should match exactly.

If your byte counts differ:
- Check Node version (we test against v22)
- Check Rust toolchain (`rustup default stable`)
- Verify with `cargo build` rather than `cargo run` — debug-build
  artifacts shouldn't affect output bytes (only timing)

## Where to ask

- Spec questions: open an issue on the repo
- Implementation bugs: open an issue on the implementation in
  question (JS, Rust, or Python)
- Cross-impl disputes: see
  `weavepack/governance/06-spec-interpretation.md`
