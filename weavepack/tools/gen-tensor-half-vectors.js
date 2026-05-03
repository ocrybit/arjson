// Generate fp16/bf16 conformance vectors for weavepack-tensor (RFC 0001).
// Writes weavepack/profiles/tensor/test-vectors/types/half.json.

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  encodeDocument, DTYPE,
  f32ArrayToFp16Bits, f32ArrayToBf16Bits,
} from "../../sdk/src/profiles/tensor/index.js"

const __filename = fileURLToPath(import.meta.url)
const OUT = join(dirname(__filename), "..", "profiles", "tensor", "test-vectors", "types", "half.json")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")

// Each spec: human-readable + a Float32Array input. Encoder converts to
// fp16/bf16 raw bits as appropriate.
const cases = [
  {
    name: "fp16 unit values",
    description: "fp16 round-trip: 0, 1, -1, 0.5",
    dtype: DTYPE.FP16,
    shape: [4],
    f32: [0, 1, -1, 0.5],
  },
  {
    name: "fp16 max-finite",
    description: "65504 (max finite fp16, exact representation)",
    dtype: DTYPE.FP16,
    shape: [1],
    f32: [65504],
  },
  {
    name: "fp16 smallest subnormal",
    description: "2^-24 is the smallest fp16 subnormal",
    dtype: DTYPE.FP16,
    shape: [1],
    f32: [Math.pow(2, -24)],
  },
  {
    name: "fp16 underflow to zero",
    description: "value below smallest subnormal flushes to 0",
    dtype: DTYPE.FP16,
    shape: [1],
    f32: [Math.pow(2, -25)],
  },
  {
    name: "fp16 2D matrix",
    description: "2x3 fp16 matrix",
    dtype: DTYPE.FP16,
    shape: [2, 3],
    f32: [1, 2, 3, 4, 5, 6],
  },
  {
    name: "bf16 unit values",
    description: "bf16 round-trip: 0, 1, -1, 0.5",
    dtype: DTYPE.BF16,
    shape: [4],
    f32: [0, 1, -1, 0.5],
  },
  {
    name: "bf16 large dynamic range",
    description: "bf16 preserves f32 exponent range; values in [1e-30, 1e30]",
    dtype: DTYPE.BF16,
    shape: [3],
    f32: [1e-30, 1, 1e30],
  },
  {
    name: "bf16 2D matrix",
    description: "2x3 bf16 matrix",
    dtype: DTYPE.BF16,
    shape: [2, 3],
    f32: [1, 2, 3, 4, 5, 6],
  },
]

const vectors = cases.map(c => {
  const f32 = new Float32Array(c.f32)
  const doc = { tensors: { t: { dtype: c.dtype, shape: c.shape, data: f32 } } }
  const bytes = encodeDocument(doc)
  // Recover the actual stored bits and the lossy round-trip f32 values
  // for the expected_decoded_f32 field (the corpus needs both).
  const bits = c.dtype === DTYPE.FP16
    ? f32ArrayToFp16Bits(f32)
    : f32ArrayToBf16Bits(f32)
  return {
    name: c.name,
    description: c.description,
    input: {
      tensors: {
        t: {
          dtype: c.dtype,
          shape: c.shape,
          data: Array.from(c.f32),  // plain f32 numbers as JSON
        }
      }
    },
    expected_bytes_hex: toHex(bytes),
    // Raw fp16/bf16 bits (one u16 per element) for bit-exact verification.
    expected_bits: Array.from(bits),
  }
})

writeFileSync(OUT, JSON.stringify(vectors, null, 2) + "\n")
console.log(`Wrote ${vectors.length} fp16/bf16 vectors to ${OUT}`)
