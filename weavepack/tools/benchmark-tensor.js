#!/usr/bin/env node
// weavepack/tools/benchmark-tensor.js
//
// Phase 5.7: benchmark weavepack-tensor vs safetensors and raw+compression.
// Measures snapshot size, delta efficiency, and encode/decode throughput.
//
// Usage (from repo root):
//   node weavepack/tools/benchmark-tensor.js
//
// Requires Node.js v22+ (built-in zstd in node:zlib).

import { zstdCompressSync, brotliCompressSync, constants } from "node:zlib"
import {
  encodeDocument,
  encodeDocumentSchemaful,
  decodeDocument,
  decodeDocumentSchemaful,
  encodeDelta,
  applyDelta,
  DTYPE,
} from "../../sdk/src/profiles/tensor/index.js"
import { schemaHashHex } from "../../sdk/src/profiles/tensor/schema.js"

// ── LCG PRNG (deterministic, seed-based) ─────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0
  return {
    nextUint32() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s
    },
    nextFloat32() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return ((s / 0xFFFFFFFF) - 0.5) * 0.2  // [-0.1, 0.1] typical weight range
    },
  }
}

// ── Synthetic model builder ───────────────────────────────────────────────

function makeModel(rng, config) {
  const tensors = {}
  for (const [name, shape] of Object.entries(config)) {
    const n = shape.reduce((a, b) => a * b, 1)
    const data = new Float32Array(n)
    for (let i = 0; i < n; i++) data[i] = rng.nextFloat32()
    tensors[name] = { dtype: DTYPE.FP32, shape, data }
  }
  return { tensors }
}

function cloneModel(doc) {
  const tensors = {}
  for (const [name, t] of Object.entries(doc.tensors)) {
    tensors[name] = { dtype: t.dtype, shape: t.shape, data: new Float32Array(t.data) }
  }
  return { tensors }
}

// ── Safetensors format (simplified — FP32 only for benchmark) ────────────
//
// Wire: [8-byte LE uint64 header_len][JSON header][raw data concatenated]
// JSON header: { name: { dtype, shape, data_offsets: [start, end] }, ... }

const ST_DTYPE = {
  [DTYPE.FP32]:  "F32",
  [DTYPE.FP16]:  "F16",
  [DTYPE.BF16]:  "BF16",
  [DTYPE.FP64]:  "F64",
  [DTYPE.INT8]:  "I8",
  [DTYPE.UINT8]: "U8",
  [DTYPE.INT32]: "I32",
  [DTYPE.INT64]: "I64",
  [DTYPE.BOOL]:  "BOOL",
}

function encodeSafetensors(doc) {
  const names = Object.keys(doc.tensors).sort()
  let offset = 0
  const header = { __metadata__: {} }
  const parts = []

  for (const name of names) {
    const t = doc.tensors[name]
    const raw = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)
    header[name] = { dtype: ST_DTYPE[t.dtype] ?? "F32", shape: t.shape, data_offsets: [offset, offset + raw.length] }
    offset += raw.length
    parts.push(raw)
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const result = new Uint8Array(8 + headerBytes.length + offset)
  const view = new DataView(result.buffer)
  view.setUint32(0, headerBytes.length & 0xFFFFFFFF, true)
  view.setUint32(4, 0, true)
  result.set(headerBytes, 8)
  let off = 8 + headerBytes.length
  for (const p of parts) { result.set(p, off); off += p.length }
  return result
}

// ── Raw bytes (no metadata — theoretical lower bound) ────────────────────

function encodeRaw(doc) {
  const parts = []
  let total = 0
  for (const t of Object.values(doc.tensors)) {
    const raw = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)
    parts.push(raw); total += raw.length
  }
  const result = new Uint8Array(total)
  let off = 0
  for (const p of parts) { result.set(p, off); off += p.length }
  return result
}

// ── Compression ───────────────────────────────────────────────────────────

const ZSTD_LEVEL = constants.ZSTD_c_compressionLevel

function compress(buf, method) {
  if (method === "zstd")   return zstdCompressSync(buf, { params: { [ZSTD_LEVEL]: 3 } })
  if (method === "brotli") return brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
  throw new Error(`unknown method: ${method}`)
}

// ── Timing ────────────────────────────────────────────────────────────────

function median(fn, reps) {
  fn()  // warm up
  const times = []
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(reps / 2)]
}

// ── Formatting ────────────────────────────────────────────────────────────

function fmtB(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function pct(a, b) { return `${(a / b * 100).toFixed(1)}%` }

function mbps(bytes, ms) { return `${((bytes / (1024 * 1024)) / (ms / 1000)).toFixed(0)} MB/s` }

function row(name, size, rel) {
  console.log(`  ${name.padEnd(36)} ${fmtB(size).padStart(10)}  ${rel.padStart(8)}`)
}

// ── Schema helpers ────────────────────────────────────────────────────────

function schemaOf(doc) {
  const s = {}
  for (const [n, t] of Object.entries(doc.tensors)) s[n] = { dtype: t.dtype, shape: t.shape }
  return s
}

function totalDataBytes(doc) {
  let total = 0
  for (const t of Object.values(doc.tensors)) total += t.data.byteLength
  return total
}

// ── Main ──────────────────────────────────────────────────────────────────

function runBenchmark(label, config) {
  const line = "─".repeat(72)
  console.log(`\n${line}`)
  console.log(`  ${label}`)
  console.log(line)

  const rng = makeRng(0xDEADBEEF)
  const doc = makeModel(rng, config)
  const rawDataB = totalDataBytes(doc)
  const schema = schemaOf(doc)
  const registry = new Map([[schemaHashHex(schema), schema]])
  const tensorCount = Object.keys(doc.tensors).length

  console.log(`  ${tensorCount} tensors · ${fmtB(rawDataB)} raw fp32 data`)

  // ── Encode all formats ──────────────────────────────────────────────────
  const wpBytes   = encodeDocument(doc)
  const wpSfBytes = encodeDocumentSchemaful(doc, schema)
  const stBytes   = encodeSafetensors(doc)
  const rawBytes  = encodeRaw(doc)

  // ── Snapshot: no compression ────────────────────────────────────────────
  console.log(`\n  Snapshot — uncompressed`)
  console.log(`  ${"format".padEnd(36)} ${"size".padStart(10)}  ${"vs raw-bytes".padStart(8)}`)
  console.log(`  ${"─".repeat(58)}`)
  row("raw bytes (no metadata)",     rawBytes.length,  "baseline")
  row("safetensors",                 stBytes.length,   pct(stBytes.length,   rawBytes.length))
  row("weavepack schemaless",        wpBytes.length,   pct(wpBytes.length,   rawBytes.length))
  row("weavepack schemaful",         wpSfBytes.length, pct(wpSfBytes.length, rawBytes.length))

  // ── Snapshot: zstd-3 ───────────────────────────────────────────────────
  const rawZ  = compress(rawBytes,  "zstd")
  const stZ   = compress(stBytes,   "zstd")
  const wpZ   = compress(wpBytes,   "zstd")
  const wpSfZ = compress(wpSfBytes, "zstd")

  console.log(`\n  Snapshot — zstd level 3`)
  console.log(`  ${"format".padEnd(36)} ${"size".padStart(10)}  ${"vs raw+zstd".padStart(8)}`)
  console.log(`  ${"─".repeat(58)}`)
  row("raw + zstd",                  rawZ.length,  "baseline")
  row("safetensors + zstd",          stZ.length,   pct(stZ.length,   rawZ.length))
  row("weavepack schemaless + zstd", wpZ.length,   pct(wpZ.length,   rawZ.length))
  row("weavepack schemaful + zstd",  wpSfZ.length, pct(wpSfZ.length, rawZ.length))

  // ── Snapshot: brotli-6 ─────────────────────────────────────────────────
  const rawBr  = compress(rawBytes,  "brotli")
  const stBr   = compress(stBytes,   "brotli")
  const wpBr   = compress(wpBytes,   "brotli")
  const wpSfBr = compress(wpSfBytes, "brotli")

  console.log(`\n  Snapshot — brotli quality 6`)
  console.log(`  ${"format".padEnd(36)} ${"size".padStart(10)}  ${"vs raw+brotli".padStart(8)}`)
  console.log(`  ${"─".repeat(58)}`)
  row("raw + brotli",                  rawBr.length,  "baseline")
  row("safetensors + brotli",          stBr.length,   pct(stBr.length,   rawBr.length))
  row("weavepack schemaless + brotli", wpBr.length,   pct(wpBr.length,   rawBr.length))
  row("weavepack schemaful + brotli",  wpSfBr.length, pct(wpSfBr.length, rawBr.length))

  // ── Delta: sparse update (1% of elements in 3 tensors) ─────────────────
  const sparseDoc = cloneModel(doc)
  const sparseTensors = Object.keys(config).slice(2, 5)  // 3 tensors mid-model
  const rng2 = makeRng(0xCAFEBABE)
  for (const name of sparseTensors) {
    const t = sparseDoc.tensors[name]
    const n = t.data.length
    const nChange = Math.max(1, Math.ceil(n * 0.01))
    for (let i = 0; i < nChange; i++) {
      const idx = rng2.nextUint32() % n
      t.data[idx] += rng2.nextFloat32() * 0.001
    }
  }

  const sparseWpDelta = encodeDelta(doc, sparseDoc)
  const sparseWpDeltaZ = sparseWpDelta ? compress(sparseWpDelta, "zstd") : null

  console.log(`\n  Delta — sparse update (1% of elements in ${sparseTensors.length} of ${tensorCount} tensors)`)
  console.log(`  ${"approach".padEnd(36)} ${"delta size".padStart(10)}  ${"vs safetensors snapshot".padStart(8)}`)
  console.log(`  ${"─".repeat(68)}`)
  row("safetensors (full re-encode)", stBytes.length, "baseline")
  row("raw re-send",                  rawBytes.length, pct(rawBytes.length, stBytes.length))
  if (sparseWpDelta) {
    row("weavepack delta",           sparseWpDelta.length,  pct(sparseWpDelta.length,  stBytes.length))
    row("weavepack delta + zstd",    sparseWpDeltaZ.length, pct(sparseWpDeltaZ.length, stBytes.length))
  } else {
    console.log("  weavepack delta: no change detected")
  }

  // ── Delta: full gradient step (all weights shift by tiny amounts) ───────
  const fullDoc = cloneModel(doc)
  const rng3 = makeRng(0xBEEFCAFE)
  for (const t of Object.values(fullDoc.tensors)) {
    for (let i = 0; i < t.data.length; i++) t.data[i] += rng3.nextFloat32() * 0.0001
  }

  const fullWpDelta = encodeDelta(doc, fullDoc)
  const fullWpDeltaZ = fullWpDelta ? compress(fullWpDelta, "zstd") : null

  console.log(`\n  Delta — full gradient step (all ${tensorCount} tensors, all weights shifted ±0.01%)`)
  console.log(`  ${"approach".padEnd(36)} ${"delta size".padStart(10)}  ${"vs safetensors snapshot".padStart(8)}`)
  console.log(`  ${"─".repeat(68)}`)
  row("safetensors (full re-encode)", stBytes.length, "baseline")
  if (fullWpDelta) {
    row("weavepack delta",           fullWpDelta.length,  pct(fullWpDelta.length,  stBytes.length))
    row("weavepack delta + zstd",    fullWpDeltaZ.length, pct(fullWpDeltaZ.length, stBytes.length))
  } else {
    console.log("  weavepack delta: no change detected")
  }

  // ── Delta: single-layer swap (replace 1 tensor out of N) ───────────────
  const layerDoc = cloneModel(doc)
  const layerName = Object.keys(config)[0]  // replace the first tensor
  {
    const t = layerDoc.tensors[layerName]
    const rng4 = makeRng(0xF00DCAFE)
    for (let i = 0; i < t.data.length; i++) t.data[i] = rng4.nextFloat32()
  }

  const layerWpDelta = encodeDelta(doc, layerDoc)
  const layerTensorBytes = doc.tensors[layerName].data.byteLength

  console.log(`\n  Delta — single tensor replaced ("${layerName}", ${fmtB(layerTensorBytes)})`)
  console.log(`  ${"approach".padEnd(36)} ${"delta size".padStart(10)}  ${"vs safetensors snapshot".padStart(8)}`)
  console.log(`  ${"─".repeat(68)}`)
  row("safetensors (full re-encode)", stBytes.length, "baseline")
  if (layerWpDelta) {
    const layerWpDeltaZ = compress(layerWpDelta, "zstd")
    row("weavepack delta",           layerWpDelta.length,  pct(layerWpDelta.length,  stBytes.length))
    row("weavepack delta + zstd",    layerWpDeltaZ.length, pct(layerWpDeltaZ.length, stBytes.length))
  } else {
    console.log("  weavepack delta: no change detected")
  }

  // ── Throughput ────────────────────────────────────────────────────────
  const reps = rawDataB > 4 * 1024 * 1024 ? 3 : 5
  const wpEncMs   = median(() => encodeDocument(doc), reps)
  const wpSfEncMs = median(() => encodeDocumentSchemaful(doc, schema), reps)
  const stEncMs   = median(() => encodeSafetensors(doc), reps)
  const rawEncMs  = median(() => encodeRaw(doc), reps)
  const wpDecMs   = median(() => decodeDocument(wpBytes), reps)
  const wpSfDecMs = median(() => decodeDocumentSchemaful(wpSfBytes, registry), reps)

  console.log(`\n  Throughput — encode (median of ${reps} runs)`)
  console.log(`  ${"operation".padEnd(36)} ${"MB/s".padStart(10)}`)
  console.log(`  ${"─".repeat(48)}`)
  console.log(`  ${"raw bytes copy (baseline)".padEnd(36)} ${mbps(rawDataB, rawEncMs).padStart(10)}`)
  console.log(`  ${"safetensors encode".padEnd(36)} ${mbps(rawDataB, stEncMs).padStart(10)}`)
  console.log(`  ${"weavepack schemaless encode".padEnd(36)} ${mbps(rawDataB, wpEncMs).padStart(10)}`)
  console.log(`  ${"weavepack schemaful encode".padEnd(36)} ${mbps(rawDataB, wpSfEncMs).padStart(10)}`)

  console.log(`\n  Throughput — decode`)
  console.log(`  ${"operation".padEnd(36)} ${"MB/s".padStart(10)}`)
  console.log(`  ${"─".repeat(48)}`)
  console.log(`  ${"weavepack schemaless decode".padEnd(36)} ${mbps(rawDataB, wpDecMs).padStart(10)}`)
  console.log(`  ${"weavepack schemaful decode".padEnd(36)} ${mbps(rawDataB, wpSfDecMs).padStart(10)}`)

  console.log()
  return {
    rawDataB,
    wpBytes, wpSfBytes, stBytes, rawBytes,
    rawZ, stZ, wpZ, wpSfZ,
    rawBr, stBr, wpBr, wpSfBr,
    sparseWpDelta, sparseWpDeltaZ,
    fullWpDelta, fullWpDeltaZ,
    wpEncMs, wpSfEncMs, stEncMs, rawEncMs, wpDecMs, wpSfDecMs,
  }
}

// ── Model configurations ──────────────────────────────────────────────────

// Nano: ~2 MB fp32 (fast, sanity-check)
const NANO_CONFIG = {
  "embed.weight":     [2048, 64],
  "pos.weight":       [256,  64],
  "l0.attn.wq":       [64,   64],
  "l0.attn.wk":       [64,   64],
  "l0.attn.wv":       [64,   64],
  "l0.attn.wo":       [64,   64],
  "l0.mlp.fc1":       [64,  256],
  "l0.mlp.fc2":       [256,  64],
  "l0.norm.weight":   [64],
  "l0.norm.bias":     [64],
  "l1.attn.wq":       [64,   64],
  "l1.attn.wk":       [64,   64],
  "l1.attn.wv":       [64,   64],
  "l1.attn.wo":       [64,   64],
  "l1.mlp.fc1":       [64,  256],
  "l1.mlp.fc2":       [256,  64],
  "l1.norm.weight":   [64],
  "l1.norm.bias":     [64],
  "head.weight":      [64, 2048],
  "norm.weight":      [64],
  "norm.bias":        [64],
}

// Small: ~16 MB fp32 (representative of a real micro-model)
const SMALL_CONFIG = {
  "embed.weight":     [4096, 128],
  "pos.weight":       [512,  128],
  "l0.attn.wq":       [128,  128],
  "l0.attn.wk":       [128,  128],
  "l0.attn.wv":       [128,  128],
  "l0.attn.wo":       [128,  128],
  "l0.mlp.fc1":       [128,  512],
  "l0.mlp.fc2":       [512,  128],
  "l0.norm.weight":   [128],
  "l0.norm.bias":     [128],
  "l1.attn.wq":       [128,  128],
  "l1.attn.wk":       [128,  128],
  "l1.attn.wv":       [128,  128],
  "l1.attn.wo":       [128,  128],
  "l1.mlp.fc1":       [128,  512],
  "l1.mlp.fc2":       [512,  128],
  "l1.norm.weight":   [128],
  "l1.norm.bias":     [128],
  "l2.attn.wq":       [128,  128],
  "l2.attn.wk":       [128,  128],
  "l2.attn.wv":       [128,  128],
  "l2.attn.wo":       [128,  128],
  "l2.mlp.fc1":       [128,  512],
  "l2.mlp.fc2":       [512,  128],
  "l2.norm.weight":   [128],
  "l2.norm.bias":     [128],
  "l3.attn.wq":       [128,  128],
  "l3.attn.wk":       [128,  128],
  "l3.attn.wv":       [128,  128],
  "l3.attn.wo":       [128,  128],
  "l3.mlp.fc1":       [128,  512],
  "l3.mlp.fc2":       [512,  128],
  "l3.norm.weight":   [128],
  "l3.norm.bias":     [128],
  "head.weight":      [128, 4096],
  "norm.weight":      [128],
  "norm.bias":        [128],
}

// ── Run ───────────────────────────────────────────────────────────────────

console.log("weavepack-tensor benchmark — Phase 5.7")
console.log("Node.js", process.version)

const nanoResults = runBenchmark("Nano model  (~2 MB fp32, 21 tensors)", NANO_CONFIG)
const smallResults = runBenchmark("Small model (~16 MB fp32, 39 tensors)", SMALL_CONFIG)

console.log("Done.")
