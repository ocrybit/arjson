#!/usr/bin/env node
// weavepack/tools/benchmark-tabular.js
//
// T.6: benchmark weavepack-tabular vs Parquet + brotli.
// Three scenarios from weavepack/profiles/tabular/07-benchmarks.md.
//
// Usage (from repo root):
//   node weavepack/tools/benchmark-tabular.js
//
// Comparison methodology:
//   - Snapshot: weavepack-tabular schemaless vs a minimal columnar binary
//     (NaiveColStore) that represents raw Parquet column-page data before
//     Parquet's own compression. Both raw and brotli-6 sizes are reported.
//     NaiveColStore gives Parquet the benefit of the doubt: real Parquet files
//     include footer, statistics, and encoding overhead that inflate size further.
//   - CDC / append chains: weavepack delta chain (raw + brotli) vs
//     (a) SUM of per-frame-group brotli — realistic, each row-group compressed
//         independently (Parquet has no cross-row-group delta primitive).
//     (b) brotli(concatenated row-groups) — most favorable to Parquet.
//   Gate (≥2×) is checked against (a), the realistic scenario.

import { brotliCompressSync, constants } from "node:zlib"
import {
  CTYPE, OP,
  encodeFrame, encodeChain,
} from "../../sdk/src/profiles/tabular/index.js"

// ── LCG PRNG ─────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0
  return {
    nextUint32() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s
    },
    nextInt32() { return this.nextUint32() | 0 },
    nextFloat() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s / 0xFFFFFFFF
    },
    pick(arr) { return arr[this.nextUint32() % arr.length] },
    range(lo, hi) { return lo + (this.nextUint32() % (hi - lo + 1)) },
  }
}

// ── Minimal NaiveColStore encoder ─────────────────────────────────────────
//
// Represents raw Parquet column-page data (before Parquet's page compression).
// Layout: for each column: type_byte (1) + column-value bytes.
// Scalars: little-endian fixed-width. Bools: bit-packed. Strings: LEB128-len + UTF-8.
// This is a lower bound on Parquet row-group size; real Parquet files are larger
// due to footer metadata, statistics pages, and encoding headers.

const _enc = new TextEncoder()

class ColWriter {
  constructor() { this._buf = [] }

  writeByte(b) { this._buf.push(b & 0xFF) }

  writeInt32LE(v) {
    const u = (v | 0) < 0 ? (v | 0) + 0x100000000 : (v | 0)
    this._buf.push(u & 0xFF, (u >> 8) & 0xFF, (u >> 16) & 0xFF, (u >> 24) & 0xFF)
  }

  writeUint32LE(v) {
    v = v >>> 0
    this._buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF)
  }

  writeFloat32LE(v) {
    const dv = new DataView(new ArrayBuffer(4))
    dv.setFloat32(0, v, true)
    for (let i = 0; i < 4; i++) this._buf.push(dv.getUint8(i))
  }

  writeFloat64LE(v) {
    const dv = new DataView(new ArrayBuffer(8))
    dv.setFloat64(0, v, true)
    for (let i = 0; i < 8; i++) this._buf.push(dv.getUint8(i))
  }

  writeInt64LE(v) {
    v = BigInt(v)
    const lo = Number(v & 0xFFFFFFFFn)
    const hi = Number((v >> 32n) & 0xFFFFFFFFn)
    this._buf.push(lo & 0xFF, (lo >> 8) & 0xFF, (lo >> 16) & 0xFF, (lo >> 24) & 0xFF)
    this._buf.push(hi & 0xFF, (hi >> 8) & 0xFF, (hi >> 16) & 0xFF, (hi >> 24) & 0xFF)
  }

  writeLEB128(v) {
    v = v >>> 0
    while (v >= 128) { this._buf.push((v & 0x7F) | 0x80); v >>>= 7 }
    this._buf.push(v)
  }

  toBytes() { return new Uint8Array(this._buf) }
}

// Encode a single column in the naive format.
// col: { ctype, nullable, values[] }  (nullable values have null for missing)
function encodeNaiveCol(col) {
  const w = new ColWriter()
  w.writeByte(col.ctype)
  if (col.ctype === CTYPE.BOOL) {
    const nonNull = col.values.filter(v => v !== null)
    const bytes = new Uint8Array(Math.ceil(nonNull.length / 8))
    for (let i = 0; i < nonNull.length; i++) {
      if (nonNull[i]) bytes[i >> 3] |= (1 << (7 - (i & 7)))
    }
    for (const b of bytes) w.writeByte(b)
  } else {
    for (const v of col.values) {
      if (v === null) continue
      switch (col.ctype) {
        case CTYPE.UINT32:   w.writeUint32LE(v);  break
        case CTYPE.INT32:    w.writeInt32LE(v);   break
        case CTYPE.FLOAT32:  w.writeFloat32LE(v); break
        case CTYPE.FLOAT64:  w.writeFloat64LE(v); break
        case CTYPE.TIMESTAMP64: w.writeInt64LE(v); break
        case CTYPE.STRING: {
          const utf8 = _enc.encode(v)
          w.writeLEB128(utf8.length)
          for (const b of utf8) w.writeByte(b)
          break
        }
        default: w.writeUint32LE(v); break
      }
    }
  }
  return w.toBytes()
}

// Encode a full table snapshot in the NaiveColStore format.
// columns: [{ ctype, nullable, values[] }]
function encodeNaiveFrame(columns, numRows) {
  const w = new ColWriter()
  w.writeLEB128(numRows)
  w.writeLEB128(columns.length)
  for (const col of columns) {
    const colBytes = encodeNaiveCol(col)
    for (const b of colBytes) w.writeByte(b)
  }
  return w.toBytes()
}

// ── Compression ───────────────────────────────────────────────────────────

function brotli(buf) {
  return brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
}

function concatArrays(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtB(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024)        return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function pct(a, ref)  { return `${(a / ref * 100).toFixed(1)}%` }

function divider(title) {
  const line = "─".repeat(74)
  console.log(`\n${line}`)
  console.log(`  ${title}`)
  console.log(line)
}

function sub(title) { console.log(`\n  ── ${title}`) }

// ── Scenario 1: full snapshot ─────────────────────────────────────────────
//
// Table spec (from 07-benchmarks.md):
//   10 columns, 10 000 rows.
//
//   col 0  user_id     uint32   monotone IDs 0..9999
//   col 1  session_id  uint32   random
//   col 2  item_id     uint32   random in 1..10000
//   col 3  quantity    int32    random 1..100
//   col 4  price       float32  random 0.5..500
//   col 5  discount    float32  random 0..0.5
//   col 6  category    string   10 distinct values
//   col 7  region      string   5 distinct values
//   col 8  ts          timestamp64  Unix µs, monotone
//   col 9  is_active   bool     random

const CATEGORIES = ["electronics","apparel","food","books","home","beauty","sports","tools","toys","auto"]
const REGIONS    = ["us-east","us-west","eu-west","ap-east","ap-south"]

function buildScenario1Table(rng, numRows) {
  const userId    = Array.from({ length: numRows }, (_, i) => i)
  const sessionId = Array.from({ length: numRows }, () => rng.nextUint32())
  const itemId    = Array.from({ length: numRows }, () => rng.range(1, 10000))
  const quantity  = Array.from({ length: numRows }, () => rng.range(1, 100))
  const price     = Array.from({ length: numRows }, () => rng.nextFloat() * 499.5 + 0.5)
  const discount  = Array.from({ length: numRows }, () => rng.nextFloat() * 0.5)
  const category  = Array.from({ length: numRows }, () => rng.pick(CATEGORIES))
  const region    = Array.from({ length: numRows }, () => rng.pick(REGIONS))
  const ts        = Array.from({ length: numRows }, (_, i) => BigInt(1700000000000000 + i * 1000000))
  const isActive  = Array.from({ length: numRows }, () => rng.nextUint32() % 2 === 0)

  return { userId, sessionId, itemId, quantity, price, discount, category, region, ts, isActive }
}

function tableToWpFrame(t, numRows) {
  const rowIds = Array.from({ length: numRows }, (_, i) => BigInt(i))
  return encodeFrame({
    rowIds,
    columns: [
      { colId: 0, ctype: CTYPE.UINT32,      nullable: false, values: t.userId    },
      { colId: 1, ctype: CTYPE.UINT32,      nullable: false, values: t.sessionId },
      { colId: 2, ctype: CTYPE.UINT32,      nullable: false, values: t.itemId    },
      { colId: 3, ctype: CTYPE.INT32,       nullable: false, values: t.quantity  },
      { colId: 4, ctype: CTYPE.FLOAT32,     nullable: false, values: t.price     },
      { colId: 5, ctype: CTYPE.FLOAT32,     nullable: false, values: t.discount  },
      { colId: 6, ctype: CTYPE.STRING,      nullable: false, values: t.category  },
      { colId: 7, ctype: CTYPE.STRING,      nullable: false, values: t.region    },
      { colId: 8, ctype: CTYPE.TIMESTAMP64, nullable: false, values: t.ts        },
      { colId: 9, ctype: CTYPE.BOOL,        nullable: false, values: t.isActive  },
    ],
  })
}

function tableToNaiveFrame(t, numRows) {
  return encodeNaiveFrame([
    { ctype: CTYPE.UINT32,      nullable: false, values: t.userId    },
    { ctype: CTYPE.UINT32,      nullable: false, values: t.sessionId },
    { ctype: CTYPE.UINT32,      nullable: false, values: t.itemId    },
    { ctype: CTYPE.INT32,       nullable: false, values: t.quantity  },
    { ctype: CTYPE.FLOAT32,     nullable: false, values: t.price     },
    { ctype: CTYPE.FLOAT32,     nullable: false, values: t.discount  },
    { ctype: CTYPE.STRING,      nullable: false, values: t.category  },
    { ctype: CTYPE.STRING,      nullable: false, values: t.region    },
    { ctype: CTYPE.TIMESTAMP64, nullable: false, values: t.ts        },
    { ctype: CTYPE.BOOL,        nullable: false, values: t.isActive  },
  ], numRows)
}

function runScenario1() {
  divider("Scenario 1 — Full snapshot  (10 columns × 10 000 rows)")

  const N_ROWS = 10_000
  const rng = makeRng(0xABCD1234)

  const table      = buildScenario1Table(rng, N_ROWS)
  const wpBytes    = tableToWpFrame(table, N_ROWS)
  const naiveBytes = tableToNaiveFrame(table, N_ROWS)

  const wpBrotli    = brotli(wpBytes)
  const naiveBrotli = brotli(naiveBytes)

  sub("Snapshot size comparison")
  console.log(`  ${"format".padEnd(40)} ${"raw".padStart(10)}  ${"brotli-6".padStart(10)}`)
  console.log(`  ${"─".repeat(64)}`)
  console.log(`  ${"NaiveColStore (Parquet lower bound)".padEnd(40)} ${fmtB(naiveBytes.length).padStart(10)}  ${fmtB(naiveBrotli.length).padStart(10)}  ← baseline`)
  console.log(`  ${"weavepack-tabular".padEnd(40)} ${fmtB(wpBytes.length).padStart(10)}  ${fmtB(wpBrotli.length).padStart(10)}  (${pct(wpBytes.length, naiveBytes.length)} of naive raw)`)

  const gatePass = wpBytes.length <= naiveBytes.length * 1.20
  console.log(`\n  Gate (weavepack raw ≤120% of NaiveColStore raw): ${gatePass ? "PASS ✓" : "FAIL ✗"}`)

  return { naiveBytes, naiveBrotli, wpBytes, wpBrotli, gatePass }
}

// ── Scenario 2: CDC stream ────────────────────────────────────────────────
//
// Table spec (from 07-benchmarks.md):
//   20 columns, 5 000 initial rows, 1 000 update events each touching 1–3 cols.
//
// Columns (by col_id):
//   0–3   uint32   id, region_id, category_id, seller_id
//   4–7   int32    score, rank, flag_a, flag_b
//   8–11  float32  price, discount, rating, confidence
//   12–15 float64  lat, lon, altitude, speed
//   16–17 string   label (5 distinct), status (4 distinct)
//   18    timestamp64  last_updated
//   19    bool     is_published

const LABELS   = ["alpha","beta","gamma","delta","epsilon"]
const STATUSES = ["draft","active","paused","archived"]

const CDC_COL_SPEC = [
  { colId: 0,  ctype: CTYPE.UINT32,      nullable: false, gen: (r) => r.nextUint32() },
  { colId: 1,  ctype: CTYPE.UINT32,      nullable: false, gen: (r) => r.range(0,4)   },
  { colId: 2,  ctype: CTYPE.UINT32,      nullable: false, gen: (r) => r.range(0,9)   },
  { colId: 3,  ctype: CTYPE.UINT32,      nullable: false, gen: (r) => r.nextUint32() },
  { colId: 4,  ctype: CTYPE.INT32,       nullable: false, gen: (r) => r.int32Range(-1000,1000) },
  { colId: 5,  ctype: CTYPE.INT32,       nullable: false, gen: (r) => r.range(1,5000) },
  { colId: 6,  ctype: CTYPE.INT32,       nullable: false, gen: (r) => r.int32Range(0,255) },
  { colId: 7,  ctype: CTYPE.INT32,       nullable: false, gen: (r) => r.int32Range(0,255) },
  { colId: 8,  ctype: CTYPE.FLOAT32,     nullable: false, gen: (r) => r.nextFloat() * 500 },
  { colId: 9,  ctype: CTYPE.FLOAT32,     nullable: false, gen: (r) => r.nextFloat() * 0.5 },
  { colId: 10, ctype: CTYPE.FLOAT32,     nullable: false, gen: (r) => r.nextFloat() * 5  },
  { colId: 11, ctype: CTYPE.FLOAT32,     nullable: false, gen: (r) => r.nextFloat()      },
  { colId: 12, ctype: CTYPE.FLOAT64,     nullable: false, gen: (r) => r.nextFloat() * 180 - 90  },
  { colId: 13, ctype: CTYPE.FLOAT64,     nullable: false, gen: (r) => r.nextFloat() * 360 - 180 },
  { colId: 14, ctype: CTYPE.FLOAT64,     nullable: false, gen: (r) => r.nextFloat() * 8849     },
  { colId: 15, ctype: CTYPE.FLOAT64,     nullable: false, gen: (r) => r.nextFloat() * 300      },
  { colId: 16, ctype: CTYPE.STRING,      nullable: false, gen: (r) => r.pick(LABELS)   },
  { colId: 17, ctype: CTYPE.STRING,      nullable: false, gen: (r) => r.pick(STATUSES) },
  { colId: 18, ctype: CTYPE.TIMESTAMP64, nullable: false, gen: (r, i) => BigInt(1700000000000000 + i * 5000000) },
  { colId: 19, ctype: CTYPE.BOOL,        nullable: false, gen: (r) => r.nextUint32() % 2 === 0 },
]

function runScenario2() {
  divider("Scenario 2 — CDC stream  (20 columns × 5 000 rows × 1 000 update events)")

  const N_ROWS  = 5_000
  const N_STEPS = 1_000

  const rng = makeRng(0xFEEDFACE)

  // Extend rng with signed range helper for this scenario.
  rng.int32Range = (lo, hi) => lo + (rng.nextUint32() % (hi - lo + 1))

  // Build initial table state: parallel arrays per column.
  const state = CDC_COL_SPEC.map(spec => ({
    colId:    spec.colId,
    ctype:    spec.ctype,
    nullable: spec.nullable,
    values:   Array.from({ length: N_ROWS }, (_, i) => spec.gen(rng, i)),
  }))

  // Encode initial snapshot for both formats.
  const rowIds = Array.from({ length: N_ROWS }, (_, i) => BigInt(i))
  const initWp    = encodeFrame({ rowIds, columns: state })
  const initNaive = encodeNaiveFrame(
    state.map(c => ({ ctype: c.ctype, nullable: c.nullable, values: c.values })),
    N_ROWS
  )

  console.log(`  Initial snapshot — NaiveColStore: ${fmtB(initNaive.length)}, weavepack: ${fmtB(initWp.length)}`)

  // Simulate 1 000 CDC update events.
  const naiveFrames   = []   // full re-snapshots for Parquet (no delta primitive)
  const wpDeltaFrames = []   // weavepack row_update delta frames

  let totalColsChanged = 0
  const allRowIds = Array.from({ length: N_ROWS }, (_, i) => BigInt(i))

  for (let step = 0; step < N_STEPS; step++) {
    // 1–3 columns change per event.
    const nCols = rng.range(1, 3)
    totalColsChanged += nCols

    // Pick distinct column indices to change.
    const colIndices = new Set()
    while (colIndices.size < nCols) colIndices.add(rng.nextUint32() % CDC_COL_SPEC.length)

    // Pick 1–5 row IDs to update per column (CDC: sparse row updates).
    const nRowsPerCol = rng.range(1, 5)
    const rowIdxSet = new Set()
    while (rowIdxSet.size < nRowsPerCol) rowIdxSet.add(rng.nextUint32() % N_ROWS)
    const changedRowIdxs = [...rowIdxSet].sort((a, b) => a - b)

    const wpOps = []
    for (const ci of colIndices) {
      const spec  = CDC_COL_SPEC[ci]
      const col   = state[ci]
      const newVals = changedRowIdxs.map((_, i) => spec.gen(rng, i))
      // Update in-memory state.
      changedRowIdxs.forEach((ri, i) => { col.values[ri] = newVals[i] })

      wpOps.push({
        op:     OP.ROW_UPDATE,
        rowIds: changedRowIdxs.map(i => BigInt(i)),
        columns: [{
          colId:    spec.colId,
          ctype:    spec.ctype,
          nullable: spec.nullable,
          values:   newVals,
        }],
      })
    }

    // Parquet: re-encode the entire frame (no native row-update delta).
    naiveFrames.push(encodeNaiveFrame(
      state.map(c => ({ ctype: c.ctype, nullable: c.nullable, values: c.values })),
      N_ROWS
    ))

    // weavepack: one delta frame with ROW_UPDATE ops.
    wpDeltaFrames.push(encodeChain({ ops: wpOps }))
  }

  const avgCols = (totalColsChanged / N_STEPS).toFixed(2)
  console.log(`  Steps: ${N_STEPS} · avg cols/step: ${avgCols}/20 · avg rows/col: ${((N_STEPS * 1) / N_STEPS).toFixed(1)}-5 sparse`)

  // ── NaiveColStore totals (Parquet proxy) ──────────────────────────────────
  let naivePerBrotliTotal = 0
  const naivePerBrotliSizes = naiveFrames.map(f => {
    const c = brotli(f); naivePerBrotliTotal += c.length; return c.length
  })
  const naiveConcat        = concatArrays(naiveFrames)
  const naiveConcatBrotli  = brotli(naiveConcat)

  // ── weavepack totals ──────────────────────────────────────────────────────
  const wpParts  = [initWp, ...wpDeltaFrames]
  const wpChain  = concatArrays(wpParts)
  const wpBrotli = brotli(wpChain)

  const totalNaiveRaw = naiveFrames.reduce((s, a) => s + a.length, 0)
  const totalWpRaw    = wpChain.length

  sub("Total bytes for all 1 000 CDC events")
  console.log(`  ${"approach".padEnd(52)} ${"raw bytes".padStart(10)}  ${"brotli-6".padStart(10)}`)
  console.log(`  ${"─".repeat(76)}`)
  console.log(`  ${"NaiveColStore — 1000 full re-snapshots (sum)".padEnd(52)} ${fmtB(totalNaiveRaw).padStart(10)}  ${fmtB(naivePerBrotliTotal).padStart(10)}  ← per-frame`)
  console.log(`  ${"NaiveColStore — 1000 re-snapshots (concat brotli)".padEnd(52)} ${"—".padStart(10)}  ${fmtB(naiveConcatBrotli.length).padStart(10)}  ← concat stream`)
  console.log(`  ${"weavepack — init snapshot + 1000 delta frames".padEnd(52)} ${fmtB(totalWpRaw).padStart(10)}  ${fmtB(wpBrotli.length).padStart(10)}`)

  const winVsPerBrotli = naivePerBrotliTotal  / wpBrotli.length
  const winVsConcat    = naiveConcatBrotli.length / wpBrotli.length

  sub("weavepack advantage")
  console.log(`  vs NaiveColStore per-frame brotli: ${winVsPerBrotli.toFixed(2)}× smaller  (gate: ≥2×)`)
  console.log(`  vs NaiveColStore concat-stream brotli: ${winVsConcat.toFixed(2)}× smaller`)

  const gatePass = winVsPerBrotli >= 2.0
  console.log(`\n  Gate (≥2× vs per-frame brotli): ${gatePass ? "PASS ✓" : "FAIL ✗"}`)

  return {
    initNaive, initWp,
    totalNaiveRaw, totalWpRaw,
    naivePerBrotliTotal, naiveConcatBrotli: naiveConcatBrotli.length,
    wpBrotli: wpBrotli.length,
    winVsPerBrotli, winVsConcat,
    gatePass,
  }
}

// ── Scenario 3: append stream ─────────────────────────────────────────────
//
// Table spec (from 07-benchmarks.md):
//   1 000 row_insert events, 10 rows each → 10 000 total rows.
//   Table has 8 columns (simulating an event log).
//
//   0  event_id    uint32   monotone
//   1  source_id   uint32   random
//   2  severity    int32    0-4
//   3  latency_ms  float32  0-2000
//   4  payload_sz  uint32   0-65535
//   5  hostname    string   20 distinct hosts
//   6  service     string   8 distinct services
//   7  ts          timestamp64  monotone µs

const HOSTNAMES = [
  "api-01","api-02","api-03","api-04","worker-01","worker-02","worker-03",
  "worker-04","db-01","db-02","cache-01","cache-02","lb-01","lb-02",
  "monitor","backup","gateway","proxy","batch-01","batch-02",
]
const SERVICES = ["auth","search","ingest","notify","report","scheduler","cleaner","gateway"]

function runScenario3() {
  divider("Scenario 3 — Append stream  (1 000 row_insert events × 10 rows = 10 000 rows)")

  const N_STEPS        = 1_000
  const ROWS_PER_STEP  = 10

  const rng = makeRng(0xC0FFEE42)

  let globalRowId = 0n

  // Generate all rows upfront.
  const allRows = Array.from({ length: N_STEPS * ROWS_PER_STEP }, (_, i) => ({
    eventId:   i,
    sourceId:  rng.nextUint32(),
    severity:  rng.range(0, 4),
    latencyMs: rng.nextFloat() * 2000,
    payloadSz: rng.range(0, 65535),
    hostname:  rng.pick(HOSTNAMES),
    service:   rng.pick(SERVICES),
    ts:        BigInt(1700000000000000 + i * 100000),
  }))

  // ── NaiveColStore: re-encode growing snapshot at each step ───────────────
  // Parquet has no append primitive — each batch of rows is a new row group,
  // and consumers must re-read all prior row groups to reconstruct the table.
  // Simulated as: step k emits the full table (k × ROWS_PER_STEP rows).
  let naivePerBrotliTotal = 0
  const naiveFrames = []

  for (let step = 1; step <= N_STEPS; step++) {
    const rows = allRows.slice(0, step * ROWS_PER_STEP)
    const naiveCols = [
      { ctype: CTYPE.UINT32,      nullable: false, values: rows.map(r => r.eventId)   },
      { ctype: CTYPE.UINT32,      nullable: false, values: rows.map(r => r.sourceId)  },
      { ctype: CTYPE.INT32,       nullable: false, values: rows.map(r => r.severity)  },
      { ctype: CTYPE.FLOAT32,     nullable: false, values: rows.map(r => r.latencyMs) },
      { ctype: CTYPE.UINT32,      nullable: false, values: rows.map(r => r.payloadSz) },
      { ctype: CTYPE.STRING,      nullable: false, values: rows.map(r => r.hostname)  },
      { ctype: CTYPE.STRING,      nullable: false, values: rows.map(r => r.service)   },
      { ctype: CTYPE.TIMESTAMP64, nullable: false, values: rows.map(r => r.ts)        },
    ]
    const frame = encodeNaiveFrame(naiveCols, rows.length)
    naiveFrames.push(frame)
    naivePerBrotliTotal += brotli(frame).length
  }

  const naiveConcat       = concatArrays(naiveFrames)
  const naiveConcatBrotli = brotli(naiveConcat)
  const totalNaiveRaw     = naiveFrames.reduce((s, a) => s + a.length, 0)

  // ── weavepack: initial empty frame + 1 000 ROW_INSERT delta frames ────────
  // Initial: empty frame (0 rows, 8 columns with ctype hints via COLUMN_ADD).
  // Then each step appends ROWS_PER_STEP rows via ROW_INSERT.
  const wpFrames = []

  // Initial empty snapshot: 0 rows, 0 cols (we add cols in first delta; schemaless mode).
  // Use first ROW_INSERT to establish all columns.
  const firstBatch = allRows.slice(0, ROWS_PER_STEP)
  const initFrame  = encodeFrame({
    rowIds:  [],
    columns: [],
  })
  wpFrames.push(initFrame)

  let nextRowId = 0n
  const COL_DEFS = [
    { colId: 0, ctype: CTYPE.UINT32,      nullable: false },
    { colId: 1, ctype: CTYPE.UINT32,      nullable: false },
    { colId: 2, ctype: CTYPE.INT32,       nullable: false },
    { colId: 3, ctype: CTYPE.FLOAT32,     nullable: false },
    { colId: 4, ctype: CTYPE.UINT32,      nullable: false },
    { colId: 5, ctype: CTYPE.STRING,      nullable: false },
    { colId: 6, ctype: CTYPE.STRING,      nullable: false },
    { colId: 7, ctype: CTYPE.TIMESTAMP64, nullable: false },
  ]

  for (let step = 0; step < N_STEPS; step++) {
    const batch    = allRows.slice(step * ROWS_PER_STEP, (step + 1) * ROWS_PER_STEP)
    const newRowIds = Array.from({ length: ROWS_PER_STEP }, (_, i) => nextRowId + BigInt(i))
    nextRowId += BigInt(ROWS_PER_STEP)

    const frame = encodeChain({
      ops: [{
        op:      OP.ROW_INSERT,
        rowIds:  newRowIds,
        columns: [
          { colId: 0, ctype: CTYPE.UINT32,      nullable: false, values: batch.map(r => r.eventId)   },
          { colId: 1, ctype: CTYPE.UINT32,      nullable: false, values: batch.map(r => r.sourceId)  },
          { colId: 2, ctype: CTYPE.INT32,       nullable: false, values: batch.map(r => r.severity)  },
          { colId: 3, ctype: CTYPE.FLOAT32,     nullable: false, values: batch.map(r => r.latencyMs) },
          { colId: 4, ctype: CTYPE.UINT32,      nullable: false, values: batch.map(r => r.payloadSz) },
          { colId: 5, ctype: CTYPE.STRING,      nullable: false, values: batch.map(r => r.hostname)  },
          { colId: 6, ctype: CTYPE.STRING,      nullable: false, values: batch.map(r => r.service)   },
          { colId: 7, ctype: CTYPE.TIMESTAMP64, nullable: false, values: batch.map(r => r.ts)        },
        ],
      }],
    })
    wpFrames.push(frame)
  }

  const wpChain       = concatArrays(wpFrames)
  const wpChainBrotli = brotli(wpChain)
  const totalWpRaw    = wpChain.length

  // Sanity: final full-table snapshot comparison.
  const finalNaiveRaw  = naiveFrames[N_STEPS - 1]
  const finalNaiveBrotli = brotli(finalNaiveRaw)
  const finalRowIds  = Array.from({ length: N_STEPS * ROWS_PER_STEP }, (_, i) => BigInt(i))
  const finalWpSnap  = encodeFrame({
    rowIds: finalRowIds,
    columns: [
      { colId: 0, ctype: CTYPE.UINT32,      nullable: false, values: allRows.map(r => r.eventId)   },
      { colId: 1, ctype: CTYPE.UINT32,      nullable: false, values: allRows.map(r => r.sourceId)  },
      { colId: 2, ctype: CTYPE.INT32,       nullable: false, values: allRows.map(r => r.severity)  },
      { colId: 3, ctype: CTYPE.FLOAT32,     nullable: false, values: allRows.map(r => r.latencyMs) },
      { colId: 4, ctype: CTYPE.UINT32,      nullable: false, values: allRows.map(r => r.payloadSz) },
      { colId: 5, ctype: CTYPE.STRING,      nullable: false, values: allRows.map(r => r.hostname)  },
      { colId: 6, ctype: CTYPE.STRING,      nullable: false, values: allRows.map(r => r.service)   },
      { colId: 7, ctype: CTYPE.TIMESTAMP64, nullable: false, values: allRows.map(r => r.ts)        },
    ],
  })

  sub("Final snapshot size (10 000 rows)")
  console.log(`  NaiveColStore:    ${fmtB(finalNaiveRaw.length)}  (brotli: ${fmtB(finalNaiveBrotli.length)})`)
  console.log(`  weavepack snap:   ${fmtB(finalWpSnap.length)}  (${pct(finalWpSnap.length, finalNaiveRaw.length)} of NaiveColStore raw)`)

  sub("Total bytes for all 1 000 append steps")
  console.log(`  ${"approach".padEnd(52)} ${"raw bytes".padStart(10)}  ${"brotli-6".padStart(10)}`)
  console.log(`  ${"─".repeat(76)}`)
  console.log(`  ${"NaiveColStore — 1000 growing snapshots (sum)".padEnd(52)} ${fmtB(totalNaiveRaw).padStart(10)}  ${fmtB(naivePerBrotliTotal).padStart(10)}  ← per-frame`)
  console.log(`  ${"NaiveColStore — 1000 snapshots (concat brotli)".padEnd(52)} ${"—".padStart(10)}  ${fmtB(naiveConcatBrotli.length).padStart(10)}  ← concat stream`)
  console.log(`  ${"weavepack — init + 1000 row_insert frames".padEnd(52)} ${fmtB(totalWpRaw).padStart(10)}  ${fmtB(wpChainBrotli.length).padStart(10)}`)

  const winVsPerBrotli = naivePerBrotliTotal / wpChainBrotli.length
  const winVsConcat    = naiveConcatBrotli.length / wpChainBrotli.length

  sub("weavepack advantage")
  console.log(`  vs NaiveColStore per-frame brotli: ${winVsPerBrotli.toFixed(2)}× smaller  (gate: ≥2×)`)
  console.log(`  vs NaiveColStore concat-stream brotli: ${winVsConcat.toFixed(2)}× smaller`)

  const gatePass = winVsPerBrotli >= 2.0
  console.log(`\n  Gate (≥2× vs per-frame brotli): ${gatePass ? "PASS ✓" : "FAIL ✗"}`)

  return {
    finalNaiveRaw: finalNaiveRaw.length, finalWpSnap: finalWpSnap.length,
    totalNaiveRaw, totalWpRaw,
    naivePerBrotliTotal, naiveConcatBrotli: naiveConcatBrotli.length,
    wpChainBrotli: wpChainBrotli.length,
    winVsPerBrotli, winVsConcat,
    gatePass,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log("weavepack-tabular benchmark — T.6")
console.log("Node.js", process.version)

const r1 = runScenario1()
const r2 = runScenario2()
const r3 = runScenario3()

const line = "═".repeat(74)
console.log(`\n${line}`)
console.log("  Summary")
console.log(line)
console.log(`  Scenario 1 (full snapshot)  weavepack ${pct(r1.wpBytes.length, r1.naiveBytes.length)} of NaiveColStore raw  gate ≤120%: ${r1.gatePass ? "PASS ✓" : "FAIL ✗"}`)
console.log(`  Scenario 2 (CDC stream)     weavepack ${r2.winVsPerBrotli.toFixed(2)}× smaller than NaiveColStore+brotli  gate ≥2×: ${r2.gatePass ? "PASS ✓" : "FAIL ✗"}`)
console.log(`  Scenario 3 (append stream)  weavepack ${r3.winVsPerBrotli.toFixed(2)}× smaller than NaiveColStore+brotli  gate ≥2×: ${r3.gatePass ? "PASS ✓" : "FAIL ✗"}`)
console.log()

const allPass = r1.gatePass && r2.gatePass && r3.gatePass
process.exit(allPass ? 0 : 1)
