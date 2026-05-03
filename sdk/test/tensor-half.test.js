// fp16 / bf16 round-trip tests for weavepack-tensor.
// Implements RFC 0001 (weavepack/rfcs/0001-tensor-fp16-bf16.md).

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocument, decodeDocument, DTYPE,
  fp16BitsToF32, f32ToFp16Bits, fp16BitsToF32Array, f32ArrayToFp16Bits,
  bf16BitsToF32, f32ToBf16Bits, bf16BitsToF32Array, f32ArrayToBf16Bits,
} from "../src/profiles/tensor/index.js"

describe("fp16 conversions (RFC 0001)", () => {
  it("round-trips zero (positive and negative)", () => {
    assert.equal(fp16BitsToF32(f32ToFp16Bits(0)), 0)
    assert.equal(Object.is(fp16BitsToF32(f32ToFp16Bits(-0)), -0), true)
  })

  it("round-trips 1.0", () => {
    assert.equal(fp16BitsToF32(f32ToFp16Bits(1.0)), 1.0)
    assert.equal(f32ToFp16Bits(1.0), 0x3c00)
  })

  it("round-trips -1.0", () => {
    assert.equal(fp16BitsToF32(f32ToFp16Bits(-1.0)), -1.0)
    assert.equal(f32ToFp16Bits(-1.0), 0xbc00)
  })

  it("encodes max-finite (65504)", () => {
    assert.equal(f32ToFp16Bits(65504), 0x7bff)
    assert.equal(fp16BitsToF32(0x7bff), 65504)
  })

  it("overflows to Infinity above max-finite", () => {
    assert.equal(f32ToFp16Bits(70000), 0x7c00)  // +Infinity
    assert.equal(fp16BitsToF32(0x7c00), Infinity)
  })

  it("encodes -Infinity", () => {
    assert.equal(f32ToFp16Bits(-Infinity), 0xfc00)
    assert.equal(fp16BitsToF32(0xfc00), -Infinity)
  })

  it("encodes NaN", () => {
    const bits = f32ToFp16Bits(NaN)
    // High bits indicate exp=0x1f and mantissa != 0 (NaN-shape).
    assert.equal((bits >> 10) & 0x1f, 0x1f)
    assert.notEqual(bits & 0x3ff, 0)
    assert.ok(Number.isNaN(fp16BitsToF32(bits)))
  })

  it("preserves smallest normal (2^-14)", () => {
    const v = Math.pow(2, -14)
    const bits = f32ToFp16Bits(v)
    assert.equal(bits, 0x0400)  // smallest normal: exp=1, mantissa=0
    assert.equal(fp16BitsToF32(bits), v)
  })

  it("encodes subnormals (smaller than 2^-14)", () => {
    const v = Math.pow(2, -16)  // smaller than smallest normal
    const bits = f32ToFp16Bits(v)
    // Subnormal: exp=0, mantissa nonzero
    assert.equal((bits >> 10) & 0x1f, 0)
    assert.notEqual(bits & 0x3ff, 0)
    // Round-trip; allowing for subnormal precision loss.
    const back = fp16BitsToF32(bits)
    assert.ok(Math.abs(back - v) < 1e-10)
  })

  it("underflows to zero below smallest subnormal", () => {
    assert.equal(f32ToFp16Bits(Math.pow(2, -25)), 0)
  })

  it("converts arrays via f32ArrayToFp16Bits + back", () => {
    const f32 = new Float32Array([1.0, 2.5, -3.14, 0, 100])
    const u16 = f32ArrayToFp16Bits(f32)
    const back = fp16BitsToF32Array(u16)
    assert.equal(back[0], 1.0)
    assert.equal(back[1], 2.5)
    // 3.14 doesn't fit fp16 exactly; allow small rounding.
    assert.ok(Math.abs(back[2] + 3.14) < 0.01)
    assert.equal(back[3], 0)
    assert.equal(back[4], 100)
  })
})

describe("bf16 conversions (RFC 0001)", () => {
  it("round-trips zero", () => {
    assert.equal(bf16BitsToF32(f32ToBf16Bits(0)), 0)
  })

  it("round-trips 1.0 exactly", () => {
    assert.equal(f32ToBf16Bits(1.0), 0x3f80)
    assert.equal(bf16BitsToF32(0x3f80), 1.0)
  })

  it("round-trips -1.0 exactly", () => {
    assert.equal(f32ToBf16Bits(-1.0), 0xbf80)
    assert.equal(bf16BitsToF32(0xbf80), -1.0)
  })

  it("preserves f32 dynamic range", () => {
    // bf16 has same exponent range as f32 (8 bits).
    const big = 1e30
    const back = bf16BitsToF32(f32ToBf16Bits(big))
    // Allow some precision loss but should be in same order of magnitude.
    assert.ok(back > 1e29 && back < 1e31)
  })

  it("encodes ±Infinity", () => {
    assert.equal(f32ToBf16Bits(Infinity), 0x7f80)
    assert.equal(bf16BitsToF32(0x7f80), Infinity)
    assert.equal(f32ToBf16Bits(-Infinity), 0xff80)
    assert.equal(bf16BitsToF32(0xff80), -Infinity)
  })

  it("encodes NaN", () => {
    const bits = f32ToBf16Bits(NaN)
    assert.ok(Number.isNaN(bf16BitsToF32(bits)))
  })

  it("converts arrays via f32ArrayToBf16Bits + back", () => {
    const f32 = new Float32Array([1.0, -2.0, 3.5, 0])
    const u16 = f32ArrayToBf16Bits(f32)
    const back = bf16BitsToF32Array(u16)
    for (let i = 0; i < f32.length; i++) {
      assert.equal(back[i], f32[i], `index ${i}: ${back[i]} != ${f32[i]}`)
    }
  })
})

describe("fp16 tensor round-trip via encodeDocument/decodeDocument", () => {
  it("encodes and decodes fp16 tensor (Float32Array input)", () => {
    const doc = {
      tensors: {
        weight: { dtype: DTYPE.FP16, shape: [4],
          data: new Float32Array([1.0, 2.0, -3.0, 0.5]) }
      }
    }
    const bytes = encodeDocument(doc)
    const decoded = decodeDocument(bytes)
    assert.equal(decoded.tensors.weight.dtype, DTYPE.FP16)
    assert.equal(decoded.tensors.weight.data.length, 4)
    // Decoded data is Uint16Array (raw bits); convert to f32 to compare.
    const f32 = fp16BitsToF32Array(decoded.tensors.weight.data)
    assert.equal(f32[0], 1.0)
    assert.equal(f32[1], 2.0)
    assert.equal(f32[2], -3.0)
    assert.equal(f32[3], 0.5)
  })

  it("encodes and decodes fp16 tensor (Uint16Array raw bits input)", () => {
    const doc = {
      tensors: {
        weight: { dtype: DTYPE.FP16, shape: [3],
          data: new Uint16Array([0x3c00, 0x4000, 0xc000]) }  // 1.0, 2.0, -2.0
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    const f32 = fp16BitsToF32Array(decoded.tensors.weight.data)
    assert.equal(f32[0], 1.0)
    assert.equal(f32[1], 2.0)
    assert.equal(f32[2], -2.0)
  })

  it("encodes and decodes bf16 tensor (Float32Array input)", () => {
    const doc = {
      tensors: {
        w: { dtype: DTYPE.BF16, shape: [4],
          data: new Float32Array([1.0, -1.0, 2.0, 0.5]) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.equal(decoded.tensors.w.dtype, DTYPE.BF16)
    const f32 = bf16BitsToF32Array(decoded.tensors.w.data)
    assert.equal(f32[0], 1.0)
    assert.equal(f32[1], -1.0)
    assert.equal(f32[2], 2.0)
    assert.equal(f32[3], 0.5)
  })

  it("preserves bit-exact fp16 NaN bits round-trip", () => {
    const u16 = new Uint16Array([0x7e00])  // qNaN
    const doc = { tensors: { x: { dtype: DTYPE.FP16, shape: [1], data: u16 } } }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.equal(decoded.tensors.x.data[0], 0x7e00)
  })

  it("mixed dtype document with fp16 and fp32 together", () => {
    const doc = {
      tensors: {
        half: { dtype: DTYPE.FP16, shape: [2], data: new Float32Array([1.0, 2.0]) },
        full: { dtype: DTYPE.FP32, shape: [2], data: new Float32Array([3.0, 4.0]) },
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    const halfF32 = fp16BitsToF32Array(decoded.tensors.half.data)
    assert.equal(halfF32[0], 1.0)
    assert.equal(halfF32[1], 2.0)
    assert.equal(decoded.tensors.full.data[0], 3.0)
    assert.equal(decoded.tensors.full.data[1], 4.0)
  })
})
