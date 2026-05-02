# weavepack-tensor — 01: Types (dtypes)

**Status:** Draft. Phase 5 of the weavepack roadmap.

## Scope

This document specifies the **dtype vocabulary** of weavepack-tensor
— the set of element types tensors can carry, their bit widths, value
ranges, and on-wire encoding.

Unlike the JSON profile (where the value space is heterogeneous and
tagged per-element), tensor profile elements are **homogeneous within
a tensor** — all elements share a single dtype declared once. The
dtype is declared in the schema sidecar (see `06-schemas.md` of
weavepack-core) or in a per-tensor header for schemaless mode.

## dtype space (5 bits, 0..31)

The dtype is a 5-bit integer. The current registry:

| dtype | Name | Bits/elem | Range / form |
|---|---|---|---|
| 0 | `bool` | 1 | {0, 1} |
| 1 | `int4` | 4 | -8 .. 7 (two's complement) |
| 2 | `uint4` | 4 | 0 .. 15 |
| 3 | `int8` | 8 | -128 .. 127 |
| 4 | `uint8` | 8 | 0 .. 255 |
| 5 | `int16` | 16 | -32768 .. 32767 |
| 6 | `uint16` | 16 | 0 .. 65535 |
| 7 | `int32` | 32 | -2^31 .. 2^31-1 |
| 8 | `uint32` | 32 | 0 .. 2^32-1 |
| 9 | `int64` | 64 | -2^63 .. 2^63-1 |
| 10 | `uint64` | 64 | 0 .. 2^64-1 |
| 11 | `fp8e4m3` | 8 | IEEE 754 binary8 with E4M3 layout (NaN-only signaling) |
| 12 | `fp8e5m2` | 8 | IEEE 754 binary8 with E5M2 layout |
| 13 | `fp16` | 16 | IEEE 754 binary16 |
| 14 | `bf16` | 16 | bfloat16 (Google brain float; 8-bit exp, 7-bit mantissa) |
| 15 | `fp32` | 32 | IEEE 754 binary32 |
| 16 | `fp64` | 64 | IEEE 754 binary64 |
| 17 | `cfloat32` | 64 | complex<float32> = (real, imag) packed |
| 18 | `cfloat64` | 128 | complex<float64> |
| 19..27 | reserved | — | — |
| 28 | `qint4` | 4 + scale/zp metadata | quantized int4 with scale + zero_point in schema |
| 29 | `qint8` | 8 + scale/zp metadata | quantized int8 |
| 30 | `qfp8` | 8 + scale/zp metadata | quantized fp8 (e4m3 or e5m2 declared in schema) |
| 31 | extension | (5 bits + LEB128 follow-up) | future dtypes |

dtype 31 acts as the extension gate for future dtypes. The follow-up
LEB128 carries the actual extended-dtype-id, registered in the
weavepack-tensor extension registry.

## Element layout

For dtypes that are an integer number of bits (most), elements are
packed contiguously in the data block:

```
elem 0 | elem 1 | elem 2 | ... | elem N-1
```

Bit alignment is **MSB-first**: the first bit of element 0 is the
highest-order bit of the data block's first byte.

For sub-byte dtypes (`bool`, `int4`, `uint4`, `qint4`):

- `bool`: 1 bit per element. 8 elements per byte.
- `int4`/`uint4`/`qint4`: 4 bits per element. 2 elements per byte.

The data block is padded with zero bits to a byte boundary at the end.

For multi-byte dtypes:

- All multi-byte numeric dtypes use **little-endian byte order**
  (matches IEEE 754 native layout on the vast majority of consumer
  hardware).
- Big-endian variants are NOT supported in v0.1; consumers requiring
  them must byte-swap on the receive side.

## Dtype-specific encoding details

### `bool`

1 bit per element. RLE prefix MAY be applied (mode 00 = all false,
mode 01 = all true, mode 10 = mixed). Same encoding as the JSON
profile's `bools` column.

### `int4` / `uint4`

4 bits per element. Two elements per byte: high nibble = element i,
low nibble = element i+1.

For `int4`, two's-complement: bit 3 is the sign bit. Range: -8..7.

### `int8` / `uint8`

1 byte per element. `int8` is two's-complement.

### `int16` / `uint16` / `int32` / `uint32` / `int64` / `uint64`

Multi-byte integer, little-endian. Two's-complement for signed types.

### `fp8e4m3`

IEEE 754 binary8 with 1 sign bit, 4 exponent bits, 3 mantissa bits.
Bias 7. Range approximately ±448 with denormals. NaN encoded as
sign + all-ones exponent + non-zero mantissa. Infinity NOT
representable in this layout (saturates to max-finite).

Used for ML inference where extreme dynamic range isn't needed.

### `fp8e5m2`

IEEE 754 binary8 with 1 sign bit, 5 exponent bits, 2 mantissa bits.
Bias 15. Range approximately ±57344 with denormals. Infinity and
NaN both representable.

Used for ML training and inference where dynamic range matters more
than precision.

### `fp16`

IEEE 754 binary16. 1 sign + 5 exponent + 10 mantissa bits. Standard
half-precision. Range approximately ±65504.

### `bf16`

bfloat16: 1 sign + 8 exponent + 7 mantissa. Same range as fp32 with
reduced precision. Common in transformer training (TPU/A100 native).

### `fp32` / `fp64`

IEEE 754 binary32 / binary64. Standard single / double precision.

### `cfloat32` / `cfloat64`

Complex numbers. Each element is a pair (real, imaginary) with the
underlying float type. Real comes first.

For `cfloat32`: 8 bytes per element (4 bytes real + 4 bytes imag).
For `cfloat64`: 16 bytes per element.

### Quantized types (`qint4`, `qint8`, `qfp8`)

A quantized tensor stores low-precision values plus per-tensor (or
per-channel) scale and zero-point metadata. The wire format is:

- Data block: same as the underlying dtype (`int4`, `int8`, `fp8`)
- Schema metadata: per-tensor `scale` (fp32) and `zero_point`
  (matching int dtype) — declared in the schema sidecar, NOT in the
  data block

Decoding a quantized element: `value = (qvalue - zero_point) * scale`
(scaling done in fp32 by default; consumers MAY use mixed-precision).

For per-channel quantization (different scale/zp per output channel),
the schema declares which axis is the channel axis, and scale/zp
become 1D arrays of length `shape[channel_axis]`. The wire format
then has one fp32 scale per channel and one zero_point per channel
in the schema.

## Element count and data block size

For a tensor of shape `[d0, d1, ..., dn]` with dtype having `b`
bits/element:

```
total_elements = d0 * d1 * ... * dn
total_bits     = total_elements * b
data_bytes     = ceil(total_bits / 8)
```

Padding: zero-bit padding at end of the block to reach byte boundary.

A 1024×768 fp32 tensor occupies 1024 × 768 × 4 = 3,145,728 bytes,
no padding (already byte-aligned).

A 100×100 int4 tensor occupies 100 × 100 × 0.5 = 5,000 bytes, no
padding.

A 17×7 bool tensor occupies ⌈17 × 7 / 8⌉ = ⌈14.875⌉ = 15 bytes
with 1-bit padding at the end.

## Forbidden values

The following dtype/value combinations are reserved and MUST cause
a refusal during decoding:

- Quantized dtype without schema declaring scale/zero-point
- `int4` with high bit set in lower nibble (would imply > 4 bits used)
- Any dtype tag in the reserved range (19..27 in the current registry)

## Round-trip guarantees

For any tensor `T` with a supported dtype:

```
decode(encode(T)) == T  bit-exactly
```

(No JSON-style coercion; tensor data is bit-preserved.)

For floating-point dtypes, NaN bit patterns are preserved (specific
NaN signaling bits round-trip). This contrasts with the JSON profile
where NaN coerces to null.

## Conformance

Level 1 decoders MUST handle dtypes 0..18 and 28..30 (the defined
non-extended dtypes).

Level 2 encoders MUST emit only defined dtypes.

Level 3 encoders MUST agree byte-for-byte with the reference for the
same input tensor + dtype + schema.

Implementations MAY support a subset of dtypes (e.g., fp16 and fp32
only). Doing so is a documented limitation, not a conformance
violation. Consumers receiving an unsupported dtype get a clear
error, never silent data corruption.

## Implementation notes (non-normative)

The reference implementation will:

- Use typed arrays (`Float32Array`, `Float16Array` via polyfill,
  `Uint8Array`, etc.) for dtype-specific decode buffers
- Use `DataView` for endianness control on multi-byte dtypes
- Defer fp8 / int4 / quantization until v0.2 (start with fp32 / fp16
  / int8 / fp64 for the v0.1 launch)

## Test vector references

Conformance test vectors live at
`weavepack/profiles/tensor/test-vectors/types/` (to be populated in
Phase 5.6).
