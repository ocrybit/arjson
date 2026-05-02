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

  describe("extended dtype support (Phase 5.3)", () => {
    it("round-trips fp64", () => {
      const data = new Float64Array([1.0, 2.5, -3.14159265358979, 1e308])
      const doc = { tensors: { x: { dtype: DTYPE.FP64, shape: [4], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.x.dtype, DTYPE.FP64)
      assert.ok(decoded.tensors.x.data instanceof Float64Array)
      for (let i = 0; i < 4; i++) {
        assert.equal(decoded.tensors.x.data[i], data[i])
      }
    })

    it("round-trips int8", () => {
      const data = new Int8Array([-128, -1, 0, 1, 127])
      const doc = { tensors: { x: { dtype: DTYPE.INT8, shape: [5], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.x.dtype, DTYPE.INT8)
      assert.ok(decoded.tensors.x.data instanceof Int8Array)
      for (let i = 0; i < 5; i++) {
        assert.equal(decoded.tensors.x.data[i], data[i])
      }
    })

    it("round-trips uint8", () => {
      const data = new Uint8Array([0, 1, 127, 128, 255])
      const doc = { tensors: { x: { dtype: DTYPE.UINT8, shape: [5], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.x.dtype, DTYPE.UINT8)
      for (let i = 0; i < 5; i++) {
        assert.equal(decoded.tensors.x.data[i], data[i])
      }
    })

    it("round-trips int16/uint16", () => {
      const i16 = new Int16Array([-32768, -1, 0, 1, 32767])
      const u16 = new Uint16Array([0, 1, 32767, 32768, 65535])
      const doc = {
        tensors: {
          a: { dtype: DTYPE.INT16, shape: [5], data: i16 },
          b: { dtype: DTYPE.UINT16, shape: [5], data: u16 },
        }
      }
      const decoded = decodeDocument(encodeDocument(doc))
      for (let i = 0; i < 5; i++) {
        assert.equal(decoded.tensors.a.data[i], i16[i])
        assert.equal(decoded.tensors.b.data[i], u16[i])
      }
    })

    it("round-trips int32/uint32", () => {
      const i32 = new Int32Array([-2147483648, -1, 0, 1, 2147483647])
      const u32 = new Uint32Array([0, 1, 2147483647, 2147483648, 4294967295])
      const doc = {
        tensors: {
          a: { dtype: DTYPE.INT32, shape: [5], data: i32 },
          b: { dtype: DTYPE.UINT32, shape: [5], data: u32 },
        }
      }
      const decoded = decodeDocument(encodeDocument(doc))
      for (let i = 0; i < 5; i++) {
        assert.equal(decoded.tensors.a.data[i], i32[i])
        assert.equal(decoded.tensors.b.data[i], u32[i])
      }
    })

    it("round-trips int64/uint64 (BigInt)", () => {
      const i64 = new BigInt64Array([-9223372036854775808n, -1n, 0n, 1n, 9223372036854775807n])
      const u64 = new BigUint64Array([0n, 1n, 18446744073709551615n])
      const doc = {
        tensors: {
          a: { dtype: DTYPE.INT64, shape: [5], data: i64 },
          b: { dtype: DTYPE.UINT64, shape: [3], data: u64 },
        }
      }
      const decoded = decodeDocument(encodeDocument(doc))
      for (let i = 0; i < 5; i++) {
        assert.equal(decoded.tensors.a.data[i], i64[i])
      }
      for (let i = 0; i < 3; i++) {
        assert.equal(decoded.tensors.b.data[i], u64[i])
      }
    })

    it("round-trips bool with sub-byte alignment", () => {
      // 11 booleans: requires 2 bytes with 5 bits unused at the end.
      const data = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0]
      const doc = { tensors: { mask: { dtype: DTYPE.BOOL, shape: [11], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.mask.dtype, DTYPE.BOOL)
      for (let i = 0; i < 11; i++) {
        assert.equal(decoded.tensors.mask.data[i], data[i],
          `bool index ${i} mismatch`)
      }
    })

    it("round-trips mixed-dtype document", () => {
      const doc = {
        tensors: {
          weights: { dtype: DTYPE.FP32, shape: [4], data: new Float32Array([1, 2, 3, 4]) },
          int_buf: { dtype: DTYPE.INT32, shape: [3], data: new Int32Array([10, 20, 30]) },
          flags: { dtype: DTYPE.BOOL, shape: [5], data: [1, 0, 1, 0, 1] },
        }
      }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.weights.dtype, DTYPE.FP32)
      assert.equal(decoded.tensors.int_buf.dtype, DTYPE.INT32)
      assert.equal(decoded.tensors.flags.dtype, DTYPE.BOOL)
      assert.equal(decoded.tensors.weights.data[2], 3)
      assert.equal(decoded.tensors.int_buf.data[2], 30)
      assert.equal(decoded.tensors.flags.data[2], 1)
    })
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
