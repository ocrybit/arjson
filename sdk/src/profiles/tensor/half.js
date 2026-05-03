// fp16 / bf16 conversion helpers for weavepack-tensor.
//
// Implements the conversions specified in RFC 0001
// (weavepack/rfcs/0001-tensor-fp16-bf16.md):
//
//   fp16 ↔ f32   IEEE 754 binary16 (1 sign + 5 exp + 10 mantissa)
//   bf16 ↔ f32   bfloat16 (1 sign + 8 exp + 7 mantissa = upper 16
//                bits of f32)
//
// All round-to-nearest-even per IEEE 754. Subnormals + Infinity +
// NaN handled per spec.
//
// We use a shared ArrayBuffer + DataView pair to extract / construct
// f32 bit patterns. This is the standard portable approach in JS
// (no BigInt cost, works on any V8 / SpiderMonkey).

const _convBuf = new ArrayBuffer(4)
const _convF32 = new Float32Array(_convBuf)
const _convU32 = new Uint32Array(_convBuf)

function f32ToBits(f) {
  _convF32[0] = f
  return _convU32[0]
}

function bitsToF32(b) {
  _convU32[0] = b
  return _convF32[0]
}

// ── fp16 → f32 ──────────────────────────────────────────────────────

export function fp16BitsToF32(raw) {
  raw = raw & 0xffff
  const sign = (raw >> 15) & 1
  const exp = (raw >> 10) & 0x1f
  const mantissa = raw & 0x3ff

  if (exp === 0) {
    if (mantissa === 0) {
      return sign ? -0 : 0
    }
    // Subnormal: value = ±(mantissa / 1024) × 2^-14
    const v = (mantissa / 1024) * Math.pow(2, -14)
    return sign ? -v : v
  }
  if (exp === 0x1f) {
    if (mantissa === 0) return sign ? -Infinity : Infinity
    return NaN
  }
  // Normal.
  const v = (1 + mantissa / 1024) * Math.pow(2, exp - 15)
  return sign ? -v : v
}

// ── f32 → fp16 (round-to-nearest-even) ──────────────────────────────

export function f32ToFp16Bits(f) {
  if (Number.isNaN(f)) return 0x7e00  // canonical qNaN

  if (f === 0) {
    // Preserve sign of zero.
    return f32ToBits(f) >>> 16 & 0x8000
  }

  const bits = f32ToBits(f)
  const sign = (bits >>> 31) & 1
  const exp32 = (bits >>> 23) & 0xff
  const mant32 = bits & 0x7fffff

  if (exp32 === 0xff) {
    // f32 Infinity or NaN.
    return mant32 === 0 ? (sign << 15) | 0x7c00 : 0x7e00
  }

  // Unbiased exponent.
  const e = exp32 - 127

  if (e > 15) {
    // Overflow → ±Infinity in fp16.
    return (sign << 15) | 0x7c00
  }

  if (e < -24) {
    // Underflow below smallest fp16 subnormal → ±0.
    return sign << 15
  }

  if (e < -14) {
    // Subnormal range. fp16 subnormal value = m * 2^-24.
    // From f32: value = (mant24 / 2^23) * 2^e where mant24 = mant32 | 0x800000.
    // Solving: m = mant24 * 2^(e + 1)  (i.e., shift right by -e - 1).
    // Range check: smallest subnormal is 2^-24 (e=-24, shift=23, m=1).
    // Below that → underflow to 0.
    const mant24 = mant32 | 0x800000
    const shift = -e - 1
    if (shift > 23) return sign << 15  // way below smallest subnormal
    let m = mant24 >>> shift
    // Round-to-nearest-even on the bits shifted off.
    const lostMask = (1 << shift) - 1
    const lost = mant24 & lostMask
    const halfway = 1 << (shift - 1)
    if (lost > halfway || (lost === halfway && (m & 1))) m += 1
    if (m >= 0x400) {
      // Rounded up into normal range. exp=1, mantissa=0.
      return (sign << 15) | (1 << 10)
    }
    return (sign << 15) | m
  }

  // Normal.
  const exp16 = e + 15
  // Extract top 10 mantissa bits, round-to-nearest-even on remaining 13 bits.
  let m = mant32 >>> 13
  const lost = mant32 & 0x1fff
  const halfway = 0x1000
  if (lost > halfway || (lost === halfway && (m & 1))) m += 1
  if (m >= 0x400) {
    // Mantissa overflow → carry into exponent.
    if (exp16 + 1 >= 31) return (sign << 15) | 0x7c00  // → Infinity
    return (sign << 15) | ((exp16 + 1) << 10) | 0
  }
  return (sign << 15) | (exp16 << 10) | m
}

// ── bf16 → f32 ──────────────────────────────────────────────────────

export function bf16BitsToF32(raw) {
  // bf16 IS the upper 16 bits of f32; pad lower 16 with zeros.
  return bitsToF32((raw & 0xffff) << 16)
}

// ── f32 → bf16 (round-to-nearest-even) ──────────────────────────────

export function f32ToBf16Bits(f) {
  if (Number.isNaN(f)) return 0x7fc0  // qNaN with mantissa bit set

  const bits = f32ToBits(f)
  const upper = (bits >>> 16) & 0xffff
  const lower = bits & 0xffff

  // Round-to-nearest-even: if lower > 0x8000, round up; if exactly
  // 0x8000, round to even (round up only if upper is odd).
  if (lower > 0x8000 || (lower === 0x8000 && (upper & 1))) {
    let result = upper + 1
    // Carry into exponent OK; if it overflows to NaN-shape with zero
    // mantissa, keep one mantissa bit set (RFC 0001 NaN handling).
    if ((result & 0x7fff) === 0x7f80) {
      // We just landed on Infinity bit pattern. That's correct for
      // genuine overflow. But if the original wasn't Infinity, this
      // is unusual — happens only for values just below max-finite.
      // Returning Infinity is the correct IEEE result.
    }
    return result & 0xffff
  }
  return upper
}

// ── Bulk array helpers ──────────────────────────────────────────────

/// Convert a Float32Array to a Uint16Array of fp16 raw bits.
export function f32ArrayToFp16Bits(f32arr) {
  const out = new Uint16Array(f32arr.length)
  for (let i = 0; i < f32arr.length; i++) out[i] = f32ToFp16Bits(f32arr[i])
  return out
}

/// Convert a Uint16Array of fp16 raw bits to a Float32Array.
export function fp16BitsToF32Array(u16arr) {
  const out = new Float32Array(u16arr.length)
  for (let i = 0; i < u16arr.length; i++) out[i] = fp16BitsToF32(u16arr[i])
  return out
}

export function f32ArrayToBf16Bits(f32arr) {
  const out = new Uint16Array(f32arr.length)
  for (let i = 0; i < f32arr.length; i++) out[i] = f32ToBf16Bits(f32arr[i])
  return out
}

export function bf16BitsToF32Array(u16arr) {
  const out = new Float32Array(u16arr.length)
  for (let i = 0; i < u16arr.length; i++) out[i] = bf16BitsToF32(u16arr[i])
  return out
}
