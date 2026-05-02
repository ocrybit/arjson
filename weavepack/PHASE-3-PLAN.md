# Phase 3 — Implementation Plan

**Status:** In progress.

This document outlines the strategy for refactoring `sdk/src/` to
match the protocol/profile boundary established in Phases 1 and 2.

## Goal

Restructure the JS reference so:

- `sdk/src/core/` contains profile-agnostic encoder/decoder/builder/
  artable infrastructure
- `sdk/src/profiles/json/` contains JSON-specific type vocabulary,
  diff algorithm, path grammar, and delta op vocabulary
- A new profile can be added by writing a sibling `profiles/<name>/`
  without touching `sdk/src/core/`
- All 367 existing regression tests pass unchanged
- Wire format is unchanged (no v2 break)

## Approach: incremental extraction

The current code is tightly coupled — JSON-specific values appear
inline as numeric constants throughout `encoder.js` / `decoder.js`.
A "big bang" refactor risks breaking many tests at once. Instead,
this plan extracts JSON-specific surfaces **one at a time**, each
landing as its own commit with the regression suite passing.

The extractions, in dependency order (easiest first):

### Stage 3.1 — Type vocabulary manifest

Create `sdk/src/profiles/json/types.js` documenting the JSON-specific
constants used elsewhere. Initially, this is a **declarative manifest**
that doesn't change behavior — encoder/decoder still use inline
constants. The manifest serves as:

- The source of truth other extractions reference
- The foundation a future `null` profile copies and modifies
- A self-test for "is this constant JSON-specific or core?"

### Stage 3.2 — Diff algorithm extraction

Move the JSON-specific diff (top-level `diff()` + `diffArray` +
helpers) from `arjson.js` into `sdk/src/profiles/json/diff.js`.

The diff is profile-specific because:
- It dispatches on `Array.isArray(v)` and `typeof v === "object"` —
  JSON's container shapes
- It uses `.` and `[]` path syntax — JSON's path grammar
- It assumes 4 primitive types — JSON's value space
- It coerces non-finite numbers to null — JSON's number semantics

This extraction is the cleanest because diff has no callers outside
`arjson.js` itself.

### Stage 3.3 — Path grammar extraction

Move `parsePath`, `parsePathStrict`, `escapeKey` from `utils.js` to
`sdk/src/profiles/json/paths.js`. The path grammar is JSON-specific
(other profiles will define their own). Update `artable.js` to import
from the new location.

### Stage 3.4 — String-fast-diff extraction

Move `diff.js` (the byte-aligned fast-diff format) to
`sdk/src/profiles/json/strdiff.js`. While the byte-aligned varint
format is generic, the choice to use it for string updates is JSON-
specific. Other profiles may use different diff strategies for their
data types.

### Stage 3.5 — Single-payload tag dispatch

Extract the single-payload encode logic from `encoder.js` `encode()`
function (the if-else chain handling null/bool/int/float/string/empty
values) into `profiles/json/single-payload.js`. The decoder's
`getSingle()` similarly extracts to the profile. Same with structured-
mode `_encode()` value-type dispatch.

This is the largest extraction. The encoder needs to call into the
profile descriptor for "given this JS value, what's its vtype, and
how do I emit its payload?" rather than hardcoding the dispatch.

### Stage 3.6 — Builder extraction

`builder.js` currently has hardcoded vtype interpretation. Move the
JSON-specific build logic to `profiles/json/build.js`. The core
builder becomes a generic walker that consumes the profile's
`getVal(vtype, columns) → value` function.

### Stage 3.7 — Refactor index.js + add profile descriptor

After all extractions, `arjson.js` becomes the JSON profile entry
point in `sdk/src/profiles/json/index.js`. The new `sdk/src/index.js`
exports:

```js
import { ARJSON } from "./profiles/json/index.js"
import { weavepack } from "./core/index.js"

export { ARJSON, weavepack }
```

Where `weavepack` is the core protocol API (encoder/decoder factory)
that takes a profile descriptor.

### Stage 3.8 — Validate with null profile

Implement `sdk/src/profiles/null/index.js` — a trivial profile that:

- Has a single value type (call it `unit`, like `()` in ML)
- Has no containers
- Has no path grammar (paths always `""`)
- Has no delta ops (every update is a re-anchor)

Validate that the null profile works without modifying anything in
`sdk/src/core/`. If touching core is required, the boundary leaks —
file as a Phase 3 bug, fix, repeat.

## Test discipline

Before each stage:
1. Run `cd sdk && npm test` — must be 367 passing
2. Run the conformance corpus: `node weavepack/tools/verify-test-vectors.js`
   — must be 93/0 pass/fail

After each stage:
1. Same. No tests should regress.

If a stage breaks tests, revert and try a smaller extraction. The
regression suite is the safety net; respect it.

## Wire format stability

Phase 3 MUST NOT change the wire format. All payloads encoded by the
post-refactor code MUST be byte-equivalent to pre-refactor code for
the same input. This is enforceable via the conformance corpus
(byte-exact vectors).

If a refactor inadvertently changes byte output, the corpus will
catch it. Don't proceed with the refactor until the corpus passes.

## Anticipated friction points

These are the JSON-specific surfaces hardest to extract cleanly:

1. **Splice/delete escapes in vtypes column**: vtype 0 + count escape
   carries (index, remove, type3) which is JSON array splice semantics.
   Other profiles may not have arrays, so the splice escape is JSON-
   specific. But it's encoded in a column the core defines. The boundary
   is fuzzy — likely the core defines "vtype 0 escape" as a generic
   slot, and the profile fills in its meaning.

2. **Single-payload tag space**: the 64-tag space is JSON-shaped (6
   special values + 3 number paths + 53 char tags + 4 multi-char tags).
   Other profiles use different tag layouts. The core defines "single-
   payload mode = 1-bit selector + 6-bit tag"; the profile fills in
   the tag→value mapping.

3. **Number encoding**: the precision + mantissa form is JSON-specific
   (matches IEEE 754 binary64). A tensor profile may emit raw float32
   bytes. The core's `nums` column is generic; the profile decides the
   per-entry semantics.

4. **strmap charset**: the `[A-Za-z0-9-_]` (base64url) and `[A-Za-z]`
   (single-char strmap) alphabets are JSON-tuned. Other profiles may
   use ASCII-only or even non-alphabetic alphabets. Core defines "the
   profile picks an alphabet"; profile fills in.

Resolution for each: the profile descriptor exports the value and the
core machinery reads it. No inline constants.

## Profile descriptor contract

The `ProfileDescriptor` interface (informal):

```js
export const profile = {
  // Identity
  id: "json",                                  // matches profile-id in registry
  version: "1.1",

  // Type vocabulary
  vtypeBits: 3,                                 // bits per vtype
  ktypeBits: 2,                                 // bits per ktype

  // Value space dispatch (encoder)
  getVtype: (v) => /* vtype number */,
  encodeValue: (encoder, v, vtype) => /* writes to value column */,

  // Value reconstruction (decoder)
  decodeValue: (decoder, vtype) => /* reads value */,
  buildValue: (artable, vtype, position) => /* materializes value */,

  // Container dispatch
  getKtype: (k, parentContainerType) => /* ktype number */,

  // Path grammar
  parsePath: (path) => /* array of key/index components */,
  emitPath: (components) => /* path string */,

  // Diff algorithm
  diff: (oldValue, newValue) => /* array of delta ops */,

  // Single-payload eligibility
  isSinglePayload: (v) => /* true if v fits single-payload mode */,
  encodeSingle: (encoder, v) => /* writes single-payload tag + payload */,
  decodeSingle: (decoder) => /* reads single-payload tag and returns value */,
}
```

The exact shape may evolve during the extraction. The above is the
target.

## Stage tracking

- [x] 3.0 (this doc): plan written
- [x] 3.1: type vocabulary manifest
- [x] 3.2: diff algorithm extraction
- [x] 3.3: path grammar extraction
- [x] 3.4: string-fast-diff extraction
- [x] 3.5a: encode extraction (encoder-side dispatch moved to profiles/json/encode.js)
- [x] 3.6: builder extraction (whole builder.js moved to profiles/json/)
- [ ] 3.5b: decode extraction (decoder-side: getSingle, getNums, getVtypes, getKtypes, getKeys still in src/decoder.js)
- [ ] 3.7: index.js refactor + profile descriptor finalized
- [ ] 3.8: null-profile validation gate
