// Worked example: simulated training-checkpoint chain.
//
// Demonstrates the use case in USE-CASES.md scenario 1 (periodic
// ML training checkpoints) with a tiny model: 1 fp32 tensor of 1024
// elements, "trained" for 100 steps with small per-step changes.
//
// Run: node weavepack/profiles/tensor/examples/training-checkpoint-chain.js

import { TensorPack, DTYPE } from "../../../../sdk/src/profiles/tensor/index.js"

const N = 1024
const STEPS = 100
const CHANGES_PER_STEP = 20  // 2% sparsity per step (typical for fine-tune)

// "Initial weights" — sinusoidal pattern.
const initialWeights = new Float32Array(N)
for (let i = 0; i < N; i++) initialWeights[i] = Math.sin(i / 100)

const pack = new TensorPack({
  json: { tensors: { weights: { dtype: DTYPE.FP32, shape: [N], data: initialWeights } } }
})

// Anchor size.
const anchorBytes = pack.toBuffer().length

// Simulate STEPS training steps.
const currentWeights = new Float32Array(initialWeights)
let totalDeltaBytes = 0
const stepBytes = []

for (let step = 0; step < STEPS; step++) {
  // Modify CHANGES_PER_STEP elements per step (random small updates).
  for (let c = 0; c < CHANGES_PER_STEP; c++) {
    const idx = (step * CHANGES_PER_STEP + c) % N
    currentWeights[idx] += (Math.random() - 0.5) * 0.001
  }
  const newDoc = { tensors: { weights: { dtype: DTYPE.FP32, shape: [N], data: new Float32Array(currentWeights) } } }
  const beforeBytes = pack.toBuffer().length
  pack.update(newDoc)
  const afterBytes = pack.toBuffer().length
  stepBytes.push(afterBytes - beforeBytes)
  totalDeltaBytes += afterBytes - beforeBytes
}

const finalChainBytes = pack.toBuffer().length
const safetensorsEquivalent = (STEPS + 1) * N * 4  // STEPS deltas + 1 anchor; safetensors stores each as full snapshot

console.log("Tiny training simulation:")
console.log("  Tensor: 1 × Float32Array(1024)")
console.log(`  Steps:  ${STEPS}`)
console.log(`  Changes per step: ${CHANGES_PER_STEP} (~${(CHANGES_PER_STEP / N * 100).toFixed(1)}% sparsity)`)
console.log()
console.log("Storage:")
console.log(`  Anchor (initial encode):     ${anchorBytes} bytes`)
console.log(`  Total delta cost:            ${totalDeltaBytes} bytes`)
console.log(`  Average delta size:          ${(totalDeltaBytes / STEPS).toFixed(1)} bytes/step`)
console.log(`  Final chain (anchor+deltas): ${finalChainBytes} bytes`)
console.log()
console.log("Comparison:")
console.log(`  safetensors-style (1 full snapshot per step): ${safetensorsEquivalent} bytes`)
console.log(`  weavepack chain:                              ${finalChainBytes} bytes`)
console.log(`  Saving:                                       ${(safetensorsEquivalent / finalChainBytes).toFixed(0)}× smaller`)

const restored = new TensorPack({ arj: pack.toBuffer() })
const matches = restored.json.tensors.weights.data.every((v, i) => Math.abs(v - currentWeights[i]) < 1e-6)
console.log()
console.log(`Round-trip verification: ${matches ? "✓ chain restores to final state exactly" : "✗ FAILED"}`)
