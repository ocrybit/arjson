# RFC 0001 — fp16 and bf16 dtype support in weavepack-tensor

**Status:** Accepted (2026-05-06 — JS + Rust + Python reference impls all pass 20/20 vectors byte-exact; no blocking issues raised during discussion period; dual-implementation requirement satisfied; NaN/subnormal/RNE open questions resolved as "any NaN" + emit per IEEE + silent convert — see open questions resolution below)
**Author(s):** Claude / arjson maintainers (TBD)
**Created:** 2026-05-03
**Accepted:** 2026-05-06
**Affects:** weavepack-tensor profile

## Summary

Add concrete encode/decode support for the `fp16` (dtype tag 13) and
`bf16` (dtype tag 14) elements that are already declared in
`weavepack/profiles/tensor/01-types.md` but not implemented in any
reference impl. This is a fill-in change: spec is unchanged; the
implementations gain behavior they currently lack.

## Motivation

Half-precision floats are the dominant storage format for modern
ML model weights. Llama 3, Stable Diffusion, GPT-class models, and
fine-tuned variants all ship in fp16 or bf16. A tensor profile
that can't handle them is missing the primary use case.

Current state:

- Spec declares the dtypes (`weavepack/profiles/tensor/01-types.md`)
- All three implementations (JS, Rust, Python PoC) treat fp16/bf16
  as "supported dtype tags" but their decode path produces raw
  Uint8Array, not actual half-precision values

The cost of leaving this unimplemented: weavepack-tensor cannot be
used for the workloads it was designed for.

## Detailed design

### Wire format

No wire format change. Per `weavepack/profiles/tensor/01-types.md`:

- `fp16` (tag 13): IEEE 754 binary16 layout (1 sign + 5 exp + 10
  mantissa = 16 bits per element), little-endian
- `bf16` (tag 14): bfloat16 layout (1 sign + 8 exp + 7 mantissa
  = 16 bits per element), little-endian

Element packing is byte-aligned (16 bits = 2 bytes per element);
the data block size is `2 × prod(shape)` bytes.

### Conversion to and from f32

JavaScript and Python don't have native fp16 / bf16 types. Both
must convert to f32 on decode and from f32 on encode.

**fp16 → f32**:

```
sign     = (raw >> 15) & 1
exp      = (raw >> 10) & 0x1F
mantissa = raw & 0x3FF

if exp == 0:
  if mantissa == 0:    return ±0
  else:                return ±(mantissa / 2^10) × 2^(-14)  (denormal)
elif exp == 0x1F:
  if mantissa == 0:    return ±Infinity
  else:                return NaN  (preserve mantissa as signaling
                                    bits when target type allows)
else:
  return ±(1 + mantissa / 2^10) × 2^(exp - 15)
```

**f32 → fp16** (per IEEE 754-2008 binary32 → binary16):

```
extract sign, exp, mantissa from f32 bits
if f32 is NaN:        return NaN16 (preserve sign + nonzero mantissa)
if f32 is ±Inf:       return ±Inf16 (exp=31, mantissa=0)
if |f32| > 65504:     return ±Inf16 (overflow)
if |f32| < 2^-24:     return ±0     (underflow)
if exp - 127 < -14:   denormal: shift mantissa accordingly
else:                 normal: exp16 = exp - 127 + 15
                              mantissa16 = top 10 bits with
                                           round-to-nearest-even
```

**bf16 → f32**: trivial — bf16 is the upper 16 bits of f32.

```
fp32_bits = bf16_raw << 16
return f32_from_bits(fp32_bits)
```

**f32 → bf16**: round-to-nearest-even on the lower 16 bits of f32,
return upper 16 bits.

```
upper = f32_bits >> 16
lower = f32_bits & 0xFFFF
if lower > 0x8000 or (lower == 0x8000 and (upper & 1)):
  upper += 1  (carry into exponent OK for IEEE rounding)
return upper as bf16
```

NaN handling: bf16 NaN must have at least one bit set in the
lower-7 mantissa bits. After rounding, if upper becomes NaN-shaped
with zero mantissa, force one mantissa bit on (e.g., the lowest).

### API surface

Each implementation exposes its native typed-array equivalent
when available:

- **JS**: `Float16Array` (Node 21+) when present; otherwise
  `Uint16Array` of raw bits with separate `decodeFp16Array(u16) → Float32Array`
  helper.
- **Rust**: `half::f16` from the `half` crate (already used by ML
  ecosystem). bf16 via `half::bf16`.
- **Python**: `numpy.float16` and `ml_dtypes.bfloat16` (the latter
  is the standard way to get bf16 in numpy).

Implementations MAY accept f32 input arrays in encode and convert
internally, or MAY require the caller to pre-convert. Both are
conformant; documented per impl.

## Backwards compatibility

**Forward compat**: existing payloads without fp16/bf16 tensors
are unaffected. Implementations not yet supporting these dtypes
already error with "unsupported dtype" when they encounter them.
After this RFC ships, those implementations error less often.

**Backward compat**: payloads created by post-RFC encoders using
fp16/bf16 dtypes will be rejected by pre-RFC decoders with the
existing "unsupported dtype" error. This is graceful failure, not
silent corruption.

No version bump required. The dtypes are already in the v0.1 spec;
this RFC just fills implementation gaps. Conformance claims should
be updated to reflect which dtypes each impl now supports.

## Reference implementation

Required to be in at least one language before acceptance per the
dual-implementation rule (`weavepack/governance/01-rfc-process.md`).

**What's already implemented** (as of this RFC's Discussion phase):

- **Rust**: `half::f16` + `bf16` types from the `half` crate;
  encoder + decoder + conformance integrated. Passes 20/20 RFC
  vectors byte-exact.
- **JS**: hand-rolled f32↔fp16/bf16 bit conversions (no native
  Float16Array dependency). Passes 20/20 vectors byte-exact.
- **Python (pure)**: decoder returns raw u16 bits; helpers
  `fp16_bits_to_f32` / `bf16_bits_to_f32` convert on the consumer
  side. Passes 20/20 vectors via the conformance corpus.

A 4th-language implementation would follow the same pattern and
need:

1. Encode path producing byte-exact output for the test vectors below
2. Decode path materializing into the appropriate typed array
3. Updated conformance binary that reports fp16/bf16 vector pass count

## Test vectors

Added to `weavepack/profiles/tensor/test-vectors/types/half.json`.
20 vectors total covering:

**fp16** (8 original + 5 new):
- Round-trip: 0, 1.0, -1.0, 0.5 (unit values)
- Max-finite: 65504 (0x7bff)
- Smallest subnormal: 2^-24 (0x0001)
- Underflow to zero (below 2^-24)
- 2D matrix [1..6]
- Smallest normal: 2^-14 (0x0400) ← new
- +Infinity (0x7c00) ← new
- -Infinity (0xfc00) ← new
- Quiet NaN / qNaN (0x7e00) ← new
- Signaling NaN / sNaN (0x7c01) ← new

**bf16** (3 original + 7 new):
- Round-trip: 0, 1.0, -1.0, 0.5 (unit values)
- Large dynamic range [1e-30, 1, 1e30]
- 2D matrix [1..6]
- +Infinity (0x7f80) ← new
- -Infinity (0xff80) ← new
- Quiet NaN (0x7fc0) ← new
- Smallest denormal (0x0001 ≈ 9.18e-41) ← new
- Round-to-nearest-even tie, rounds up (0x3f82) ← new
- Round-to-nearest-even tie, rounds to even (0x3f80) ← new
- Largest finite (3.39e38 via large-dynamic-range vector, already covered)

**Mixed-dtype** (1 new):
- Document with fp16 tensor `a` + fp32 tensor `b` ← new

Each vector specifies the input values (as f32 numbers or raw uint16
bit patterns via `data_raw_bits` for non-finite values), the
`expected_bytes_hex` for byte-exact encoder verification, and
`expected_bits` for decoded Uint16Array round-trip verification.

## Migration

Not applicable — additive change.

## Alternatives considered

### Force callers to use raw u16 buffers

Punt the conversion to user code. Rejected because:
- Users would re-implement IEEE conversions, varying in correctness
- Rounding behavior would diverge across consumers
- Defeats the protocol's "reversibility before optimization"
  principle

### Defer to v0.2 of the tensor profile

Wait until other v0.2 changes are bundled. Rejected because:
- fp16/bf16 are not v0.2 features per current spec — they're
  v0.1 dtypes that just lack implementations
- Blocking the most common use case for cosmetic version-grouping
  is a bad tradeoff

### Use a different fp16 representation (e.g., google's brain-float
variants beyond bf16)

Out of scope. The spec already commits to IEEE 754 binary16 +
bfloat16. Other half-precision variants would need their own
RFCs.

## Open questions

1. **NaN signaling bit preservation**: do implementations need to
   preserve specific NaN bit patterns, or is "any NaN" sufficient?
   IEEE 754 doesn't fully specify; suggest "any NaN" for v0.1 and
   tighten in a follow-up RFC if a real consumer needs exact NaN
   round-trip.

2. **Default encoding for f32 inputs**: when a user passes an f32
   array and the schema declares the tensor as fp16, should the
   encoder convert silently or error? Suggest: convert silently
   with documented rounding behavior; offer an opt-in strict mode.

3. **Subnormal handling**: some hardware (older GPUs, some FPGAs)
   doesn't support fp16 subnormals (flushes to zero). Should the
   protocol emit subnormals or always zero them? Suggest: emit
   per IEEE; consumers concerned about subnormal hardware can
   pre-process.

## Open questions resolution (at acceptance)

1. **NaN signaling bit preservation**: resolved as "any NaN is sufficient"
   for v0.1. All three impls emit 0x7e00 (fp16) / 0x7fc0 (bf16) as
   canonical qNaN; signaling NaN inputs round-trip as qNaN on decode.
   Exact NaN payload preservation is deferred to a follow-up RFC if
   any real consumer requires it.

2. **Default encoding for f32 inputs**: resolved as "convert silently
   with documented rounding behavior." The RNE rounding algorithm is
   specified in this RFC and matches across all three impls. No strict
   mode needed for v0.1.

3. **Subnormal handling**: resolved as "emit per IEEE." Hardware that
   flushes subnormals must handle this in user code pre/post-encode.
   The conformance corpus explicitly tests subnormal encode/decode
   (fp16 0x0001, bf16 0x0001); all three impls must pass.

## See also

- `weavepack/profiles/tensor/01-types.md` — dtype registry
- `weavepack/profiles/tensor/05-conformance.md` — test vector
  format
- `weavepack/governance/01-rfc-process.md` — RFC procedure
- `half` crate (Rust): https://docs.rs/half/
- `ml_dtypes` (Python): https://github.com/jax-ml/ml_dtypes
