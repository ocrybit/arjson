# weavepack-log — 01: Types (Column Types)

**Status:** Draft. Phase L of the weavepack v0.5 roadmap.

## Scope

This document specifies the **column type vocabulary** of
weavepack-log — the set of primitive types a column can carry,
their bit widths, value ranges, null semantics, and on-wire encoding.

weavepack-log extends the weavepack-tabular type vocabulary with one
additional type (`level`, ctype 16) for log severity encoding. All
tabular ctypes 0–15 are inherited with identical semantics; this
document documents all 17 ctypes for completeness. Implementations
MUST NOT import weavepack-tabular code; the type definitions below
are authoritative and profile-isolated.

## Column type space (5 bits, ctype 0..16)

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
| 16 | `level` | 3 | log severity — see §Level encoding |

All multi-byte scalar values are stored **little-endian** (same as
weavepack-tensor, weavepack-wire, and weavepack-tabular). String and
bytes values are stored as a LEB128-encoded byte count followed
immediately by the payload bytes.

The ctype field in a column header uses 5 bits when ctype 16 is in
scope (log profile). Decoders MUST refuse with `unknown_ctype` if they
read a ctype value ≥ 17 (values 17–31 are reserved).

## Level encoding (ctype 16)

Log severity is a common field across all structured event streams.
The `level` type encodes severity at 3 bits per event — far cheaper
than a string representation.

### Severity values

| Numeric | Name | Meaning |
|---|---|---|
| 0 | `TRACE` | Finest-grained debug information |
| 1 | `DEBUG` | Debug-level diagnostic messages |
| 2 | `INFO` | Normal operational events |
| 3 | `WARN` | Recoverable warnings |
| 4 | `ERROR` | Error conditions |
| 5 | `FATAL` | Unrecoverable errors; process termination expected |
| 6 | reserved | MUST be refused with `unknown_level` |
| 7 | reserved | MUST be refused with `unknown_level` |

Encoders MUST NOT emit values 6 or 7. Decoders reading values 6 or 7
in a `level` column MUST refuse with `unknown_level`.

### Bit packing

Level values are packed at 3 bits per value in the value column, with
no inter-value padding. Within each byte, values are stored
least-significant-bit-first (same as the core bit-pack convention).

Example: three consecutive events [INFO, INFO, ERROR] pack as:
```
bits: 010 010 100
byte 0: 0b_010_010_10 = 0x4A  (bits 0–7: INFO, INFO, first 2 bits of ERROR)
byte 1: 0b_??????_?1  = 0x01  (bit 0: remaining bit of ERROR; bits 1–7: padding)
```

Padding bits in the final byte MUST be 0. Decoders reading non-zero
padding bits MUST refuse with `invalid_level_padding`.

### RLE

RLE applies to `level` columns. Server log streams typically exhibit
long runs of `INFO` events; a run of N identical severity values
encodes as a (count, value) pair using the core RLE mechanism.

At 10 000 INFO events: raw = 10 000 × 3 bits = 3 750 bytes; RLE = 1
run of (10000, 2) = ~4 bytes.

## Null semantics

Any column may be declared **nullable** (the mandatory `seq` and `ts`
columns are exceptions — they are always non-nullable; see
02-containers.md). Nullable columns carry a companion **null bitmap**:
one bit per event in the column, packed most-significant-bit-first
within each byte.

Null bitmap layout:
```
null_bitmap[event_i] = (bitmap_byte[event_i >> 3] >> (7 - (event_i & 7))) & 1
```
A bit of 1 means the cell at `event_i` is NULL. A bit of 0 means
the cell has a non-null value.

For NULL cells, **no bits appear in the value column**. The value
column contains only the non-null values, in event-order. A decoder
MUST iterate the null bitmap to skip NULL positions when reading the
value column.

Non-nullable columns carry no null bitmap. A non-nullable column that
receives a NULL value is a decoder error (`non_nullable_null`).

Without a schema, a 1-bit `nullable` flag in the column header
determines whether a bitmap follows.

## Per-type encoding

### Fixed-width integer types (int8 through uint64)

Stored as a sequence of bit-packed values at their declared bit width.
Signed integers use two's-complement; no zigzag encoding.

RLE applies: runs of identical integer values are run-length-encoded.

### bool (ctype 0)

Each event's boolean value is stored as a single bit: 0 = false,
1 = true. RLE applies.

### float32 (ctype 9), float64 (ctype 10)

IEEE 754 binary32 / binary64, little-endian. Stored raw; NaN bit
patterns are preserved without canonicalization.

### string (ctype 11)

Each non-null value: LEB128-encoded byte count N, then N bytes of
UTF-8. Decoders MUST validate UTF-8; malformed input MUST be refused
with `invalid_utf8`. Empty string: byte count = 0.

### bytes (ctype 12)

Each non-null value: LEB128-encoded byte count N, then N raw bytes.
No encoding restriction on the payload.

### date32 (ctype 13)

A signed 32-bit integer representing days since 1970-01-01. Negative
values represent dates before 1970. No timezone conversion; the value
is a plain calendar date. Decoders expose the raw day count.

### timestamp64 (ctype 14)

A signed 64-bit integer representing microseconds since
1970-01-01T00:00:00Z (UTC Unix epoch). Precision: 1 microsecond.
Encoders MUST store UTC, converting timezone offsets before encoding.
Decoders expose the raw microsecond count.

The mandatory `ts` column (col_id 1) uses this type. It is stored with
**delta coding** (see 02-containers.md §Mandatory column encoding)
because consecutive log event timestamps within a batch are monotone
and typically close together (sub-millisecond inter-event gaps on a
busy service).

### ext (ctype 15) — Extension types

ctype 15 is the extension gate. When a decoder reads ctype = 15 in a
column header, it reads a following LEB128 `ext_id`:

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
  refuse with `value_too_large`.

- A single event batch: total encoded byte count MUST be ≤ 2 GiB
  (2 147 483 648). A decoder tracking running byte count MUST refuse
  with `frame_too_large` when the limit is reached.

- A single batch MUST contain ≤ 2^32 − 1 events. A decoder reading
  `num_events` > 2^32 − 1 MUST refuse with `batch_too_large`.
