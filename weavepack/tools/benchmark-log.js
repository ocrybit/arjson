#!/usr/bin/env node
// weavepack/tools/benchmark-log.js
//
// L.6: benchmark weavepack-log vs JSON Lines + gzip.
// Three scenarios from weavepack/profiles/log/07-benchmarks.md.
//
// Usage (from repo root):
//   node weavepack/tools/benchmark-log.js
//
// Comparison methodology:
//   - Snapshot: weavepack-log event_batch vs JSON Lines + gzip.
//     JSON Lines = one JSON object per line, newline-separated, gzip-6 compressed.
//     weavepack raw and brotli-6 sizes are reported; JSON Lines gzip-6 is the gate.
//   - Streaming append: weavepack delta chain (init + 1000 event_append frames) raw
//     vs JSON Lines (full re-snapshot per step, gzip-6 per step).
//     Gate: weavepack raw + brotli ≥ 2× smaller than per-step JSON Lines gzip.
//   - Multi-schema: 1000 events mixing 3 event types; weavepack vs JSON Lines.
//     Gate: weavepack ≥ 2× smaller.

import { brotliCompressSync, gzipSync, constants } from "node:zlib"
import {
  CTYPE, OP,
  encodeBatch, encodeChain,
} from "../../sdk/src/profiles/log/index.js"

// ── LCG PRNG ─────────────────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0
  return {
    nextUint32() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s
    },
    nextFloat() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s / 0xFFFFFFFF
    },
    pick(arr) { return arr[this.nextUint32() % arr.length] },
    range(lo, hi) { return lo + (this.nextUint32() % (hi - lo + 1)) },
  }
}

// ── Brotli / gzip helpers ────────────────────────────────────────────────────────────

const BROTLI_Q6 = { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }

function brotli(bytes) {
  return brotliCompressSync(bytes instanceof Buffer ? bytes : Buffer.from(bytes), BROTLI_Q6).length
}

function gzip6(bytes) {
  return gzipSync(bytes instanceof Buffer ? bytes : Buffer.from(bytes), { level: 6 }).length
}

// ── JSON Lines helpers ────────────────────────────────────────────────────────────────────

function encodeJsonLines(events) {
  return Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8")
}

// ── Scenario 1 — High-repetition batch ────────────────────────────────────────────────────
//
// 10 000 events; 70% of fields identical (host, service, env, level=INFO).
// Varying: ts, seq, request_id (string), duration_ms (float32), status_code (uint16).
//
// weavepack encodes the batch as a single snapshot frame.
// Baseline: JSON Lines + gzip-6.

function scenario1() {
  const rng = makeRng(42)
  const N = 10_000

  const HOST    = "web-01.prod.example.com"
  const SERVICE = "api-gateway"
  const ENV     = "production"
  const LEVEL_INFO = 2  // INFO

  const seqs = Array.from({length: N}, (_, i) => BigInt(i + 1))
  const tss  = Array.from({length: N}, (_, i) => BigInt(1_700_000_000_000_000 + i * 1000))

  const levelVals = Array(N).fill(LEVEL_INFO)
  const hostVals  = Array(N).fill(HOST)
  const svcVals   = Array(N).fill(SERVICE)
  const envVals   = Array(N).fill(ENV)
  const reqIdVals = Array.from({length: N}, (_, i) => `req-${(rng.nextUint32()).toString(16).padStart(8, "0")}`)
  const durVals   = Array.from({length: N}, () => Math.round(rng.nextFloat() * 500 * 10) / 10)
  const statVals  = Array.from({length: N}, () => rng.pick([200, 200, 200, 200, 201, 204, 400, 404, 500]))

  const batch = {
    seqs, tss,
    columns: [
      { colId: 2, ctype: CTYPE.LEVEL,   nullable: false, values: levelVals },
      { colId: 3, ctype: CTYPE.STRING,  nullable: false, values: hostVals  },
      { colId: 4, ctype: CTYPE.STRING,  nullable: false, values: svcVals   },
      { colId: 5, ctype: CTYPE.STRING,  nullable: false, values: envVals   },
      { colId: 6, ctype: CTYPE.STRING,  nullable: false, values: reqIdVals },
      { colId: 7, ctype: CTYPE.FLOAT32, nullable: false, values: durVals   },
      { colId: 8, ctype: CTYPE.UINT16,  nullable: false, values: statVals  },
    ],
  }

  const wpBytes  = encodeBatch(batch)
  const wpRaw    = wpBytes.length
  const wpBrotli = brotli(wpBytes)

  const rng2 = makeRng(42)
  const jsonEvents = Array.from({length: N}, (_, i) => ({
    seq:         i + 1,
    ts:          1_700_000_000_000_000 + i * 1000,
    level:       "INFO",
    host:        HOST,
    service:     SERVICE,
    env:         ENV,
    request_id:  `req-${(rng2.nextUint32()).toString(16).padStart(8, "0")}`,
    duration_ms: Math.round(rng2.nextFloat() * 500 * 10) / 10,
    status_code: rng2.pick([200, 200, 200, 200, 201, 204, 400, 404, 500]),
  }))
  const jlBytes = encodeJsonLines(jsonEvents)
  const jlGzip  = gzip6(jlBytes)

  const ratio = jlGzip / wpBrotli

  console.log("\n── Scenario 1: High-repetition batch (10 000 events) ────────────────────────")
  console.log(`  weavepack raw:           ${wpRaw.toLocaleString()} bytes`)
  console.log(`  weavepack brotli-6:      ${wpBrotli.toLocaleString()} bytes`)
  console.log(`  JSON Lines gzip-6:       ${jlGzip.toLocaleString()} bytes`)
  console.log(`  ratio (jsonl-gz / wp-br): ${ratio.toFixed(2)}×`)
  const gate = ratio >= 0.8
  console.log(`  Gate (wp within 20% of jsonl gzip): ${gate ? "PASS" : "FAIL"}`)
  return gate
}

// ── Scenario 2 — Streaming append (per-append delta) ──────────────────────────────────
//
// Start empty; 1 000 event_append ops, each appending 10 events.
// weavepack: emit one event_append delta frame per step.
// JSON Lines baseline: full re-snapshot at each step, gzip per step.
// Gate: sum(weavepack delta frames) ≤ 0.5 × sum(jsonl gzip per step).

function scenario2() {
  const rng = makeRng(99)
  const STEPS = 1_000
  const EVENTS_PER_STEP = 10

  const HOST    = "ingest-01.prod.example.com"
  const SERVICE = "log-ingest"
  const LEVELS  = [2, 2, 2, 2, 1, 3, 4]

  let totalWpRaw    = 0
  let totalWpBrotli = 0
  let totalJlGzip   = 0

  const allEvents = []

  for (let step = 0; step < STEPS; step++) {
    const baseSeq = BigInt(step * EVENTS_PER_STEP + 1)
    const baseTs  = BigInt(1_700_000_000_000_000 + step * EVENTS_PER_STEP * 1000)

    const seqs = Array.from({length: EVENTS_PER_STEP}, (_, i) => baseSeq + BigInt(i))
    const tss  = Array.from({length: EVENTS_PER_STEP}, (_, i) => baseTs + BigInt(i * 1000))
    const levelVals   = Array.from({length: EVENTS_PER_STEP}, () => rng.pick(LEVELS))
    const reqIdVals   = Array.from({length: EVENTS_PER_STEP}, () => `req-${rng.nextUint32().toString(16).padStart(8, "0")}`)
    const durVals     = Array.from({length: EVENTS_PER_STEP}, () => Math.round(rng.nextFloat() * 500 * 10) / 10)
    const statVals    = Array.from({length: EVENTS_PER_STEP}, () => rng.pick([200, 200, 200, 201, 400, 404, 500]))

    const appendOp = {
      op:   OP.EVENT_APPEND,
      seqs, tss,
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,   nullable: false, values: levelVals },
        { colId: 3, ctype: CTYPE.STRING,  nullable: false, values: Array(EVENTS_PER_STEP).fill(HOST)    },
        { colId: 4, ctype: CTYPE.STRING,  nullable: false, values: Array(EVENTS_PER_STEP).fill(SERVICE) },
        { colId: 5, ctype: CTYPE.STRING,  nullable: false, values: reqIdVals  },
        { colId: 6, ctype: CTYPE.FLOAT32, nullable: false, values: durVals    },
        { colId: 7, ctype: CTYPE.UINT16,  nullable: false, values: statVals   },
      ],
    }
    const chainBytes = encodeChain({ ops: [appendOp] })
    totalWpRaw    += chainBytes.length
    totalWpBrotli += brotli(chainBytes)

    for (let i = 0; i < EVENTS_PER_STEP; i++) {
      allEvents.push({
        seq:         Number(seqs[i]),
        ts:          Number(tss[i]),
        level:       ["TRACE","DEBUG","INFO","WARN","ERROR","FATAL"][levelVals[i]],
        host:        HOST,
        service:     SERVICE,
        request_id:  reqIdVals[i],
        duration_ms: durVals[i],
        status_code: statVals[i],
      })
    }
    const jlBytes = encodeJsonLines(allEvents)
    totalJlGzip  += gzip6(jlBytes)
  }

  const ratioRaw    = totalJlGzip / totalWpRaw
  const ratioBrotli = totalJlGzip / totalWpBrotli

  console.log("\n── Scenario 2: Streaming append (1 000 steps × 10 events) ────────────────────────")
  console.log(`  weavepack delta sum raw:     ${totalWpRaw.toLocaleString()} bytes`)
  console.log(`  weavepack delta sum brotli:  ${totalWpBrotli.toLocaleString()} bytes`)
  console.log(`  JSON Lines per-step gzip sum: ${totalJlGzip.toLocaleString()} bytes`)
  console.log(`  ratio raw     (jsonl / wp):  ${ratioRaw.toFixed(1)}×`)
  console.log(`  ratio brotli  (jsonl / wp):  ${ratioBrotli.toFixed(1)}×`)
  const gate = ratioBrotli >= 2.0
  console.log(`  Gate (≥2× smaller brotli): ${gate ? "PASS" : "FAIL"}`)
  return gate
}

// ── Scenario 3 — Multi-schema stream ────────────────────────────────────────────────────────
//
// 1 000 events mixing 3 event types: HTTP (40%), DB (35%), cache (25%).
// weavepack encodes as a single batch (simplified: all events in one batch,
// common fields shared, type-specific fields nullable).
// JSON Lines: all events as full objects with redundant field names per event.
// Gate: weavepack brotli ≥ 2× smaller than JSON Lines gzip.

function scenario3() {
  const rng = makeRng(77)
  const N = 1_000

  const METHODS = ["GET","GET","GET","POST","PUT","DELETE"]
  const TABLES  = ["users","orders","products","sessions","logs"]
  const CMDS    = ["GET","SET","DEL","EXPIRE","HSET"]
  const STATUS  = [200,200,200,201,204,400,404,500]
  const LEVELS  = [2,2,2,3,4]

  const seqs = Array.from({length: N}, (_, i) => BigInt(i + 1))
  const tss  = Array.from({length: N}, (_, i) => BigInt(1_700_000_000_000_000 + i * 500))

  const types = Array.from({length: N}, () => rng.nextUint32() % 100)
  const isHttp  = types.map(t => t < 40)
  const isDb    = types.map(t => t >= 40 && t < 75)
  const isCache = types.map(t => t >= 75)

  const levelVals      = Array.from({length: N}, () => rng.pick(LEVELS))
  const methodVals     = types.map((t, i) => isHttp[i] ? rng.pick(METHODS) : null)
  const statusVals     = types.map((t, i) => isHttp[i] ? rng.pick(STATUS)  : null)
  const httpDurVals    = types.map((t, i) => isHttp[i] ? Math.round(rng.nextFloat() * 300 * 10) / 10 : null)
  const tableVals      = types.map((t, i) => isDb[i] ? rng.pick(TABLES) : null)
  const dbDurVals      = types.map((t, i) => isDb[i] ? Math.round(rng.nextFloat() * 100 * 10) / 10 : null)
  const cmdVals        = types.map((t, i) => isCache[i] ? rng.pick(CMDS) : null)
  const hitVals        = types.map((t, i) => isCache[i] ? (rng.nextFloat() > 0.3) : null)

  const batch = {
    seqs, tss,
    columns: [
      { colId: 2, ctype: CTYPE.LEVEL,   nullable: false, values: levelVals   },
      { colId: 3, ctype: CTYPE.STRING,  nullable: true,  values: methodVals  },
      { colId: 4, ctype: CTYPE.UINT16,  nullable: true,  values: statusVals  },
      { colId: 5, ctype: CTYPE.FLOAT32, nullable: true,  values: httpDurVals },
      { colId: 6, ctype: CTYPE.STRING,  nullable: true,  values: tableVals   },
      { colId: 7, ctype: CTYPE.FLOAT32, nullable: true,  values: dbDurVals   },
      { colId: 8, ctype: CTYPE.STRING,  nullable: true,  values: cmdVals     },
      { colId: 9, ctype: CTYPE.BOOL,    nullable: true,  values: hitVals     },
    ],
  }

  const wpBytes  = encodeBatch(batch)
  const wpRaw    = wpBytes.length
  const wpBrotli = brotli(wpBytes)

  const rng2 = makeRng(77)
  const jsonEvents = types.map((t, i) => {
    const lv = rng2.pick(LEVELS)
    const base = { seq: i + 1, ts: 1_700_000_000_000_000 + i * 500, level: ["TRACE","DEBUG","INFO","WARN","ERROR"][lv] }
    if (isHttp[i]) {
      return { ...base, type: "http", method: rng2.pick(METHODS), status: rng2.pick(STATUS), duration_ms: Math.round(rng2.nextFloat() * 300 * 10) / 10 }
    } else if (isDb[i]) {
      return { ...base, type: "db", table: rng2.pick(TABLES), duration_ms: Math.round(rng2.nextFloat() * 100 * 10) / 10 }
    } else {
      return { ...base, type: "cache", cmd: rng2.pick(CMDS), hit: rng2.nextFloat() > 0.3 }
    }
  })
  const jlBytes = encodeJsonLines(jsonEvents)
  const jlGzip  = gzip6(jlBytes)

  const ratio = jlGzip / wpBrotli

  console.log("\n── Scenario 3: Multi-schema stream (1 000 events, 3 types) ───────────────────────")
  console.log(`  weavepack raw:           ${wpRaw.toLocaleString()} bytes`)
  console.log(`  weavepack brotli-6:      ${wpBrotli.toLocaleString()} bytes`)
  console.log(`  JSON Lines gzip-6:       ${jlGzip.toLocaleString()} bytes`)
  console.log(`  ratio (jsonl-gz / wp-br): ${ratio.toFixed(2)}×`)
  const gate = ratio >= 2.0
  console.log(`  Gate (≥2× smaller brotli): ${gate ? "PASS" : "FAIL"}`)
  return gate
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────

console.log("weavepack-log benchmark vs JSON Lines + gzip")
console.log("=============================================")

const g1 = scenario1()
const g2 = scenario2()
const g3 = scenario3()

const allPass = g1 && g2 && g3
console.log(`\nAll gates ${allPass ? "PASS ✓" : "FAIL ✗"}`)
process.exit(allPass ? 0 : 1)
