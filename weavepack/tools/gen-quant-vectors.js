// Generator for qint4 and qfp8 schemaful conformance test vectors.
// Run from repo root:  node weavepack/tools/gen-quant-vectors.js
//
// Writes weavepack/profiles/tensor/test-vectors/schemas/qint.json
// (extending it with qint4 and qfp8 entries beyond the existing qint8 ones).

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  encodeDocumentSchemaful,
  decodeDocumentSchemaful,
  DTYPE,
  schemaHashHex,
  fp8e4m3ToF32,
} from "../../sdk/src/profiles/tensor/index.js"

const __filename = fileURLToPath(import.meta.url)
const OUT = join(dirname(__filename), "..", "profiles", "tensor", "test-vectors", "schemas", "qint.json")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")

function makeRegistry(schema) {
  const hex = schemaHashHex(schema)
  return new Map([[hex, schema]])
}

function encodeAndDecode(schema, inputTensors) {
  const registry = makeRegistry(schema)
  const bytes = encodeDocumentSchemaful({ tensors: inputTensors }, schema)
  const decoded = decodeDocumentSchemaful(bytes, registry)
  return { bytes, decoded }
}

// Helper: convert typed array to plain JS array for JSON serialization.
function toArr(data) {
  if (data instanceof BigInt64Array || data instanceof BigUint64Array)
    return Array.from(data, v => Number(v))
  return Array.from(data)
}

const vectors = []

// ── existing qint8 vectors (regenerated for consistency) ──────────────────

// qint8 simple 1D
;(function () {
  const schema = { w: { dtype: DTYPE.QINT8, shape: [3], scale: 0.0078125, zero_point: 0 } }
  const input = { w: { dtype: DTYPE.QINT8, shape: [3], data: new Float32Array([-0.5, 0.0, 0.5]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint8 simple 1D",
    description: "1D qint8 tensor; scale=2^-7=0.0078125, zero_point=0. Values [-0.5, 0.0, 0.5] map exactly to q=[-64, 0, 64]; dequant is lossless.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { w: { dtype: DTYPE.QINT8, shape: [3], data: [-0.5, 0.0, 0.5] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint8 2D matrix
;(function () {
  const schema = { mat: { dtype: DTYPE.QINT8, shape: [2, 2], scale: 0.0078125, zero_point: 0 } }
  const input = { mat: { dtype: DTYPE.QINT8, shape: [2, 2], data: new Float32Array([-0.5, 0.0, 0.0, 0.5]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint8 2D matrix",
    description: "2×2 qint8 matrix; scale=0.0078125, zero_point=0. All values are exact multiples of scale.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { mat: { dtype: DTYPE.QINT8, shape: [2, 2], data: [-0.5, 0.0, 0.0, 0.5] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint8 nonzero zero_point
;(function () {
  const schema = { v: { dtype: DTYPE.QINT8, shape: [2], scale: 0.0078125, zero_point: -64 } }
  const input = { v: { dtype: DTYPE.QINT8, shape: [2], data: new Float32Array([-0.5, 0.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint8 nonzero zero_point",
    description: "1D qint8 tensor with zero_point=-64; effectively shifts the quantization range. Lossless for [-0.5, 0.0].",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { v: { dtype: DTYPE.QINT8, shape: [2], data: [-0.5, 0.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint8 mixed with fp32
;(function () {
  const schema = {
    a: { dtype: DTYPE.QINT8, shape: [2], scale: 0.0078125, zero_point: 0 },
    b: { dtype: DTYPE.FP32, shape: [2] },
  }
  const input = {
    a: { dtype: DTYPE.QINT8, shape: [2], data: new Float32Array([0.0, 0.5]) },
    b: { dtype: DTYPE.FP32, shape: [2], data: new Float32Array([1.0, -1.0]) },
  }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint8 mixed with fp32",
    description: "Schemaful doc with a qint8 tensor 'a' and an fp32 tensor 'b'. Tensors emitted in sorted name order (a, b).",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { a: { dtype: DTYPE.QINT8, shape: [2], data: [0.0, 0.5] }, b: { dtype: DTYPE.FP32, shape: [2], data: [1.0, -1.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint8 clamping overflow
;(function () {
  const schema = { c: { dtype: DTYPE.QINT8, shape: [2], scale: 0.0078125, zero_point: 0 } }
  const input = { c: { dtype: DTYPE.QINT8, shape: [2], data: new Float32Array([1.5, -1.5]) } }
  const { bytes, decoded } = encodeAndDecode(schema, input)
  const decF32 = Array.from(decoded.tensors.c.data)
  vectors.push({
    name: "qint8 clamping overflow",
    description: "Values 1.5 and -1.5 exceed the qint8 range at scale=0.0078125; encoder clamps to [127, -128]. Decoded values are [0.9921875, -1.0].",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { c: { dtype: DTYPE.QINT8, shape: [2], data: [1.5, -1.5] } } },
    expected_bytes_hex: toHex(bytes),
    expected_decoded: { tensors: { c: { dtype: DTYPE.QINT8, shape: [2], data: decF32 } } },
  })
})()

// ── qint4 vectors ─────────────────────────────────────────────────────────

// qint4 simple 1D
// scale=0.25, zp=0. Range -2.0..1.75 (q -8..7 × 0.25).
// Values [-2.0, -1.0, 0.0, 1.0] → q=[-8, -4, 0, 4] (exact).
;(function () {
  const schema = { w: { dtype: DTYPE.QINT4, shape: [4], scale: 0.25, zero_point: 0 } }
  const input = { w: { dtype: DTYPE.QINT4, shape: [4], data: new Float32Array([-2.0, -1.0, 0.0, 1.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint4 simple 1D",
    description: "1D qint4 tensor; scale=0.25, zero_point=0. Values [-2.0, -1.0, 0.0, 1.0] map exactly to q=[-8, -4, 0, 4]; dequant is lossless.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { w: { dtype: DTYPE.QINT4, shape: [4], data: [-2.0, -1.0, 0.0, 1.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint4 2D matrix
// 2×2, scale=0.5, zp=0. Values [-1.0, 0.0, 0.0, 1.0] → q=[-2, 0, 0, 2].
;(function () {
  const schema = { mat: { dtype: DTYPE.QINT4, shape: [2, 2], scale: 0.5, zero_point: 0 } }
  const input = { mat: { dtype: DTYPE.QINT4, shape: [2, 2], data: new Float32Array([-1.0, 0.0, 0.0, 1.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint4 2D matrix",
    description: "2×2 qint4 matrix; scale=0.5, zero_point=0. Values are exact multiples of scale within 4-bit signed range.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { mat: { dtype: DTYPE.QINT4, shape: [2, 2], data: [-1.0, 0.0, 0.0, 1.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint4 nonzero zero_point
// scale=0.25, zp=4. q = round(f32/0.25 + 4). Values [0.0, 1.0] → q=[4, 8 clamped 7].
// Actually let's pick values that are in range: 0.0 → q=4, -1.0 → q=0.
;(function () {
  const schema = { v: { dtype: DTYPE.QINT4, shape: [2], scale: 0.25, zero_point: 4 } }
  // 0.0 → round(0/0.25 + 4) = 4; -1.0 → round(-1/0.25 + 4) = 0. Both in [-8,7].
  const input = { v: { dtype: DTYPE.QINT4, shape: [2], data: new Float32Array([0.0, -1.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint4 nonzero zero_point",
    description: "1D qint4 tensor with zero_point=4, scale=0.25. Values [0.0, -1.0] map to q=[4, 0]; dequant is lossless.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { v: { dtype: DTYPE.QINT4, shape: [2], data: [0.0, -1.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qint4 clamping overflow
// scale=0.25, zp=0. Values 2.5 and -2.5 exceed 4-bit range; clamp to [7, -8].
// Decoded: [7×0.25, -8×0.25] = [1.75, -2.0].
;(function () {
  const schema = { c: { dtype: DTYPE.QINT4, shape: [2], scale: 0.25, zero_point: 0 } }
  const input = { c: { dtype: DTYPE.QINT4, shape: [2], data: new Float32Array([2.5, -2.5]) } }
  const { bytes, decoded } = encodeAndDecode(schema, input)
  const decF32 = Array.from(decoded.tensors.c.data)
  vectors.push({
    name: "qint4 clamping overflow",
    description: "Values 2.5 and -2.5 exceed qint4 range at scale=0.25; encoder clamps to [7, -8]. Decoded values are [1.75, -2.0].",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { c: { dtype: DTYPE.QINT4, shape: [2], data: [2.5, -2.5] } } },
    expected_bytes_hex: toHex(bytes),
    expected_decoded: { tensors: { c: { dtype: DTYPE.QINT4, shape: [2], data: decF32 } } },
  })
})()

// qint4 odd count (3 elements; 2 bytes nibble-packed, last nibble padded to 0)
// scale=0.25, zp=0. Values [-1.0, 0.0, 1.0] → q=[-4, 0, 4].
;(function () {
  const schema = { x: { dtype: DTYPE.QINT4, shape: [3], scale: 0.25, zero_point: 0 } }
  const input = { x: { dtype: DTYPE.QINT4, shape: [3], data: new Float32Array([-1.0, 0.0, 1.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qint4 odd count",
    description: "3-element qint4 tensor; nibble packing pads the 4th nibble to 0. Values [-1.0, 0.0, 1.0] → q=[-4, 0, 4], stored in 2 bytes.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { x: { dtype: DTYPE.QINT4, shape: [3], data: [-1.0, 0.0, 1.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// ── qfp8 vectors ──────────────────────────────────────────────────────────

// qfp8 simple 1D
// Uses fp8e4m3 encoding; scale=2.0. Values [1.0, -1.0, 2.0] → scaled [0.5, -0.5, 1.0].
// fp8e4m3: 0.5 = 0b0_0011_000 = 0x30; -0.5 = 0b1_0011_000 = 0xB0; 1.0 = 0b0_0111_000 = 0x38.
// Dequant: multiply decoded fp8 by scale=2.0 → [1.0, -1.0, 2.0] (lossless for these values).
;(function () {
  const schema = { w: { dtype: DTYPE.QFP8, shape: [3], scale: 2.0 } }
  const input = { w: { dtype: DTYPE.QFP8, shape: [3], data: new Float32Array([1.0, -1.0, 2.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qfp8 simple 1D",
    description: "1D qfp8 tensor; scale=2.0. Values [1.0, -1.0, 2.0] scaled to [0.5, -0.5, 1.0] then encoded as fp8e4m3 bits; dequant is lossless for these values.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { w: { dtype: DTYPE.QFP8, shape: [3], data: [1.0, -1.0, 2.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qfp8 2D matrix
// scale=0.5. Values [0.5, 1.0, -0.5, -1.0] → scaled [1.0, 2.0, -1.0, -2.0] → exact fp8e4m3.
;(function () {
  const schema = { mat: { dtype: DTYPE.QFP8, shape: [2, 2], scale: 0.5 } }
  const input = { mat: { dtype: DTYPE.QFP8, shape: [2, 2], data: new Float32Array([0.5, 1.0, -0.5, -1.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qfp8 2D matrix",
    description: "2×2 qfp8 matrix; scale=0.5. Values scaled ×2 before fp8e4m3 encoding; dequant multiplies by 0.5.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { mat: { dtype: DTYPE.QFP8, shape: [2, 2], data: [0.5, 1.0, -0.5, -1.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qfp8 range extension
// scale=256.0 (shifts fp8e4m3 max from 448 to 114688).
// Values [128.0, -128.0, 256.0] → scaled [0.5, -0.5, 1.0] → fp8e4m3 exact.
;(function () {
  const schema = { z: { dtype: DTYPE.QFP8, shape: [3], scale: 256.0 } }
  const input = { z: { dtype: DTYPE.QFP8, shape: [3], data: new Float32Array([128.0, -128.0, 256.0]) } }
  const { bytes } = encodeAndDecode(schema, input)
  vectors.push({
    name: "qfp8 range extension via scale",
    description: "scale=256.0 extends fp8e4m3 dynamic range. Values [128, -128, 256] scaled down to [0.5, -0.5, 1.0] before fp8e4m3 encoding.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { z: { dtype: DTYPE.QFP8, shape: [3], data: [128.0, -128.0, 256.0] } } },
    expected_bytes_hex: toHex(bytes),
  })
})()

// qfp8 lossy rounding
// scale=1.0, value=0.1 cannot be represented exactly in fp8e4m3.
// expected_decoded shows the actual round-tripped value.
;(function () {
  const schema = { v: { dtype: DTYPE.QFP8, shape: [1], scale: 1.0 } }
  const input = { v: { dtype: DTYPE.QFP8, shape: [1], data: new Float32Array([0.1]) } }
  const { bytes, decoded } = encodeAndDecode(schema, input)
  const decF32 = Array.from(decoded.tensors.v.data)
  vectors.push({
    name: "qfp8 lossy rounding",
    description: "scale=1.0, input 0.1 is not exactly representable in fp8e4m3; expected_decoded shows the rounded value.",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { v: { dtype: DTYPE.QFP8, shape: [1], data: [0.1] } } },
    expected_bytes_hex: toHex(bytes),
    expected_decoded: { tensors: { v: { dtype: DTYPE.QFP8, shape: [1], data: decF32 } } },
  })
})()

writeFileSync(OUT, JSON.stringify(vectors, null, 2) + "\n", "utf8")
console.log(`Wrote ${vectors.length} vectors → schemas/qint.json`)
console.log("  qint8: 5, qint4: 5, qfp8: 4")
