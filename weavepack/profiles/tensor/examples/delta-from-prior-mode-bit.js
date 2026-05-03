// Worked example: hand-crafted mode=1 delta + brotli measurement.
//
// The v0.1 encoder always emits tensor_replace with mode=0 (absolute
// values). The decoder supports mode=1 (per-element arithmetic delta)
// since the V0.2 A.3 work, but encoder-side heuristics for emitting
// mode=1 are still pending. This example hand-crafts a mode=1 delta
// and measures the downstream-compression benefit when the per-element
// changes are small.
//
// Run: node weavepack/profiles/tensor/examples/delta-from-prior-mode-bit.js

import { TensorPack, DTYPE, applyDelta, encodeDocument } from "../../../../sdk/src/profiles/tensor/index.js"
import { brotliCompressSync } from "node:zlib"

const N = 1024

// Smooth base tensor (fixed across all magnitudes for fair comparison).
const baseValues = new Float32Array(N).map((_, i) => Math.sin(i / 100))

// Mode=1 delta: hand-craft. Wire format
//   [type=1] [op_count=1] [op=TENSOR_REPLACE] [name "w"] [dtype=FP32] [rank=1] [dim=N] [mode=1] [data]
// Data block contains per-element deltas (newValues - baseValues), encoded as fp32.
function craftMode1Delta(name, deltaArray) {
  const bits = []
  const wb = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1) }
  const wleb = v => { while (v >= 128) { wb(0x80 | (v & 0x7f), 8); v = Math.floor(v / 128) } wb(v & 0x7f, 8) }
  const wshort = v => {
    if (v < 4) { wb(0, 2); wb(v, 2) }
    else if (v < 12) { wb(1, 2); wb(v - 4, 3) }
    else if (v < 28) { wb(2, 2); wb(v - 12, 4) }
    else { wb(3, 2); wleb(v - 28) }
  }
  wb(1, 1)             // type bit (delta)
  wleb(1)              // op_count
  wb(0, 3)             // OP_TENSOR_REPLACE = 0
  const nameBytes = Buffer.from(name, "utf8")
  wshort(nameBytes.length)
  for (const b of nameBytes) wb(b, 8)
  wb(DTYPE.FP32, 5)
  wshort(1)            // rank
  wleb(deltaArray.length) // dim
  wb(1, 1)             // mode = 1
  // Pack fp32 little-endian deltas as bytes.
  const buf = new Uint8Array(deltaArray.length * 4)
  new Float32Array(buf.buffer).set(deltaArray)
  for (const b of buf) wb(b, 8)
  while (bits.length % 8 !== 0) bits.push(0)
  const out = new Uint8Array(bits.length / 8)
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    out[i / 8] = byte
  }
  return out
}

function measure(magnitude) {
  let seed = 42
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 0x100000000; return seed / 0x100000000 }
  const newValues = new Float32Array(baseValues)
  for (let i = 0; i < N; i++) newValues[i] += (rand() - 0.5) * 2 * magnitude

  const baseDoc = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: baseValues } } }
  const newDoc  = { tensors: { w: { dtype: DTYPE.FP32, shape: [N], data: newValues } } }
  const pack = new TensorPack({ json: baseDoc })
  pack.update(newDoc)
  const baseBuf = encodeDocument(baseDoc)
  const fullBuf = pack.toBuffer()
  const mode0Delta = fullBuf.subarray(baseBuf.length + 1)  // skip base + leb128(len)
  const mode0Brotli = brotliCompressSync(mode0Delta).length

  const deltaArray = new Float32Array(N)
  for (let i = 0; i < N; i++) deltaArray[i] = newValues[i] - baseValues[i]
  const mode1Delta = craftMode1Delta("w", deltaArray)
  const mode1Brotli = brotliCompressSync(mode1Delta).length

  // Round-trip check: applying the mode=1 delta to the base must equal newDoc.
  const restored = applyDelta(baseDoc, mode1Delta)
  const restoredOk = Array.from(restored.tensors.w.data).every((v, i) => Math.abs(v - newValues[i]) < 1e-6)

  return { mode0: mode0Delta.length, mode0Brotli, mode1: mode1Delta.length, mode1Brotli, restoredOk }
}

const fmt = n => n.toString().padStart(5)

console.log("Delta-from-prior mode bit: brotli stacking across update magnitudes")
console.log(`  N = ${N} fp32 elements; every element changes by ±magnitude`)
console.log()
console.log("magnitude    mode=0 raw   +brotli  | mode=1 raw   +brotli  | brotli win  RT")
console.log("─────────────────────────────────────────────────────────────────────────────")

const magnitudes = [0.0001, 0.001, 0.01, 0.1, 1.0]
for (const m of magnitudes) {
  const r = measure(m)
  const win = (r.mode0Brotli / r.mode1Brotli)
  const rt = r.restoredOk ? "✓" : "✗"
  console.log(
    `±${m.toString().padEnd(6)}    ${fmt(r.mode0)}        ${fmt(r.mode0Brotli)}    | ${fmt(r.mode1)}        ${fmt(r.mode1Brotli)}    | ${win.toFixed(2)}×       ${rt}`
  )
}

console.log()
console.log("The raw byte counts are similar (both encode N fp32 values).")
console.log("The win shows up under brotli: mode=1 deltas are small numbers")
console.log("with many leading zero/sign bytes, which brotli dedups aggressively.")
console.log("As update magnitude grows, the deltas approach the absolute values")
console.log("and the brotli win shrinks.")
