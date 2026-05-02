# weavepack-json — 01: Value Types

**Status:** Draft. Retroactive spec of arjson v0.1.x as of 2026-05-03.

## Scope

This document specifies the value-type vocabulary of the JSON profile of
weavepack and how each value type is encoded on the wire. It does NOT
cover container shapes (objects, arrays — see `02-containers.md`), path
syntax (`03-paths.md`), delta operations (`04-deltas.md`), or test
vectors (`05-conformance.md`).

The JSON profile encodes the value space of [RFC 8259 (JSON)](
https://www.rfc-editor.org/rfc/rfc8259):

```
JSON-value = null | boolean | number | string | array | object
```

Internally, weavepack-json discriminates between several encoding
classes for numbers and strings to maximize bit density. These are
implementation-level distinctions; the decoded value is always one of
the six JSON types above.

## Wire mode dispatch

The first bit of every weavepack-json payload (the `dc` column) selects
the wire mode:

| bit 0 | mode | use |
|---|---|---|
| `1` | **single** | The entire payload is one primitive or one empty container. |
| `0` | **structured** | The payload contains at least one non-empty container. |

The remainder of the wire envelope is interpreted differently per mode.

## Single-payload mode (bit 0 = `1`)

After the leading `1` bit, a 1-bit selector and a 6-bit tag determine
the value:

```
1 [s] [tag6]
```

**If `s` = `1` (positive integer fast path):**

- `tag6` ∈ [0, 62]: the value is `tag6` (a non-negative integer in [0, 62])
- `tag6` = 63: the value is `63 + leb128()` where the leb128 immediately
  follows in the `dc` column

**If `s` = `0`:**

`tag6` selects the value type:

| `tag6` | meaning | payload follows |
|---|---|---|
| 0 | `null` | — |
| 1 | `true` | — |
| 2 | `false` | — |
| 3 | `""` (empty string) | — |
| 4 | `[]` (empty array) | — |
| 5 | `{}` (empty object) | — |
| 6 | negative integer | `uint_dc()` (magnitude) |
| 7 | positive float | `uint_dc()` (precision), `uint_dc()` (scaled mantissa) |
| 8 | negative float | `uint_dc()` (precision), `uint_dc()` (scaled mantissa) |
| 9..60 | single character A–Z, a–z | — (character recovered from strmap index `tag6 - 9`) |
| 61 | single non-base64url character | `leb128_2()` (UTF-16 code unit) |
| 62 | multi-character base64url string | `short()` (length), then `length × 6` bits (base64url indices) |
| 63 | multi-character non-base64url string | `short()` (length), then `length` × `leb128_2()` (UTF-16 code units) |

The `uint_dc()`, `short()`, `leb128_2()`, and `leb128()` primitives are
defined in `weavepack-core/03-bit-encoding.md`. Briefly:

- `short()` is a 2-bit prefix selecting a 2-, 3-, 4-, or leb128-bit
  field, biased toward small values (≤ 16)
- `uint_dc()` is similar but biased toward small unsigned ints (≤ 64)
- `leb128_2()` is byte-aligned LEB128 (8-bit groups, MSB continuation)

The base64url alphabet is `[A-Za-z0-9-_]` with index 0 = `A`, 1 = `B`,
…, 25 = `Z`, 26 = `a`, …, 51 = `z`, 52 = `0`, …, 61 = `9`, 62 = `-`,
63 = `_`.

The strmap (single-char) alphabet is `[A-Za-z]` with index 0 = `A`,
1 = `B`, …, 25 = `Z`, 26 = `a`, …, 51 = `z`. This is a strict subset
of the base64url alphabet; the strmap is intentionally shorter to fit
single-character special values into the unused tag space.

## Structured-payload mode (bit 0 = `0`)

In structured mode, value types are encoded in the `vtypes` column as
3-bit values, with run-length coding for repeated types and a special
3-bit-zero escape that marks array/object container starts. The `vtypes`
column is read after the column header sequence defined in
`weavepack-core/02-wire-format.md`.

### Value type tags (3-bit)

| `vtype` | name | meaning | value column |
|---|---|---|---|
| 0 | `undefined` | Internal marker used by the diff/delta machinery. Never appears in a successfully decoded user-visible JSON tree; folds to `null` if reached. | — |
| 1 | `null` | JSON `null` | — |
| 2 | `string-base64url` | UTF-16 string consisting only of `[A-Za-z0-9-_]` characters, OR a strmap reference to a previously seen string, OR a fast-diff patch against a prior string | `vals` (and `strdiffs` for diffs) |
| 3 | `boolean` | JSON `true` or `false` | `bools` |
| 4 | `int+` | Non-negative integer that fits in IEEE 754 binary64 with no fractional part | `nums` |
| 5 | `int-` | Negative integer | `nums` (magnitude) |
| 6 | `float-or-empty-container` | Positive or negative number with decimal precision, OR a marker for an empty array `[]` or empty object `{}` opened mid-tree | `nums` |
| 7 | `string-fallback` | UTF-16 string with at least one character outside the base64url alphabet | `vals` |

### Run-length encoding of vtypes

The `vtypes` column uses a 3-bit-zero escape for run-length and
splice/delete metadata:

- **Plain type** (`vtype` ∈ [1, 7]): the 3 bits literally give the vtype.
- **Run** (`vtype` = 0, then `count = short()`, `count > 0`): `count`
  consecutive slots all have the same type, given by the next 3 bits.
- **Splice/delete metadata** (`vtype` = 0, then `short()` = 0, then a
  1-bit escape selector): describes update operations on existing
  arrays. Detailed in `04-deltas.md`. For initial-payload encoding
  (no deltas applied), this escape does not appear.

### Number encoding (vtypes 4, 5, 6)

The `nums` column carries integer magnitudes and float scaled-mantissas.
A delta-pack encoding (`dint`) is used so monotone or near-monotone
integer sequences compress well.

For **positive integers** (vtype 4) and **negative integers** (vtype 5):
the `nums` column carries the magnitude. The sign is determined by the
vtype.

For **floats** (vtype 6), the `nums` column carries:

1. A precision marker `p` (number of decimal digits after the point,
   biased by 1 for empty-container detection):
   - `p = 0` → empty `[]` (only valid as a container-level marker)
   - `p = 1` → empty `{}` (only valid as a container-level marker)
   - `p = 2` → unscaled (rare; `Math.round(v * 10^1)` happens to be the
     value)
   - `p ≥ 2` → number is scaled by `10^(p-1)`
2. (If `p ≥ 2`): the integer mantissa = `Math.round(|v| * 10^(p-1))`
3. The sign is encoded in the precision marker's high half: `p ≥ 4`
   means negative; subtract 4 to recover the positive precision.

The "p = 0 means `[]`" and "p = 1 means `{}`" cases are how the encoder
emits empty containers that appear inside a structured tree, since they
have no per-element vtype slots of their own and need a placeholder.
At the top level, empty containers use single-payload mode tags 4 and 5.

### Boolean encoding (vtype 3)

The `bools` column is a length-prefixed bit-RLE column. After determining
the count of vtype-3 slots from the `vtypes` column, the decoder reads:

- 2-bit mode prefix:
  - `00` = all zeros (no body)
  - `01` = all ones (no body)
  - `10` = mixed (`count` raw bits follow, MSB first per byte)
  - `11` = reserved

If `count` is zero, the prefix is omitted entirely.

This RLE prefix is the v1.1 wire-format change relative to v1.0. v1.0
always wrote the raw body without the 2-bit prefix.

### String encoding (vtypes 2 and 7)

Strings have three sub-modes selected by a 1- or 2-bit header in the
`vals` column following the `short()` length prefix:

**vtype 2 (base64url-eligible):**

A `short()` length is read first.

- If `length = 0`:
  - 1-bit selector follows
    - `0` = strmap reference: `short()` index into the strmap
    - `1` = strdiff: a reference to a fast-diff patch in `strdiffs`
- If `length > 0`: `length × 6` bits follow, each a base64url alphabet
  index for the next character. The string is literal.

**vtype 7 (non-base64url):**

A `short()` length is read first, then `length × leb128_2()` UTF-16
code units. The string contains at least one character outside the
base64url alphabet.

When a string of length ≥ 2 first appears in a payload (and is not
strmap-referenced or strdiff-patched), the encoder writes it literally
under vtype 2 (if base64url-eligible) or vtype 7. On subsequent
occurrences within the same payload, the encoder emits a strmap
reference under vtype 2 with `length = 0`. Empty strings (`""`) at
the top level use single-payload tag 3; nested empty strings use
vtype 2 with a `length = 1` placeholder followed by no bits.

### `undefined` (vtype 0)

JSON has no `undefined`. The `undefined` type appears only as an
internal marker during delta encoding (representing a value-of-no-type
for paths that exist but carry no value). A correctly encoded
JSON-shaped weavepack-json payload — initial or after applying
deltas — never decodes a top-level `undefined`. If a decoder sees a
vtype-0 leaf during materialization, it folds to `null` for JSON
profile compatibility.

## Number encoding details

JSON numbers in IEEE 754 binary64 (the JavaScript number type) split
into three encoding paths:

1. **Integer in `[0, 2^53)`** with no fractional component → vtype 4
   (positive int) or 5 (negative int). The `nums` column carries the
   magnitude as `dint(magnitude)`.

2. **Number with decimal precision** → vtype 6. The `nums` column carries
   the precision marker (1..308 + sign offset) and the scaled mantissa.
   Numbers are scaled by `10^precision` where `precision` is the count
   of significant fractional digits (capped at 308, the IEEE 754
   binary64 effective decimal precision limit).

3. **Special non-finite values** (`NaN`, `+Infinity`, `-Infinity`):
   coerced to `null` by the encoder, matching `JSON.stringify`'s
   behavior. There is no on-wire representation of these values.

The `Number.MAX_SAFE_INTEGER` boundary (2^53 - 1) is implicit. Numbers
larger than this are encoded as their best double-precision approximation
via the precision-mantissa form. Round-trip fidelity is guaranteed up
to 2^53 - 1; beyond that, fidelity matches IEEE 754 binary64 round-trip
fidelity.

## String encoding details

JSON strings are sequences of UTF-16 code units. weavepack-json is
encoding-agnostic with respect to surrogates — it treats a JSON string
as the array of code units `string.charCodeAt(i)` for `i ∈ [0, length)`.

Three encoding subtypes:

1. **Empty string `""`**: top-level uses single-payload tag 3; nested
   uses vtype 2 with `length = 1` and no character bits.

2. **Single-character A–Z / a–z**: top-level uses single-payload tag
   `9 + strmap_index`. Nested strings of length 1 with this character
   range still go through the strmap on first occurrence, so they
   encode under vtype 2 with `length ≥ 2` (the 1-character string
   itself fits the literal path).

3. **Multi-character or non-base64url**: as documented above.

The strmap is built incrementally during encoding. The first occurrence
of a string is written literally; subsequent occurrences in the same
payload are 1-bit-flagged strmap references. The strmap indices are
local to the payload (or to a delta chain when chained payloads share
the strmap, see `04-deltas.md`).

## Strdiffs sidecar

When a string update is small relative to the prior value, the encoder
emits a fast-diff patch against the prior version instead of re-emitting
the full new string. This is signaled by:

- vtype 2
- `vals` length = 0
- 1-bit selector = `1` (strdiff)

The patch payload appears in the `strdiffs` column as a sequence of
fast-diff operations encoded byte-aligned. The decoder applies the
patch to the prior string value to recover the new string. Detailed
patch format is documented in `04-deltas.md` (string diff section).

The encoder's heuristic for emitting a strdiff vs a full replacement
is: both prior and new strings must have length ≥ 20, AND the patch
size must be < 60% of the new string length. Below this threshold,
the patch is larger than the full new string; above it, the patch
wins. The threshold is normative: implementations choosing different
heuristics will produce non-byte-equivalent (but semantically
equivalent) payloads.

## Forbidden values

JSON values that weavepack-json declines to encode (encoder MUST coerce
or reject):

- `NaN`, `+Infinity`, `-Infinity` → coerced to `null`
- `undefined` (as a JSON value, not as an internal marker) → coerced
  to `null` if it appears as a property value; properties whose value
  is `undefined` are typically omitted by `JSON.stringify` and the
  weavepack encoder follows that convention
- BigInt → not handled; encoder behavior undefined (may overflow or
  throw)
- Symbol, Function, Date, RegExp, Map, Set, etc. → not handled;
  encoder behavior undefined

## Round-trip guarantees

For any value `v` in the supported JSON value space:

```
decode(encode(v)) ≡_JSON v
```

where `≡_JSON` is JSON-level equality (object key order is not
significant; `0` and `-0` are equivalent; etc.).

For numbers specifically:

```
v in [0, 2^53)         →   bit-exact round-trip
v in (-2^53, 0)        →   bit-exact round-trip
v with finite decimal  →   round-trip equal to within float-printing
                           precision (matches Number.prototype.toString)
v non-finite           →   round-trips as null (NaN/Infinity coerced)
```

For strings:

```
all UTF-16 code units  →   bit-exact round-trip
including surrogates,
control chars, emoji
```

For containers: structure preserved; key order preserved within each
object (JSON does not require key-order preservation, but weavepack
implementations SHOULD preserve it for compatibility with consumers
that depend on it, e.g., signature schemes over JSON).

## Test vector references

Conformance test vectors covering each value type live in
`profiles/json/test-vectors/types/`. Each vector is a tuple
`(input, expected-bytes, decoded-output)` derived from `sdk/test/`.

See `05-conformance.md` for the test corpus structure.
