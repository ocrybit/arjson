// weavepack-tensor — initial round-trip tests.
//
// Phase 5 work-in-progress. Validates the v0.1 implementation
// (schemaless, fp32-only, no deltas) round-trips correctly.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocument,
  decodeDocument,
  TensorPack,
  DTYPE,
} from "../src/profiles/tensor/index.js"

function fp32(values) {
  return new Float32Array(values)
}

function arrEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      // Allow exact bit-equality for fp32; Number.EPSILON is too loose
      // for this profile's bit-exact round-trip guarantee.
      // For NaN: equal if both are NaN.
      if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue
      return false
    }
  }
  return true
}

describe("weavepack-tensor v0.1 (fp32, schemaless, no deltas)", () => {
  it("encodes and decodes a single 1D fp32 tensor", () => {
    const doc = {
      tensors: {
        weight: { dtype: DTYPE.FP32, shape: [4], data: fp32([1.0, 2.5, -3.14, 0]) }
      }
    }
    const bytes = encodeDocument(doc)
    const decoded = decodeDocument(bytes)
    assert.equal(Object.keys(decoded.tensors).length, 1)
    assert.deepEqual(decoded.tensors.weight.shape, [4])
    assert.equal(decoded.tensors.weight.dtype, DTYPE.FP32)
    assert.ok(arrEq(decoded.tensors.weight.data, fp32([1.0, 2.5, -3.14, 0])))
  })

  it("round-trips a 2D matrix", () => {
    const doc = {
      tensors: {
        W: { dtype: DTYPE.FP32, shape: [2, 3], data: fp32([1, 2, 3, 4, 5, 6]) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.deepEqual(decoded.tensors.W.shape, [2, 3])
    assert.ok(arrEq(decoded.tensors.W.data, fp32([1, 2, 3, 4, 5, 6])))
  })

  it("round-trips multiple tensors with varied names", () => {
    const doc = {
      tensors: {
        "embedding.weight": { dtype: DTYPE.FP32, shape: [2, 4],
          data: fp32([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) },
        "linear.bias": { dtype: DTYPE.FP32, shape: [4],
          data: fp32([0.01, 0.02, 0.03, 0.04]) },
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    const names = Object.keys(decoded.tensors)
    assert.equal(names.length, 2)
    assert.ok(names.includes("embedding.weight"))
    assert.ok(names.includes("linear.bias"))
    assert.deepEqual(decoded.tensors["embedding.weight"].shape, [2, 4])
    assert.deepEqual(decoded.tensors["linear.bias"].shape, [4])
  })

  it("preserves NaN and special float bits", () => {
    const doc = {
      tensors: {
        special: { dtype: DTYPE.FP32, shape: [4],
          data: fp32([NaN, Infinity, -Infinity, 0]) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    const data = decoded.tensors.special.data
    assert.ok(Number.isNaN(data[0]))
    assert.equal(data[1], Infinity)
    assert.equal(data[2], -Infinity)
    assert.equal(data[3], 0)
  })

  it("handles a larger tensor (1024 elements)", () => {
    const values = Array.from({ length: 1024 }, (_, i) => Math.sin(i / 10))
    const doc = {
      tensors: {
        signal: { dtype: DTYPE.FP32, shape: [32, 32], data: fp32(values) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.ok(arrEq(decoded.tensors.signal.data, fp32(values)))
  })

  it("handles UTF-8 tensor names with non-ASCII", () => {
    const doc = {
      tensors: {
        "中文_weight": { dtype: DTYPE.FP32, shape: [2], data: fp32([1.0, 2.0]) }
      }
    }
    const decoded = decodeDocument(encodeDocument(doc))
    assert.ok("中文_weight" in decoded.tensors)
    assert.ok(arrEq(decoded.tensors["中文_weight"].data, fp32([1.0, 2.0])))
  })

  describe("TensorPack high-level API", () => {
    it("constructs from json and round-trips via toBuffer", () => {
      const doc = {
        tensors: {
          x: { dtype: DTYPE.FP32, shape: [3], data: fp32([1, 2, 3]) }
        }
      }
      const pack = new TensorPack({ json: doc })
      const buf = pack.toBuffer()
      const restored = new TensorPack({ arj: buf })
      assert.ok(arrEq(restored.json.tensors.x.data, fp32([1, 2, 3])))
    })
  })

  describe("boundary verification", () => {
    it("does not import from profiles/json/", async () => {
      const { readFileSync } = await import("node:fs")
      const { fileURLToPath } = await import("node:url")
      const src = readFileSync(
        fileURLToPath(new URL("../src/profiles/tensor/index.js", import.meta.url)),
        "utf8"
      )
      const importLines = src.split("\n").filter(line =>
        /^\s*import\b/.test(line) || /^\s*export\s+.*\bfrom\b/.test(line)
      )
      const offending = importLines.filter(line => line.includes("profiles/json"))
      assert.deepEqual(
        offending,
        [],
        "tensor profile must not import from profiles/json/"
      )
    })
  })
})
