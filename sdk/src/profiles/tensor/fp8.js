// fp8e4m3 / fp8e5m2 conversion helpers for weavepack-tensor.
//
// Implements encode/decode for the two 8-bit floating-point dtypes declared
// in weavepack/profiles/tensor/01-types.md:
//
//   fp8e4m3 — 1 sign + 4 exp (bias 7) + 3 mantissa, no Infinity
//              max-finite ±448; NaN = S.1111.111 only (0x7F, 0xFF)
//   fp8e5m2 — 1 sign + 5 exp (bias 15) + 2 mantissa, Infinity and NaN
//              max-finite ±57344; ±Inf = S.11111.00; NaN = S.11111.{01..11}
//
// All round-to-nearest-even per IEEE 754. Subnormals + Infinity + NaN
// handled per spec.

const _convBuf = new ArrayBuffer(4)
const _convF32 = new Float32Array(_convBuf)
const _convU32 = new Uint32Array(_convBuf)

function f32ToBits(f) { _convF32[0] = f; return _convU32[0] }

// ── fp8e4m3 → f32 ────────────────────────────────────────────────────────
// Format: S.EEEE.MMM  (bit 7 = sign, bits 6:3 = exp, bits 2:0 = mantissa)
// Bias 7. Only S.1111.111 (0x7F / 0xFF) are NaN; all other exp=15 values
// are valid normals (giving max-finite = 448 at exp=15, mant=6).

export function fp8e4m3ToF32(raw) {
  raw = raw & 0xff
  const sign = (raw >> 7) & 1
  const exp  = (raw >> 3) & 0xf
  const mant = raw & 0x7

  if (exp === 0xf && mant === 0x7) return NaN

  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0
    // subnormal: ±(mant/8) × 2^-6 = ±mant × 2^-9
    const v = mant * (1 / 512)
    return sign ? -v : v
  }
  // normal: ±(1 + mant/8) × 2^(exp-7)
  const v = (1 + mant / 8) * Math.pow(2, exp - 7)
  return sign ? -v : v
}

// ── f32 → fp8e4m3 (round-to-nearest-even) ────────────────────────────────

export function f32ToFp8e4m3(f) {
  if (Number.isNaN(f)) return 0x7f  // canonical NaN

  const bits   = f32ToBits(f)
  const sign   = (bits >>> 31) & 1
  const signBit = sign << 7
  const exp32  = (bits >>> 23) & 0xff
  const mant32 = bits & 0x7fffff

  if (exp32 === 0 && mant32 === 0) return signBit  // ±0

  // f32 ±Inf saturates to max-finite ±448 (no Infinity in fp8e4m3)
  if (exp32 === 0xff && mant32 === 0) return signBit | 0x7e

  const e = exp32 - 127  // unbiased f32 exponent

  if (e > 8) return signBit | 0x7e  // overflow → max-finite

  if (e >= -6) {
    // Normal range: biased fp8 exp = e + 7, in [1..15].
    const exp8 = e + 7
    // Keep top 3 of 23 mantissa bits; round on remaining 20.
    let m = mant32 >>> 20
    const lost = mant32 & 0xfffff
    if (lost > 0x80000 || (lost === 0x80000 && (m & 1))) m++
    if (m >= 8) {
      // Mantissa overflow → carry into exponent.
      const newExp8 = exp8 + 1
      if (newExp8 > 15) return signBit | 0x7e  // overflow → max-finite
      return signBit | (newExp8 << 3) | 0
    }
    // exp8=15, mant=7 is the sole NaN pattern; clamp to max-finite.
    if (exp8 === 15 && m === 7) return signBit | 0x7e
    return signBit | (exp8 << 3) | m
  }

  // Subnormal range: fp8 subnormal value = mant × 2^-9.
  // f32 value = mant24 × 2^(e-23) where mant24 = (1<<23)|mant32.
  // fp8 mant = round(v / 2^-9) = round(mant24 >> (14 - e)).
  if (e >= -10) {
    const mant24 = mant32 | 0x800000
    const shift  = 14 - e  // in [21..24]
    let m, lost, halfway
    if (shift >= 24) {
      // e = -10: m = 0, all bits of mant24 are in the "lost" fraction.
      m       = 0
      lost    = mant24
      halfway = 0x800000
    } else {
      m       = mant24 >>> shift
      lost    = mant24 & ((1 << shift) - 1)
      halfway = 1 << (shift - 1)
    }
    if (lost > halfway || (lost === halfway && (m & 1))) m++
    if (m >= 8) return signBit | (1 << 3)  // carry → smallest normal (exp8=1, m=0)
    return signBit | m  // exp8=0 (subnormal)
  }

  return signBit  // underflow → ±0
}

// ── Bulk array helpers (fp8e4m3) ──────────────────────────────────────────

export function f32ArrayToFp8e4m3Bits(f32arr) {
  const out = new Uint8Array(f32arr.length)
  for (let i = 0; i < f32arr.length; i++) out[i] = f32ToFp8e4m3(f32arr[i])
  return out
}

// ── fp8e5m2 → f32 ────────────────────────────────────────────────────────
// Format: S.EEEEE.MM  (bit 7 = sign, bits 6:2 = exp, bits 1:0 = mantissa)
// Bias 15. ±Inf at S.11111.00; NaN at S.11111.{01..11}; max-finite ±57344.

export function fp8e5m2ToF32(raw) {
  raw = raw & 0xff
  const sign = (raw >> 7) & 1
  const exp  = (raw >> 2) & 0x1f
  const mant = raw & 0x3

  if (exp === 0x1f) {
    if (mant === 0) return sign ? -Infinity : Infinity
    return NaN
  }
  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0
    // subnormal: ±(mant/4) × 2^-14 = ±mant × 2^-16
    const v = mant * (1 / 65536)
    return sign ? -v : v
  }
  // normal: ±(1 + mant/4) × 2^(exp-15)
  const v = (1 + mant / 4) * Math.pow(2, exp - 15)
  return sign ? -v : v
}

// ── f32 → fp8e5m2 (round-to-nearest-even) ────────────────────────────────

export function f32ToFp8e5m2(f) {
  if (Number.isNaN(f)) return 0x7f  // canonical qNaN (0_11111_11)

  const bits   = f32ToBits(f)
  const sign   = (bits >>> 31) & 1
  const signBit = sign << 7
  const exp32  = (bits >>> 23) & 0xff
  const mant32 = bits & 0x7fffff

  if (exp32 === 0 && mant32 === 0) return signBit  // ±0

  // f32 ±Inf → fp8e5m2 ±Inf (0x7C / 0xFC)
  if (exp32 === 0xff && mant32 === 0) return signBit | 0x7c

  const e = exp32 - 127  // unbiased f32 exponent

  if (e > 15) return signBit | 0x7c  // overflow → ±Inf

  if (e >= -14) {
    // Normal range: biased fp8 exp = e + 15, in [1..30].
    const exp8 = e + 15
    // Keep top 2 of 23 mantissa bits; round on remaining 21.
    let m = mant32 >>> 21
    const lost = mant32 & 0x1fffff
    if (lost > 0x100000 || (lost === 0x100000 && (m & 1))) m++
    if (m >= 4) {
      // Carry into exponent.
      const newExp8 = exp8 + 1
      if (newExp8 >= 31) return signBit | 0x7c  // overflow → ±Inf
      return signBit | (newExp8 << 2) | 0
    }
    return signBit | (exp8 << 2) | m
  }

  // Subnormal: fp8 subnormal value = mant × 2^-16.
  // fp8 mant = round(v / 2^-16) = round(mant24 >> (7 - e)).
  if (e >= -17) {
    const mant24 = mant32 | 0x800000
    const shift  = 7 - e  // in [22..24]
    let m, lost, halfway
    if (shift >= 24) {
      m       = 0
      lost    = mant24
      halfway = 0x800000
    } else {
      m       = mant24 >>> shift
      lost    = mant24 & ((1 << shift) - 1)
      halfway = 1 << (shift - 1)
    }
    if (lost > halfway || (lost === halfway && (m & 1))) m++
    if (m >= 4) return signBit | (1 << 2)  // carry → smallest normal (exp8=1, m=0)
    return signBit | m
  }

  return signBit  // underflow → ±0
}

// ── Bulk array helpers (fp8e5m2) ──────────────────────────────────────────

export function f32ArrayToFp8e5m2Bits(f32arr) {
  const out = new Uint8Array(f32arr.length)
  for (let i = 0; i < f32arr.length; i++) out[i] = f32ToFp8e5m2(f32arr[i])
  return out
}
