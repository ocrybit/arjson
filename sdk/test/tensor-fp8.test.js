// fp8e4m3 / fp8e5m2 round-trip tests for weavepack-tensor.
// See weavepack/profiles/tensor/01-types.md for the normative spec.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocument, decodeDocument, DTYPE,
  fp8e4m3ToF32, f32ToFp8e4m3, f32ArrayToFp8e4m3Bits,
  fp8e5m2ToF32, f32ToFp8e5m2, f32ArrayToFp8e5m2Bits,
} from "../src/profiles/tensor/index.js"

// ── fp8e4m3 ──────────────────────────────────────────────────────────────────

describe("fp8e4m3 decode (fp8e4m3ToF32)", () => {
  it("decodes ±0", () => {
    assert.equal(fp8e4m3ToF32(0x00), 0)
    assert.equal(Object.is(fp8e4m3ToF32(0x80), -0), true)
  })

  it("decodes 1.0 (0x38 = 0_0111_000)", () => {
    assert.equal(fp8e4m3ToF32(0x38), 1.0)
  })

  it("decodes -1.0 (0xB8 = 1_0111_000)", () => {
    assert.equal(fp8e4m3ToF32(0xb8), -1.0)
  })

  it("decodes 0.5 (0x30 = 0_0110_000)", () => {
    assert.equal(fp8e4m3ToF32(0x30), 0.5)
  })

  it("decodes max-finite 448 (0x7E = 0_1111_110)", () => {
    assert.equal(fp8e4m3ToF32(0x7e), 448)
  })

  it("decodes smallest subnormal 2^-9 (0x01 = 0_0000_001)", () => {
    assert.equal(fp8e4m3ToF32(0x01), 1 / 512)
  })

  it("decodes NaN (0x7F = 0_1111_111)", () => {
    assert.ok(Number.isNaN(fp8e4m3ToF32(0x7f)))
  })

  it("decodes NaN negative pattern (0xFF = 1_1111_111)", () => {
    assert.ok(Number.isNaN(fp8e4m3ToF32(0xff)))
  })
})

describe("fp8e4m3 encode (f32ToFp8e4m3)", () => {
  it("encodes ±0", () => {
    assert.equal(f32ToFp8e4m3(0), 0x00)
    assert.equal(f32ToFp8e4m3(-0), 0x80)
  })

  it("encodes 1.0 → 0x38", () => {
    assert.equal(f32ToFp8e4m3(1.0), 0x38)
  })

  it("encodes -1.0 → 0xB8", () => {
    assert.equal(f32ToFp8e4m3(-1.0), 0xb8)
  })

  it("encodes 0.5 → 0x30", () => {
    assert.equal(f32ToFp8e4m3(0.5), 0x30)
  })

  it("encodes max-finite 448 → 0x7E", () => {
    assert.equal(f32ToFp8e4m3(448), 0x7e)
  })

  it("encodes -448 → 0xFE", () => {
    assert.equal(f32ToFp8e4m3(-448), 0xfe)
  })

  it("saturates overflow to max-finite (no Infinity in fp8e4m3)", () => {
    assert.equal(f32ToFp8e4m3(1e38), 0x7e)   // overflow → 448
    assert.equal(f32ToFp8e4m3(-1e38), 0xfe)  // overflow → -448
    assert.equal(f32ToFp8e4m3(Infinity), 0x7e)
    assert.equal(f32ToFp8e4m3(-Infinity), 0xfe)
  })

  it("encodes NaN → canonical 0x7F", () => {
    assert.equal(f32ToFp8e4m3(NaN), 0x7f)
  })

  it("encodes smallest subnormal 2^-9 → 0x01", () => {
    assert.equal(f32ToFp8e4m3(1 / 512), 0x01)
  })

  it("underflows below 0.5 × (smallest subnormal) to zero", () => {
    // Boundary: 2^-10; below → 0.
    assert.equal(f32ToFp8e4m3(1 / 2048), 0x00)  // 2^-11, well below boundary
  })

  it("round-trips normal values exactly", () => {
    const vals = [1, -1, 2, 4, 8, 16, 0.5, 0.25, 0.125, 448, -448]
    for (const v of vals) {
      assert.equal(fp8e4m3ToF32(f32ToFp8e4m3(v)), v, `round-trip failed for ${v}`)
    }
  })
})

describe("fp8e4m3 bulk + tensor round-trip", () => {
  it("bulk-converts Float32Array via f32ArrayToFp8e4m3Bits", () => {
    const f32 = new Float32Array([0, 1, -1, 0.5, 448])
    const bits = f32ArrayToFp8e4m3Bits(f32)
    assert.deepEqual(Array.from(bits), [0x00, 0x38, 0xb8, 0x30, 0x7e])
  })

  it("encodes and decodes fp8e4m3 tensor (Float32Array input)", () => {
    const doc = {
      tensors: {
        w: { dtype: DTYPE.FP8E4M3, shape: [4], data: new Float32Array([1, 2, 4, 8]) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.equal(decoded.tensors.w.dtype, DTYPE.FP8E4M3)
    // Decoded data is Uint8Array of raw fp8 bits.
    const bits = Array.from(decoded.tensors.w.data)
    assert.deepEqual(bits, [0x38, 0x40, 0x48, 0x50])
  })

  it("encodes and decodes fp8e4m3 tensor (Uint8Array raw bits input)", () => {
    const rawBits = new Uint8Array([0x00, 0x38, 0xb8, 0x7e])
    const doc = { tensors: { t: { dtype: DTYPE.FP8E4M3, shape: [4], data: rawBits } } }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.deepEqual(Array.from(decoded.tensors.t.data), [0x00, 0x38, 0xb8, 0x7e])
  })

  it("preserves NaN bits through round-trip", () => {
    const rawBits = new Uint8Array([0x7f])  // canonical NaN
    const doc = { tensors: { t: { dtype: DTYPE.FP8E4M3, shape: [1], data: rawBits } } }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.equal(decoded.tensors.t.data[0], 0x7f)
  })
})

// ── fp8e5m2 ──────────────────────────────────────────────────────────────────

describe("fp8e5m2 decode (fp8e5m2ToF32)", () => {
  it("decodes ±0", () => {
    assert.equal(fp8e5m2ToF32(0x00), 0)
    assert.equal(Object.is(fp8e5m2ToF32(0x80), -0), true)
  })

  it("decodes 1.0 (0x3C = 0_01111_00)", () => {
    assert.equal(fp8e5m2ToF32(0x3c), 1.0)
  })

  it("decodes -1.0 (0xBC)", () => {
    assert.equal(fp8e5m2ToF32(0xbc), -1.0)
  })

  it("decodes 0.5 (0x38 = 0_01110_00)", () => {
    assert.equal(fp8e5m2ToF32(0x38), 0.5)
  })

  it("decodes max-finite 57344 (0x7B = 0_11110_11)", () => {
    assert.equal(fp8e5m2ToF32(0x7b), 57344)
  })

  it("decodes +Infinity (0x7C = 0_11111_00)", () => {
    assert.equal(fp8e5m2ToF32(0x7c), Infinity)
  })

  it("decodes -Infinity (0xFC = 1_11111_00)", () => {
    assert.equal(fp8e5m2ToF32(0xfc), -Infinity)
  })

  it("decodes NaN (0x7F = 0_11111_11)", () => {
    assert.ok(Number.isNaN(fp8e5m2ToF32(0x7f)))
  })

  it("decodes smallest subnormal 2^-16 (0x01)", () => {
    assert.equal(fp8e5m2ToF32(0x01), 1 / 65536)
  })
})

describe("fp8e5m2 encode (f32ToFp8e5m2)", () => {
  it("encodes ±0", () => {
    assert.equal(f32ToFp8e5m2(0), 0x00)
    assert.equal(f32ToFp8e5m2(-0), 0x80)
  })

  it("encodes 1.0 → 0x3C", () => {
    assert.equal(f32ToFp8e5m2(1.0), 0x3c)
  })

  it("encodes -1.0 → 0xBC", () => {
    assert.equal(f32ToFp8e5m2(-1.0), 0xbc)
  })

  it("encodes max-finite 57344 → 0x7B", () => {
    assert.equal(f32ToFp8e5m2(57344), 0x7b)
  })

  it("encodes +Infinity → 0x7C", () => {
    assert.equal(f32ToFp8e5m2(Infinity), 0x7c)
  })

  it("encodes -Infinity → 0xFC", () => {
    assert.equal(f32ToFp8e5m2(-Infinity), 0xfc)
  })

  it("overflows to ±Infinity", () => {
    assert.equal(f32ToFp8e5m2(1e38), 0x7c)   // overflow → +Inf
    assert.equal(f32ToFp8e5m2(-1e38), 0xfc)  // overflow → -Inf
  })

  it("encodes NaN → canonical 0x7F", () => {
    assert.equal(f32ToFp8e5m2(NaN), 0x7f)
  })

  it("encodes smallest subnormal 2^-16 → 0x01", () => {
    assert.equal(f32ToFp8e5m2(1 / 65536), 0x01)
  })

  it("underflows below 2^-17 to zero", () => {
    assert.equal(f32ToFp8e5m2(1 / 262144), 0x00)  // 2^-18, well below boundary
  })

  it("round-trips normal values exactly", () => {
    const vals = [1, -1, 2, 4, 0.5, 0.25, 57344, -57344]
    for (const v of vals) {
      assert.equal(fp8e5m2ToF32(f32ToFp8e5m2(v)), v, `round-trip failed for ${v}`)
    }
  })
})

describe("fp8e5m2 bulk + tensor round-trip", () => {
  it("bulk-converts Float32Array via f32ArrayToFp8e5m2Bits", () => {
    const f32 = new Float32Array([0, 1, -1, 0.5])
    const bits = f32ArrayToFp8e5m2Bits(f32)
    assert.deepEqual(Array.from(bits), [0x00, 0x3c, 0xbc, 0x38])
  })

  it("encodes and decodes fp8e5m2 tensor (Float32Array input)", () => {
    const doc = {
      tensors: {
        w: { dtype: DTYPE.FP8E5M2, shape: [4], data: new Float32Array([1, 2, 4, 57344]) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.equal(decoded.tensors.w.dtype, DTYPE.FP8E5M2)
    const bits = Array.from(decoded.tensors.w.data)
    // 1→0x3C, 2→0x40 (exp=16,mant=0), 4→0x44, 57344→0x7B
    assert.equal(bits[0], 0x3c)
    assert.equal(bits[3], 0x7b)
  })

  it("preserves ±Inf bits through round-trip", () => {
    const rawBits = new Uint8Array([0x7c, 0xfc])
    const doc = { tensors: { t: { dtype: DTYPE.FP8E5M2, shape: [2], data: rawBits } } }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.equal(decoded.tensors.t.data[0], 0x7c)
    assert.equal(decoded.tensors.t.data[1], 0xfc)
  })
})
