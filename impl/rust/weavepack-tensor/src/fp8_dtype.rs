// fp8e4m3 / fp8e5m2 conversion helpers for weavepack-tensor (Rust).
//
// Mirrors sdk/src/profiles/tensor/fp8.js exactly:
//   fp8e4m3 — 1 sign + 4 exp (bias 7) + 3 mantissa, no Infinity
//              max-finite ±448; NaN = S.1111.111 only (0x7F, 0xFF)
//   fp8e5m2 — 1 sign + 5 exp (bias 15) + 2 mantissa, Infinity and NaN
//              max-finite ±57344; ±Inf = S.11111.00; NaN = S.11111.{01..11}
//
// All round-to-nearest-even per IEEE 754. Subnormals + Infinity + NaN
// handled per spec.

// ── fp8e4m3 → f32 ─────────────────────────────────────────────────────────

pub fn fp8e4m3_to_f32(raw: u8) -> f32 {
    let sign = (raw >> 7) & 1;
    let exp  = (raw >> 3) & 0xf;
    let mant =  raw       & 0x7;

    if exp == 0xf && mant == 0x7 {
        return f32::NAN;
    }
    let sign_factor: f32 = if sign != 0 { -1.0 } else { 1.0 };
    if exp == 0 {
        if mant == 0 {
            return if sign != 0 { -0.0 } else { 0.0 };
        }
        // subnormal: ±(mant/8) × 2^-6
        return sign_factor * (mant as f32) * (1.0 / 512.0);
    }
    // normal: ±(1 + mant/8) × 2^(exp-7)
    sign_factor * (1.0 + (mant as f32) / 8.0) * (2.0f32).powi(exp as i32 - 7)
}

// ── f32 → fp8e4m3 (round-to-nearest-even) ─────────────────────────────────

pub fn f32_to_fp8e4m3(f: f32) -> u8 {
    if f.is_nan() {
        return 0x7f; // canonical NaN
    }
    let bits = f.to_bits();
    let sign     = ((bits >> 31) & 1) as u8;
    let sign_bit = sign << 7;
    let exp32    = ((bits >> 23) & 0xff) as i32;
    let mant32   = bits & 0x7f_ffff;

    if exp32 == 0 && mant32 == 0 {
        return sign_bit; // ±0
    }
    // ±Inf saturates to max-finite ±448 (no Infinity in fp8e4m3)
    if exp32 == 0xff && mant32 == 0 {
        return sign_bit | 0x7e;
    }

    let e = exp32 - 127; // unbiased f32 exponent

    if e > 8 {
        return sign_bit | 0x7e; // overflow → max-finite
    }

    if e >= -6 {
        // Normal range: biased fp8 exp = e+7 in [1..15].
        let exp8 = (e + 7) as u8;
        let mut m = (mant32 >> 20) as u8;
        let lost  = mant32 & 0xf_ffff;
        // Round-to-nearest-even on 20 dropped bits.
        if lost > 0x8_0000 || (lost == 0x8_0000 && (m & 1) != 0) {
            m += 1;
        }
        if m >= 8 {
            let new_exp8 = exp8 + 1;
            if new_exp8 > 15 {
                return sign_bit | 0x7e; // overflow → max-finite
            }
            return sign_bit | (new_exp8 << 3);
        }
        // exp8=15, mant=7 is the sole NaN pattern; clamp to max-finite.
        if exp8 == 15 && m == 7 {
            return sign_bit | 0x7e;
        }
        return sign_bit | (exp8 << 3) | m;
    }

    // Subnormal range (e in [-10..-7]).
    if e >= -10 {
        let mant24 = mant32 | 0x80_0000;
        let shift  = (14 - e) as u32; // in [21..24]
        let (m, lost, halfway) = if shift >= 24 {
            (0u8, mant24, 0x80_0000u32)
        } else {
            let m_val = (mant24 >> shift) as u8;
            let l     = mant24 & ((1 << shift) - 1);
            let h     = 1u32 << (shift - 1);
            (m_val, l, h)
        };
        let mut m = m;
        if lost > halfway || (lost == halfway && (m & 1) != 0) {
            m += 1;
        }
        if m >= 8 {
            return sign_bit | (1 << 3); // carry → smallest normal (exp8=1, m=0)
        }
        return sign_bit | m; // exp8=0 (subnormal)
    }

    sign_bit // underflow → ±0
}

// ── fp8e5m2 → f32 ─────────────────────────────────────────────────────────

pub fn fp8e5m2_to_f32(raw: u8) -> f32 {
    let sign = (raw >> 7) & 1;
    let exp  = (raw >> 2) & 0x1f;
    let mant =  raw       & 0x3;

    if exp == 0x1f {
        return if mant == 0 {
            if sign != 0 { f32::NEG_INFINITY } else { f32::INFINITY }
        } else {
            f32::NAN
        };
    }
    let sign_factor: f32 = if sign != 0 { -1.0 } else { 1.0 };
    if exp == 0 {
        if mant == 0 {
            return if sign != 0 { -0.0 } else { 0.0 };
        }
        // subnormal: ±(mant/4) × 2^-14
        return sign_factor * (mant as f32) * (1.0 / 65536.0);
    }
    // normal: ±(1 + mant/4) × 2^(exp-15)
    sign_factor * (1.0 + (mant as f32) / 4.0) * (2.0f32).powi(exp as i32 - 15)
}

// ── f32 → fp8e5m2 (round-to-nearest-even) ─────────────────────────────────

pub fn f32_to_fp8e5m2(f: f32) -> u8 {
    if f.is_nan() {
        return 0x7f; // canonical qNaN (0_11111_11)
    }
    let bits = f.to_bits();
    let sign     = ((bits >> 31) & 1) as u8;
    let sign_bit = sign << 7;
    let exp32    = ((bits >> 23) & 0xff) as i32;
    let mant32   = bits & 0x7f_ffff;

    if exp32 == 0 && mant32 == 0 {
        return sign_bit; // ±0
    }
    // ±Inf → fp8e5m2 ±Inf
    if exp32 == 0xff && mant32 == 0 {
        return sign_bit | 0x7c;
    }

    let e = exp32 - 127;

    if e > 15 {
        return sign_bit | 0x7c; // overflow → ±Inf
    }

    if e >= -14 {
        // Normal range: biased fp8 exp = e+15 in [1..30].
        let exp8 = (e + 15) as u8;
        let mut m = (mant32 >> 21) as u8;
        let lost  = mant32 & 0x1f_ffff;
        if lost > 0x10_0000 || (lost == 0x10_0000 && (m & 1) != 0) {
            m += 1;
        }
        if m >= 4 {
            let new_exp8 = exp8 + 1;
            if new_exp8 >= 31 {
                return sign_bit | 0x7c; // overflow → ±Inf
            }
            return sign_bit | (new_exp8 << 2);
        }
        return sign_bit | (exp8 << 2) | m;
    }

    // Subnormal range (e in [-17..-15]).
    if e >= -17 {
        let mant24 = mant32 | 0x80_0000;
        let shift  = (7 - e) as u32; // in [22..24]
        let (m, lost, halfway) = if shift >= 24 {
            (0u8, mant24, 0x80_0000u32)
        } else {
            let m_val = (mant24 >> shift) as u8;
            let l     = mant24 & ((1 << shift) - 1);
            let h     = 1u32 << (shift - 1);
            (m_val, l, h)
        };
        let mut m = m;
        if lost > halfway || (lost == halfway && (m & 1) != 0) {
            m += 1;
        }
        if m >= 4 {
            return sign_bit | (1 << 2); // carry → smallest normal (exp8=1, m=0)
        }
        return sign_bit | m;
    }

    sign_bit // underflow → ±0
}
