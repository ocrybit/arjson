# weavepack-json conformance corpus

This directory contains the conformance test vectors for the JSON
profile of weavepack. See `../05-conformance.md` for the conformance
levels and acceptance criteria.

## Layout

```
test-vectors/
├── types/                round-trip vectors organized by value type
├── containers/           round-trip vectors for arrays and objects
└── deltas/               delta-update vectors
```

Each `.json` file is an **array of vectors**. The vector shape depends
on the directory:

### Round-trip vector (in `types/`, `containers/`)

```json
{
  "name": "human-readable name",
  "description": "what this tests",
  "input": <any JSON value>,
  "expected_bytes_hex": "hex bytes from enc(input)",
  "expected_decoded": <optional; only present when input ≠ decoded>
}
```

To verify:

```js
const bytes = enc(v.input)
assert(toHex(bytes) === v.expected_bytes_hex)
const decoded = dec(bytes)
assert(deepEqual(decoded, v.expected_decoded ?? v.input))
```

`expected_decoded` is set only when `input` cannot round-trip to itself
(e.g., `NaN` decodes back to `null` per RFC 8259).

### Delta vector (in `deltas/`)

```json
{
  "name": "human-readable name",
  "description": "what this tests",
  "initial": <any JSON value>,
  "update": <any JSON value>,
  "initial_delta_hex": "hex bytes of Delta_0",
  "expected_delta_bytes_hex": "hex bytes of Delta_1 (the update)",
  "expected_chain_bytes_hex": "hex bytes of toBuffer(deltas)",
  "expected_final": <JSON value after applying the update>
}
```

For chain vectors with multiple updates, the field name is `updates`
(plural) and `update_deltas_hex` is an array.

To verify:

```js
const arj = new ARJSON({ json: v.initial })
arj.update(v.update)
assert(toHex(arj.toBuffer()) === v.expected_chain_bytes_hex)
assert(deepEqual(arj.json, v.expected_final))

// also verify a fresh decoder restores the chain identically
const restored = new ARJSON({ arj: arj.toBuffer() })
assert(deepEqual(restored.json, v.expected_final))
```

## Generating

The corpus is generated from a curated input list in
`../../tools/generate-test-vectors.js`. To regenerate (e.g., after
extending the input list):

```bash
node weavepack/tools/generate-test-vectors.js
```

This overwrites the existing vectors with fresh bytes from the
JS reference encoder.

## Verifying

To check that all vectors round-trip cleanly through the reference
implementation:

```bash
node weavepack/tools/verify-test-vectors.js
```

Output: `Pass: N` and `Fail: 0` on success; exit code 1 if any vector
fails.

## Conformance levels

The corpus supports three conformance levels (see `../05-conformance.md`):

- **Level 1** (decoder): `dec(expected_bytes_hex) === expected_decoded`
- **Level 2** (encoder, semantic): `dec(your_encode(input)) === input`
- **Level 3** (byte-exact): `your_encode(input) === expected_bytes_hex`

Level 3 is the strictest; it requires byte-for-byte equality with the
reference encoder. Level 2 only requires the output to round-trip
correctly. Level 1 implementations are read-only.

## Coverage

The corpus is intentionally a partial coverage of the JSON profile —
it covers the major cases but not every edge case. Implementations
targeting full conformance should additionally pass the property-based
tests in `../../properties/` (Phase 4 deliverable; see roadmap).

The current corpus has:

- 68 round-trip vectors across types and containers
- 25 delta vectors across replace/add/remove/diff/splice/reanchor/chain

Coverage gaps that may be added in future revisions:

- Adversarial inputs (very deep nesting, very long strings)
- Edge cases in the strdiff format
- Numeric precision boundary cases (denormals, subnormals)
- Per-platform endianness verification
