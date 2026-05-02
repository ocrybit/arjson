# weavepack-core — 03: Bit Encoding

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the **bit-level primitives** used throughout
weavepack: `short()`, `uint()`, `leb128()`, RLE flag prefix, delta-
pack for monotone integer streams, and the `dint` (delta-int) form
for the `nums` column. These primitives are profile-agnostic.

## Bit ordering

- Bits are packed **MSB-first** within each byte. Bit 0 of a byte
  is the highest-order bit (value 0x80).
- Multi-bit fields can span byte boundaries; the encoding is
  unambiguous given the field's declared width.
- LEB128 chunks are byte-aligned; each chunk consumes 8 bits.

## Primitives

### `n(width)` — fixed-width unsigned integer

Reads `width` bits from the bit cursor as an unsigned integer. The
cursor advances by `width` bits.

The implementation may use a 32-bit window read for `width ≤ 24`
(fast path) or bit-by-bit reassembly for `width > 24`. The result
is the same.

### `leb128()` — variable-length unsigned integer (byte-aligned)

```
leb128 = byte*

byte high bit:
  1 → continuation; lower 7 bits are part of the value
  0 → terminator; lower 7 bits are the final 7 bits of the value
```

Encoding:
1. While `value ≥ 128`: emit `(value & 0x7f) | 0x80`; `value >>= 7`
2. Emit `value & 0x7f`

Decoding:
1. Read a byte
2. Accumulate `byte & 0x7f` shifted by `7 * chunk_index`
3. If `byte & 0x80`: advance and repeat
4. Otherwise: stop

The result is the unsigned integer.

This is the standard LEB128 encoding (used in DWARF, WebAssembly,
protobuf varints, etc.). LEB128 is byte-aligned: it operates on
whole bytes from the bit stream.

### `short()` — short unsigned integer (small-bias)

Optimized for values in [0, 16]. The encoding uses a 2-bit prefix
to select the field width:

| 2-bit prefix | Field width | Range |
|---|---|---|
| `00` | 2 bits | 0..3 |
| `01` | 3 bits | 0..7 (typically 4..7) |
| `10` | 4 bits | 0..15 (typically 8..15) |
| `11` | LEB128 | 0..2^64 |

Encoding:
- If `v < 4`: prefix = `00`, body = `v` in 2 bits
- Else if `v < 8`: prefix = `01`, body = `v` in 3 bits
- Else if `v < 16`: prefix = `10`, body = `v` in 4 bits
- Else: prefix = `11`, body = `leb128(v)`

Decoding: read 2-bit prefix, then read the corresponding number of
body bits (or call `leb128()` for prefix `11`).

A typical small value (0..15) consumes 4..6 bits. A value ≥ 16
consumes 2 bits + LEB128 of the value (typically 1-3 bytes).

### `uint()` — unsigned integer (medium-bias)

Optimized for values in [0, 64], biased larger than `short()`. Used
for the `dc` column's value-tag field and for `nums` magnitudes:

| 2-bit prefix | Field width | Range |
|---|---|---|
| `00` | 3 bits | 0..7 |
| `01` | 4 bits | 0..15 (typically 8..15) |
| `10` | 6 bits | 0..63 (typically 16..63) |
| `11` | LEB128 | 0..2^64 |

Encoding:
- If `v < 8`: prefix = `00`, body = `v` in 3 bits
- Else if `v < 16`: prefix = `01`, body = `v` in 4 bits
- Else if `v < 64`: prefix = `10`, body = `v` in 6 bits
- Else: prefix = `11`, body = `leb128(v)`

Decoding: same pattern as `short()`.

### `dint(prev)` — delta-int (run-length aware)

Used for the `nums` column. Encodes either an absolute value, a
small delta from the previous value, or a run of repeated
delta/absolute pairs.

Header (2 bits):

| Header | Meaning |
|---|---|
| `00` | small delta |
| `01` | absolute value, small (3-bit body, range 0..7) |
| `10` | absolute value, medium (6-bit body, range 0..63) |
| `11` | absolute value, LEB128 (range 0..2^64) |

For header `00` (small delta): the next 3 bits encode a delta in
[0, 7]. Values 0..3 are positive deltas; values 4..6 are negative
deltas (`-(v-3)`); value 7 is the **run-length escape**.

When the decoded delta is 7 with header `00` (run-length escape):
- Read `short()` for the run length L
- Read a 2-bit "follow-up" header
- Read the follow-up value (delta or absolute, per the same rules)
- Emit L consecutive copies of (the same delta or absolute) into
  the output

This is how repeated values (e.g., 100 zeros in a row) compress to
O(log L) bits.

Encoding: the inverse, with thresholds:
- A run of ≥ 3 same-(delta-or-absolute) emits the run-length form
- Otherwise each value emits its own `dint`

The exact threshold is a quality-of-implementation choice; both
forms are decodable. Level 3 conformance requires using the
threshold the JS reference uses (run if count ≥ 3).

### Delta-pack for refs (`vlinks`, `klinks`)

The `vrefs` and `krefs` index streams are encoded with **delta-pack**.
Per ref:

- A 1-bit flag (in the corresponding `vflags` / `kflags` column)
  selects: delta (1) or absolute (0)
- For delta: 3 bits encoding `(value - prev) + 0` if positive small,
  or `-(value - prev) + 3` if negative small (range -3..3 in 3 bits
  using value 7 as run-length escape)
- For absolute: a bit-width-adaptive integer

The bit width of absolute values starts at 1 and grows monotonically
during encoding. When a new absolute exceeds the current width, the
encoder emits zero-padding bits to extend the width, then writes the
new value at the wider width. This means absolute reads are width-
aware: the decoder tracks the current absolute width.

The width-extension scheme: emit (new_width - prev_width) instances
of zero at the previous width. The decoder, on reading a zero, knows
to bump the width by 1 and retry the read.

This is a Golomb-Rice-style adaptive code: small streams stay narrow,
large streams grow gracefully.

### RLE flag prefix

Three flag-bit columns (`vflags`, `kflags`, `bools`) prefix their
content with a 2-bit mode:

| Prefix | Mode | Body |
|---|---|---|
| `00` | all zeros | none |
| `01` | all ones | none |
| `10` | mixed | `count` raw bits |
| `11` | reserved | (forbidden) |

The encoder tracks zero-count and one-count as it appends to each
column. At dump time, it inspects the counts and chooses the prefix.

This RLE prefix is the v1.1 wire-format addition. v1.0 always
emitted raw bits with no prefix.

## Numbers (the `nums` column)

The `nums` column carries integer magnitudes and float scaled-mantissas.
The exact mapping from a profile's value to `nums` entries is profile-
specific; for the JSON profile, see `profiles/json/01-types.md` (number
encoding section).

Each entry uses `dint` encoding. Sequential entries get RLE compression
when repeated (e.g., a column of 1000 zeros encodes to a few bytes).

For multi-field values (e.g., a JSON float = precision + scaled
mantissa), the entries are emitted in a fixed profile-defined order.
The decoder consumes them in the same order.

## Strings (the `vals` / `strs` and `kvals` columns)

String values use a length-prefix + character-data encoding. The
length is encoded with `short()` (a string of 16 chars is the
common case; lengths > 16 fall back to LEB128).

Two character encodings:

### base64url-6 (`A-Z a-z 0-9 - _`)

Each character is 6 bits. The 64-character alphabet is `A-Za-z0-9-_`
with indices 0..63 in that order:

| Index | Char |
|---|---|
| 0..25 | A..Z |
| 26..51 | a..z |
| 52..61 | 0..9 |
| 62 | - |
| 63 | _ |

A string is encoded as `length × 6` bits. A length=0 string with
ktype 2 (base64url) is the **strmap reference / strdiff signal** —
see `04-strmap.md`.

### LEB128 fallback

When a string contains any character outside the base64url alphabet
(including control characters, spaces, punctuation, non-ASCII), the
encoder uses LEB128 per UTF-16 code unit:

```
char = leb128(code_unit)   ; for code_unit ∈ [0, 65535]
```

Each character takes 1-3 bytes:
- 1 byte for code unit 0..127
- 2 bytes for code unit 128..16383
- 3 bytes for code unit 16384..65535

Surrogate pairs (for emoji, non-BMP characters) are encoded as two
separate LEB128 values (high surrogate + low surrogate).

## Strmap encoding

The strmap is a deduplicated string table. Each unique string in a
payload is interned with an integer index. Subsequent occurrences
emit a 1-bit flag + the strmap index.

Details in `04-strmap.md`.

## strdiffs

The `strdiffs` column carries byte-aligned fast-diff patches for
incremental string updates. Each patch begins with:

- `leb128(total_bits)` — total bits of patch content (for skipping)
- `uint8` — number of patch ops
- `op[]` — sequence of ops

Each op:

- `flags` (uint8): high bit = op type (0=delete, 1=insert); next
  bit = has_ref (1=insert references strmap, 0=insert is literal)
- `pos` (leb128): position in original string
- For delete: `len` (leb128)
- For insert with has_ref=1: `ref` (leb128)
- For insert with has_ref=0: `len` (leb128) + `len` raw bytes

The patch is applied by walking ops in `pos` order and reproducing
the new string from the original.

Note: the current strdiff format is byte-oriented for inserts (1 byte
per character). Strings containing characters with code unit ≥ 256
cannot be patched via this format; the diff falls back to full
replace. v2 will lift this restriction.

## Padding

After the last column, the bit cursor may not be byte-aligned. The
encoder pads with zero bits to reach a byte boundary. The decoder
ignores any trailing zero bits past its consumed bit count up to
the next byte boundary.

The padding is part of the payload's length (it is included in the
LEB128 length prefix when the payload is part of a chain).

## Conformance for bit primitives

A Level 3 conformant encoder MUST use exactly these encodings. A
Level 2 encoder MAY produce semantically equivalent payloads using
different bit-pack thresholds (e.g., always using LEB128 instead of
short / uint), but the result MUST decode to the same value.

A decoder MUST handle all variants: short, uint, leb128, dint with
all its run-length escapes, RLE prefixes in all modes, delta-pack
with width-extension, and strdiff patches.

## Implementation notes (non-normative)

For performance, the JS reference uses:

- Precomputed `bitsLookup[]` for `bits(n)` lookups in the hot path
- Inline `n()` reads using a 32-bit window (avoids bit-by-bit)
- Inline single-bit writes (vflags, kflags, bools) bypassing the
  general `_add` path
- Precomputed `POW10[]` for float scaling
- Single-pass base64url scan with a charCode-indexed lookup table

These are quality-of-implementation. Any implementation that produces
spec-conformant output is correct, regardless of internal optimization.
