// fp16 / bf16 conversion helpers backing RFC 0001.
//
// Wraps the `half` crate's bit-level conversions so the rest of the
// crate can deal in raw u16 wire bits + Vec<f32> work buffers.
//
// See weavepack/rfcs/0001-tensor-fp16-bf16.md.

use half::{bf16, f16};

// ── single element ─────────────────────────────────────────────────────────

#[inline]
pub fn fp16_bits_to_f32(raw: u16) -> f32 {
    f16::from_bits(raw).to_f32()
}

#[inline]
pub fn f32_to_fp16_bits(f: f32) -> u16 {
    f16::from_f32(f).to_bits()
}

#[inline]
pub fn bf16_bits_to_f32(raw: u16) -> f32 {
    bf16::from_bits(raw).to_f32()
}

#[inline]
pub fn f32_to_bf16_bits(f: f32) -> u16 {
    bf16::from_f32(f).to_bits()
}

// ── bulk array ─────────────────────────────────────────────────────────────

pub fn fp16_array_to_f32(input: &[u16]) -> Vec<f32> {
    input.iter().map(|&x| fp16_bits_to_f32(x)).collect()
}

pub fn f32_array_to_fp16(input: &[f32]) -> Vec<u16> {
    input.iter().map(|&x| f32_to_fp16_bits(x)).collect()
}

pub fn bf16_array_to_f32(input: &[u16]) -> Vec<f32> {
    input.iter().map(|&x| bf16_bits_to_f32(x)).collect()
}

pub fn f32_array_to_bf16(input: &[f32]) -> Vec<u16> {
    input.iter().map(|&x| f32_to_bf16_bits(x)).collect()
}

// ── byte-level helpers (little-endian on the wire) ────────────────────────

pub fn fp16_bytes_to_u16s(bytes: &[u8]) -> Vec<u16> {
    debug_assert!(bytes.len() % 2 == 0, "fp16 bytes must be even-length");
    bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect()
}

pub fn u16s_to_le_bytes(raw: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() * 2);
    for &u in raw {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fp16_round_trip_unit_values() {
        // Values exactly representable in fp16.
        for v in [0.0f32, 1.0, -1.0, 2.0, 0.5, -0.5, 100.0, -100.0] {
            let bits = f32_to_fp16_bits(v);
            let back = fp16_bits_to_f32(bits);
            assert_eq!(back, v, "fp16 round-trip failed for {v}");
        }
    }

    #[test]
    fn fp16_max_finite_and_infinity() {
        // Largest fp16 finite is 65504.
        assert_eq!(f32_to_fp16_bits(65504.0), 0x7bff);
        assert_eq!(fp16_bits_to_f32(0x7bff), 65504.0);
        // Overflow → +Infinity.
        assert_eq!(f32_to_fp16_bits(70000.0), 0x7c00);
        assert!(fp16_bits_to_f32(0x7c00).is_infinite());
        // -Infinity.
        assert_eq!(f32_to_fp16_bits(-70000.0), 0xfc00);
        assert!(fp16_bits_to_f32(0xfc00).is_infinite());
    }

    #[test]
    fn fp16_nan_round_trip() {
        let bits = f32_to_fp16_bits(f32::NAN);
        // exp = 0x1f, mantissa != 0
        assert_eq!((bits >> 10) & 0x1f, 0x1f);
        assert!(fp16_bits_to_f32(bits).is_nan());
    }

    #[test]
    fn fp16_smallest_subnormal_round_trip() {
        // 2^-24 is the smallest fp16 subnormal.
        let v = (-24f32).exp2();
        let bits = f32_to_fp16_bits(v);
        // exp=0, mantissa=1
        assert_eq!(bits, 0x0001);
        assert_eq!(fp16_bits_to_f32(bits), v);
    }

    #[test]
    fn fp16_underflow_to_zero() {
        // Below smallest subnormal → 0.
        assert_eq!(f32_to_fp16_bits((-25f32).exp2()), 0);
    }

    #[test]
    fn bf16_round_trip_unit_values() {
        // bf16 represents these values exactly (7-bit mantissa is
        // sufficient for these magnitudes).
        for v in [0.0f32, 1.0, -1.0, 2.0, 0.5, -0.5] {
            let bits = f32_to_bf16_bits(v);
            let back = bf16_bits_to_f32(bits);
            assert_eq!(back, v, "bf16 round-trip failed for {v}");
        }
    }

    #[test]
    fn bf16_lossy_for_large_precision() {
        // 1e30 has only ~7 significant bits in bf16; round-trip is approximate.
        let bits = f32_to_bf16_bits(1e30);
        let back = bf16_bits_to_f32(bits);
        // Within order of magnitude.
        assert!(back > 1e29 && back < 1e31);
        // bf16's relative precision is ~2^-7 ≈ 0.78%.
        assert!(((back - 1e30).abs() / 1e30) < 0.01);
    }

    #[test]
    fn bf16_one_bit_pattern() {
        assert_eq!(f32_to_bf16_bits(1.0), 0x3f80);
        assert_eq!(bf16_bits_to_f32(0x3f80), 1.0);
    }

    #[test]
    fn bf16_infinity_and_nan() {
        assert_eq!(f32_to_bf16_bits(f32::INFINITY), 0x7f80);
        assert!(bf16_bits_to_f32(0x7f80).is_infinite());
        let nan_bits = f32_to_bf16_bits(f32::NAN);
        assert!(bf16_bits_to_f32(nan_bits).is_nan());
    }

    #[test]
    fn bulk_array_round_trip() {
        let f = vec![1.0f32, 2.0, -3.0, 0.5];
        let bits = f32_array_to_fp16(&f);
        let back = fp16_array_to_f32(&bits);
        assert_eq!(back, f);

        let bbits = f32_array_to_bf16(&f);
        let bback = bf16_array_to_f32(&bbits);
        assert_eq!(bback, f);
    }

    #[test]
    fn byte_round_trip_le() {
        let raw: Vec<u16> = vec![0x3c00, 0x4000, 0xc000];
        let bytes = u16s_to_le_bytes(&raw);
        // Little-endian: 0x3c00 → [0x00, 0x3c]
        assert_eq!(bytes, vec![0x00, 0x3c, 0x00, 0x40, 0x00, 0xc0]);
        let back = fp16_bytes_to_u16s(&bytes);
        assert_eq!(back, raw);
    }
}
