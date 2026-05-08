# weavepack-wire — 01: Types (Scalar Types)

**Status:** Draft. Phase W of the weavepack v0.3 roadmap.

## Scope

This document specifies the **scalar type vocabulary** of weavepack-wire
— the set of primitive types that field values can carry, their bit
widths, value ranges, and on-wire encoding.

Unlike the JSON profile (which has a single heterogeneous "any value"
column), weavepack-wire fields are **typed per the schema** — a field
declared as `int32` always stores int32 values. The type is fixed at
schema-definition time and does not change per-payload.

## Scalar type space (4 bits, 0..15)

The vtype for a wire scalar is a 4-bit tag. The current registry:

| vtype | Name | Bits | Range / form |
|---|---|---|---|
| 0 | `bool` | 1 | {false, true} |
| 1 | `int32` | 32 | -2^31 .. 2^31-1 (two's-complement) |
| 2 | `int64` | 64 | -2^63 .. 2^63-1 |
| 3 | `uint32` | 32 | 0 .. 2^32-1 |
| 4 | `uint64` | 64 | 0 .. 2^64-1 |
| 5 | `sint32` | 32 | -2^31 .. 2^31-1 (zigzag-encoded) |
| 6 | `sint64` | 64 | -2^63 .. 2^63-1 (zigzag-encoded) |
| 7 | `float32` | 32 | IEEE 754 binary32, little-endian |
| 8 | `float64` | 64 | IEEE 754 binary64, little-endian |
| 9 | `string` | variable | LEB128-byte-count + UTF-8 bytes |
| 10 | `bytes` | variable | LEB128-byte-count + raw octets |
| 11 | `enum` | variable | int32 with schema-declared name set |
| 12–15 | reserved | — | for future extension |

vtype 12 acts as an extension gate for future scalar types. A decoder
encountering vtype 12 MUST read a follow-up LEB128 for the extended
type id and handle it if registered; otherwise refuse with
`unknown_scalar_type`.

## Why both int32 and sint32?

`int32` stores the two's-complement bit pattern directly. Negative
values in the range -2^31 .. -1 are represented as large unsigned
values, which expand to many bits in the variable-width column encoding.

`sint32` applies zigzag encoding before writing: `encoded = (v << 1)
^ (v >> 31)`. This maps small negative values to small unsigned values:
-1 → 1, -2 → 3, -3 → 5, etc. For fields that commonly hold small
negative values (e.g., signed offsets, temperature deltas), `sint32`
is more compact.

The caller chooses the right type in the schema. The wire format
doesn't auto-detect; it follows the schema declaration.

## Variable-width integer encoding

Integers in weavepack-wire value columns are stored using the core
bit-pack substrate:

- **Fixed-width fields** (`float32`, `float64`, `bool`): always exactly
  that many bits. No variance.
- **Variable-width integer fields** (`int32`, `int64`, `uint32`,
  `uint64`, `sint32`, `sint64`, `enum`): stored as LEB128 (unsigned
  base-128 encoding, 7 bits per group, MSB continuation flag).

The choice of LEB128 for integers is consistent with the core
protocol's field-length encoding and the tensor profile's shape
encoding. The bit-pack substrate writes LEB128 groups into the column
buffer as a contiguous bit sequence.

LEB128 for common values:
- 0 → 1 byte (7 bits used)
- 127 → 1 byte
- 128 → 2 bytes
- 16383 → 2 bytes
- For `int32` two's-complement, -1 is 10 bytes in LEB128 (all-ones
  bit pattern); use `sint32` for negative values.

## bool

1 bit. False = 0, True = 1. A message with N bool fields uses N bits
of bool column storage — not N bytes. The schema groups bool fields
into the bool column; the decoder reads them in field-number order.

## float32 / float64

IEEE 754 binary32 / binary64. Always little-endian byte order. The
encoder writes the raw 32 or 64 bits into the value column without any
transformation. NaN bit patterns round-trip exactly (no NaN-to-null
coercion as in the JSON profile).

Infinity and NaN are valid on-wire values. The schema may declare a
field as "finite-only" (refusal on Inf/NaN), but the wire format
itself does not enforce this.

## string

Variable length. Encoding:

```
LEB128(byte_count)   : number of UTF-8 bytes in the string
UTF-8 bytes          : the string content
```

The string MUST be valid UTF-8. A decoder encountering invalid UTF-8
in a `string` field MUST refuse with `invalid_utf8`. Empty string
(`byte_count = 0`) is valid.

Maximum string length: 256 MiB (implementation bound, not a wire
constraint). Strings larger than this SHOULD cause encoder refusal
(`value_too_large`).

## bytes

Same encoding as `string` but the content is raw octets with no
validity constraint. Not required to be UTF-8.

```
LEB128(byte_count)   : number of bytes
raw bytes            : the content
```

Maximum bytes length: same 256 MiB bound as string.

## enum

On the wire, an `enum` field is encoded as an `int32`. The schema
provides the mapping from integer to symbolic name. An encoder
SHOULD emit only values declared in the schema's enum value set.
A decoder encountering an undeclared enum value MUST preserve it
numerically (open enum semantics, same as protobuf v3).

Encoding: same as `int32` (two's-complement LEB128).

## Null / absence

There is no `null` type. Absence of a field is represented structurally
(the field number does not appear in the field-number column for that
payload). See `02-containers.md` for presence semantics.

Fields with a default value (declared in schema): the schema defines
the default; absent field = default value on the receiver side.
weavepack-wire does not store the default on the wire (same as protobuf
v3's field-omission-equals-default rule).

## Type width table

| Type | Bits on wire | Notes |
|---|---|---|
| `bool` | 1 | bits column |
| `int32` | 8–80 | LEB128 (1–10 groups); 8 for values 0..127 |
| `int64` | 8–160 | LEB128 (1–20 groups) |
| `uint32` | 8–40 | LEB128 (1–5 groups); 8 for values 0..127 |
| `uint64` | 8–80 | LEB128 (1–10 groups) |
| `sint32` | 8–40 | zigzag + LEB128; 8 for values -64..63 |
| `sint64` | 8–80 | zigzag + LEB128 |
| `float32` | 32 | fixed |
| `float64` | 64 | fixed |
| `string` | 8 + 8×N | LEB128 length + N UTF-8 bytes |
| `bytes` | 8 + 8×N | LEB128 length + N raw bytes |
| `enum` | 8–80 | same as int32 LEB128 |

## Byte order

All multi-byte numeric types use **little-endian byte order** on the
wire. This matches the vast majority of consumer hardware and aligns
with the tensor profile convention. There is no runtime endianness
detection; the wire format is always little-endian.

## Round-trip guarantees

For any field value `v` of a supported scalar type:

```
decode(encode(v, type)) == v  (bit-exact)
```

For floating-point types, NaN bit patterns are preserved. For integer
types, two's-complement round-trips exactly. For strings, UTF-8 byte
sequences round-trip byte-for-byte.

## Forbidden values

The following MUST cause refusal during decoding:

- A `string` field whose bytes are not valid UTF-8
- A field whose vtype tag is in the reserved range (12–15) without a
  registered extension handler
- A value whose size (string or bytes length) exceeds the decoder's
  implementation bound (typically 256 MiB)

## Conformance

Level 1 decoders MUST handle vtypes 0..11 (all defined non-extension
scalars).

Level 2 encoders MUST emit only defined vtypes and produce valid UTF-8
for string fields.

Level 3 encoders MUST agree byte-for-byte with the reference for the
same input value + type declaration.

## Test vector references

Conformance test vectors live at
`weavepack/profiles/wire/test-vectors/types/`:

- `scalars.json` — round-trips for all scalar types (bool, integers,
  floats, string, bytes, enum)
- `strings.json` — empty string, ASCII, Unicode BMP, 4-byte emoji

(Populated in Stage W.3.)
