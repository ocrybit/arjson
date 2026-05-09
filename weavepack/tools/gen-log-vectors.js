// Generator: produce weavepack-log conformance test vector corpus.
// Run from the repo root:
//   node weavepack/tools/gen-log-vectors.js
//
// Writes to weavepack/profiles/log/test-vectors/.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CTYPE, LEVEL, OP, SCHEMA_SUB_OP,
  encodeBatch, encodeChain, encodeStreamHeader,
  decodeBatch, decodeChain, decodeStreamHeader,
  initState, applyChain,
} from "../../sdk/src/profiles/log/index.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..", "profiles", "log", "test-vectors")

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
}

// Serialize batch spec values for JSON.
// BigInt → string, Uint8Array → {_bytes:[...]}, others pass through.
function safeJSON(v) {
  return JSON.stringify(v, (_k, val) => {
    if (typeof val === "bigint") return val.toString()
    if (val instanceof Uint8Array) return { _bytes: Array.from(val) }
    return val
  }, 2)
}

function writeFile(relPath, data) {
  const full = join(ROOT, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, safeJSON(data))
  console.log("wrote", relPath)
}

// ── Batch spec helpers ────────────────────────────────────────────────────

// Batch spec → JS batch (for encodeBatch).
// seqs/tss: string[] → BigInt[]
// column values: string → BigInt for int64/uint64/timestamp64, {_bytes} → Uint8Array for bytes
const BIGINT_CTYPES = new Set([CTYPE.INT64, CTYPE.UINT64, CTYPE.TIMESTAMP64])

function specValToJs(ctype, v) {
  if (v === null || v === undefined) return null
  if (typeof v === "object" && v._bytes !== undefined) return new Uint8Array(v._bytes)
  if (BIGINT_CTYPES.has(ctype) && typeof v === "string") return BigInt(v)
  return v
}

function specToBatch(spec) {
  return {
    schemaHash: spec.schemaHash ? new Uint8Array(spec.schemaHash._bytes) : undefined,
    seqs: (spec.seqs || []).map(s => BigInt(s)),
    tss:  (spec.tss  || []).map(s => BigInt(s)),
    columns: (spec.columns || []).map(col => ({
      colId:    col.colId,
      ctype:    col.ctype,
      nullable: col.nullable,
      values:   col.values.map(v => specValToJs(col.ctype, v)),
    })),
  }
}

// Generate snapshot vector: encode batch → bytes hex, add to spec.
function snap(spec) {
  const batch = specToBatch(spec)
  return toHex(encodeBatch(batch))
}

// Generate delta vector: encode ops → bytes hex.
function chain(ops) {
  const jsOps = specToOps(ops)
  return toHex(encodeChain({ ops: jsOps }))
}

function specToOps(ops) {
  return ops.map(op => {
    const o = { ...op }
    if (o.seqs)    o.seqs = o.seqs.map(s => BigInt(s))
    if (o.tss)     o.tss  = o.tss.map(s => BigInt(s))
    if (o.seq !== undefined) o.seq = BigInt(o.seq)
    if (o.seqLo !== undefined) o.seqLo = BigInt(o.seqLo)
    if (o.seqHi !== undefined) o.seqHi = BigInt(o.seqHi)
    if (o.columns) o.columns = o.columns.map(col => {
      const c = { ...col }
      if (c.values) c.values = c.values.map(v => specValToJs(c.ctype, v))
      if (c.value !== undefined) c.value = specValToJs(c.ctype, c.value)
      return c
    })
    return o
  })
}

// Apply ops to an initial batch spec, return final state spec.
function applyAndSpec(initialSpec, opsSpec) {
  const batch = specToBatch(initialSpec)
  const bytes = encodeBatch(batch)
  const decoded = decodeBatch(bytes)
  const state = initState(decoded)
  const jsOps = specToOps(opsSpec)
  const final = applyChain(state, jsOps)

  // Convert state → spec.
  function jsValToSpec(ctype, v) {
    if (v === null || v === undefined) return null
    if (v instanceof Uint8Array) return { _bytes: Array.from(v) }
    if (typeof v === "bigint") return v.toString()
    return v
  }

  const result = {
    seqs: final.seqs.map(s => s.toString()),
    tss:  final.tss.map(s => s.toString()),
    columns: final.columns.map(col => ({
      colId:    col.colId,
      ctype:    col.ctype,
      nullable: col.nullable,
      values:   col.values.map(v => jsValToSpec(col.ctype, v)),
    })),
  }
  if (final.schema && final.schema.length > 0) {
    result.schema = final.schema
  }
  if (final.expired && final.expired.size > 0) {
    result.expired = Array.from(final.expired).sort()
  }
  if (final.cursors && final.cursors.size > 0) {
    result.cursors = Object.fromEntries(
      Array.from(final.cursors.entries()).map(([k, v]) => [k, v.toString()])
    )
  }
  return result
}

// ── types/scalars.json ────────────────────────────────────────────────────
//
// One-event batches exercising each ctype (no nullable).

const BASE_SEQ = ["0"]
const BASE_TSS = ["1000000"]

function scalar(name, description, ctype, value) {
  const col = { colId: 2, ctype, nullable: false, values: [value] }
  const input = { seqs: BASE_SEQ, tss: BASE_TSS, columns: [col] }
  return { name, description, input, expected_bytes_hex: snap(input) }
}

const scalarsVectors = [
  scalar("bool false",      "ctype 0 bool false",        CTYPE.BOOL,      false),
  scalar("bool true",       "ctype 0 bool true",         CTYPE.BOOL,      true),
  scalar("int8 min",        "ctype 1 int8 -128",         CTYPE.INT8,      -128),
  scalar("int8 zero",       "ctype 1 int8 zero",         CTYPE.INT8,      0),
  scalar("int8 max",        "ctype 1 int8 127",          CTYPE.INT8,      127),
  scalar("int16 min",       "ctype 2 int16 -32768",      CTYPE.INT16,     -32768),
  scalar("int16 max",       "ctype 2 int16 32767",       CTYPE.INT16,     32767),
  scalar("int32 min",       "ctype 3 int32 min",         CTYPE.INT32,     -2147483648),
  scalar("int32 max",       "ctype 3 int32 max",         CTYPE.INT32,     2147483647),
  scalar("int64 zero",      "ctype 4 int64 zero",        CTYPE.INT64,     "0"),
  scalar("int64 pos",       "ctype 4 int64 positive",    CTYPE.INT64,     "9007199254740992"),
  scalar("int64 neg",       "ctype 4 int64 negative",    CTYPE.INT64,     "-1"),
  scalar("int64 min",       "ctype 4 int64 min",         CTYPE.INT64,     "-9223372036854775808"),
  scalar("int64 max",       "ctype 4 int64 max",         CTYPE.INT64,     "9223372036854775807"),
  scalar("uint8 zero",      "ctype 5 uint8 zero",        CTYPE.UINT8,     0),
  scalar("uint8 max",       "ctype 5 uint8 max",         CTYPE.UINT8,     255),
  scalar("uint16 zero",     "ctype 6 uint16 zero",       CTYPE.UINT16,    0),
  scalar("uint16 max",      "ctype 6 uint16 max",        CTYPE.UINT16,    65535),
  scalar("uint32 zero",     "ctype 7 uint32 zero",       CTYPE.UINT32,    0),
  scalar("uint32 max",      "ctype 7 uint32 max",        CTYPE.UINT32,    4294967295),
  scalar("uint64 zero",     "ctype 8 uint64 zero",       CTYPE.UINT64,    "0"),
  scalar("uint64 max",      "ctype 8 uint64 max",        CTYPE.UINT64,    "18446744073709551615"),
  scalar("float32 zero",    "ctype 9 float32 zero",      CTYPE.FLOAT32,   0.0),
  scalar("float32 pi",      "ctype 9 float32 pi",        CTYPE.FLOAT32,   Math.fround(3.14159)),
  scalar("float32 neg",     "ctype 9 float32 negative",  CTYPE.FLOAT32,   -1.5),
  scalar("float64 zero",    "ctype 10 float64 zero",     CTYPE.FLOAT64,   0.0),
  scalar("float64 pi",      "ctype 10 float64 pi",       CTYPE.FLOAT64,   3.141592653589793),
  scalar("float64 neg",     "ctype 10 float64 negative", CTYPE.FLOAT64,   -1e100),
  scalar("string empty",    "ctype 11 empty string",     CTYPE.STRING,    ""),
  scalar("string ascii",    "ctype 11 ascii string",     CTYPE.STRING,    "hello"),
  scalar("string unicode",  "ctype 11 unicode string",   CTYPE.STRING,    "こんにちは"),
  { // bytes ctype — value stored as {_bytes:[...]}
    name: "bytes empty", description: "ctype 12 empty bytes",
    input: { seqs: BASE_SEQ, tss: BASE_TSS, columns: [{ colId: 2, ctype: CTYPE.BYTES, nullable: false, values: [{ _bytes: [] }] }] },
    expected_bytes_hex: snap({ seqs: BASE_SEQ.map(BigInt), tss: BASE_TSS.map(BigInt), columns: [{ colId: 2, ctype: CTYPE.BYTES, nullable: false, values: [new Uint8Array(0)] }] }),
  },
  { // bytes ctype with data
    name: "bytes data", description: "ctype 12 bytes with values",
    input: { seqs: BASE_SEQ, tss: BASE_TSS, columns: [{ colId: 2, ctype: CTYPE.BYTES, nullable: false, values: [{ _bytes: [0xDE, 0xAD, 0xBE, 0xEF] }] }] },
    expected_bytes_hex: snap({ seqs: BASE_SEQ.map(BigInt), tss: BASE_TSS.map(BigInt), columns: [{ colId: 2, ctype: CTYPE.BYTES, nullable: false, values: [new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])] }] }),
  },
  scalar("date32 zero",     "ctype 13 date32 epoch",     CTYPE.DATE32,    0),
  scalar("date32 pos",      "ctype 13 date32 positive",  CTYPE.DATE32,    19845),
  scalar("date32 neg",      "ctype 13 date32 negative",  CTYPE.DATE32,    -1),
  scalar("timestamp64 zero","ctype 14 timestamp64 zero", CTYPE.TIMESTAMP64, "0"),
  scalar("timestamp64 pos", "ctype 14 timestamp64 pos",  CTYPE.TIMESTAMP64, "1715200000000000"),
  scalar("level TRACE",     "ctype 16 level TRACE=0",    CTYPE.LEVEL,     LEVEL.TRACE),
  scalar("level DEBUG",     "ctype 16 level DEBUG=1",    CTYPE.LEVEL,     LEVEL.DEBUG),
  scalar("level INFO",      "ctype 16 level INFO=2",     CTYPE.LEVEL,     LEVEL.INFO),
  scalar("level WARN",      "ctype 16 level WARN=3",     CTYPE.LEVEL,     LEVEL.WARN),
  scalar("level ERROR",     "ctype 16 level ERROR=4",    CTYPE.LEVEL,     LEVEL.ERROR),
  scalar("level FATAL",     "ctype 16 level FATAL=5",    CTYPE.LEVEL,     LEVEL.FATAL),
]

// Patch bytes scalars to use the right format.
// (Already done inline above — those two entries are manually constructed.)

writeFile("types/scalars.json", scalarsVectors)

// ── types/nulls.json ──────────────────────────────────────────────────────
//
// Nullable columns: all-null, mixed null/non-null, multi-event.

const nullsVectors = [
  (() => {
    const input = {
      seqs: ["0"], tss: ["1000000"],
      columns: [{ colId: 2, ctype: CTYPE.INT32, nullable: true, values: [null] }],
    }
    return { name: "all-null int32", description: "one-event nullable column with null value", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      seqs: ["0", "1", "2"], tss: ["1000000", "1000001", "1000002"],
      columns: [{ colId: 2, ctype: CTYPE.INT32, nullable: true, values: [null, 42, null] }],
    }
    return { name: "mixed null int32", description: "three-event nullable column: null, 42, null", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      seqs: ["0", "1", "2", "3"], tss: ["1000000", "1000001", "1000002", "1000003"],
      columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: true, values: ["hello", null, "world", null] }],
    }
    return { name: "mixed null string", description: "four-event nullable string: hello, null, world, null", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      seqs: ["0", "1", "2"], tss: ["1000000", "1000001", "1000002"],
      columns: [{ colId: 2, ctype: CTYPE.LEVEL, nullable: true, values: [LEVEL.INFO, null, LEVEL.ERROR] }],
    }
    return { name: "nullable level", description: "nullable level column: INFO, null, ERROR", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      seqs: ["0", "1"], tss: ["1000000", "1000001"],
      columns: [
        { colId: 2, ctype: CTYPE.INT32,  nullable: false,  values: [10, 20] },
        { colId: 3, ctype: CTYPE.STRING, nullable: true,   values: ["ok", null] },
      ],
    }
    return { name: "two cols one nullable", description: "two-column batch: non-nullable int32, nullable string", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("types/nulls.json", nullsVectors)

// ── containers/batches.json ───────────────────────────────────────────────
//
// Multi-event, multi-column batches; empty batch; seq/ts delta coding.

const batchesVectors = [
  (() => {
    const input = { seqs: [], tss: [], columns: [] }
    return { name: "empty batch", description: "zero-event batch with no columns", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      seqs: ["0"], tss: ["1715000000000000"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.INFO] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false, values: ["started"] },
      ],
    }
    return { name: "single event two columns", description: "one event with level and message columns", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      seqs: ["100", "101", "102", "103", "104"],
      tss:  ["1715000000000000", "1715000000001000", "1715000000002000", "1715000000003000", "1715000000004000"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,   nullable: false, values: [LEVEL.INFO, LEVEL.INFO, LEVEL.WARN, LEVEL.INFO, LEVEL.ERROR] },
        { colId: 3, ctype: CTYPE.STRING,  nullable: false, values: ["req", "resp", "slow", "req", "timeout"] },
        { colId: 4, ctype: CTYPE.UINT16,  nullable: false, values: [200, 200, 200, 201, 500] },
      ],
    }
    return { name: "five events three columns", description: "five HTTP log events: level, message, status_code", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // Seq gap > 1 (e.g., non-contiguous seqs from a multiplexed stream).
    const input = {
      seqs: ["0", "5", "10"],
      tss:  ["1000000", "1000000", "1000000"],
      columns: [{ colId: 2, ctype: CTYPE.UINT32, nullable: false, values: [1, 2, 3] }],
    }
    return { name: "non-contiguous seqs", description: "batch with seq gaps: 0, 5, 10", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // Negative first timestamp (pre-epoch).
    const input = {
      seqs: ["0", "1"],
      tss:  ["-1000000", "-500000"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [1, 2] }],
    }
    return { name: "negative timestamp", description: "batch with pre-epoch timestamps", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // All level values in one batch.
    const input = {
      seqs: ["0", "1", "2", "3", "4", "5"],
      tss:  ["0", "1", "2", "3", "4", "5"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL, nullable: false, values: [LEVEL.TRACE, LEVEL.DEBUG, LEVEL.INFO, LEVEL.WARN, LEVEL.ERROR, LEVEL.FATAL] },
      ],
    }
    return { name: "all level values", description: "six events covering all 6 level values", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("containers/batches.json", batchesVectors)

// ── containers/stream_header.json ─────────────────────────────────────────

function headerSnap(spec) {
  const h = {
    streamId:   new Uint8Array(spec.streamId._bytes),
    source:     spec.source,
    schemaHash: spec.schemaHash ? new Uint8Array(spec.schemaHash._bytes) : undefined,
    seqStart:   BigInt(spec.seqStart),
  }
  return toHex(encodeStreamHeader(h))
}

const streamHeaderVectors = [
  (() => {
    const input = {
      streamId:   { _bytes: Array.from(new Uint8Array(16).fill(0)) },
      source:     "my-service",
      seqStart:   "0",
    }
    return { name: "basic stream header", description: "stream header with source and zero schema hash", input, expected_bytes_hex: headerSnap(input) }
  })(),
  (() => {
    const sid = new Uint8Array([0x01,0x23,0x45,0x67,0x89,0xAB,0xCD,0xEF,0xFE,0xDC,0xBA,0x98,0x76,0x54,0x32,0x10])
    const hash = new Uint8Array(32).fill(0xAB)
    const input = {
      streamId:   { _bytes: Array.from(sid) },
      source:     "analytics-pipeline",
      schemaHash: { _bytes: Array.from(hash) },
      seqStart:   "50000",
    }
    return { name: "full stream header", description: "stream header with UUID, source, non-zero schema hash, seqStart", input, expected_bytes_hex: headerSnap(input) }
  })(),
  (() => {
    const input = {
      streamId: { _bytes: Array.from(new Uint8Array(16).fill(0)) },
      source:   "",
      seqStart: "999",
    }
    return { name: "anonymous stream header", description: "stream header with empty source", input, expected_bytes_hex: headerSnap(input) }
  })(),
]

writeFile("containers/stream_header.json", streamHeaderVectors)

// ── containers/schema.json ────────────────────────────────────────────────
//
// Batches with a non-zero schema_hash (hash covers column definitions).

const schemaHash1 = new Uint8Array(32)
schemaHash1[0] = 0x01; schemaHash1[31] = 0xFF

const schemaVectors = [
  (() => {
    const input = {
      schemaHash: { _bytes: Array.from(schemaHash1) },
      seqs: ["0", "1"],
      tss:  ["1000000", "1000001"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.INFO, LEVEL.WARN] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false, values: ["ping", "latency"] },
      ],
    }
    return { name: "batch with schema hash", description: "two-event batch with non-zero schema_hash", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // All-zero schema hash (schemaless mode, omit schemaHash field).
    const input = {
      seqs: ["0"],
      tss:  ["0"],
      columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["hello"] }],
    }
    return { name: "schemaless batch", description: "batch with all-zero schema_hash (schemaless mode)", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("containers/schema.json", schemaVectors)

// ── deltas/event_append.json ──────────────────────────────────────────────

function deltaVec(name, description, initial, ops) {
  const final = applyAndSpec(initial, ops)
  return { name, description, initial, ops, expected_chain_bytes_hex: chain(ops), expected_final: final }
}

const eventAppendVectors = [
  (() => {
    const initial = { seqs: [], tss: [], columns: [] }
    const ops = [{
      op: OP.EVENT_APPEND,
      seqs: ["0"], tss: ["1000000"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.INFO] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false, values: ["started"] },
      ],
    }]
    return deltaVec("append to empty stream", "append one event to an empty batch", initial, ops)
  })(),
  (() => {
    const initial = {
      seqs: ["0"], tss: ["1000000"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.INFO] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false, values: ["a"] },
      ],
    }
    const ops = [{
      op: OP.EVENT_APPEND,
      seqs: ["1", "2"], tss: ["1000001", "1000002"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.WARN, LEVEL.ERROR] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false, values: ["b", "c"] },
      ],
    }]
    return deltaVec("append two events", "append two events to a one-event batch", initial, ops)
  })(),
  (() => {
    // Two sequential event_append ops.
    const initial = { seqs: [], tss: [], columns: [] }
    const ops = [
      {
        op: OP.EVENT_APPEND,
        seqs: ["0"], tss: ["0"],
        columns: [{ colId: 2, ctype: CTYPE.UINT32, nullable: false, values: [10] }],
      },
      {
        op: OP.EVENT_APPEND,
        seqs: ["1"], tss: ["1"],
        columns: [{ colId: 2, ctype: CTYPE.UINT32, nullable: false, values: [20] }],
      },
    ]
    return deltaVec("two sequential appends", "two event_append ops in a single chain", initial, ops)
  })(),
]

writeFile("deltas/event_append.json", eventAppendVectors)

// ── deltas/field_update.json ──────────────────────────────────────────────

const fieldUpdateVectors = [
  (() => {
    const initial = {
      seqs: ["0", "1"], tss: ["1000000", "1000001"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.INFO, LEVEL.INFO] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false, values: ["hello", "world"] },
      ],
    }
    const ops = [{
      op: OP.FIELD_UPDATE, seq: "1",
      columns: [{ colId: 3, ctype: CTYPE.STRING, hasValue: true, value: "REDACTED" }],
    }]
    return deltaVec("update string field", "redact string field at seq=1", initial, ops)
  })(),
  (() => {
    const initial = {
      seqs: ["0"], tss: ["1000000"],
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL, nullable: false, values: [LEVEL.WARN] },
        { colId: 3, ctype: CTYPE.UINT16, nullable: false, values: [503] },
      ],
    }
    const ops = [{
      op: OP.FIELD_UPDATE, seq: "0",
      columns: [
        { colId: 2, ctype: CTYPE.LEVEL,  hasValue: true, value: LEVEL.ERROR },
        { colId: 3, ctype: CTYPE.UINT16, hasValue: true, value: 500 },
      ],
    }]
    return deltaVec("update two fields", "update level and status at seq=0", initial, ops)
  })(),
  (() => {
    // field_update with null value (erase field, requires nullable column).
    const initial = {
      seqs: ["0", "1"], tss: ["1000000", "1000001"],
      columns: [
        { colId: 2, ctype: CTYPE.STRING, nullable: true, values: ["sensitive", "public"] },
      ],
    }
    const ops = [{
      op: OP.FIELD_UPDATE, seq: "0",
      columns: [{ colId: 2, ctype: CTYPE.STRING, hasValue: false, value: null }],
    }]
    return deltaVec("field update to null", "set nullable field to null at seq=0 (compliance erase)", initial, ops)
  })(),
]

writeFile("deltas/field_update.json", fieldUpdateVectors)

// ── deltas/event_expire.json ──────────────────────────────────────────────

const eventExpireVectors = [
  (() => {
    const initial = {
      seqs: ["0", "1", "2", "3", "4"], tss: ["0", "1", "2", "3", "4"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [10, 20, 30, 40, 50] }],
    }
    const ops = [{ op: OP.EVENT_EXPIRE, seqLo: "1", seqHi: "3" }]
    return deltaVec("expire middle range", "expire seqs 1–3 (30-day retention policy)", initial, ops)
  })(),
  (() => {
    const initial = {
      seqs: ["0", "1", "2"], tss: ["0", "1", "2"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [1, 2, 3] }],
    }
    const ops = [{ op: OP.EVENT_EXPIRE, seqLo: "0", seqHi: "2" }]
    return deltaVec("expire all events", "expire entire seq range (0–2)", initial, ops)
  })(),
  (() => {
    // Single-event expiry.
    const initial = {
      seqs: ["5", "6", "7"], tss: ["0", "1", "2"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [1, 2, 3] }],
    }
    const ops = [{ op: OP.EVENT_EXPIRE, seqLo: "6", seqHi: "6" }]
    return deltaVec("expire single event", "expire exactly one event at seq=6", initial, ops)
  })(),
]

writeFile("deltas/event_expire.json", eventExpireVectors)

// ── deltas/schema_evolve.json ─────────────────────────────────────────────

const schemaEvolveVectors = [
  (() => {
    const initial = { seqs: [], tss: [], columns: [] }
    const ops = [{
      op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD,
      colId: 2, ctype: CTYPE.LEVEL, nullable: false, name: "level",
    }]
    return deltaVec("column_add", "add 'level' column to schema", initial, ops)
  })(),
  (() => {
    // Add then drop a column.
    const initial = { seqs: [], tss: [], columns: [] }
    const ops = [
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD, colId: 2, ctype: CTYPE.STRING, nullable: false, name: "host" },
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_DROP, colId: 2 },
    ]
    return deltaVec("column_add then drop", "add 'host' column then drop it", initial, ops)
  })(),
  (() => {
    // Rename a column.
    const initial = { seqs: [], tss: [], columns: [] }
    const ops = [
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD, colId: 2, ctype: CTYPE.UINT16, nullable: false, name: "status" },
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_RENAME, colId: 2, name: "http_status" },
    ]
    return deltaVec("column rename", "rename 'status' to 'http_status'", initial, ops)
  })(),
  (() => {
    // Add multiple columns.
    const initial = { seqs: [], tss: [], columns: [] }
    const ops = [
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD, colId: 2, ctype: CTYPE.LEVEL, nullable: false, name: "level" },
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD, colId: 3, ctype: CTYPE.STRING, nullable: false, name: "service" },
      { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD, colId: 4, ctype: CTYPE.STRING, nullable: true, name: "trace_id" },
    ]
    return deltaVec("add three columns", "add level, service, and nullable trace_id to schema", initial, ops)
  })(),
]

writeFile("deltas/schema_evolve.json", schemaEvolveVectors)

// ── deltas/cursor_checkpoint.json ─────────────────────────────────────────

const cursorCheckpointVectors = [
  (() => {
    const initial = {
      seqs: ["0", "1", "2"], tss: ["0", "1", "2"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [1, 2, 3] }],
    }
    const ops = [{ op: OP.CURSOR_CHECKPOINT, seq: "2", name: "analytics-pipeline" }]
    return deltaVec("cursor at last seq", "checkpoint analytics-pipeline at seq=2", initial, ops)
  })(),
  (() => {
    const initial = {
      seqs: ["0", "1", "2", "3", "4"], tss: ["0", "1", "2", "3", "4"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [1, 2, 3, 4, 5] }],
    }
    const ops = [
      { op: OP.CURSOR_CHECKPOINT, seq: "2", name: "pipeline-a" },
      { op: OP.CURSOR_CHECKPOINT, seq: "4", name: "pipeline-b" },
    ]
    return deltaVec("two cursors", "checkpoint two different consumers at different positions", initial, ops)
  })(),
  (() => {
    // Idempotent: same name, same seq twice.
    const initial = {
      seqs: ["0", "1"], tss: ["0", "1"],
      columns: [{ colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [1, 2] }],
    }
    const ops = [
      { op: OP.CURSOR_CHECKPOINT, seq: "1", name: "reader" },
      { op: OP.CURSOR_CHECKPOINT, seq: "1", name: "reader" },
    ]
    return deltaVec("idempotent cursor checkpoint", "same cursor checkpointed twice is idempotent", initial, ops)
  })(),
]

writeFile("deltas/cursor_checkpoint.json", cursorCheckpointVectors)

// ── schemas/multiplex.json ────────────────────────────────────────────────
//
// Multi-schema stream: col_id 2 is schema_id (uint8), selecting which event
// type this event is. Three event types mixed in one batch.
// HTTP=0, DB=1, CACHE=2 (per schema_id value in col_id 2).

const multiplexVectors = [
  (() => {
    // 6 events mixing 3 schema types.
    // col 2: schema_id (uint8 0=HTTP, 1=DB, 2=CACHE)
    // col 3: level
    // col 4: service name (all events share)
    // col 5: nullable url (HTTP only, null for DB/CACHE)
    // col 6: nullable query (DB only, null for others)
    const input = {
      seqs: ["0", "1", "2", "3", "4", "5"],
      tss:  ["1000000", "1000001", "1000002", "1000003", "1000004", "1000005"],
      columns: [
        { colId: 2, ctype: CTYPE.UINT8,  nullable: false, values: [0, 1, 2, 0, 1, 2] },
        { colId: 3, ctype: CTYPE.LEVEL,  nullable: false, values: [LEVEL.INFO, LEVEL.INFO, LEVEL.INFO, LEVEL.WARN, LEVEL.ERROR, LEVEL.INFO] },
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["web", "web", "web", "web", "web", "web"] },
        { colId: 5, ctype: CTYPE.STRING, nullable: true,  values: ["/index", null, null, "/login", null, null] },
        { colId: 6, ctype: CTYPE.STRING, nullable: true,  values: [null, "SELECT 1", null, null, "SELECT users", null] },
      ],
    }
    return {
      name: "mixed schema stream",
      description: "6 events of 3 types (HTTP/DB/CACHE) via schema_id col; col 2=uint8 schema_id, col 3=level, col 4=service, col 5=nullable url, col 6=nullable query",
      input,
      expected_bytes_hex: snap(input),
    }
  })(),
]

writeFile("schemas/multiplex.json", multiplexVectors)

console.log("Done. All log test vectors written.")
