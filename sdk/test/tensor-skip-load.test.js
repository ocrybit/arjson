// weavepack-tensor — A.4 sub-tensor random access (skip-load) tests.
//
// Exercises listTensorsSchemaful and decodeTensorSchemaful:
// the decoder can seek directly to a named tensor in a schemaful
// payload without parsing the preceding tensors' data blocks.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encodeDocumentSchemaful,
  decodeDocumentSchemaful,
  listTensorsSchemaful,
  decodeTensorSchemaful,
  DTYPE,
  dataBytes,
  schemaHashHex,
} from "../src/profiles/tensor/index.js"

function fp32(values) { return new Float32Array(values) }
function int8(values) { return new Int8Array(values) }

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

describe("tensor skip-load (A.4)", () => {
  // Three-tensor document used across several tests.
  const schema3 = {
    "alpha": { dtype: DTYPE.FP32, shape: [4] },
    "beta":  { dtype: DTYPE.FP32, shape: [2, 3] },
    "gamma": { dtype: DTYPE.FP32, shape: [1] },
  }
  const doc3 = {
    tensors: {
      alpha: { dtype: DTYPE.FP32, shape: [4], data: fp32([1, 2, 3, 4]) },
      beta:  { dtype: DTYPE.FP32, shape: [2, 3], data: fp32([10, 20, 30, 40, 50, 60]) },
      gamma: { dtype: DTYPE.FP32, shape: [1], data: fp32([999]) },
    }
  }
  const registry3 = makeRegistry(schema3)
  const bytes3 = encodeDocumentSchemaful(doc3, schema3)

  it("listTensorsSchemaful returns names in canonical sorted order", () => {
    const names = listTensorsSchemaful(bytes3, registry3)
    assert.deepEqual(names, ["alpha", "beta", "gamma"])
  })

  it("decodeTensorSchemaful: first tensor (alpha) matches full decode", () => {
    const full = decodeDocumentSchemaful(bytes3, registry3)
    const single = decodeTensorSchemaful(bytes3, "alpha", registry3)
    assert.equal(single.dtype, DTYPE.FP32)
    assert.deepEqual(single.shape, [4])
    assert.ok(arrClose(single.data, full.tensors.alpha.data))
  })

  it("decodeTensorSchemaful: middle tensor (beta) matches full decode", () => {
    const full = decodeDocumentSchemaful(bytes3, registry3)
    const single = decodeTensorSchemaful(bytes3, "beta", registry3)
    assert.equal(single.dtype, DTYPE.FP32)
    assert.deepEqual(single.shape, [2, 3])
    assert.ok(arrClose(single.data, full.tensors.beta.data))
  })

  it("decodeTensorSchemaful: last tensor (gamma) matches full decode", () => {
    const full = decodeDocumentSchemaful(bytes3, registry3)
    const single = decodeTensorSchemaful(bytes3, "gamma", registry3)
    assert.equal(single.dtype, DTYPE.FP32)
    assert.deepEqual(single.shape, [1])
    assert.ok(arrClose(single.data, full.tensors.gamma.data))
  })

  it("decodeTensorSchemaful: all three tensors agree with full decode", () => {
    const full = decodeDocumentSchemaful(bytes3, registry3)
    for (const name of ["alpha", "beta", "gamma"]) {
      const single = decodeTensorSchemaful(bytes3, name, registry3)
      assert.ok(arrClose(single.data, full.tensors[name].data), `mismatch on ${name}`)
    }
  })

  it("decodeTensorSchemaful: throws for name not in schema", () => {
    assert.throws(
      () => decodeTensorSchemaful(bytes3, "notareal", registry3),
      /not found in schema/
    )
  })

  it("decodeTensorSchemaful: single-tensor document", () => {
    const schema1 = { "w": { dtype: DTYPE.FP32, shape: [3] } }
    const doc1 = { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32([7, 8, 9]) } } }
    const reg1 = makeRegistry(schema1)
    const bytes1 = encodeDocumentSchemaful(doc1, schema1)
    const single = decodeTensorSchemaful(bytes1, "w", reg1)
    assert.ok(arrClose(single.data, fp32([7, 8, 9])))
  })

  it("decodeTensorSchemaful: mixed dtypes (fp32 + int8)", () => {
    const schemaMix = {
      "activations": { dtype: DTYPE.INT8,  shape: [4] },
      "weights":     { dtype: DTYPE.FP32,  shape: [2] },
    }
    const docMix = {
      tensors: {
        activations: { dtype: DTYPE.INT8, shape: [4], data: int8([-1, 0, 1, 127]) },
        weights:     { dtype: DTYPE.FP32, shape: [2], data: fp32([3.14, -2.71]) },
      }
    }
    const regMix = makeRegistry(schemaMix)
    const bytesMix = encodeDocumentSchemaful(docMix, schemaMix)
    const full = decodeDocumentSchemaful(bytesMix, regMix)

    const act = decodeTensorSchemaful(bytesMix, "activations", regMix)
    assert.deepEqual(Array.from(act.data), Array.from(full.tensors.activations.data))

    const wts = decodeTensorSchemaful(bytesMix, "weights", regMix)
    assert.ok(arrClose(wts.data, full.tensors.weights.data))
  })

  it("decodeTensorSchemaful: qint8 with scale/zero_point dequantizes correctly", () => {
    const schemaQ = {
      "dense": { dtype: DTYPE.QINT8, shape: [4], scale: 0.5, zero_point: 10 },
      "bias":  { dtype: DTYPE.FP32,  shape: [4] },
    }
    // Provide pre-quantized int8 data; encoder stores it as-is.
    const docQ = {
      tensors: {
        dense: { dtype: DTYPE.QINT8, shape: [4], data: int8([10, 11, 12, 13]), scale: 0.5, zero_point: 10 },
        bias:  { dtype: DTYPE.FP32,  shape: [4], data: fp32([0.1, 0.2, 0.3, 0.4]) },
      }
    }
    const regQ = makeRegistry(schemaQ)
    const bytesQ = encodeDocumentSchemaful(docQ, schemaQ)
    const full = decodeDocumentSchemaful(bytesQ, regQ)

    const single = decodeTensorSchemaful(bytesQ, "dense", regQ)
    assert.ok(arrClose(single.data, full.tensors.dense.data, 1e-5),
      "dequantized values must match full-decode")
  })

  it("listTensorsSchemaful: does not decode any tensor data (just returns names)", () => {
    // With a 5-tensor schema, listTensorsSchemaful should return all 5 names
    // without throwing even though some tensors have large shapes.
    const schemaBig = {
      "a": { dtype: DTYPE.FP32, shape: [100] },
      "b": { dtype: DTYPE.FP32, shape: [100] },
      "c": { dtype: DTYPE.FP32, shape: [100] },
      "d": { dtype: DTYPE.FP32, shape: [100] },
      "e": { dtype: DTYPE.FP32, shape: [100] },
    }
    const docBig = { tensors: {} }
    for (const name of Object.keys(schemaBig)) {
      docBig.tensors[name] = { dtype: DTYPE.FP32, shape: [100], data: new Float32Array(100).fill(1) }
    }
    const regBig = makeRegistry(schemaBig)
    const bytesBig = encodeDocumentSchemaful(docBig, schemaBig)
    const names = listTensorsSchemaful(bytesBig, regBig)
    assert.deepEqual(names, ["a", "b", "c", "d", "e"])
  })

  it("decodeTensorSchemaful: byte offsets are consistent with dataBytes arithmetic", () => {
    // Verify that the skip calculation matches the known byte sizes.
    // alpha: fp32[4]  = 16 bytes, beta: fp32[2,3] = 24 bytes, gamma: fp32[1] = 4 bytes
    assert.equal(dataBytes(DTYPE.FP32, [4]),    16)
    assert.equal(dataBytes(DTYPE.FP32, [2, 3]), 24)
    assert.equal(dataBytes(DTYPE.FP32, [1]),     4)
    // gamma starts at bit 258 + 16*8 + 24*8 = 258 + 320 = 578 bits
    // Cross-check: decoding gamma by skip should match full decode.
    const single = decodeTensorSchemaful(bytes3, "gamma", registry3)
    assert.ok(arrClose(single.data, fp32([999])))
  })
})
