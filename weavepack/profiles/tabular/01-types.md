# weavepack-tabular — 01: Types (Column Types)

**Status:** Draft. Phase T of the weavepack v0.4 roadmap.

## Scope

This document specifies the **column type vocabulary** of
weavepack-tabular — the set of primitive types a column can carry,
their bit widths, value ranges, null semantics, and on-wire encoding.

Unlike weavepack-json (heterogeneous values per cell), weavepack-tabular
columns are **typed per-column** — every cell in a column has the same
declared type. The type is fixed at frame-definition time (or
schema-definition time) and does not change except via a `column_add`
or `column_drop` delta.

## Column type space (4 bits, ctype 0..15)

| ctype | Name | Bits | Range / form |
|---|---|---|---|
| 0 | `bool` | 1 | {false, true} |
| 1 | `int8` | 8 | −128 .. 127 (two's-complement) |
| 2 | `int16` | 16 | −32 768 .. 32 767 |
| 3 | `int32` | 32 | −2^31 .. 2^31−1 |
| 4 | `int64` | 64 | −2^63 .. 2^63−1 |
| 5 | `uint8` | 8 | 0 .. 255 |
| 6 | `uint16` | 16 | 0 .. 65 535 |
| 7 | `uint32` | 32 | 0 .. 2^32−1 |
| 8 | `uint64` | 64 | 0 .. 2^64−1 |
| 9 | `float32` | 32 | IEEE 754 binary32, little-endian |
| 10 | `float64` | 64 | IEEE 754 binary64, little-endian |
| 11 | `string` | variable | LEB128-byte-count + UTF-8 bytes |
| 12 | `bytes` | variable | LEB128-byte-count + raw octets |
| 13 | `date32` | 32 | days since 1970-01-01 (signed int32) |
| 14 | `timestamp64` | 64 | microseconds since 1970-01-01T00:00:00Z (signed int64) |
| 15 | `ext` | variable | extension gate — see §Extension types |

All multi-byte scalar values are stored **little-endian** (same as
weavepack-tensor and weavepack-wire). String and bytes values are stored
as a LEB128-encoded byte count followed immediately by the payload bytes.

## Null semantics

Any column may be declared **nullable**. Nullable columns carry a
companion **null bitmap**: one bit per row in the column, packed
most-significant-bit-first within each byte.

Null bitmap layout:
```
null_bitmap[row_i] = (bitmap_byte[row_i >> 3] >> (7 - (row_i & 7))) & 1
```
A bit of 1 means the cell at `row_i` is NULL. A bit of 0 means the
cell has a non-null value.

For NULL cells, **no bits appear in the value column**. The value
column contains only the non-null values, in row-order. A decoder
must iterate the null bitmap to skip NULL positions when reading the
value column.

Non-nullable columns carry no null bitmap. A non-nullable column that
receives a NULL value is a decoder error (`non_nullable_null`).

Without a schema, a 1-bit `nullable` flag in the column header
determines whether a bitmap follows.

## Per-type encoding

### Fixed-width integer types (int8, int16, int32, int64, uint8, uint16, uint32, uint64)

Stored as a sequence of bit-packed values in the core encoder's value
column. Each value occupies exactly the declared bit width.

Signed integers use two's-complement; no zigzag encoding. (Unlike
weavepack-wire's `sint32`, tabular analytics workloads do not benefit
from zigzag because integer column values span the full signed range
rather than clustering near zero.)

RLE applies: runs of identical integer values in a column are
run-length-encoded using the core RLE mechanism. This provides strong
compression for low-cardinality integer columns (e.g., a `status`
column with 3 distinct values in 10 000 rows).

### bool (ctype 0)

Each row's boolean value is stored as a single bit: 0 = false, 1 = true.
This is more compact than Arrow's byte-per-value layout.

RLE applies: boolean columns with long runs (e.g., a `is_deleted` flag
mostly false) compress to near-zero overhead.

### float32 (ctype 9), float64 (ctype 10)

IEEE 754 binary32 / binary64, little-endian. The 32 or 64 bits are
written directly to the value column with no transformation.

Special values (NaN, +Inf, −Inf) are preserved as-is; the encoder does
not canonicalize NaN bit patterns.

### string (ctype 11)

Each non-null value: LEB128-encoded byte count N, then N bytes of
UTF-8. Decoders MUST validate that the bytes are valid UTF-8; a
malformed string MUST be refused with `invalid_utf8`.

Empty string: LEB128 byte count = 0.

### bytes (ctype 12)

Each non-null value: LEB128-encoded byte count N, then N raw bytes.
No encoding restriction on the payload.

### date32 (ctype 13)

A signed 32-bit integer (ctype 3 encoding) representing the number of
days elapsed since 1970-01-01 (the Unix epoch). Negative values
represent dates before 1970.

Range: approximately −5 877 641 days .. +5 877 641 days (far exceeding
any practical date range).

Encoders MUST NOT apply timezone conversion; the value is a plain
calendar date with no timezone. Decoders expose the raw day count;
timezone interpretation is a consumer responsibility.

### timestamp64 (ctype 14)

A signed 64-bit integer (ctype 4 encoding) representing microseconds
elapsed since 1970-01-01T00:00:00Z (UTC Unix epoch). Negative values
represent instants before the epoch.

Precision: 1 microsecond. Range: ±292 000 years from epoch.

Encoders MUST store UTC. If the source value has a timezone offset,
it MUST be converted to UTC before encoding. The wire format carries
no timezone information. Decoders expose the raw microsecond count.

### ext (ctype 15) — Extension types

ctype 15 is the extension gate. When a decoder reads ctype = 15 in a
column header, it reads a following LEB128 `ext_id` that identifies
the extended column type. Currently registered ext_ids:

| ext_id | Name | Notes |
|---|---|---|
| 0 | `decimal128` | 128-bit fixed-point; scale in schema |
| 1 | `duration64` | signed 64-bit microsecond duration |
| 2–127 | reserved | for future weavepack spec extension |
| 128+ | profile-local | implementor-defined; not in conformance corpus |

A decoder encountering an unrecognized ext_id MUST refuse with
`unknown_ext_type`. It MUST NOT silently skip the column.

## Size limits

To prevent denial-of-service via malformed payloads:

- `string` and `bytes` values: LEB128 byte count MUST be ≤ 256 MiB
  (268 435 456). A decoder reading a count exceeding this limit MUST
  refuse with `value_too_large` without reading any bytes.

- A single frame: total encoded byte count (sum of all column data)
  MUST be ≤ 2 GiB (2 147 483 648). A decoder tracking running byte
  count MUST refuse with `frame_too_large` when the limit is reached.

These are safety limits, not target sizes. Real frames should be
well under 256 MiB per the application's batching strategy.
