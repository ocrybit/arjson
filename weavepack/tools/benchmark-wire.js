#!/usr/bin/env node
// weavepack/tools/benchmark-wire.js
//
// W.6: benchmark weavepack-wire vs protobuf v3 + brotli.
// Three scenarios from weavepack/profiles/wire/07-benchmarks.md.
//
// Usage (from repo root):
//   node weavepack/tools/benchmark-wire.js
//
// Comparison methodology:
//   - Snapshot: weavepack-wire schemaless vs protobuf v3 binary, both raw and brotli-6.
//   - Delta chains: weavepack delta chain (raw + brotli) vs
//     (a) SUM of per-snapshot brotli — realistic for independent API responses, and
//     (b) brotli(concatenated snapshots) — most favorable to protobuf (cross-frame compression).
//   Gate (≥2×) is checked against (a), the realistic scenario.

import { brotliCompressSync, constants } from "node:zlib"
import {
  VTYPE, OP,
  encodeDocument, encodeChain,
} from "../../sdk/src/profiles/wire/index.js"

// ── LCG PRNG (deterministic) ──────────────────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0
  return {
    nextUint32() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s
    },
    nextInt() { return (this.nextUint32() | 0) },
    nextFloat() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0
      return s / 0xFFFFFFFF
    },
    nextSint32Range(lo, hi) {
      return lo + (this.nextUint32() % (hi - lo + 1))
    },
    pick(arr) { return arr[this.nextUint32() % arr.length] },
  }
}

// ── Minimal protobuf v3 binary encoder ───────────────────────────────────
//
// Only the wire types needed for the benchmark scenarios.
//   WT_VARINT (0): bool, uint32, sint32 (zigzag), enum
//   WT_64BIT  (1): float64
//   WT_LEN    (2): string, bytes, message, packed repeated
//   WT_32BIT  (5): float32

const WT_VARINT = 0
const WT_64BIT  = 1
const WT_LEN    = 2
const WT_32BIT  = 5

const _enc = new TextEncoder()

class ProtoWriter {
  constructor() { this._buf = [] }

  _push(b) { this._buf.push(b & 0xFF) }

  writeVarint(v) {
    v = Math.floor(v) >>> 0
    while (v > 127) { this._push((v & 0x7F) | 0x80); v = v >>> 7 }
    this._push(v)
  }

  writeSint32(v) {
    const z = ((v << 1) ^ (v >> 31)) >>> 0
    this.writeVarint(z)
  }

  writeFloat32(v) {
    const b = new Uint8Array(new ArrayBuffer(4))
    new DataView(b.buffer).setFloat32(0, v, true)
    for (const byte of b) this._push(byte)
  }

  writeFloat64(v) {
    const b = new Uint8Array(new ArrayBuffer(8))
    new DataView(b.buffer).setFloat64(0, v, true)
    for (const byte of b) this._push(byte)
  }

  writeBytes(src) { for (const b of src) this._push(b) }

  tag(fieldNum, wireType) { this.writeVarint((fieldNum << 3) | wireType) }

  toBytes() { return new Uint8Array(this._buf) }
}

// Encode a protobuf message from a flat field-spec array.
// Each element: [fieldNum, type, value]
// types: 'uint32' 'bool' 'sint32' 'float32' 'float64' 'string'
//        'message' (value = nested field-spec array)
//        'packed_uint32' (value = number[])
//        'repeated_string' (value = string[])
function encodeProto(fields) {
  const w = new ProtoWriter()
  for (const [fieldNum, type, value] of fields) {
    switch (type) {
      case 'uint32':
        w.tag(fieldNum, WT_VARINT); w.writeVarint(value >>> 0); break
      case 'bool':
        w.tag(fieldNum, WT_VARINT); w.writeVarint(value ? 1 : 0); break
      case 'sint32':
        w.tag(fieldNum, WT_VARINT); w.writeSint32(value | 0); break
      case 'float32':
        w.tag(fieldNum, WT_32BIT); w.writeFloat32(value); break
      case 'float64':
        w.tag(fieldNum, WT_64BIT); w.writeFloat64(value); break
      case 'string': {
        const utf8 = _enc.encode(value)
        w.tag(fieldNum, WT_LEN); w.writeVarint(utf8.length); w.writeBytes(utf8); break
      }
      case 'message': {
        const sub = encodeProto(value)
        w.tag(fieldNum, WT_LEN); w.writeVarint(sub.length); w.writeBytes(sub); break
      }
      case 'packed_uint32': {
        const tmp = new ProtoWriter()
        for (const v of value) tmp.writeVarint(v >>> 0)
        const packed = tmp.toBytes()
        w.tag(fieldNum, WT_LEN); w.writeVarint(packed.length); w.writeBytes(packed); break
      }
      case 'repeated_string': {
        const utf8Strs = value.map(s => _enc.encode(s))
        for (const utf8 of utf8Strs) {
          w.tag(fieldNum, WT_LEN); w.writeVarint(utf8.length); w.writeBytes(utf8)
        }
        break
      }
      default:
        throw new Error(`unknown proto type: ${type}`)
    }
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

function ratio(a, b) { return (b / a).toFixed(2) + "×" }
function pct(a, ref)  { return `${(a / ref * 100).toFixed(1)}%` }

function row(label, size, relLabel, relVal) {
  console.log(`  ${label.padEnd(42)} ${fmtB(size).padStart(10)}  ${relLabel.padStart(14)}: ${relVal}`)
}

function divider(title) {
  const line = "─".repeat(74)
  console.log(`\n${line}`)
  console.log(`  ${title}`)
  console.log(line)
}

function sub(title) { console.log(`\n  ── ${title}`) }

// ── Scenario 1: full snapshot ─────────────────────────────────────────────
//
// Message spec (from 07-benchmarks.md):
//   10 fields at root, 5 nested messages, 1 repeated field of 100 uint32s.
//
//   root:
//     1 uint32   game_id
//     2 uint32   player_id
//     3 sint32   score
//     4 float32  health
//     5 bool     is_active
//     6 message  position   {1:float32 x, 2:float32 y, 3:float32 z}
//     7 message  velocity   {1:float32 vx, 2:float32 vy, 3:float32 vz}
//     8 message  stats      {1:sint32 kills, 2:sint32 deaths, 3:sint32 assists}
//     9 message  inventory  {1:uint32 gold, 2:uint32 slot_count, 3:uint32 capacity}
//    10 message  session    {1:uint32 server_id, 2:uint32 latency_ms, 3:uint32 flags}
//    11 repeated uint32     item_ids (100 elements)

function buildScenario1(rng) {
  const x  = rng.nextFloat() * 200 - 100
  const y  = rng.nextFloat() * 200 - 100
  const z  = rng.nextFloat() * 50
  const vx = (rng.nextFloat() - 0.5) * 20
  const vy = (rng.nextFloat() - 0.5) * 20
  const vz = (rng.nextFloat() - 0.5) * 5
  const kills    = rng.nextUint32() % 50
  const deaths   = rng.nextUint32() % 20
  const assists  = rng.nextUint32() % 60
  const gold     = rng.nextUint32() % 5000
  const slotCount = rng.nextUint32() % 20 + 1
  const capacity = 20
  const serverId = rng.nextUint32() % 8 + 1
  const latency  = rng.nextUint32() % 150 + 10
  const items    = Array.from({ length: 100 }, () => rng.nextUint32() % 500 + 1)

  const protoFields = [
    [1,  'uint32',  1001],
    [2,  'uint32',  42],
    [3,  'sint32',  1500],
    [4,  'float32', 0.85],
    [5,  'bool',    true],
    [6,  'message', [[1,'float32',x],[2,'float32',y],[3,'float32',z]]],
    [7,  'message', [[1,'float32',vx],[2,'float32',vy],[3,'float32',vz]]],
    [8,  'message', [[1,'sint32',kills],[2,'sint32',deaths],[3,'sint32',assists]]],
    [9,  'message', [[1,'uint32',gold],[2,'uint32',slotCount],[3,'uint32',capacity]]],
    [10, 'message', [[1,'uint32',serverId],[2,'uint32',latency],[3,'uint32',0]]],
    [11, 'packed_uint32', items],
  ]

  const wpFields = [
    { num: 1,  vtype: VTYPE.UINT32, value: 1001 },
    { num: 2,  vtype: VTYPE.UINT32, value: 42 },
    { num: 3,  vtype: VTYPE.SINT32, value: 1500 },
    { num: 4,  vtype: VTYPE.FLOAT32, value: 0.85 },
    { num: 5,  vtype: VTYPE.BOOL, value: true },
    { num: 6,  message: [
      { num: 1, vtype: VTYPE.FLOAT32, value: x },
      { num: 2, vtype: VTYPE.FLOAT32, value: y },
      { num: 3, vtype: VTYPE.FLOAT32, value: z },
    ]},
    { num: 7,  message: [
      { num: 1, vtype: VTYPE.FLOAT32, value: vx },
      { num: 2, vtype: VTYPE.FLOAT32, value: vy },
      { num: 3, vtype: VTYPE.FLOAT32, value: vz },
    ]},
    { num: 8,  message: [
      { num: 1, vtype: VTYPE.SINT32, value: kills },
      { num: 2, vtype: VTYPE.SINT32, value: deaths },
      { num: 3, vtype: VTYPE.SINT32, value: assists },
    ]},
    { num: 9,  message: [
      { num: 1, vtype: VTYPE.UINT32, value: gold },
      { num: 2, vtype: VTYPE.UINT32, value: slotCount },
      { num: 3, vtype: VTYPE.UINT32, value: capacity },
    ]},
    { num: 10, message: [
      { num: 1, vtype: VTYPE.UINT32, value: serverId },
      { num: 2, vtype: VTYPE.UINT32, value: latency },
      { num: 3, vtype: VTYPE.UINT32, value: 0 },
    ]},
    { num: 11, repeated: { elemType: VTYPE.UINT32, values: items } },
  ]

  return { protoFields, wpFields }
}

function runScenario1() {
  divider("Scenario 1 — Full snapshot  (11 fields, 5 nested, 100-element repeated)")

  const rng = makeRng(0xDECAFBAD)
  const { protoFields, wpFields } = buildScenario1(rng)

  const protoBytes = encodeProto(protoFields)
  const wpBytes    = encodeDocument(wpFields)
  const protoBr    = brotli(protoBytes)
  const wpBr       = brotli(wpBytes)

  sub("Raw snapshot size")
  console.log(`  ${"format".padEnd(42)} ${"size".padStart(10)}  ${"vs protobuf".padStart(14)}`)
  console.log(`  ${"─".repeat(70)}`)
  console.log(`  ${"protobuf v3".padEnd(42)} ${fmtB(protoBytes.length).padStart(10)}  ${"baseline".padStart(14)}`)
  console.log(`  ${"weavepack-wire schemaless".padEnd(42)} ${fmtB(wpBytes.length).padStart(10)}  ${pct(wpBytes.length, protoBytes.length).padStart(14)}`)

  sub("Snapshot + brotli-6")
  console.log(`  ${"format".padEnd(42)} ${"size".padStart(10)}  ${"vs protobuf+brotli".padStart(14)}`)
  console.log(`  ${"─".repeat(70)}`)
  console.log(`  ${"protobuf v3 + brotli".padEnd(42)} ${fmtB(protoBr.length).padStart(10)}  ${"baseline".padStart(14)}`)
  console.log(`  ${"weavepack-wire + brotli".padEnd(42)} ${fmtB(wpBr.length).padStart(10)}  ${pct(wpBr.length, protoBr.length).padStart(14)}`)

  const withinGate = wpBytes.length <= protoBytes.length * 1.15
  console.log(`\n  Gate (weavepack ≤ 115% of protobuf raw): ${withinGate ? "PASS ✓" : "FAIL ✗"}`)

  return { protoBytes, wpBytes, protoBr, wpBr }
}

// ── Scenario 2: incremental API response ─────────────────────────────────
//
// Game state message with 25 fields (enough to make 1-5% = 1-2 fields per step).
// 1000 update steps; each step field_set 1 or 2 scalar fields chosen at random.
//
// fields 1-8:   uint32  (counters, IDs)
// fields 9-14:  sint32  (signed stats: score, rank changes, etc.)
// fields 15-20: float32 (positions, health, speed)
// fields 21-25: string  (player name, team, region, status, title)

const GAME_FIELD_SPEC = [
  // [num, type, gen_fn_key]
  ...[1,2,3,4,5,6,7,8].map(n  => [n,  'uint32',  'uint']),
  ...[9,10,11,12,13,14].map(n => [n,  'sint32',  'sint']),
  ...[15,16,17,18,19,20].map(n=> [n,  'float32', 'float']),
  [21, 'string', 'name'],
  [22, 'string', 'team'],
  [23, 'string', 'region'],
  [24, 'string', 'status'],
  [25, 'string', 'title'],
]

const NAMES   = ["Alice","Bob","Carol","Dave","Eve","Frank","Grace","Hank"]
const TEAMS   = ["red","blue","green","yellow","purple"]
const REGIONS = ["us-east","us-west","eu-west","eu-central","ap-south"]
const STATUSES = ["active","idle","away","dnd","spectating"]
const TITLES  = ["novice","veteran","elite","legend","champion","master"]

function genFieldValue(rng, genKey) {
  switch (genKey) {
    case 'uint':   return rng.nextUint32() % 10000
    case 'sint':   return rng.nextSint32Range(-5000, 5000)
    case 'float':  return (rng.nextFloat() - 0.5) * 200
    case 'name':   return rng.pick(NAMES)
    case 'team':   return rng.pick(TEAMS)
    case 'region': return rng.pick(REGIONS)
    case 'status': return rng.pick(STATUSES)
    case 'title':  return rng.pick(TITLES)
    default:       return 0
  }
}

function buildInitialState(rng) {
  const state = {}
  for (const [num, type, genKey] of GAME_FIELD_SPEC) {
    state[num] = { num, type, genKey, value: genFieldValue(rng, genKey) }
  }
  return state
}

function stateToProtoFields(state) {
  return GAME_FIELD_SPEC.map(([num]) => [num, state[num].type, state[num].value])
}

function stateToWpFields(state) {
  return GAME_FIELD_SPEC.map(([num, type]) => {
    const { value } = state[num]
    switch (type) {
      case 'uint32':  return { num, vtype: VTYPE.UINT32,  value }
      case 'sint32':  return { num, vtype: VTYPE.SINT32,  value }
      case 'float32': return { num, vtype: VTYPE.FLOAT32, value }
      case 'string':  return { num, vtype: VTYPE.STRING,  value }
      default:        return { num, vtype: VTYPE.UINT32,  value: 0 }
    }
  })
}

function makeWpFieldSetOp(fieldSpec, value) {
  const [num, type] = fieldSpec
  let vtype
  switch (type) {
    case 'uint32':  vtype = VTYPE.UINT32;  break
    case 'sint32':  vtype = VTYPE.SINT32;  break
    case 'float32': vtype = VTYPE.FLOAT32; break
    case 'string':  vtype = VTYPE.STRING;  break
    default:        vtype = VTYPE.UINT32
  }
  return {
    op: OP.FIELD_SET,
    path: [{ field: num }],
    value: { vtype, value },
  }
}

function runScenario2() {
  divider("Scenario 2 — Incremental API response  (25 fields, 1000 update steps, ~2 fields/step)")

  const N_STEPS = 1000
  const rng = makeRng(0xFEEDBEEF)

  // Build initial state.
  const state = buildInitialState(rng)
  const initProto = encodeProto(stateToProtoFields(state))
  const initWp    = encodeDocument(stateToWpFields(state))

  console.log(`  Initial snapshot — protobuf: ${fmtB(initProto.length)}, weavepack: ${fmtB(initWp.length)}`)

  // Simulate 1000 update steps.
  const protoSnapshots = []   // full snapshots for "protobuf update" simulation
  const wpDeltaFrames  = []   // delta chain frames

  // Track how many fields changed on average.
  let totalFieldsChanged = 0

  for (let step = 0; step < N_STEPS; step++) {
    // Change 1–2 fields per step (4–8% of 25).
    const nChange = 1 + (rng.nextUint32() % 2)
    totalFieldsChanged += nChange

    const ops = []
    // Pick distinct fields to change.
    const indices = new Set()
    while (indices.size < nChange) indices.add(rng.nextUint32() % GAME_FIELD_SPEC.length)

    for (const idx of indices) {
      const spec = GAME_FIELD_SPEC[idx]
      const newVal = genFieldValue(rng, spec[2])
      state[spec[0]].value = newVal
      ops.push(makeWpFieldSetOp(spec, newVal))
    }

    // Protobuf: full re-encode (no delta primitive in protobuf).
    protoSnapshots.push(encodeProto(stateToProtoFields(state)))

    // weavepack: delta frame.
    wpDeltaFrames.push(encodeChain(ops))
  }

  const avgChange = (totalFieldsChanged / N_STEPS).toFixed(2)
  console.log(`  Steps: ${N_STEPS} · avg fields changed per step: ${avgChange} / 25`)

  // ── Protobuf totals ──────────────────────────────────────────────────────
  // (a) Per-snapshot brotli (realistic: each API response compressed independently).
  let protoPerBrotliTotal = 0
  const protoPerBrotliSizes = protoSnapshots.map(s => { const c = brotli(s); protoPerBrotliTotal += c.length; return c.length })

  // (b) Concat brotli (best-case for protobuf — cross-frame compression).
  const protoConcat        = concatArrays(protoSnapshots)
  const protoConcatBrotli  = brotli(protoConcat)

  // ── weavepack totals ─────────────────────────────────────────────────────
  const wpChainParts  = [initWp, ...wpDeltaFrames]
  const wpChain       = concatArrays(wpChainParts)
  const wpChainBrotli = brotli(wpChain)

  const totalProtoRaw = protoSnapshots.reduce((s, a) => s + a.length, 0)
  const totalWpRaw    = wpChain.length

  sub("Total bytes for all 1000 updates")
  console.log(`  ${"approach".padEnd(48)} ${"raw bytes".padStart(10)}  ${"brotli-6".padStart(10)}`)
  console.log(`  ${"─".repeat(72)}`)
  console.log(`  ${"protobuf — 1000 full snapshots (sum)".padEnd(48)} ${fmtB(totalProtoRaw).padStart(10)}  ${fmtB(protoPerBrotliTotal).padStart(10)}  ← per-snapshot`)
  console.log(`  ${"protobuf — 1000 snapshots (concat brotli)".padEnd(48)} ${"—".padStart(10)}  ${fmtB(protoConcatBrotli.length).padStart(10)}  ← concat stream`)
  console.log(`  ${"weavepack — snapshot + 1000 delta frames".padEnd(48)} ${fmtB(totalWpRaw).padStart(10)}  ${fmtB(wpChainBrotli.length).padStart(10)}`)

  const winVsPerBrotli  = protoPerBrotliTotal  / wpChainBrotli.length
  const winVsConcat     = protoConcatBrotli.length / wpChainBrotli.length

  sub("weavepack advantage")
  console.log(`  vs protobuf per-snapshot brotli: ${winVsPerBrotli.toFixed(2)}× smaller  (gate: ≥2×)`)
  console.log(`  vs protobuf concat-stream brotli: ${winVsConcat.toFixed(2)}× smaller`)

  const gatePass = winVsPerBrotli >= 2.0
  console.log(`\n  Gate (≥2× vs per-snapshot brotli): ${gatePass ? "PASS ✓" : "FAIL ✗"}`)

  return {
    initProto, initWp,
    totalProtoRaw, totalWpRaw,
    protoPerBrotliTotal, protoConcatBrotli: protoConcatBrotli.length,
    wpChainBrotli: wpChainBrotli.length,
    winVsPerBrotli, winVsConcat,
    gatePass,
  }
}

// ── Scenario 3: streaming token stream ───────────────────────────────────
//
// A repeated field of string tokens (field 1), appended 10 tokens at a time.
// 100 append steps → final state has 1000 tokens.
//
// Tokens are drawn from a small vocabulary (realistic LLM-style text output).

const TOKEN_VOCAB = [
  "the", "a", "an", "is", "are", "was", "were", "has", "have", "had",
  "he", "she", "it", "they", "we", "I", "you", "this", "that", "these",
  "and", "or", "but", "not", "with", "for", "from", "at", "by", "on",
  "to", "of", "in", "as", "up", "out", "if", "do", "go", "be",
  "world", "hello", "foo", "bar", "baz", "data", "model", "result", "value", "key",
  "time", "event", "stream", "chunk", "token", "state", "delta", "chain", "pack", "wire",
]

function runScenario3() {
  divider("Scenario 3 — Streaming token stream  (10 tokens/step × 100 steps = 1000 tokens)")

  const N_STEPS        = 100
  const TOKENS_PER_STEP = 10

  const rng = makeRng(0xC0FFEE42)

  // Generate the full token sequence upfront (deterministic).
  const allTokens = Array.from({ length: N_STEPS * TOKENS_PER_STEP }, () => rng.pick(TOKEN_VOCAB))

  // ── Protobuf: re-encode full snapshot at each step ──────────────────────
  // The repeated field (field 1, string, non-packed since strings can't be packed)
  // grows by TOKENS_PER_STEP each step.
  let protoPerBrotliTotal = 0
  const protoSnapshots = []
  for (let step = 1; step <= N_STEPS; step++) {
    const tokens = allTokens.slice(0, step * TOKENS_PER_STEP)
    const proto  = encodeProto([[1, 'repeated_string', tokens]])
    protoSnapshots.push(proto)
    protoPerBrotliTotal += brotli(proto).length
  }

  const protoConcat       = concatArrays(protoSnapshots)
  const protoConcatBrotli = brotli(protoConcat)
  const totalProtoRaw     = protoSnapshots.reduce((s, a) => s + a.length, 0)

  // ── weavepack: initial empty snapshot + 100 REPEATED_APPEND ops ─────────
  // Initial doc: field 1 = empty repeated string.
  const initFields = [{ num: 1, repeated: { elemType: VTYPE.STRING, values: [] } }]
  const initDoc    = encodeDocument(initFields)

  // Each step: append TOKENS_PER_STEP tokens via one REPEATED_APPEND op.
  const wpFrames = [initDoc]
  for (let step = 0; step < N_STEPS; step++) {
    const batch = allTokens.slice(step * TOKENS_PER_STEP, (step + 1) * TOKENS_PER_STEP)
    wpFrames.push(encodeChain([{
      op: OP.REPEATED_APPEND,
      path: [{ field: 1 }],
      elements: { elemType: VTYPE.STRING, values: batch },
    }]))
  }

  const wpChain       = concatArrays(wpFrames)
  const wpChainBrotli = brotli(wpChain)
  const totalWpRaw    = wpChain.length

  // Sanity: final snapshot size comparison.
  const finalProtoRaw = protoSnapshots[N_STEPS - 1]
  const finalWpSnap   = encodeDocument([{ num: 1, repeated: { elemType: VTYPE.STRING, values: allTokens } }])

  sub("Final snapshot size (after all 1000 tokens)")
  console.log(`  protobuf:       ${fmtB(finalProtoRaw.length)}`)
  console.log(`  weavepack snap: ${fmtB(finalWpSnap.length)}  (${pct(finalWpSnap.length, finalProtoRaw.length)} of protobuf)`)

  sub("Total bytes for all 100 streaming steps")
  console.log(`  ${"approach".padEnd(48)} ${"raw bytes".padStart(10)}  ${"brotli-6".padStart(10)}`)
  console.log(`  ${"─".repeat(72)}`)
  console.log(`  ${"protobuf — 100 full snapshots (sum)".padEnd(48)} ${fmtB(totalProtoRaw).padStart(10)}  ${fmtB(protoPerBrotliTotal).padStart(10)}  ← per-snapshot`)
  console.log(`  ${"protobuf — 100 snapshots (concat brotli)".padEnd(48)} ${"—".padStart(10)}  ${fmtB(protoConcatBrotli.length).padStart(10)}  ← concat stream`)
  console.log(`  ${"weavepack — init + 100 append frames".padEnd(48)} ${fmtB(totalWpRaw).padStart(10)}  ${fmtB(wpChainBrotli.length).padStart(10)}`)

  const winVsPerBrotli = protoPerBrotliTotal  / wpChainBrotli.length
  const winVsConcat    = protoConcatBrotli.length / wpChainBrotli.length

  sub("weavepack advantage")
  console.log(`  vs protobuf per-snapshot brotli: ${winVsPerBrotli.toFixed(2)}× smaller  (gate: ≥2×)`)
  console.log(`  vs protobuf concat-stream brotli: ${winVsConcat.toFixed(2)}× smaller`)

  const gatePass = winVsPerBrotli >= 2.0
  console.log(`\n  Gate (≥2× vs per-snapshot brotli): ${gatePass ? "PASS ✓" : "FAIL ✗"}`)

  return {
    finalProtoRaw: finalProtoRaw.length, finalWpSnap: finalWpSnap.length,
    totalProtoRaw, totalWpRaw,
    protoPerBrotliTotal, protoConcatBrotli: protoConcatBrotli.length,
    wpChainBrotli: wpChainBrotli.length,
    winVsPerBrotli, winVsConcat,
    gatePass,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log("weavepack-wire benchmark — W.6")
console.log("Node.js", process.version)

const r1 = runScenario1()
const r2 = runScenario2()
const r3 = runScenario3()

const line = "═".repeat(74)
console.log(`\n${line}`)
console.log("  Summary")
console.log(line)
console.log(`  Scenario 1 (full snapshot)    weavepack ${pct(r1.wpBytes.length, r1.protoBytes.length)} of protobuf raw   gate ≤115%: ${r1.wpBytes.length <= r1.protoBytes.length * 1.15 ? "PASS ✓" : "FAIL ✗"}`)
console.log(`  Scenario 2 (incremental API)  weavepack ${r2.winVsPerBrotli.toFixed(2)}× smaller than protobuf+brotli   gate ≥2×: ${r2.gatePass ? "PASS ✓" : "FAIL ✗"}`)
console.log(`  Scenario 3 (token stream)     weavepack ${r3.winVsPerBrotli.toFixed(2)}× smaller than protobuf+brotli   gate ≥2×: ${r3.gatePass ? "PASS ✓" : "FAIL ✗"}`)
console.log()
