// Worked example: time-series sensor grid.
//
// Demonstrates USE-CASES.md scenario 6 (time-series tensor data).
// Simulates a 32×32 fp32 temperature grid where most cells barely
// change between timesteps; only cells near a moving "heat source"
// see material updates.
//
// Run: node weavepack/profiles/tensor/examples/sensor-grid-stream.js

import { TensorPack, DTYPE } from "../../../../sdk/src/profiles/tensor/index.js"

const ROWS = 32
const COLS = 32
const TIMESTEPS = 60   // 60 readings (1/min for an hour)
const HEAT_RADIUS = 3  // cells within this many of the heat source change

// Initial grid: cool ambient temperature with small noise.
const grid = new Float32Array(ROWS * COLS)
for (let i = 0; i < grid.length; i++) grid[i] = 20 + Math.random() * 0.1

const pack = new TensorPack({
  json: { tensors: { temp: { dtype: DTYPE.FP32, shape: [ROWS, COLS], data: grid } } }
})
const anchorBytes = pack.toBuffer().length

// Simulate the heat source moving in a circle around the grid center.
let totalDeltaBytes = 0
for (let t = 0; t < TIMESTEPS; t++) {
  const cy = ROWS / 2 + Math.cos(t / 10) * 8
  const cx = COLS / 2 + Math.sin(t / 10) * 8
  const newGrid = new Float32Array(grid)
  // Update cells within HEAT_RADIUS of (cy, cx).
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const dy = r - cy, dx = c - cx
      const dist = Math.sqrt(dy*dy + dx*dx)
      if (dist <= HEAT_RADIUS) {
        // Heat falls off with distance; max temp ~50, ambient ~20.
        const heat = 30 * (1 - dist / HEAT_RADIUS)
        newGrid[r * COLS + c] = 20 + heat + Math.random() * 0.1
      }
    }
  }
  const beforeBytes = pack.toBuffer().length
  pack.update({ tensors: { temp: { dtype: DTYPE.FP32, shape: [ROWS, COLS], data: newGrid } } })
  totalDeltaBytes += pack.toBuffer().length - beforeBytes
  // Update the running grid for next iteration.
  grid.set(newGrid)
}

const finalChainBytes = pack.toBuffer().length
const safetensorsEquivalent = (TIMESTEPS + 1) * ROWS * COLS * 4

const changedCellsPerStep = Math.PI * HEAT_RADIUS * HEAT_RADIUS  // approx
console.log("Time-series sensor grid:")
console.log(`  Grid:      ${ROWS}×${COLS} fp32 = ${ROWS * COLS} cells`)
console.log(`  Timesteps: ${TIMESTEPS}`)
console.log(`  ~${changedCellsPerStep.toFixed(0)} cells change per step (${(changedCellsPerStep / (ROWS*COLS) * 100).toFixed(1)}%)`)
console.log()
console.log("Storage:")
console.log(`  Anchor (initial encode):    ${anchorBytes} bytes`)
console.log(`  Total delta cost:           ${totalDeltaBytes} bytes`)
console.log(`  Average delta size:         ${(totalDeltaBytes / TIMESTEPS).toFixed(0)} bytes/step`)
console.log(`  Final chain:                ${finalChainBytes} bytes`)
console.log()
console.log("Comparison:")
console.log(`  safetensors-style (1 snapshot per step): ${safetensorsEquivalent} bytes`)
console.log(`  weavepack chain:                         ${finalChainBytes} bytes`)
console.log(`  Saving:                                  ${(safetensorsEquivalent / finalChainBytes).toFixed(0)}× smaller`)
