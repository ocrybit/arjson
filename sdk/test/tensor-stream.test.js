// weavepack-tensor — A.5 streaming mode tests.
//
// Exercises iterateTensorsSchemaful: the generator yields one tensor at a
// time in canonical (sorted) order via a single sequential cursor advance —
// no per-tensor seek or offset arithmetic.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocument,
  encodeDocumentSchemaful,
  decodeDocumentSchemaful,
  decodeTensorSchemaful,
  iterateTensorsSchemaful,
  DTYPE,
  schemaHashHex,
} from "../src/profiles/tensor/index.js"

function fp32(values) { return new Float32Array(values) }
function int8(values)  { return new Int8Array(values) }

function makeRegistry(schema) {
  const hex = schemaHashHex(schema)
  return new Map([[hex, schema]])
}

function arrClose(a, b, tol = 1e-6) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tol) return false
  }
  return true
}

describe("tensor streaming iterator (A.5)", () => {
  const schema3 = {
    "alpha": { dtype: DTYPE.FP32, shape: [4] },
    "beta":  { dtype: DTYPE.FP32, shape: [2, 3] },
    "gamma": { dtype: DTYPE.FP32, shape: [1] },
  }
  const doc3 = {
    tensors: {
      alpha: { dtype: DTYPE.FP32, shape: [4],    data: fp32([1, 2, 3, 4]) },
      beta:  { dtype: DTYPE.FP32, shape: [2, 3], data: fp32([10, 20, 30, 40, 50, 60]) },
      gamma: { dtype: DTYPE.FP32, shape: [1],    data: fp32([999]) },
    }
  }
  const registry3 = makeRegistry(schema3)
  const bytes3 = encodeDocumentSchemaful(doc3, schema3)

  it("yields tensors in canonical (sorted) name order", () => {
    const names = []
    for (const { name } of iterateTensorsSchemaful(bytes3, registry3)) {
      names.push(name)
    }
    assert.deepEqual(names, ["alpha", "beta", "gamma"])
  })

  it("all yielded values match decodeDocumentSchemaful", () => {
    const full = decodeDocumentSchemaful(bytes3, registry3)
    for (const { name, dtype, shape, data } of iterateTensorsSchemaful(bytes3, registry3)) {
      assert.equal(dtype, full.tensors[name].dtype, `dtype mismatch on ${name}`)
      assert.deepEqual(shape, full.tensors[name].shape, `shape mismatch on ${name}`)
      assert.ok(arrClose(data, full.tensors[name].data), `data mismatch on ${name}`)
    }
  })

  it("single-tensor document: yields exactly one entry", () => {
    const schema1 = { "w": { dtype: DTYPE.FP32, shape: [3] } }
    const doc1 = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([7, 8, 9]) } } }
    const reg1 = makeRegistry(schema1)
    const bytes1 = encodeDocumentSchemaful(doc1, schema1)
    const entries = [...iterateTensorsSchemaful(bytes1, reg1)]
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, "w")
    assert.ok(arrClose(entries[0].data, fp32([7, 8, 9])))
  })

  it("mixed dtypes (fp32 + int8): each tensor decoded correctly", () => {
    const schemaMix = {
      "acts":    { dtype: DTYPE.INT8, shape: [4] },
      "weights": { dtype: DTYPE.FP32, shape: [2] },
    }
    const docMix = {
      tensors: {
        acts:    { dtype: DTYPE.INT8, shape: [4], data: int8([-1, 0, 1, 127]) },
        weights: { dtype: DTYPE.FP32, shape: [2], data: fp32([3.14, -2.71]) },
      }
    }
    const regMix = makeRegistry(schemaMix)
    const bytesMix = encodeDocumentSchemaful(docMix, schemaMix)
    const full = decodeDocumentSchemaful(bytesMix, regMix)

    for (const { name, data } of iterateTensorsSchemaful(bytesMix, regMix)) {
      assert.deepEqual(Array.from(data), Array.from(full.tensors[name].data),
        `mismatch on ${name}`)
    }
  })

  it("qint8 with scale/zero_point: iterator dequantizes identically to full decode", () => {
    const schemaQ = {
      "dense": { dtype: DTYPE.QINT8, shape: [4], scale: 0.5, zero_point: 10 },
      "bias":  { dtype: DTYPE.FP32,  shape: [4] },
    }
    const docQ = {
      tensors: {
        dense: { dtype: DTYPE.QINT8, shape: [4], data: int8([10, 11, 12, 13]), scale: 0.5, zero_point: 10 },
        bias:  { dtype: DTYPE.FP32,  shape: [4], data: fp32([0.1, 0.2, 0.3, 0.4]) },
      }
    }
    const regQ = makeRegistry(schemaQ)
    const bytesQ = encodeDocumentSchemaful(docQ, schemaQ)
    const full = decodeDocumentSchemaful(bytesQ, regQ)

    for (const { name, data } of iterateTensorsSchemaful(bytesQ, regQ)) {
      assert.ok(arrClose(data, full.tensors[name].data, 1e-5), `dequant mismatch on ${name}`)
    }
  })

  it("five-tensor document: iterator visits all five in order", () => {
    const schema5 = {
      "a": { dtype: DTYPE.FP32, shape: [2] },
      "b": { dtype: DTYPE.FP32, shape: [2] },
      "c": { dtype: DTYPE.FP32, shape: [2] },
      "d": { dtype: DTYPE.FP32, shape: [2] },
      "e": { dtype: DTYPE.FP32, shape: [2] },
    }
    const doc5 = { tensors: {} }
    for (const [k, v] of Object.entries(schema5)) {
      doc5.tensors[k] = { dtype: DTYPE.FP32, shape: v.shape, data: fp32([k.charCodeAt(0), 0]) }
    }
    const reg5 = makeRegistry(schema5)
    const bytes5 = encodeDocumentSchemaful(doc5, schema5)
    const names = [...iterateTensorsSchemaful(bytes5, reg5)].map(e => e.name)
    assert.deepEqual(names, ["a", "b", "c", "d", "e"])
  })

  it("iterator result is lazy: stopping early does not throw", () => {
    // Consume only the first tensor; the rest are never decoded.
    const iter = iterateTensorsSchemaful(bytes3, registry3)
    const first = iter.next()
    assert.ok(!first.done)
    assert.equal(first.value.name, "alpha")
    // No further .next() calls; generator is abandoned without error.
  })

  it("streaming data matches decodeTensorSchemaful (A.4) cross-check", () => {
    // The sequential cursor and the seeking cursor must produce identical bytes.
    for (const { name, data } of iterateTensorsSchemaful(bytes3, registry3)) {
      const single = decodeTensorSchemaful(bytes3, name, registry3)
      assert.ok(arrClose(data, single.data), `streaming vs skip-load mismatch on ${name}`)
    }
  })

  it("schemaless payload: throws with helpful message", () => {
    // encodeDocument returns a schemaless payload; iterator must reject it.
    const schemalessBytes = encodeDocument({
      tensors: { x: { dtype: DTYPE.FP32, shape: [1], data: fp32([1]) } }
    })
    assert.throws(
      () => { for (const _ of iterateTensorsSchemaful(schemalessBytes, registry3)) {} },
      /schemaless/
    )
  })
})
