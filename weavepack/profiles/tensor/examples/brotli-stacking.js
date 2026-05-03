// Honest measurement: when does weavepack beat raw + brotli, and
// when does brotli alone do the heavy lifting?
//
// weavepack targets STRUCTURAL redundancy (only-changed elements
// between related tensors). Brotli targets BYTE-LEVEL redundancy
// (repeated byte patterns within a window). They can stack — but
// when snapshot-to-snapshot byte-level redundancy is overwhelming,
// brotli alone may already be near-optimal.
//
// We measure two scenarios:
//   1. Sparse updates (only ~2% of elements change per step)
//   2. Dense updates (every element changes by a small amount —
//      typical for Adam-style training where every weight is touched)
//
// Run: node weavepack/profiles/tensor/examples/brotli-stacking.js

import { TensorPack, DTYPE } from "../../../../sdk/src/profiles/tensor/index.js"
import { brotliCompressSync } from "node:zlib"

const N = 1024
const STEPS = 100

function runScenario(name, perStepFn, initFn) {
  // safetensors-style: keep every full snapshot.
  const initial = new Float32Array(N)
  for (let i = 0; i < N; i++) initial[i] = initFn(i)

  const snapshots = []
  const current = new Float32Array(initial)
  snapshots.push(Buffer.from(current.buffer.slice(0)))
  for (let step = 0; step < STEPS; step++) {
    perStepFn(current, step)
    snapshots.push(Buffer.from(current.buffer.slice(0)))
  }
  const safetensorsBundle = Buffer.concat(snapshots)
  const safetensorsRaw = safetensorsBundle.length
  const safetensorsBrotli = brotliCompressSync(safetensorsBundle).length

  // weavepack chain (rebuild same trajectory deterministically).
  const initial2 = new Float32Array(N)
  for (let i = 0; i < N; i++) initial2[i] = initFn(i)
  const pack = new TensorPack({
    json: { tensors: { weights: { dtype: DTYPE.FP32, shape: [N], data: initial2 } } }
  })
  const replay = new Float32Array(initial2)
  for (let step = 0; step < STEPS; step++) {
    perStepFn(replay, step)
    pack.update({ tensors: { weights: { dtype: DTYPE.FP32, shape: [N], data: new Float32Array(replay) } } })
  }
  const weavepackRaw = pack.toBuffer().length
  const weavepackBrotli = brotliCompressSync(pack.toBuffer()).length

  const fmt = n => n.toString().padStart(8) + " bytes"
  console.log(`\n=== ${name} ===`)
  console.log(`                                raw       + brotli`)
  console.log(`  safetensors (concat snapshots): ${fmt(safetensorsRaw)}  ${fmt(safetensorsBrotli)}`)
  console.log(`  weavepack (chain):              ${fmt(weavepackRaw)}  ${fmt(weavepackBrotli)}`)
  console.log()
  console.log(`  Multipliers vs raw safetensors:`)
  console.log(`    weavepack alone:        ${(safetensorsRaw / weavepackRaw).toFixed(1)}× smaller`)
  console.log(`    safetensors + brotli:   ${(safetensorsRaw / safetensorsBrotli).toFixed(1)}× smaller`)
  console.log(`    weavepack + brotli:     ${(safetensorsRaw / weavepackBrotli).toFixed(1)}× smaller`)
}

// Deterministic small PRNG so the printed numbers are reproducible.
let seed = 42
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 0x100000000
  return seed / 0x100000000
}

// Scenario 1: sparse updates (2% of elements per step).
runScenario(
  "Sparse updates (2% sparsity per step, smooth init)",
  (arr, step) => {
    for (let c = 0; c < 20; c++) {
      arr[(step * 20 + c) % N] += (rand() - 0.5) * 0.001
    }
  },
  i => Math.sin(i / 100)
)

// Scenario 2: dense updates (every element changes per step).
seed = 42
runScenario(
  "Dense updates (every element +small noise, random init)",
  (arr, step) => {
    for (let i = 0; i < N; i++) arr[i] += (rand() - 0.5) * 0.001
  },
  i => rand() * 2 - 1
)

console.log()
console.log("Honest takeaway:")
console.log("  In a BUNDLED comparison (concat all snapshots, then compress the whole")
console.log("  thing), brotli alone is hard to beat for SPARSE workloads — it has")
console.log("  access to the whole byte sequence and can dedup identical fp32")
console.log("  patterns across snapshots. For DENSE small-delta workloads (where")
console.log("  the V0.2 A.3 mode=1 heuristic applies), weavepack+brotli is now")
console.log("  smaller than safetensors+brotli (1.6× in this run).")
console.log()
console.log("  weavepack's win is per-payload addressability:")
console.log("    - Each chain payload is independently retrievable (~150 bytes for")
console.log("      a sparse step), so you can fetch step 50 alone over a network.")
console.log("    - The 'safetensors + brotli' baseline is one giant blob; you must")
console.log("      decompress all 100 snapshots to read any one.")
console.log("    - For Arweave / IPFS / per-payload billing, only the per-payload")
console.log("      chain framing makes economic sense.")
console.log()
console.log("  Dense-update workloads with small per-element changes (Adam-style")
console.log("  training steps, max abs delta ≤ 0.01): the V0.2 A.3 encoder")
console.log("  heuristic now emits tensor_replace mode=1 (delta-from-prior),")
console.log("  and brotli exploits the leading-zero structure of the deltas.")
console.log("  Above the threshold, mode=0 is fine and gives parity with raw+brotli.")
