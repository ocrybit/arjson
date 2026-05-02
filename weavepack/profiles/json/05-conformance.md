# weavepack-json — 05: Conformance

**Status:** Draft. Retroactive spec of arjson v0.1.x as of 2026-05-03.

## Scope

This document specifies the conformance requirements for an
implementation of the JSON profile of weavepack, the structure of
the test vector corpus, and the acceptance criteria.

## Conformance levels

A weavepack-json implementation MAY claim one of three conformance
levels:

### Level 1 — Decoder

The implementation correctly decodes any byte sequence produced by
the JS reference encoder, recovering the original JSON value
(`decode(encode(json)) ≡_JSON json`) for all values in the corpus.

A Level 1 implementation MUST:

- Decode all wire mode dispatch cases (`01-types.md`)
- Decode all 8 vtype values, including the run-length and splice
  escapes
- Decode all 4 ktype values
- Decode all 64 single-payload tag values
- Decode chained deltas via the LEB128-prefixed framing (`04-deltas.md`)
- Apply delta operations (replace/add/remove/diff/splice) to recover
  intermediate JSON states

A Level 1 implementation MAY emit no bytes itself; it is read-only.

### Level 2 — Encoder

The implementation correctly encodes JSON values to byte sequences that
the JS reference decoder accepts and decodes back to the original
JSON value.

A Level 2 implementation MUST:

- Produce byte sequences satisfying all the structural requirements
  in `01-types.md` and `02-containers.md`
- Choose a wire mode (single vs structured) consistent with the
  reference encoder's choice for the given input
- Produce paths satisfying the path grammar (`03-paths.md`)
- Produce delta operations correctly when invoked with prior + new
  JSON values

A Level 2 implementation is NOT required to produce **byte-equal**
output to the reference encoder. Two valid encoders may disagree on:

- Strmap entry ordering (the strmap is rebuilt during decode anyway)
- Run-length thresholds (when to use RLE vs literal)
- Diff thresholds (when to emit string diff vs full replace)
- Number precision rounding (within the tolerance of IEEE 754
  binary64)

But both MUST produce byte sequences that the reference decoder
accepts.

### Level 3 — Reference

The implementation produces byte-equal output to the JS reference
encoder for all conformance corpus inputs. This is a stricter
requirement than Level 2 and is intended for consumers needing
deterministic byte output (e.g., for canonical hashing, signature
schemes, or content-addressed storage).

A Level 3 implementation MUST satisfy all Level 2 requirements PLUS:

- Use the same strmap entry ordering as the reference encoder
  (insertion order during the encode walk)
- Use the same RLE thresholds (run-length applies when count ≥ 4
  for vlinks/klinks, count ≥ 3 for nums)
- Use the same diff thresholds (length ≥ 20 + change-size < 60% of new)
- Use the same number scaling (precision = digit count after the
  point, capped at 308)
- Preserve object key insertion order verbatim

Level 3 conformance is required for implementations participating
in canonical hashing schemes or signature verification. Level 2 is
sufficient for general data interchange.

## Test corpus structure

The conformance corpus lives at
`weavepack/profiles/json/test-vectors/`. It is organized by the
spec section it tests:

```
test-vectors/
├── types/                       (01-types.md)
│   ├── primitives/
│   │   ├── null.json
│   │   ├── booleans.json
│   │   ├── integers.json
│   │   ├── floats.json
│   │   ├── strings.json
│   │   └── empty-collections.json
│   ├── numbers/
│   │   ├── max-safe.json
│   │   ├── precision-rounding.json
│   │   ├── scientific-notation.json
│   │   └── non-finite.json
│   ├── strings/
│   │   ├── ascii.json
│   │   ├── base64url.json
│   │   ├── unicode.json
│   │   ├── emoji.json
│   │   ├── control-chars.json
│   │   └── strmap-dedup.json
│   └── single-vs-structured.json
├── containers/                  (02-containers.md)
│   ├── arrays/
│   │   ├── empty.json
│   │   ├── homogeneous-primitives.json
│   │   ├── nested.json
│   │   ├── arrays-of-objects.json
│   │   └── mixed-types.json
│   ├── objects/
│   │   ├── empty.json
│   │   ├── single-key.json
│   │   ├── nested.json
│   │   ├── repeated-keys.json
│   │   └── special-char-keys.json
│   └── deeply-nested/
│       ├── 50-levels.json
│       └── 100-levels.json
├── paths/                       (03-paths.md)
│   ├── grammar/
│   │   ├── simple-keys.txt
│   │   ├── array-indices.txt
│   │   ├── escaped-brackets.txt
│   │   └── escaped-backslashes.txt
│   └── disambiguation/
│       ├── numeric-keys-vs-indices.txt
│       └── bracket-keys.txt
├── deltas/                      (04-deltas.md)
│   ├── replace/
│   │   ├── primitive-replace.json
│   │   ├── string-replace.json
│   │   └── nested-replace.json
│   ├── add/
│   │   ├── new-key.json
│   │   ├── new-array-element.json
│   │   └── new-nested-key.json
│   ├── remove/
│   │   ├── leaf-key.json
│   │   ├── nested-key.json
│   │   └── cascade-remove.json
│   ├── diff/
│   │   ├── short-string-no-diff.json
│   │   ├── long-string-with-diff.json
│   │   └── strmap-referenced-diff.json
│   ├── splice/
│   │   ├── insert-at-head.json
│   │   ├── insert-at-tail.json
│   │   ├── delete-range.json
│   │   └── replace-element.json
│   ├── reanchor/
│   │   ├── primitive-to-object.json
│   │   ├── object-to-primitive.json
│   │   └── empty-to-populated.json
│   └── chains/
│       ├── short-chain.json
│       ├── long-chain.json
│       └── reanchor-mid-chain.json
└── invariants/                   (algebraic laws)
    ├── round-trip.json
    ├── delta-correctness.json
    ├── composition.json
    └── identity.json
```

## Test vector format

Each test vector is a JSON file with one of two shapes:

### Round-trip vector (for types/, containers/)

```json
{
  "name": "human-readable-test-name",
  "description": "what this tests",
  "input": <any-JSON-value>,
  "expected_bytes_hex": "0a1b2c..."
}
```

The implementation runs `encode(input)` and compares the hex output to
`expected_bytes_hex` (Level 3) or runs `decode(encode(input))` and
compares to `input` (Level 2).

### Delta vector (for deltas/)

```json
{
  "name": "human-readable-test-name",
  "description": "what this tests",
  "initial": <any-JSON-value>,
  "update": <any-JSON-value>,
  "expected_delta_bytes_hex": "0a1b2c...",
  "expected_chain_bytes_hex": "0a1b2c...",
  "expected_final": <any-JSON-value>
}
```

The implementation:
1. Encodes `initial` to get `Delta_0`
2. Updates the running ARTable with `update` to get `Delta_1`
3. Compares `Delta_1` to `expected_delta_bytes_hex` (Level 3 only)
4. Concatenates `Delta_0 + Delta_1` and compares to
   `expected_chain_bytes_hex` (Level 3 only)
5. Decodes the chain and compares the final JSON to `expected_final`
   (all levels)

### Path vector (for paths/)

```
[path-grammar-test-format — TBD; likely a delimited textual format
listing path strings paired with expected component arrays]
```

### Invariant vector (for invariants/)

A property-based test corpus, not literal vectors. Each entry
specifies:

- A generator strategy (e.g., "random JSON tree of depth ≤ 5,
  size ≤ 100")
- The number of cases to generate
- The invariant to check (round-trip, delta-correctness, etc.)
- A deterministic seed for reproducibility

The conformance runner generates cases from the seed, runs the
implementation, and checks each case against the invariant.

## Reference test data

The initial corpus is extracted from the JS reference test suite
at `sdk/test/`. The mapping from current tests to corpus vectors:

| Test file | Maps to |
|---|---|
| `test/edge-cases.js` (empty structures, special JS values) | `types/primitives/empty-collections.json`, `types/numbers/non-finite.json` |
| `test/edge-cases.js` (large numbers) | `types/numbers/max-safe.json` |
| `test/edge-cases.js` (string edge cases) | `types/strings/control-chars.json`, `types/strings/emoji.json`, `types/strings/unicode.json` |
| `test/edge-cases.js` (deep nesting) | `containers/deeply-nested/*.json` |
| `test/regression.test.js` (interface lock) | `invariants/round-trip.json` |
| `test/delta-invariants.test.js` | `invariants/delta-correctness.json`, `invariants/composition.json` |
| `test/golden.test.js` (byte-exact tests) | `expected_bytes_hex` fields across multiple files |
| `test/fuzz.test.js` (property-based) | `invariants/round-trip.json` |
| `test/edge-cases.js` (special-character keys) | `containers/objects/special-char-keys.json` |

The extraction process is (will be) automated via a script that
reads each test file, runs the test inputs through the encoder,
captures the output bytes, and emits the corresponding vector JSON.

## Acceptance criteria

A conformance run produces a report indicating:

- Number of vectors attempted
- Number of vectors passing
- For each failing vector: the input, expected output, actual output,
  and a unified diff

For Level 1: 100% of round-trip and delta-correctness vectors must
pass.

For Level 2: 100% of round-trip vectors PLUS the implementation's
output for any input must round-trip via the reference decoder. (The
reference decoder is shipped as a "verifier binary" alongside the
test corpus.)

For Level 3: 100% of all vectors with byte-exact match (where
expected_bytes_hex is specified).

## Validation against future revisions

When the wire format changes (a v2 release), the test corpus is
versioned: `test-vectors/v1/` and `test-vectors/v2/` exist side by
side. Implementations declare which version(s) they target.

The `weavepack-core` extension gate (`07-extensions.md` of the core
spec) provides a forward-compatibility mechanism so v1 decoders can
gracefully refuse v2 payloads instead of corrupting state. This is
not a v1 spec issue but is mentioned here for context.

## Tooling

The conformance test runner is provided as part of the JS reference
implementation:

```bash
cd sdk
npm run conformance:json
```

This runs all vectors at the implementation's claimed level. To run
at a specific level:

```bash
npm run conformance:json -- --level 1
npm run conformance:json -- --level 2
npm run conformance:json -- --level 3
```

Test runners for other languages should follow the same CLI
convention so that a multi-implementation conformance matrix can be
auto-generated.

## Open issues

These are deliberately deferred to Phase 5+:

1. **Cross-language hash anchoring**: Level 3 byte-exact conformance
   requires a normative description of every implementation choice
   (sort order, threshold values, etc.). Some are not yet fully
   pinned in the spec text and require more careful documentation
   when a second implementation appears.

2. **Streaming conformance**: the test corpus assumes whole-payload
   encode/decode. Streaming-mode conformance (incremental encode of
   a large array, etc.) needs a separate vector type.

3. **Adversarial decoder safety**: vectors crafted to trigger DoS
   (very long run-length, very deep nesting, etc.) belong in
   `weavepack-core/08-security.md`'s test corpus, not in the JSON
   profile corpus.
