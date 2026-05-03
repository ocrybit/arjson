// Generate region_replace conformance vectors for weavepack-tensor.
// Writes weavepack/profiles/tensor/test-vectors/deltas/region_replace.json.

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  encodeDocument, encodeDelta, applyDelta, DTYPE,
} from "../../sdk/src/profiles/tensor/index.js"

const __filename = fileURLToPath(import.meta.url)
const OUT = join(dirname(__filename), "..", "profiles", "tensor", "test-vectors", "deltas", "region_replace.json")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")

// Cases that trigger region_replace: dense bbox change (>50% inside box,
// <30% globally to avoid tensor_replace).

const cases = [
  {
    name: "1D contiguous run",
    description: "1D fp32 tensor, contiguous 10-element block changed (10% of 100)",
    initial_data: Array.from({ length: 100 }, (_, i) => i * 0.1),
    update_data: (() => {
      const a = Array.from({ length: 100 }, (_, i) => i * 0.1)
      for (let i = 30; i < 40; i++) a[i] = 100.0 + i
      return a
    })(),
    shape: [100],
    dtype: DTYPE.FP32,
  },
  {
    name: "2D dense block",
    description: "10x10 fp32 matrix, 3x3 contiguous block changed (9%)",
    initial_data: Array.from({ length: 100 }, (_, i) => i),
    update_data: (() => {
      const a = Array.from({ length: 100 }, (_, i) => i)
      for (let r = 4; r < 7; r++)
        for (let c = 5; c < 8; c++)
          a[r * 10 + c] = 999.0
      return a
    })(),
    shape: [10, 10],
    dtype: DTYPE.FP32,
  },
  {
    name: "1D large region",
    description: "200-element fp32 tensor, 50-element contiguous run changed (25%)",
    initial_data: new Array(200).fill(0),
    update_data: (() => {
      const a = new Array(200).fill(0)
      for (let i = 50; i < 100; i++) a[i] = i
      return a
    })(),
    shape: [200],
    dtype: DTYPE.FP32,
  },
  {
    name: "int32 contiguous",
    description: "100-element int32 vector, 20-element block changed",
    initial_data: new Array(100).fill(0),
    update_data: (() => {
      const a = new Array(100).fill(0)
      for (let i = 40; i < 60; i++) a[i] = i * 100
      return a
    })(),
    shape: [100],
    dtype: DTYPE.INT32,
  },
]

const vectors = cases.map(c => {
  const Ctor = c.dtype === DTYPE.FP32 ? Float32Array
    : c.dtype === DTYPE.INT32 ? Int32Array
    : c.dtype === DTYPE.FP64 ? Float64Array
    : Float32Array
  const initialDoc = {
    tensors: { t: { dtype: c.dtype, shape: c.shape, data: new Ctor(c.initial_data) } }
  }
  const updateDoc = {
    tensors: { t: { dtype: c.dtype, shape: c.shape, data: new Ctor(c.update_data) } }
  }
  const initialBytes = encodeDocument(initialDoc)
  const deltaBytes = encodeDelta(initialDoc, updateDoc)

  // Chain framing: initial + leb128-prefixed delta.
  function leb128(v) {
    const out = []
    while (v >= 128) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
    out.push(v)
    return out
  }
  const init_len = leb128(initialBytes.length)
  const delta_len = leb128(deltaBytes.length)
  const chain = new Uint8Array(init_len.length + initialBytes.length + delta_len.length + deltaBytes.length)
  let off = 0
  for (const b of init_len) chain[off++] = b
  chain.set(initialBytes, off); off += initialBytes.length
  for (const b of delta_len) chain[off++] = b
  chain.set(deltaBytes, off)

  return {
    name: c.name,
    description: c.description,
    initial: { tensors: { t: { dtype: c.dtype, shape: c.shape, data: c.initial_data } } },
    update:  { tensors: { t: { dtype: c.dtype, shape: c.shape, data: c.update_data } } },
    expected_chain_bytes_hex: toHex(chain),
    expected_final: { tensors: { t: { dtype: c.dtype, shape: c.shape, data: c.update_data } } },
  }
})

writeFileSync(OUT, JSON.stringify(vectors, null, 2) + "\n")
console.log(`Wrote ${vectors.length} region_replace vectors to ${OUT}`)
