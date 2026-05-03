// Worked example: many fine-tuned variants over a base model.
//
// Demonstrates USE-CASES.md scenario 2 (multiple fine-tuned variants).
// Simulates 10 LoRA-style variants where each variant modifies only a
// small fraction of the base model's parameters.
//
// Run: node weavepack/profiles/tensor/examples/lora-variants.js

import { TensorPack, DTYPE } from "../../../../sdk/src/profiles/tensor/index.js"

const BASE_PARAMS = 16384  // base model "size"
const VARIANTS = 10
const VARIANT_SPARSITY = 0.05  // 5% of params modified per variant

// Base model weights (fixed pattern).
const baseWeights = new Float32Array(BASE_PARAMS)
for (let i = 0; i < BASE_PARAMS; i++) baseWeights[i] = Math.cos(i / 50) * 0.5

const baseDoc = { tensors: { weights: { dtype: DTYPE.FP32, shape: [BASE_PARAMS], data: baseWeights } } }

// Storage: anchor + N variant-deltas.
const basePack = new TensorPack({ json: baseDoc })
const baseBytes = basePack.toBuffer().length

let totalVariantBytes = 0
const variantBytes = []

for (let v = 0; v < VARIANTS; v++) {
  // Each variant changes a different ~5% of params.
  const variantWeights = new Float32Array(baseWeights)
  const changeCount = Math.floor(BASE_PARAMS * VARIANT_SPARSITY)
  const startIdx = (v * 1000) % BASE_PARAMS
  for (let i = 0; i < changeCount; i++) {
    variantWeights[(startIdx + i) % BASE_PARAMS] += (Math.random() - 0.5) * 0.1
  }

  // Each variant is its own 2-payload chain: base anchor + variant delta.
  const variantPack = new TensorPack({ json: baseDoc })
  variantPack.update({ tensors: { weights: { dtype: DTYPE.FP32, shape: [BASE_PARAMS], data: variantWeights } } })
  const fullSize = variantPack.toBuffer().length
  // The "delta cost" alone (without re-counting the base) is full - base.
  const deltaCost = fullSize - baseBytes
  variantBytes.push({ deltaOnly: deltaCost, fullChain: fullSize })
  totalVariantBytes += deltaCost
}

const safetensorsAllVariants = (VARIANTS + 1) * BASE_PARAMS * 4  // base + N full snapshots
const weavepackAllVariants = baseBytes + totalVariantBytes  // 1 base + N deltas

console.log("Multiple fine-tuned variants of a base model:")
console.log(`  Base model: ${BASE_PARAMS} fp32 parameters (${(BASE_PARAMS * 4 / 1024).toFixed(1)} KB)`)
console.log(`  Variants:   ${VARIANTS}`)
console.log(`  Per-variant sparsity: ${(VARIANT_SPARSITY * 100).toFixed(0)}%`)
console.log()
console.log("Storage:")
console.log(`  Base anchor:                       ${baseBytes} bytes`)
console.log(`  Average variant delta:             ${(totalVariantBytes / VARIANTS).toFixed(0)} bytes`)
console.log(`  Total (base + ${VARIANTS} variant deltas): ${weavepackAllVariants} bytes`)
console.log()
console.log("Comparison:")
console.log(`  safetensors (1 base + ${VARIANTS} full snapshots): ${safetensorsAllVariants} bytes`)
console.log(`  weavepack (base + deltas):                       ${weavepackAllVariants} bytes`)
console.log(`  Saving:                                          ${(safetensorsAllVariants / weavepackAllVariants).toFixed(1)}× smaller`)
