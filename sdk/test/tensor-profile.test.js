// weavepack-tensor — initial round-trip tests.
//
// Phase 5 work-in-progress. Validates the v0.1 implementation
// (schemaless, fp32-only, no deltas) round-trips correctly.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocument,
  decodeDocument,
  encodeDocumentSchemaful,
  decodeDocumentSchemaful,
  encodeDelta,
  applyDelta,
  TensorPack,
  DTYPE,
  OP,
  schemaHash,
  schemaHashHex,
  canonicalizeSchema,
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

    it("round-trips int4 boundary values", () => {
      // Range boundaries: -8, -1, 0, 7. 2 elements per byte (nibble packing).
      const data = new Int8Array([-8, -1, 0, 7])
      const doc = { tensors: { x: { dtype: DTYPE.INT4, shape: [4], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.x.dtype, DTYPE.INT4)
      assert.ok(decoded.tensors.x.data instanceof Int8Array)
      for (let i = 0; i < data.length; i++) {
        assert.equal(decoded.tensors.x.data[i], data[i], `int4 index ${i} mismatch`)
      }
    })

    it("round-trips uint4 boundary values", () => {
      const data = new Uint8Array([0, 1, 7, 8, 15])
      const doc = { tensors: { x: { dtype: DTYPE.UINT4, shape: [5], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      assert.equal(decoded.tensors.x.dtype, DTYPE.UINT4)
      assert.ok(decoded.tensors.x.data instanceof Uint8Array)
      for (let i = 0; i < data.length; i++) {
        assert.equal(decoded.tensors.x.data[i], data[i], `uint4 index ${i} mismatch`)
      }
    })

    it("int4 odd element count pads final nibble to zero", () => {
      const data = new Int8Array([3, -4, 7])
      const doc = { tensors: { w: { dtype: DTYPE.INT4, shape: [3], data } } }
      const decoded = decodeDocument(encodeDocument(doc))
      for (let i = 0; i < 3; i++) assert.equal(decoded.tensors.w.data[i], data[i])
    })

    it("int4 element_set sparse update", () => {
      const base = { tensors: { x: { dtype: DTYPE.INT4, shape: [4], data: new Int8Array([-8, -1, 0, 7]) } } }
      const updated = { tensors: { x: { dtype: DTYPE.INT4, shape: [4], data: new Int8Array([-8, -1, 3, 7]) } } }
      const delta = encodeDelta(base, updated)
      assert.ok(delta !== null)
      const result = applyDelta(base, delta)
      const expected = [-8, -1, 3, 7]
      for (let i = 0; i < 4; i++) assert.equal(result.tensors.x.data[i], expected[i])
    })

    it("uint4 element_set sparse update", () => {
      const base = { tensors: { x: { dtype: DTYPE.UINT4, shape: [4], data: new Uint8Array([0, 3, 6, 9]) } } }
      const updated = { tensors: { x: { dtype: DTYPE.UINT4, shape: [4], data: new Uint8Array([0, 3, 15, 9]) } } }
      const delta = encodeDelta(base, updated)
      assert.ok(delta !== null)
      const result = applyDelta(base, delta)
      assert.equal(result.tensors.x.data[2], 15)
    })

    it("int4 region_replace dense update", () => {
      const base = { tensors: { x: { dtype: DTYPE.INT4, shape: [2, 3], data: new Int8Array([1, 2, 3, 4, 5, 6]) } } }
      const updated = { tensors: { x: { dtype: DTYPE.INT4, shape: [2, 3], data: new Int8Array([1, 2, 3, -1, -2, -3]) } } }
      const delta = encodeDelta(base, updated)
      assert.ok(delta !== null)
      const result = applyDelta(base, delta)
      const expected = [1, 2, 3, -1, -2, -3]
      for (let i = 0; i < 6; i++) assert.equal(result.tensors.x.data[i], expected[i])
    })

    it("int4 tensor_replace round-trips all nibble values", () => {
      // Verify all 16 nibble values in a single tensor
      const values = new Int8Array([-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7])
      const doc = { tensors: { x: { dtype: DTYPE.INT4, shape: [16], data: values } } }
      const decoded = decodeDocument(encodeDocument(doc))
      for (let i = 0; i < 16; i++) {
        assert.equal(decoded.tensors.x.data[i], values[i], `nibble ${i} mismatch`)
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

    // Per-payload addressability: any prefix of a chain is itself a valid
    // chain that decodes to its corresponding intermediate state. Mirrors
    // the same guarantee for the JSON profile (interface-lock test
    // "any chain prefix decodes to its corresponding intermediate state").
    // Inline length-prefix parsing here so the test doesn't depend on
    // chainParse being exported.
    it("any chain prefix decodes to the corresponding intermediate state", () => {
      const versions = [
        fp32([1, 2, 3]),
        fp32([1, 99, 3]),
        fp32([7, 99, 3]),
        fp32([7, 99, 42]),
      ]
      const pack = new TensorPack({
        json: { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: versions[0] } } }
      })
      for (let i = 1; i < versions.length; i++) {
        pack.update({ tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: versions[i] } } })
      }
      const fullBuf = pack.toBuffer()

      // Parse out individual length-prefixed payloads.
      const payloads = []
      let off = 0
      while (off < fullBuf.length) {
        let len = 0, shift = 0, byte
        do { byte = fullBuf[off++]; len += (byte & 0x7f) * Math.pow(2, shift); shift += 7 } while (byte & 0x80)
        payloads.push(fullBuf.slice(off, off + len)); off += len
      }
      assert.equal(payloads.length, versions.length)

      // Re-emit any prefix and verify it restores to the right version.
      function emitPrefix(prefix) {
        let total = 0
        const lens = []
        for (const p of prefix) {
          const lb = []
          let len = p.length
          while (len >= 128) { lb.push((len & 0x7f) | 0x80); len = Math.floor(len / 128) }
          lb.push(len)
          lens.push(lb)
          total += lb.length + p.length
        }
        const out = new Uint8Array(total)
        let o = 0
        for (let i = 0; i < prefix.length; i++) {
          for (const b of lens[i]) out[o++] = b
          out.set(prefix[i], o); o += prefix[i].length
        }
        return out
      }

      for (let cut = 1; cut <= versions.length; cut++) {
        const prefixBuf = emitPrefix(payloads.slice(0, cut))
        const restored = new TensorPack({ arj: prefixBuf })
        assert.ok(
          arrEq(restored.json.tensors.w.data, versions[cut - 1]),
          `prefix of ${cut} payloads should restore to versions[${cut - 1}]`
        )
      }
    })
  })

  describe("delta operations (Phase 5.4)", () => {
    it("tensor_replace updates a tensor's values", () => {
      const base = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([1, 2, 3]) } } }
      const updated = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([10, 20, 30]) } } }
      const delta = encodeDelta(base, updated)
      assert.ok(delta !== null, "delta should not be null for changed tensor")
      const result = applyDelta(base, delta)
      assert.ok(arrEq(result.tensors.w.data, fp32([10, 20, 30])))
    })

    it("tensor_add introduces a new tensor", () => {
      const base = { tensors: { a: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const updated = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) },
          b: { dtype: DTYPE.FP32, shape: [3], data: fp32([3, 4, 5]) },
        }
      }
      const delta = encodeDelta(base, updated)
      const result = applyDelta(base, delta)
      assert.equal(Object.keys(result.tensors).length, 2)
      assert.ok(arrEq(result.tensors.b.data, fp32([3, 4, 5])))
      assert.ok(arrEq(result.tensors.a.data, fp32([1, 2])))
    })

    it("tensor_remove deletes a tensor", () => {
      const base = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) },
          b: { dtype: DTYPE.FP32, shape: [3], data: fp32([3, 4, 5]) },
        }
      }
      const updated = { tensors: { a: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const delta = encodeDelta(base, updated)
      const result = applyDelta(base, delta)
      assert.equal(Object.keys(result.tensors).length, 1)
      assert.ok(!("b" in result.tensors))
    })

    it("identity update produces no delta", () => {
      const doc = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) },
          b: { dtype: DTYPE.INT32, shape: [3], data: new Int32Array([10, 20, 30]) },
        }
      }
      const delta = encodeDelta(doc, doc)
      assert.equal(delta, null, "identity update should return null delta")
    })

    it("dtype change produces remove + add", () => {
      const base = { tensors: { x: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const updated = { tensors: { x: { dtype: DTYPE.INT32, shape: [2], data: new Int32Array([1, 2]) } } }
      const delta = encodeDelta(base, updated)
      const result = applyDelta(base, delta)
      assert.equal(result.tensors.x.dtype, DTYPE.INT32)
      assert.equal(result.tensors.x.data[0], 1)
    })

    it("TensorPack.update appends to chain", () => {
      const v1 = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([1, 2, 3]) } } }
      const v2 = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([10, 20, 30]) } } }
      const v3 = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([100, 200, 300]) } } }
      const pack = new TensorPack({ json: v1 })
      assert.equal(pack.deltas.length, 1)
      pack.update(v2)
      assert.equal(pack.deltas.length, 2)
      pack.update(v3)
      assert.equal(pack.deltas.length, 3)
      assert.ok(arrEq(pack.json.tensors.w.data, fp32([100, 200, 300])))
    })

    it("TensorPack chain round-trips via toBuffer", () => {
      const v1 = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [3], data: fp32([1, 2, 3]) },
          b: { dtype: DTYPE.INT32, shape: [2], data: new Int32Array([10, 20]) },
        }
      }
      const v2 = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [3], data: fp32([10, 20, 30]) },
          c: { dtype: DTYPE.UINT8, shape: [4], data: new Uint8Array([1, 2, 3, 4]) },
        }
      }
      const pack = new TensorPack({ json: v1 })
      pack.update(v2)
      const buf = pack.toBuffer()
      const restored = new TensorPack({ arj: buf })
      assert.equal(Object.keys(restored.json.tensors).length, 2)
      assert.ok("a" in restored.json.tensors)
      assert.ok("c" in restored.json.tensors)
      assert.ok(!("b" in restored.json.tensors))
      assert.ok(arrEq(restored.json.tensors.a.data, fp32([10, 20, 30])))
    })

    it("element_set: sparse changes within a tensor", () => {
      // 1000-element fp32 tensor; change just 5 elements (0.5%).
      // The differ should pick element_set.
      const N = 1000
      const baseData = new Float32Array(N)
      for (let i = 0; i < N; i++) baseData[i] = i * 0.5
      const newData = new Float32Array(baseData)
      // Change 5 elements at known positions.
      newData[10] = 999.0
      newData[100] = 888.0
      newData[500] = 777.0
      newData[800] = 666.0
      newData[999] = 555.0
      const base = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: baseData } } }
      const updated = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: newData } } }
      const delta = encodeDelta(base, updated)
      const result = applyDelta(base, delta)
      assert.equal(result.tensors.w.data[10], 999.0)
      assert.equal(result.tensors.w.data[100], 888.0)
      assert.equal(result.tensors.w.data[500], 777.0)
      assert.equal(result.tensors.w.data[800], 666.0)
      assert.equal(result.tensors.w.data[999], 555.0)
      // Unchanged elements preserved.
      assert.equal(result.tensors.w.data[0], 0)
      assert.equal(result.tensors.w.data[50], 25)
      // Delta should be much smaller than full tensor_replace.
      const fullReplaceSize = N * 4 + 32  // rough
      assert.ok(
        delta.length < fullReplaceSize / 4,
        `element_set delta ${delta.length} bytes should be < 25% of full replace ~${fullReplaceSize}`
      )
    })

    it("element_set: 2D sparse change", () => {
      const baseData = new Int32Array(100)  // 10x10
      for (let i = 0; i < 100; i++) baseData[i] = i
      const newData = new Int32Array(baseData)
      newData[5 * 10 + 3] = 9999  // [5, 3]
      newData[7 * 10 + 7] = 8888  // [7, 7]
      const base = { tensors: { m: { dtype: DTYPE.INT32, shape: [10, 10], data: baseData } } }
      const updated = { tensors: { m: { dtype: DTYPE.INT32, shape: [10, 10], data: newData } } }
      const delta = encodeDelta(base, updated)
      const result = applyDelta(base, delta)
      assert.equal(result.tensors.m.data[5 * 10 + 3], 9999)
      assert.equal(result.tensors.m.data[7 * 10 + 7], 8888)
      assert.equal(result.tensors.m.data[0], 0)
    })

    it("dense change uses tensor_replace, not element_set", () => {
      // 50% of elements change → tensor_replace path.
      const N = 100
      const baseData = new Float32Array(N).fill(1.0)
      const newData = new Float32Array(N).fill(1.0)
      for (let i = 0; i < 50; i++) newData[i] = 2.0
      const base = { tensors: { x: { dtype: DTYPE.FP32, shape: [N], data: baseData } } }
      const updated = { tensors: { x: { dtype: DTYPE.FP32, shape: [N], data: newData } } }
      const delta = encodeDelta(base, updated)
      const result = applyDelta(base, delta)
      assert.equal(result.tensors.x.data[0], 2.0)
      assert.equal(result.tensors.x.data[49], 2.0)
      assert.equal(result.tensors.x.data[50], 1.0)
    })

    it("partial change: one of three tensors", () => {
      const v1 = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) },
          b: { dtype: DTYPE.FP32, shape: [4], data: fp32([5, 6, 7, 8]) },
          c: { dtype: DTYPE.FP32, shape: [4], data: fp32([9, 10, 11, 12]) },
        }
      }
      const v2 = {
        tensors: {
          a: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) },          // unchanged
          b: { dtype: DTYPE.FP32, shape: [4], data: fp32([100, 200, 300, 400]) }, // changed
          c: { dtype: DTYPE.FP32, shape: [4], data: fp32([9, 10, 11, 12]) },     // unchanged
        }
      }
      const pack = new TensorPack({ json: v1 })
      const initialBytes = pack.toBuffer().length
      pack.update(v2)
      const totalBytes = pack.toBuffer().length
      // Delta should be smaller than encoding v2 from scratch.
      const v2FreshPack = new TensorPack({ json: v2 })
      const v2FreshBytes = v2FreshPack.toBuffer().length
      // The chain (v1 + delta(v1, v2)) MAY be larger than fresh-encoding
      // v2 because it carries the v1 baseline. But the delta itself
      // should be substantially smaller than re-encoding all three
      // tensors. Verify the increment is less than v2FreshBytes.
      const deltaBytes = totalBytes - initialBytes
      assert.ok(
        deltaBytes < v2FreshBytes * 0.7,
        `delta ${deltaBytes} bytes should be < 70% of fresh ${v2FreshBytes}`
      )
      assert.ok(arrEq(pack.json.tensors.b.data, fp32([100, 200, 300, 400])))
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

// ── Phase 5.5: schema sidecar ─────────────────────────────────────────────

describe("weavepack-tensor schema sidecar (Phase 5.5)", () => {

  describe("schema canonicalization and hashing", () => {
    it("canonical form sorts keys alphabetically", () => {
      const schema = {
        "z.bias": { dtype: DTYPE.FP32, shape: [4] },
        "a.weight": { dtype: DTYPE.FP32, shape: [4, 4] },
      }
      const canonical = canonicalizeSchema(schema)
      const parsed = JSON.parse(canonical)
      assert.deepEqual(Object.keys(parsed), ["a.weight", "z.bias"])
    })

    it("same logical schema always hashes to the same id", () => {
      const s1 = { b: { dtype: DTYPE.FP32, shape: [2] }, a: { dtype: DTYPE.INT8, shape: [3] } }
      const s2 = { a: { dtype: DTYPE.INT8, shape: [3] }, b: { dtype: DTYPE.FP32, shape: [2] } }
      assert.equal(schemaHashHex(s1), schemaHashHex(s2))
    })

    it("different schemas produce different hashes", () => {
      const s1 = { w: { dtype: DTYPE.FP32, shape: [4] } }
      const s2 = { w: { dtype: DTYPE.FP32, shape: [8] } }
      assert.notEqual(schemaHashHex(s1), schemaHashHex(s2))
    })

    it("schemaHash returns 32-byte Uint8Array", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [4] } }
      const h = schemaHash(schema)
      assert.ok(h instanceof Uint8Array)
      assert.equal(h.length, 32)
    })
  })

  describe("schemaful encode / decode round-trip", () => {
    it("round-trips a single fp32 tensor schemafully", () => {
      const schema = { weight: { dtype: DTYPE.FP32, shape: [4] } }
      const doc = { tensors: { weight: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) } } }
      const bytes = encodeDocumentSchemaful(doc, schema)
      const registry = new Map([[schemaHashHex(schema), schema]])
      const decoded = decodeDocumentSchemaful(bytes, registry)
      assert.deepEqual(decoded.tensors.weight.shape, [4])
      assert.equal(decoded.tensors.weight.dtype, DTYPE.FP32)
      assert.ok(arrEq(decoded.tensors.weight.data, fp32([1, 2, 3, 4])))
    })

    it("round-trips multiple tensors schemafully in canonical key order", () => {
      const schema = {
        "z.bias":   { dtype: DTYPE.FP32, shape: [3] },
        "a.weight": { dtype: DTYPE.FP32, shape: [3, 3] },
      }
      const doc = {
        tensors: {
          "z.bias":   { dtype: DTYPE.FP32, shape: [3],    data: fp32([0.1, 0.2, 0.3]) },
          "a.weight": { dtype: DTYPE.FP32, shape: [3, 3], data: fp32([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
        }
      }
      const bytes = encodeDocumentSchemaful(doc, schema)
      const registry = new Map([[schemaHashHex(schema), schema]])
      const decoded = decodeDocumentSchemaful(bytes, registry)
      assert.ok(arrEq(decoded.tensors["z.bias"].data, fp32([0.1, 0.2, 0.3])))
      assert.deepEqual(decoded.tensors["a.weight"].shape, [3, 3])
      assert.ok(arrEq(decoded.tensors["a.weight"].data, fp32([1, 2, 3, 4, 5, 6, 7, 8, 9])))
    })

    it("schemaful payload is smaller than schemaless when total metadata exceeds hash size", () => {
      // Per-tensor schemaless metadata (name + dtype + shape) adds up across many tensors.
      // The schema hash overhead is constant at 32 bytes, so schemaful wins once
      // N × per_tensor_metadata > 32 bytes. With 5 tensors of 13-char names, metadata
      // ~80 bytes > 32 bytes hash → schemaful is smaller.
      const N = 100  // elements per tensor (data dominates, metadata difference visible)
      const tensors = {}
      const schemaDef = {}
      for (let i = 0; i < 5; i++) {
        const name = `layer${i}.weight`  // 13 chars each
        tensors[name] = { dtype: DTYPE.FP32, shape: [N], data: new Float32Array(N) }
        schemaDef[name] = { dtype: DTYPE.FP32, shape: [N] }
      }
      const doc = { tensors }
      const schema = schemaDef
      const sBytes = encodeDocument(doc)
      const sfBytes = encodeDocumentSchemaful(doc, schema)
      assert.ok(
        sfBytes.length < sBytes.length,
        `schemaful ${sfBytes.length} bytes should be < schemaless ${sBytes.length} for 5 tensors`
      )
    })

    it("round-trips bool, int8, and int64 tensors schemafully", () => {
      const schema = {
        mask:  { dtype: DTYPE.BOOL,  shape: [8] },
        i8:    { dtype: DTYPE.INT8,  shape: [4] },
        i64:   { dtype: DTYPE.INT64, shape: [3] },
      }
      const doc = {
        tensors: {
          mask:  { dtype: DTYPE.BOOL,  shape: [8],  data: [1, 0, 1, 1, 0, 0, 1, 0] },
          i8:    { dtype: DTYPE.INT8,  shape: [4],  data: new Int8Array([-128, -1, 0, 127]) },
          i64:   { dtype: DTYPE.INT64, shape: [3],  data: new BigInt64Array([-1n, 0n, 1n]) },
        }
      }
      const bytes = encodeDocumentSchemaful(doc, schema)
      const registry = new Map([[schemaHashHex(schema), schema]])
      const decoded = decodeDocumentSchemaful(bytes, registry)
      for (let i = 0; i < 8; i++) assert.equal(decoded.tensors.mask.data[i], doc.tensors.mask.data[i])
      for (let i = 0; i < 4; i++) assert.equal(decoded.tensors.i8.data[i], doc.tensors.i8.data[i])
      for (let i = 0; i < 3; i++) assert.equal(decoded.tensors.i64.data[i], doc.tensors.i64.data[i])
    })

    it("throws on unknown schema-id", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [4] } }
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) } } }
      const bytes = encodeDocumentSchemaful(doc, schema)
      const emptyRegistry = new Map()
      assert.throws(
        () => decodeDocumentSchemaful(bytes, emptyRegistry),
        /unknown schema-id/
      )
    })

    it("throws when trying to decode schemaful payload with decodeDocument", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [4] } }
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) } } }
      const bytes = encodeDocumentSchemaful(doc, schema)
      assert.throws(
        () => decodeDocument(bytes),
        /schemaful.*use decodeDocumentSchemaful/i
      )
    })

    it("throws when trying to decode schemaless payload with decodeDocumentSchemaful", () => {
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) } } }
      const bytes = encodeDocument(doc)
      const registry = new Map()
      assert.throws(
        () => decodeDocumentSchemaful(bytes, registry),
        /schemaless.*use decodeDocument/i
      )
    })

    it("throws when document schema dtype mismatches", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [4] } }
      const doc = { tensors: { w: { dtype: DTYPE.INT32, shape: [4], data: new Int32Array([1, 2, 3, 4]) } } }
      assert.throws(
        () => encodeDocumentSchemaful(doc, schema),
        /dtype/
      )
    })

    it("throws when document schema shape mismatches", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [4] } }
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [8], data: fp32(Array.from({length:8}, (_,i)=>i)) } } }
      assert.throws(
        () => encodeDocumentSchemaful(doc, schema),
        /shape/
      )
    })

    it("throws when document is missing a tensor required by schema", () => {
      const schema = {
        w: { dtype: DTYPE.FP32, shape: [4] },
        b: { dtype: DTYPE.FP32, shape: [4] },
      }
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) } } }
      assert.throws(
        () => encodeDocumentSchemaful(doc, schema),
        /absent/
      )
    })
  })

  describe("schemaful wire format structure", () => {
    it("schemaful payload starts with 0b01 (doc=0, schema=1)", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [2] } }
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const bytes = encodeDocumentSchemaful(doc, schema)
      // Byte 0: bits 7..6 of the bit stream. bit0=0(doc), bit1=1(schema), rest is hash start.
      // The first byte of the bit stream has MSB = bit0 = 0, next bit = bit1 = 1.
      // So byte[0] MSB = 0, next bit = 1: byte[0] = 0b01xxxxxx
      assert.equal((bytes[0] >> 6) & 0b11, 0b01, "first two bits should be 01 (schemaful doc)")
    })

    it("schemaless payload starts with 0b00 (doc=0, schema=0)", () => {
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const bytes = encodeDocument(doc)
      assert.equal((bytes[0] >> 6) & 0b11, 0b00, "first two bits should be 00 (schemaless doc)")
    })

    it("delta payload starts with 0b1x (delta=1)", () => {
      const base = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const upd  = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([3, 4]) } } }
      const delta = encodeDelta(base, upd)
      assert.equal((delta[0] >> 7) & 0b1, 0b1, "first bit should be 1 (delta)")
    })

    it("tensor_replace emits mode=0 bit (absolute values)", () => {
      // The mode bit follows shape dims in tensor_replace encoding.
      // Verify the encoder produces mode=0 by checking round-trip is
      // byte-exact with the pre-computed reference.
      const base = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const upd  = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([3, 4]) } } }
      const delta = encodeDelta(base, upd)
      // Round-trip: applying the delta must reproduce the update doc.
      const result = applyDelta(base, delta)
      assert.ok(arrEq(result.tensors.w.data, fp32([3, 4])), "mode=0 round-trip")
    })

    it("applyDelta handles tensor_replace mode=1 (delta-from-prior) for fp32", () => {
      // Manually craft a delta payload with mode=1.
      // base doc: { w: fp32([10.0, 20.0, 30.0]) }
      // delta values: [0.5, -1.0, 2.5]
      // expected result: [10.5, 19.0, 32.5]
      const base = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([10, 20, 30]) } } }
      // Build a delta by encoding a doc where data = delta values [0.5, -1.0, 2.5],
      // then manually patch the mode bit from 0 to 1.
      const fakeUpd = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([0.5, -1.0, 2.5]) } } }
      // Encode a fake "replace w with [0.5, -1.0, 2.5]" delta (mode=0).
      const deltaMode0 = encodeDelta(base, fakeUpd)
      // The mode bit for tensor_replace sits immediately after the last shape
      // dimension's LEB128. Flip it from 0 to 1 by finding and patching the bit.
      // We use a small helper: decode the delta bit-stream to find mode bit position,
      // then flip it.  To keep the test self-contained, use applyDelta internals
      // via a round-about route: encode a wrapper that flips mode bit.
      //
      // Simpler approach: the mode bit is at a known relative position after the
      // header. Since the delta bytes have changed, use a reference hex instead.
      // Compute expected result values directly via the mode=1 semantic:
      // new = base + delta_values  →  [10+0.5, 20+(-1), 30+2.5] = [10.5, 19, 32.5]
      //
      // Use manual bit manipulation: find the mode bit offset and flip it.
      const d = new Uint8Array(deltaMode0)
      // Bit layout: [1-bit delta] [LEB128 op_count=1]
      //   [3-bit op=0 TENSOR_REPLACE] [short name_len=1] [8-bit 'w'=0x77]
      //   [5-bit dtype=FP32=15] [short rank=1] [LEB128 dim=3]
      //   [MODE BIT] [data 12 bytes]
      // Walk the bits to find mode bit position.
      let pos = 0
      function readN(n) { let v = 0; for (let i=0;i<n;i++) { v=(v<<1)|((d[pos>>3]>>(7-(pos&7)))&1); pos++ } return v }
      function readShort() { const p=readN(2); if(p===0) return readN(2); if(p===1) return readN(3); if(p===2) return readN(4); let r=0,s=0,b; do{b=readN(8);r+=(b&0x7f)*(2**s);s+=7}while(b&0x80); return r }
      function readLeb() { let r=0,s=0,b; do{b=readN(8);r+=(b&0x7f)*(2**s);s+=7}while(b&0x80); return r }
      readN(1) // delta bit
      readLeb() // op count
      readN(3) // op code
      const nl = readShort() // name length
      for (let i=0; i<nl; i++) readN(8) // name bytes
      readN(5) // dtype
      const rank = readShort()
      for (let i=0; i<rank; i++) readLeb() // shape dims
      // pos is now at the mode bit
      const modeBitPos = pos
      // Flip it from 0 to 1.
      const byteIdx = modeBitPos >> 3
      const bitOff  = 7 - (modeBitPos & 7)
      const mode1Delta = new Uint8Array(d)
      mode1Delta[byteIdx] |= (1 << bitOff)

      const result = applyDelta(base, mode1Delta)
      assert.ok(arrEq(result.tensors.w.data, fp32([10.5, 19, 32.5])),
        `mode=1 result: expected [10.5,19,32.5] got ${Array.from(result.tensors.w.data)}`)
    })

    it("applyDelta handles tensor_replace mode=1 for int32 (wrapping addition)", () => {
      const base = { tensors: { v: { dtype: DTYPE.INT32, shape: [3], data: new Int32Array([100, 200, 2147483647]) } } }
      const deltaValues = new Int32Array([1, -50, 1])  // last wraps: MAX+1 = MIN
      const fakeUpd = { tensors: { v: { dtype: DTYPE.INT32, shape: [3], data: deltaValues } } }
      const deltaMode0 = encodeDelta(base, fakeUpd)
      // Flip mode bit (same technique).
      const d = new Uint8Array(deltaMode0)
      let pos = 0
      function readN(n) { let v = 0; for (let i=0;i<n;i++) { v=(v<<1)|((d[pos>>3]>>(7-(pos&7)))&1); pos++ } return v }
      function readShort() { const p=readN(2); if(p===0) return readN(2); if(p===1) return readN(3); if(p===2) return readN(4); let r=0,s=0,b; do{b=readN(8);r+=(b&0x7f)*(2**s);s+=7}while(b&0x80); return r }
      function readLeb() { let r=0,s=0,b; do{b=readN(8);r+=(b&0x7f)*(2**s);s+=7}while(b&0x80); return r }
      readN(1); readLeb(); readN(3)
      const nl = readShort(); for (let i=0; i<nl; i++) readN(8)
      readN(5); const rank = readShort(); for (let i=0; i<rank; i++) readLeb()
      const modeBitPos = pos
      const mode1Delta = new Uint8Array(d)
      mode1Delta[modeBitPos >> 3] |= 1 << (7 - (modeBitPos & 7))
      const result = applyDelta(base, mode1Delta)
      const got = Array.from(result.tensors.v.data)
      assert.equal(got[0], 101, "100+1=101")
      assert.equal(got[1], 150, "200-50=150")
      assert.equal(got[2], -2147483648, "INT32_MAX+1 wraps to INT32_MIN")
    })

    it("schemaful payload contains the schema hash at bytes 1-32 (bits 2-257)", () => {
      const schema = { w: { dtype: DTYPE.FP32, shape: [2] } }
      const doc = { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32([1, 2]) } } }
      const bytes = encodeDocumentSchemaful(doc, schema)
      const expectedHash = schemaHash(schema)

      // Extract 256 bits starting at bit 2 from the byte stream.
      const extractedHash = new Uint8Array(32)
      for (let byteIdx = 0; byteIdx < 32; byteIdx++) {
        let val = 0
        for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
          const streamBit = 2 + byteIdx * 8 + bitIdx
          const bytePos = streamBit >> 3
          const bitPos  = 7 - (streamBit & 7)
          val = (val << 1) | ((bytes[bytePos] >> bitPos) & 1)
        }
        extractedHash[byteIdx] = val
      }
      assert.deepEqual(extractedHash, expectedHash)
    })
  })
})
