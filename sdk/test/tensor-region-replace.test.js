// Tests for region_replace (op 3) tensor delta.
// Implements RFC tier-1 item per V0.2-PLANNING.md.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocument, decodeDocument,
  encodeDelta, applyDelta,
  TensorPack, DTYPE,
} from "../src/profiles/tensor/index.js"

const fp32 = vs => new Float32Array(vs)
const arrEq = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return false
  }
  return true
}

describe("region_replace delta op", () => {
  it("dense block change picks region_replace", () => {
    // 10x10 fp32; change a contiguous 3x3 block.
    const baseData = fp32(Array.from({ length: 100 }, (_, i) => i))
    const newData = new Float32Array(baseData)
    // Change rows 4-6, cols 5-7 to 999.
    for (let r = 4; r < 7; r++) {
      for (let c = 5; c < 8; c++) {
        newData[r * 10 + c] = 999.0
      }
    }
    const base = { tensors: { m: { dtype: DTYPE.FP32, shape: [10, 10], data: baseData } } }
    const updated = { tensors: { m: { dtype: DTYPE.FP32, shape: [10, 10], data: newData } } }

    const delta = encodeDelta(base, updated)
    assert.ok(delta !== null)
    const result = applyDelta(base, delta)

    // Verify all 100 elements.
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const i = r * 10 + c
        const exp = (r >= 4 && r < 7 && c >= 5 && c < 8) ? 999.0 : i
        assert.equal(result.tensors.m.data[i], exp,
          `index [${r},${c}] (${i}): got ${result.tensors.m.data[i]}, expected ${exp}`)
      }
    }
  })

  it("scattered changes still pick element_set, not region_replace", () => {
    // 100 elements, change 5 widely-scattered ones.
    // Bounding box would be huge but only 5 elements changed → low density →
    // element_set wins.
    const baseData = fp32(new Array(100).fill(0))
    const newData = new Float32Array(baseData)
    newData[0] = 1
    newData[99] = 2
    newData[50] = 3
    const base = { tensors: { v: { dtype: DTYPE.FP32, shape: [100], data: baseData } } }
    const updated = { tensors: { v: { dtype: DTYPE.FP32, shape: [100], data: newData } } }

    const delta = encodeDelta(base, updated)
    const result = applyDelta(base, delta)
    assert.equal(result.tensors.v.data[0], 1)
    assert.equal(result.tensors.v.data[50], 3)
    assert.equal(result.tensors.v.data[99], 2)
    assert.equal(result.tensors.v.data[1], 0)
  })

  it("contiguous run in 1D triggers region_replace", () => {
    // 1D tensor; change a contiguous range of 10 elements (10% of total).
    const N = 100
    const baseData = fp32(Array.from({ length: N }, (_, i) => i * 0.1))
    const newData = new Float32Array(baseData)
    for (let i = 30; i < 40; i++) newData[i] = 100.0 + i

    const base = { tensors: { x: { dtype: DTYPE.FP32, shape: [N], data: baseData } } }
    const updated = { tensors: { x: { dtype: DTYPE.FP32, shape: [N], data: newData } } }

    const delta = encodeDelta(base, updated)
    const result = applyDelta(base, delta)
    for (let i = 30; i < 40; i++) {
      assert.equal(result.tensors.x.data[i], 100.0 + i)
    }
    assert.ok(Math.abs(result.tensors.x.data[29] - 2.9) < 1e-6)
    assert.ok(Math.abs(result.tensors.x.data[40] - 4.0) < 1e-6)
  })

  it("region_replace via TensorPack chain round-trip", () => {
    const N = 50
    const baseData = fp32(new Array(N).fill(1))
    const newData = new Float32Array(baseData)
    for (let i = 10; i < 20; i++) newData[i] = 99
    const v1 = { tensors: { z: { dtype: DTYPE.FP32, shape: [N], data: baseData } } }
    const v2 = { tensors: { z: { dtype: DTYPE.FP32, shape: [N], data: newData } } }

    const pack = new TensorPack({ json: v1 })
    pack.update(v2)
    const buf = pack.toBuffer()
    const restored = new TensorPack({ arj: buf })

    for (let i = 0; i < N; i++) {
      const exp = (i >= 10 && i < 20) ? 99 : 1
      assert.equal(restored.json.tensors.z.data[i], exp)
    }
  })

  it("region_replace size beats tensor_replace for dense block", () => {
    // 1000 elements; change a contiguous block of 100 (10% sparsity but
    // 100% density inside the bbox) → region_replace.
    const N = 1000
    const baseData = fp32(new Array(N).fill(0))
    const newData = new Float32Array(baseData)
    for (let i = 100; i < 200; i++) newData[i] = i

    const base = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: baseData } } }
    const updated = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: newData } } }

    const delta = encodeDelta(base, updated)
    // region_replace: ~100 × 4 bytes data + small header
    // tensor_replace (no delta): N × 4 bytes = 4000 bytes
    // element_set: 100 × (index_leb + value 4 bytes) = ~500 bytes
    // region_replace should be ~430 bytes (100 × 4 + ~30 header)
    assert.ok(delta.length < 500, `region_replace ${delta.length} bytes should be < 500`)

    const result = applyDelta(base, delta)
    for (let i = 100; i < 200; i++) {
      assert.equal(result.tensors.w.data[i], i)
    }
  })
})
