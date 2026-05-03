// Generator for weavepack-tensor conformance test vectors.
// Run from repo root:  node weavepack/tools/generate-tensor-vectors.js
//
// Writes JSON files into weavepack/profiles/tensor/test-vectors/.
// Each file is an array of test-vector objects with expected_bytes_hex
// computed by the JS reference implementation.

import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  encodeDocument,
  encodeDocumentSchemaful,
  TensorPack,
  DTYPE,
  schemaHashHex,
} from "../../sdk/src/profiles/tensor/index.js"

const __filename = fileURLToPath(import.meta.url)
const TENSOR_ROOT = join(dirname(__filename), "..", "profiles", "tensor", "test-vectors")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")

function save(relPath, vectors) {
  const full = join(TENSOR_ROOT, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(vectors, null, 2) + "\n", "utf8")
  console.log(`Wrote ${vectors.length} vectors → ${relPath}`)
}

// ── helpers ───────────────────────────────────────────────────────────────

function mkData(dtype, arr) {
  switch (dtype) {
    case DTYPE.FP32:  return new Float32Array(arr)
    case DTYPE.FP64:  return new Float64Array(arr)
    case DTYPE.INT8:  return new Int8Array(arr)
    case DTYPE.UINT8: return new Uint8Array(arr)
    case DTYPE.INT16: return new Int16Array(arr)
    case DTYPE.UINT16:return new Uint16Array(arr)
    case DTYPE.INT32: return new Int32Array(arr)
    case DTYPE.UINT32:return new Uint32Array(arr)
    case DTYPE.INT64: return new BigInt64Array(arr.map(v => BigInt(v)))
    case DTYPE.UINT64:return new BigUint64Array(arr.map(v => BigInt(v)))
    case DTYPE.BOOL:  return arr
    default: throw new Error(`unsupported dtype ${dtype} in mkData`)
  }
}

function mkDoc(tensorDefs) {
  const tensors = {}
  for (const [name, { dtype, shape, data }] of Object.entries(tensorDefs)) {
    tensors[name] = { dtype, shape, data: mkData(dtype, data) }
  }
  return { tensors }
}

// Round fp32 values through Float32Array to get canonical representation.
function fp32arr(arr) { return Array.from(new Float32Array(arr)) }
function fp64arr(arr) { return Array.from(new Float64Array(arr)) }

// Build chain bytes for initial doc + one update.
function buildChain(initialDef, updateDef) {
  const pack = new TensorPack({ json: mkDoc(initialDef) })
  pack.update(mkDoc(updateDef))
  return toHex(pack.toBuffer())
}

// ── types/dtypes.json ─────────────────────────────────────────────────────

const dtypeVectors = []

dtypeVectors.push({
  name: "fp32 1D tensor",
  description: "four-element fp32 1D tensor encoding",
  input: { tensors: { w: { dtype: DTYPE.FP32, shape: [4], data: fp32arr([0, 1, -1, 3.14]) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ w: { dtype: DTYPE.FP32, shape: [4], data: [0, 1, -1, 3.14] } }))),
})

dtypeVectors.push({
  name: "int8 1D tensor",
  description: "min/max int8 boundary values",
  input: { tensors: { x: { dtype: DTYPE.INT8, shape: [5], data: [-128, -1, 0, 1, 127] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.INT8, shape: [5], data: [-128, -1, 0, 1, 127] } }))),
})

dtypeVectors.push({
  name: "uint8 1D tensor",
  description: "min/max uint8 boundary values",
  input: { tensors: { x: { dtype: DTYPE.UINT8, shape: [5], data: [0, 1, 127, 128, 255] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.UINT8, shape: [5], data: [0, 1, 127, 128, 255] } }))),
})

dtypeVectors.push({
  name: "int16 1D tensor",
  description: "min/max int16 boundary values",
  input: { tensors: { x: { dtype: DTYPE.INT16, shape: [5], data: [-32768, -1, 0, 1, 32767] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.INT16, shape: [5], data: [-32768, -1, 0, 1, 32767] } }))),
})

dtypeVectors.push({
  name: "uint16 1D tensor",
  description: "min/max uint16 boundary values",
  input: { tensors: { x: { dtype: DTYPE.UINT16, shape: [5], data: [0, 1, 32767, 32768, 65535] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.UINT16, shape: [5], data: [0, 1, 32767, 32768, 65535] } }))),
})

dtypeVectors.push({
  name: "int32 1D tensor",
  description: "min/max int32 boundary values",
  input: { tensors: { x: { dtype: DTYPE.INT32, shape: [5], data: [-2147483648, -1, 0, 1, 2147483647] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.INT32, shape: [5], data: [-2147483648, -1, 0, 1, 2147483647] } }))),
})

dtypeVectors.push({
  name: "uint32 1D tensor",
  description: "min/max uint32 boundary values",
  input: { tensors: { x: { dtype: DTYPE.UINT32, shape: [5], data: [0, 1, 2147483647, 2147483648, 4294967295] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.UINT32, shape: [5], data: [0, 1, 2147483647, 2147483648, 4294967295] } }))),
})

dtypeVectors.push({
  name: "fp64 1D tensor",
  description: "fp64 double-precision values including large exponent",
  input: { tensors: { x: { dtype: DTYPE.FP64, shape: [4], data: fp64arr([0, 1, -1, 1e100]) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.FP64, shape: [4], data: [0, 1, -1, 1e100] } }))),
})

dtypeVectors.push({
  name: "bool tensor sub-byte alignment",
  description: "11 booleans packed into 2 bytes (5 trailing bits unused)",
  input: { tensors: { mask: { dtype: DTYPE.BOOL, shape: [11], data: [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ mask: { dtype: DTYPE.BOOL, shape: [11], data: [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0] } }))),
})

// INT64 / UINT64: stored as decimal strings in JSON to avoid precision loss.
dtypeVectors.push({
  name: "int64 1D tensor",
  description: "int64 min/max boundary values — data stored as decimal strings",
  input: { tensors: { x: { dtype: DTYPE.INT64, shape: [5],
    data: ["-9223372036854775808", "-1", "0", "1", "9223372036854775807"] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.INT64, shape: [5],
    data: ["-9223372036854775808", "-1", "0", "1", "9223372036854775807"] } }))),
})

dtypeVectors.push({
  name: "uint64 1D tensor",
  description: "uint64 min/max boundary values — data stored as decimal strings",
  input: { tensors: { x: { dtype: DTYPE.UINT64, shape: [3],
    data: ["0", "1", "18446744073709551615"] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ x: { dtype: DTYPE.UINT64, shape: [3],
    data: ["0", "1", "18446744073709551615"] } }))),
})

save("types/dtypes.json", dtypeVectors)

// ── containers/shapes.json ────────────────────────────────────────────────

const shapeVectors = []

shapeVectors.push({
  name: "fp32 1D shape [8]",
  description: "1D tensor with 8 elements",
  input: { tensors: { v: { dtype: DTYPE.FP32, shape: [8],
    data: fp32arr([1, 2, 3, 4, 5, 6, 7, 8]) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ v: { dtype: DTYPE.FP32, shape: [8],
    data: [1, 2, 3, 4, 5, 6, 7, 8] } }))),
})

shapeVectors.push({
  name: "fp32 2D shape [2,3]",
  description: "2×3 matrix stored in C row-major order",
  input: { tensors: { m: { dtype: DTYPE.FP32, shape: [2, 3],
    data: fp32arr([1, 2, 3, 4, 5, 6]) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ m: { dtype: DTYPE.FP32, shape: [2, 3],
    data: [1, 2, 3, 4, 5, 6] } }))),
})

shapeVectors.push({
  name: "fp32 3D shape [2,3,4]",
  description: "3D tensor: 2 slices of 3×4 in C row-major order",
  input: { tensors: { t: { dtype: DTYPE.FP32, shape: [2, 3, 4],
    data: fp32arr(Array.from({ length: 24 }, (_, i) => i)) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ t: { dtype: DTYPE.FP32, shape: [2, 3, 4],
    data: Array.from({ length: 24 }, (_, i) => i) } }))),
})

{
  const w = fp32arr([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
  const b = fp32arr([0.01, 0.02])
  shapeVectors.push({
    name: "multi-tensor document",
    description: "document with two tensors: a weight matrix and a bias vector",
    input: {
      tensors: {
        "layer.weight": { dtype: DTYPE.FP32, shape: [2, 4], data: w },
        "layer.bias":   { dtype: DTYPE.FP32, shape: [2],    data: b },
      }
    },
    expected_bytes_hex: toHex(encodeDocument(mkDoc({
      "layer.weight": { dtype: DTYPE.FP32, shape: [2, 4], data: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] },
      "layer.bias":   { dtype: DTYPE.FP32, shape: [2],    data: [0.01, 0.02] },
    }))),
  })
}

shapeVectors.push({
  name: "empty tensor shape [0]",
  description: "zero-element tensor: valid encoding with no data bytes",
  input: { tensors: { empty: { dtype: DTYPE.FP32, shape: [0], data: [] } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ empty: { dtype: DTYPE.FP32, shape: [0], data: new Float32Array(0) } }))),
})

shapeVectors.push({
  name: "scalar fp32 shape [1]",
  description: "single-element 1D tensor",
  input: { tensors: { s: { dtype: DTYPE.FP32, shape: [1], data: fp32arr([3.14]) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ s: { dtype: DTYPE.FP32, shape: [1], data: [3.14] } }))),
})

shapeVectors.push({
  name: "utf-8 tensor name",
  description: "tensor named with Chinese characters — UTF-8 encoded on wire",
  input: { tensors: { "中文_weight": { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
  expected_bytes_hex: toHex(encodeDocument(mkDoc({ "中文_weight": { dtype: DTYPE.FP32, shape: [2], data: [1, 2] } }))),
})

save("containers/shapes.json", shapeVectors)

// ── deltas/tensor_replace.json ────────────────────────────────────────────

const replaceVectors = []

replaceVectors.push({
  name: "tensor_replace basic",
  description: "replace all values in a 3-element fp32 tensor",
  initial: { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32arr([1, 2, 3]) } } },
  update:  { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32arr([10, 20, 30]) } } },
  expected_chain_bytes_hex: buildChain(
    { w: { dtype: DTYPE.FP32, shape: [3], data: [1, 2, 3] } },
    { w: { dtype: DTYPE.FP32, shape: [3], data: [10, 20, 30] } }
  ),
  expected_final: { tensors: { w: { dtype: DTYPE.FP32, shape: [3], data: fp32arr([10, 20, 30]) } } },
})

replaceVectors.push({
  name: "dtype change fp32 to int32",
  description: "changing dtype produces tensor_remove + tensor_add ops",
  initial: { tensors: { x: { dtype: DTYPE.FP32,  shape: [2], data: fp32arr([1, 2]) } } },
  update:  { tensors: { x: { dtype: DTYPE.INT32,  shape: [2], data: [100, 200] } } },
  expected_chain_bytes_hex: buildChain(
    { x: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] } },
    { x: { dtype: DTYPE.INT32, shape: [2], data: [100, 200] } }
  ),
  expected_final: { tensors: { x: { dtype: DTYPE.INT32, shape: [2], data: [100, 200] } } },
})

replaceVectors.push({
  name: "int32 tensor_replace",
  description: "replace all values in an int32 tensor",
  initial: { tensors: { m: { dtype: DTYPE.INT32, shape: [4], data: [0, 1, 2, 3] } } },
  update:  { tensors: { m: { dtype: DTYPE.INT32, shape: [4], data: [100, 200, 300, 400] } } },
  expected_chain_bytes_hex: buildChain(
    { m: { dtype: DTYPE.INT32, shape: [4], data: [0, 1, 2, 3] } },
    { m: { dtype: DTYPE.INT32, shape: [4], data: [100, 200, 300, 400] } }
  ),
  expected_final: { tensors: { m: { dtype: DTYPE.INT32, shape: [4], data: [100, 200, 300, 400] } } },
})

// identity: no delta appended
{
  const doc = mkDoc({ w: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] } })
  const pack = new TensorPack({ json: doc })
  const beforeLen = pack.toBuffer().length
  pack.update(doc)
  const afterLen = pack.toBuffer().length
  replaceVectors.push({
    name: "identity update no-op",
    description: "when the document is unchanged, no delta frame is appended",
    initial: { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
    update:  { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
    expected_chain_bytes_hex: toHex(pack.toBuffer()),
    expected_final: { tensors: { w: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
    note: `chain does not grow: before ${beforeLen} bytes = after ${afterLen} bytes`,
  })
}

save("deltas/tensor_replace.json", replaceVectors)

// ── deltas/tensor_add_remove.json ─────────────────────────────────────────

const addRemoveVectors = []

addRemoveVectors.push({
  name: "tensor_add new tensor",
  description: "add tensor 'b' to a document that already has tensor 'a'",
  initial: { tensors: { a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
  update:  {
    tensors: {
      a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) },
      b: { dtype: DTYPE.FP32, shape: [3], data: fp32arr([3, 4, 5]) },
    }
  },
  expected_chain_bytes_hex: buildChain(
    { a: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] } },
    {
      a: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] },
      b: { dtype: DTYPE.FP32, shape: [3], data: [3, 4, 5] },
    }
  ),
  expected_final: {
    tensors: {
      a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) },
      b: { dtype: DTYPE.FP32, shape: [3], data: fp32arr([3, 4, 5]) },
    }
  },
})

addRemoveVectors.push({
  name: "tensor_remove",
  description: "remove tensor 'b', keeping 'a'",
  initial: {
    tensors: {
      a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) },
      b: { dtype: DTYPE.FP32, shape: [3], data: fp32arr([3, 4, 5]) },
    }
  },
  update: { tensors: { a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
  expected_chain_bytes_hex: buildChain(
    {
      a: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] },
      b: { dtype: DTYPE.FP32, shape: [3], data: [3, 4, 5] },
    },
    { a: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] } }
  ),
  expected_final: { tensors: { a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) } } },
})

addRemoveVectors.push({
  name: "add two new mixed-dtype tensors",
  description: "adds int8 and uint8 tensors to an existing fp32 tensor",
  initial: { tensors: { w: { dtype: DTYPE.FP32, shape: [4], data: fp32arr([1, 2, 3, 4]) } } },
  update: {
    tensors: {
      w:  { dtype: DTYPE.FP32,  shape: [4], data: fp32arr([1, 2, 3, 4]) },
      b1: { dtype: DTYPE.INT8,  shape: [2], data: [-1, 1] },
      b2: { dtype: DTYPE.UINT8, shape: [2], data: [0, 255] },
    }
  },
  expected_chain_bytes_hex: buildChain(
    { w: { dtype: DTYPE.FP32, shape: [4], data: [1, 2, 3, 4] } },
    {
      w:  { dtype: DTYPE.FP32,  shape: [4], data: [1, 2, 3, 4] },
      b1: { dtype: DTYPE.INT8,  shape: [2], data: [-1, 1] },
      b2: { dtype: DTYPE.UINT8, shape: [2], data: [0, 255] },
    }
  ),
  expected_final: {
    tensors: {
      w:  { dtype: DTYPE.FP32,  shape: [4], data: fp32arr([1, 2, 3, 4]) },
      b1: { dtype: DTYPE.INT8,  shape: [2], data: [-1, 1] },
      b2: { dtype: DTYPE.UINT8, shape: [2], data: [0, 255] },
    }
  },
})

// remove all tensors
{
  const initDoc = mkDoc({
    a: { dtype: DTYPE.FP32, shape: [2], data: [1, 2] },
    b: { dtype: DTYPE.FP32, shape: [2], data: [3, 4] },
  })
  const emptyDoc = { tensors: {} }
  const pack = new TensorPack({ json: initDoc })
  pack.update(emptyDoc)
  addRemoveVectors.push({
    name: "remove all tensors",
    description: "delta removes all tensors leaving an empty document",
    initial: { tensors: {
      a: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([1, 2]) },
      b: { dtype: DTYPE.FP32, shape: [2], data: fp32arr([3, 4]) },
    }},
    update:  { tensors: {} },
    expected_chain_bytes_hex: toHex(pack.toBuffer()),
    expected_final: { tensors: {} },
  })
}

save("deltas/tensor_add_remove.json", addRemoveVectors)

// ── deltas/element_set.json ───────────────────────────────────────────────

const elemSetVectors = []

// sparse fp32: 2 of 100 changed
{
  const N = 100
  const base = Array.from({ length: N }, (_, i) => i * 0.5)
  const upd  = [...base]; upd[10] = 999.0; upd[90] = 888.0
  const initDoc = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: mkData(DTYPE.FP32, base) } } }
  const updDoc  = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: mkData(DTYPE.FP32, upd) } } }
  const pack = new TensorPack({ json: initDoc })
  pack.update(updDoc)
  elemSetVectors.push({
    name: "element_set sparse fp32",
    description: "2 of 100 fp32 elements changed — encoder picks element_set op",
    initial: { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: fp32arr(base) } } },
    update:  { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: fp32arr(upd) } } },
    expected_chain_bytes_hex: toHex(pack.toBuffer()),
    expected_final: { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: fp32arr(upd) } } },
  })
}

// sparse int32: 2 of 50 changed
{
  const base = Array.from({ length: 50 }, (_, i) => i)
  const upd  = [...base]; upd[5] = 9999; upd[25] = 8888
  const initDoc = { tensors: { m: { dtype: DTYPE.INT32, shape: [50], data: mkData(DTYPE.INT32, base) } } }
  const updDoc  = { tensors: { m: { dtype: DTYPE.INT32, shape: [50], data: mkData(DTYPE.INT32, upd) } } }
  const pack = new TensorPack({ json: initDoc })
  pack.update(updDoc)
  elemSetVectors.push({
    name: "element_set sparse int32",
    description: "2 of 50 int32 elements changed — encoder picks element_set op",
    initial: { tensors: { m: { dtype: DTYPE.INT32, shape: [50], data: base } } },
    update:  { tensors: { m: { dtype: DTYPE.INT32, shape: [50], data: upd } } },
    expected_chain_bytes_hex: toHex(pack.toBuffer()),
    expected_final: { tensors: { m: { dtype: DTYPE.INT32, shape: [50], data: upd } } },
  })
}

save("deltas/element_set.json", elemSetVectors)

// ── schemas/schemaful.json ────────────────────────────────────────────────

const schemaVectors = []

// single fp32 schemaful
{
  const schema = { weight: { dtype: DTYPE.FP32, shape: [4] } }
  const data = fp32arr([1, 2, 3, 4])
  const doc = { tensors: { weight: { dtype: DTYPE.FP32, shape: [4], data: mkData(DTYPE.FP32, [1, 2, 3, 4]) } } }
  schemaVectors.push({
    name: "schemaful single fp32",
    description: "schemaful document: 2-bit header + 32-byte hash + raw data blocks, no inline metadata",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: { tensors: { weight: { dtype: DTYPE.FP32, shape: [4], data } } },
    expected_bytes_hex: toHex(encodeDocumentSchemaful(doc, schema)),
  })
}

// multi-tensor schemaful: key order must be canonical (alphabetical)
{
  const schema = {
    "z.bias":   { dtype: DTYPE.FP32, shape: [3] },
    "a.weight": { dtype: DTYPE.FP32, shape: [3, 3] },
  }
  const doc = {
    tensors: {
      "z.bias":   { dtype: DTYPE.FP32, shape: [3],    data: mkData(DTYPE.FP32, [0.1, 0.2, 0.3]) },
      "a.weight": { dtype: DTYPE.FP32, shape: [3, 3], data: mkData(DTYPE.FP32, [1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    }
  }
  schemaVectors.push({
    name: "schemaful multi-tensor canonical key order",
    description: "two tensors encoded in alphabetical key order (a.weight before z.bias)",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: {
      tensors: {
        "z.bias":   { dtype: DTYPE.FP32, shape: [3],    data: fp32arr([0.1, 0.2, 0.3]) },
        "a.weight": { dtype: DTYPE.FP32, shape: [3, 3], data: fp32arr([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
      }
    },
    expected_bytes_hex: toHex(encodeDocumentSchemaful(doc, schema)),
  })
}

// schemaful bool + int8
{
  const schema = {
    i8:   { dtype: DTYPE.INT8, shape: [4] },
    mask: { dtype: DTYPE.BOOL, shape: [8] },
  }
  const doc = {
    tensors: {
      i8:   { dtype: DTYPE.INT8, shape: [4], data: mkData(DTYPE.INT8, [-128, -1, 0, 127]) },
      mask: { dtype: DTYPE.BOOL, shape: [8], data: [1, 0, 1, 1, 0, 0, 1, 0] },
    }
  }
  schemaVectors.push({
    name: "schemaful bool and int8",
    description: "schemaful document with bool (1-bit packed) and int8 tensors",
    schema,
    schema_hash_hex: schemaHashHex(schema),
    input: {
      tensors: {
        i8:   { dtype: DTYPE.INT8, shape: [4], data: [-128, -1, 0, 127] },
        mask: { dtype: DTYPE.BOOL, shape: [8], data: [1, 0, 1, 1, 0, 0, 1, 0] },
      }
    },
    expected_bytes_hex: toHex(encodeDocumentSchemaful(doc, schema)),
  })
}

save("schemas/schemaful.json", schemaVectors)

console.log("\nDone. All tensor test vectors written.")
