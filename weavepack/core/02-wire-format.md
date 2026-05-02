# weavepack-core — 02: Wire Format

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the **concrete byte layout** of a weavepack
payload. It describes the order in which columns appear, how each
column's length is determined, and how the wire envelope dispatches
to single-payload vs structured mode.

The bit-level encoding of each column's content is in
`03-bit-encoding.md`. Profile-specific column content is in the
profile's documents.

## Wire envelope

A weavepack payload is a contiguous byte sequence. The byte sequence
is interpreted as a bitstream (MSB-first within each byte; bits
flow across byte boundaries).

### Mode dispatch

The first bit of the payload selects the wire mode:

| bit 0 | mode |
|---|---|
| `1` | **single-payload mode** |
| `0` | **structured mode** |

In single-payload mode, the rest of the payload is profile-specific
content (a tagged primitive). The profile defines the tag space.
For the JSON profile, see `profiles/json/01-types.md`.

In structured mode, the rest of the payload follows the **column
sequence** below.

## Structured-mode column sequence

After the leading `0` bit, columns are emitted in this exact order:

```
0  (mode bit, already consumed)
─── from here on, column-by-column ───

[query header]      (only present for query payloads; see Query mode)
[chain header]      (only present in structured mode; see below)
[vflags column]     [2-bit RLE prefix] [body bits]
[vlinks column]     (vrefs encoded as delta-pack stream)
[kflags column]     [2-bit RLE prefix] [body bits]
[klinks column]     (krefs encoded as delta-pack stream)
[keys column]
[kvals column]
[ktypes column]
[bools column]      [2-bit RLE prefix] [body bits]
[nums column]
[vals column]       (a.k.a. strs)
[strdiffs column]
[final pad]         (zero bits to byte-align)
```

The bit positions of each column's start are NOT explicit in the
wire format; they are derived as the decoder consumes bits. The
decoder reads each column in order, deriving the next column's start
from the previous column's end.

This means: a decoder MUST faithfully consume each column's bits
exactly. Reading too few or too many bits from any column corrupts
all subsequent columns.

## Chain header

In structured mode (after the leading `0` bit), the next field is
the **chain header**:

| Field | Encoding | Meaning |
|---|---|---|
| `len` | `short()` | Number of leaves in this payload (count of `vrefs` entries) |

The length is needed up front so the decoder knows how many entries
to read from the `vlinks` and `vflags` columns.

`short()` is defined in `03-bit-encoding.md`.

## RLE flag prefix (vflags / kflags / bools)

Three of the columns (`vflags`, `kflags`, `bools`) are bit-streams
of arbitrary length. v1.1 prefixes each non-empty bit-stream with
a 2-bit mode selector:

| Prefix | Mode | Body bits |
|---|---|---|
| `00` | all zeros | none (length is known from context) |
| `01` | all ones | none (length is known from context) |
| `10` | mixed | raw bit-stream of declared length |
| `11` | reserved | (not used) |

If the column is empty (length = 0), the prefix is **omitted**. The
length of each column is determined by:

- `vflags`: equal to `len` from the chain header
- `kflags`: equal to `key_length - 1 - keylen` (computed during
  decode of the `ktypes` and `keys` columns)
- `bools`: equal to the count of bool-typed leaves (computed from
  `vtypes`)

Implementations MUST read the 2-bit prefix only when the column's
length is > 0. The prefix bits are part of the byte stream — they
are not metadata stored elsewhere.

## Single-payload column layout

In single-payload mode, the wire envelope is:

```
1                  (mode bit)
[profile header]   (profile-defined; for JSON, see profiles/json/01-types.md)
[zero-padding]     (final pad to byte-align)
```

There are no other columns. The profile header carries enough
information to recover the single value.

For JSON: the profile header is a 1-bit selector + 6-bit tag, plus
optional payload bytes. The tag space is defined in
`profiles/json/01-types.md` (table of tags 0..63).

## Query mode

When a payload is encoding a **query** (a lookup against an existing
ARTable, not a delta or initial state), the structured-mode layout
is prefixed with a query header in `dc`:

```
0                  (mode bit)
[query op]         2 bits — operation code
[query col]        short() — column id
[query doc]        leb128() — document id
[query len]        short() — only if op = 2 (length query)
[normal columns]
```

Query mode is used by ARTable-aware consumers (e.g., weavedb) to
perform lookups without materializing the full JSON tree. The query
header tells the receiving system which column to lookup, which
document, and the operation type.

This is an optional capability; implementations focused on encoding/
decoding may ignore the query op codes. A non-query payload has no
query header — the decoder distinguishes by structural context (the
query header appears only when the consumer explicitly invokes
`dump(query)`).

## Per-column encoding details

The bit-level details of each column are in `03-bit-encoding.md`.
This section describes the **structural role** of each column.

### `dc` — Document control

Carries:
- The wire mode bit (1 bit)
- The chain header's `len` field (`short()`)
- Optional query metadata (when in query mode)
- Single-payload tagged value (when in single mode)

### `vflags` — Value reference flags

One bit per leaf. `vflags[i] = 1` means `vrefs[i]` is a small delta
from the previous vref; `vflags[i] = 0` means `vrefs[i]` is an
absolute index. Used by the delta-pack decoding of `vlinks`.

### `vlinks` — Value reference values

The actual `vrefs` indices, encoded as a delta-pack stream. For
each leaf:

- If `vflags[i] = 1`: `vlinks` carries a 3-bit small delta (0..6,
  with values 4..6 representing -1, -2, -3).
- If `vflags[i] = 0`: `vlinks` carries an absolute index, bit-width
  derived from the largest absolute value seen so far.

Repeated parents are run-length encoded: a 3-bit `0` value at the
start of a sub-block signals a run, followed by a `short()` count
and the diff/absolute value.

### `kflags` — Key reference flags

One bit per kref. Same semantics as `vflags`, applied to `krefs`.

### `klinks` — Key reference values

Same delta-pack format as `vlinks`, applied to krefs.

### `keys` — Object keys / array indices

Per kref slot: a 2-bit ktype + the key data (varies by ktype).
For ktype 0 / 1 (array index / numeric placeholder), no further
data is in `keys` — the value is positionally derived. For ktype
2 / 3 (string key with literal characters), the encoded string
length follows.

### `kvals` — Key character data

Character data for string keys. Two encoding subtypes:
- 6-bit per character (for base64url-eligible keys; ktype 2)
- LEB128 per character (for fallback keys; ktype 3)

### `ktypes` — Key type discriminator

Per kref slot: a profile-defined number of bits encoding the
key/container type. For the JSON profile: 2 bits (4 ktypes).

### `vtypes` — Value type discriminator

Per leaf: a profile-defined number of bits encoding the value type.
For the JSON profile: 3 bits (8 vtypes), with run-length and
splice/delete escapes via vtype 0.

### `bools` — Boolean values

One bit per bool-typed leaf. RLE-prefixed.

### `nums` — Numeric values

Integer and float values. Encoded with the `dint` (delta-int)
primitive; see `03-bit-encoding.md`. Run-length applied for repeated
values.

### `vals` (a.k.a. `strs`) — String values

String values for string-typed leaves. Each entry has a length
prefix and either:
- A strmap reference (for previously-seen strings), or
- A strdiff reference (for fast-diffed strings), or
- Literal character data (for first-occurrence strings)

### `strdiffs` — String diff patches

Byte-aligned fast-diff patches for strings encoded as diffs against
prior versions. Detailed in `04-strmap.md` and the JSON profile's
`profiles/json/04-deltas.md`.

## Final pad

After the last column, the bit cursor may not be byte-aligned. The
encoder pads with zero bits to reach a byte boundary. The decoder
discards any trailing zero bits past its consumed bit count up to
the next byte boundary.

## Length-framing for chains

A chain of N payloads is concatenated with LEB128 length prefixes:

```
chain        = delta-frame*
delta-frame  = leb128(len) byte_0 byte_1 ... byte_{len-1}
```

The `leb128()` is defined in `03-bit-encoding.md`. The `len` is
the byte length of the payload that follows.

A consumer reading a chain reads:

1. A LEB128 length `len`
2. `len` bytes (the payload)
3. Repeats until the buffer is exhausted

A single-payload chain (N=1) is byte-equivalent to a single payload
prefixed with its LEB128 length. Consumers that know they have N=1
MAY skip the length prefix, but doing so is non-portable.

## Endianness

All multi-byte fields use **little-endian** within their LEB128 chunks
(LSB byte first; MSB continuation bit). Bit packing within each
byte is **MSB-first** (the first bit of a field is the highest-order
bit of the containing byte).

## Worked example

Encoding `42`:

```
1               mode bit (single)
1               positive int small flag
101010          value 42 (6 bits)
                                       ── 8 bits total = 1 byte = 0xea
```

Output: `0xea`. (See `profiles/json/test-vectors/types/primitives/integers.json`
for byte-equal vectors.)

Encoding `[1, 2]`:

```
0               mode bit (structured)
[chain header]  len = 2 (short)
[vflags]        2-bit RLE prefix + body
[vlinks]        vlinks stream
[kflags]        2-bit RLE prefix + body
[klinks]        klinks stream
[keys]          keys (1 ktype-0 entry for the array container)
[kvals]         empty
[ktypes]        ktypes (2 bits)
[bools]         empty
[nums]          values 1 and 2 (delta-pack)
[vals]          empty
[strdiffs]      empty
[pad]           zero bits to byte boundary
```

The exact bytes are determined by following each section's encoding
rule from `03-bit-encoding.md`.

## Strict / lenient decoding

Implementations MUST be **strict**: they MUST reject payloads that:

- Have invalid mode bits (e.g., a structured payload where a column
  exceeds the buffer)
- Have invalid type tags outside the defined range
- Have run-length or splice metadata with counts exceeding the
  remaining slots
- Have profile-id values not in the registered set
- Are truncated mid-column

Implementations MAY be **lenient** about:
- Trailing zero bits past the final pad (likely from an encoder that
  pads to a larger alignment)
- Extra bytes after a chain's last delta (likely from a buffer that
  contains other data)

Lenient and strict modes SHOULD be configurable; the default SHOULD
be strict.
