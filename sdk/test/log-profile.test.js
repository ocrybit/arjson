// weavepack-log — reference implementation tests (L.2).
//
// Covers: all ctypes (0–16) including level, nullable columns,
// snapshot round-trips, stream header encode/decode, delta chains
// (event_append, field_update, event_expire, schema_evolve,
// cursor_checkpoint), and applyChain semantics.

import { describe, it } from "node:test"
import assert from "assert"
import {
  CTYPE, LEVEL, OP, SCHEMA_SUB_OP,
  encodeBatch, decodeBatch,
  encodeChain, decodeChain,
  encodeStreamHeader, decodeStreamHeader,
  initState, applyChain,
} from "../src/profiles/log/index.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function makeBatch(seqs, tss, columns) {
  return {
    schemaHash: new Uint8Array(32),
    seqs: seqs.map(BigInt),
    tss:  tss.map(BigInt),
    columns,
  }
}

function roundTrip(batch) {
  return decodeBatch(encodeBatch(batch))
}

function bigEq(a, b) { return BigInt(a) === BigInt(b) }

function colValuesEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i]
    if (av === null && bv === null) continue
    if (av === null || bv === null) return false
    if (typeof av === "bigint" || typeof bv === "bigint") {
      if (BigInt(av) !== BigInt(bv)) return false
    } else if (av instanceof Uint8Array) {
      if (!(bv instanceof Uint8Array) || av.length !== bv.length) return false
      for (let j = 0; j < av.length; j++) if (av[j] !== bv[j]) return false
    } else if (typeof av === "number" && Number.isNaN(av)) {
      if (!Number.isNaN(bv)) return false
    } else {
      if (av !== bv) return false
    }
  }
  return true
}

// ── Empty batch ────────────────────────────────────────────────────────────

describe("weavepack-log empty batch", () => {
  it("encodes and decodes an empty batch (0 events, 0 user cols)", () => {
    const batch = makeBatch([], [], [])
    const rt = roundTrip(batch)
    assert.strictEqual(rt.seqs.length, 0)
    assert.strictEqual(rt.tss.length, 0)
    assert.strictEqual(rt.columns.length, 0)
  })

  it("encodes and decodes an empty batch with user columns (0 events)", () => {
    const batch = makeBatch([], [], [
      { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [] },
      { colId: 3, ctype: CTYPE.STRING, nullable: true, values: [] },
    ])
    const rt = roundTrip(batch)
    assert.strictEqual(rt.seqs.length, 0)
    assert.strictEqual(rt.columns.length, 2)
    assert.strictEqual(rt.columns[0].ctype, CTYPE.INT32)
    assert.strictEqual(rt.columns[1].ctype, CTYPE.STRING)
  })
})

// ── Scalar ctypes ──────────────────────────────────────────────────────────

describe("weavepack-log scalar ctypes", () => {
  it("bool column (non-nullable)", () => {
    const batch = makeBatch([0,1,2,3,4,5,6,7,8], [0,1,2,3,4,5,6,7,8], [
      { colId: 2, ctype: CTYPE.BOOL, nullable: false,
        values: [true, false, true, true, false, false, true, false, true] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values,
      [true, false, true, true, false, false, true, false, true])
  })

  it("int8 column (non-nullable)", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.INT8, nullable: false, values: [-128, 0, 127] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [-128, 0, 127])
  })

  it("int16 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.INT16, nullable: false, values: [-32768, 0, 32767] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [-32768, 0, 32767])
  })

  it("int32 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [-2147483648, 0, 2147483647] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [-2147483648, 0, 2147483647])
  })

  it("int64 column", () => {
    const batch = makeBatch([0,1], [0,1], [
      { colId: 2, ctype: CTYPE.INT64, nullable: false,
        values: [-(2n**63n), 2n**63n - 1n] },
    ])
    const rt = roundTrip(batch)
    assert.ok(bigEq(rt.columns[0].values[0], -(2n**63n)))
    assert.ok(bigEq(rt.columns[0].values[1], 2n**63n - 1n))
  })

  it("uint8 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.UINT8, nullable: false, values: [0, 127, 255] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [0, 127, 255])
  })

  it("uint16 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.UINT16, nullable: false, values: [0, 1000, 65535] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [0, 1000, 65535])
  })

  it("uint32 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.UINT32, nullable: false, values: [0, 1, 4294967295] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [0, 1, 4294967295])
  })

  it("uint64 column", () => {
    const batch = makeBatch([0,1], [0,1], [
      { colId: 2, ctype: CTYPE.UINT64, nullable: false,
        values: [0n, 2n**64n - 1n] },
    ])
    const rt = roundTrip(batch)
    assert.ok(bigEq(rt.columns[0].values[0], 0n))
    assert.ok(bigEq(rt.columns[0].values[1], 2n**64n - 1n))
  })

  it("float32 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.FLOAT32, nullable: false, values: [0.0, 1.5, -3.14] },
    ])
    const rt = roundTrip(batch)
    assert.ok(Math.abs(rt.columns[0].values[0]) < 1e-6)
    assert.ok(Math.abs(rt.columns[0].values[1] - 1.5) < 1e-5)
    assert.ok(Math.abs(rt.columns[0].values[2] - (-3.14)) < 1e-5)
  })

  it("float64 column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.FLOAT64, nullable: false,
        values: [Math.PI, -Math.E, Number.EPSILON] },
    ])
    const rt = roundTrip(batch)
    assert.strictEqual(rt.columns[0].values[0], Math.PI)
    assert.strictEqual(rt.columns[0].values[1], -Math.E)
    assert.strictEqual(rt.columns[0].values[2], Number.EPSILON)
  })

  it("string column", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.STRING, nullable: false,
        values: ["hello", "world", "weavepack-log"] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, ["hello", "world", "weavepack-log"])
  })

  it("bytes column", () => {
    const bytes1 = new Uint8Array([0x00, 0xFF, 0x42])
    const bytes2 = new Uint8Array([])
    const batch = makeBatch([0,1], [0,1], [
      { colId: 2, ctype: CTYPE.BYTES, nullable: false, values: [bytes1, bytes2] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual([...rt.columns[0].values[0]], [...bytes1])
    assert.strictEqual(rt.columns[0].values[1].length, 0)
  })

  it("date32 column (positive and negative)", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.DATE32, nullable: false, values: [-1, 0, 19845] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [-1, 0, 19845])
  })

  it("timestamp64 column", () => {
    const now = 1700000000000000n
    const batch = makeBatch([0,1,2], [now, now+1n, now+2n], [
      { colId: 2, ctype: CTYPE.TIMESTAMP64, nullable: false,
        values: [now, now + 1000n, now + 2000n] },
    ])
    const rt = roundTrip(batch)
    assert.ok(bigEq(rt.columns[0].values[0], now))
    assert.ok(bigEq(rt.columns[0].values[1], now + 1000n))
    assert.ok(bigEq(rt.columns[0].values[2], now + 2000n))
  })
})

// ── Level ctype (ctype 16) ─────────────────────────────────────────────────

describe("weavepack-log level column (ctype 16)", () => {
  it("encodes and decodes all 6 severity levels", () => {
    const batch = makeBatch([0,1,2,3,4,5], [0,1,2,3,4,5], [
      { colId: 2, ctype: CTYPE.LEVEL, nullable: false,
        values: [LEVEL.TRACE, LEVEL.DEBUG, LEVEL.INFO, LEVEL.WARN, LEVEL.ERROR, LEVEL.FATAL] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values,
      [LEVEL.TRACE, LEVEL.DEBUG, LEVEL.INFO, LEVEL.WARN, LEVEL.ERROR, LEVEL.FATAL])
  })

  it("encodes a run of INFO events efficiently (3-bit LSB-first)", () => {
    const N = 9
    const batch = makeBatch(
      Array.from({length: N}, (_, i) => i),
      Array.from({length: N}, (_, i) => i),
      [{
        colId: 2, ctype: CTYPE.LEVEL, nullable: false,
        values: Array(N).fill(LEVEL.INFO),
      }]
    )
    const encoded = encodeBatch(batch)
    const rt = decodeBatch(encoded)
    assert.deepStrictEqual(rt.columns[0].values, Array(N).fill(LEVEL.INFO))
  })

  it("encodes mixed levels with correct bit packing", () => {
    // 3 levels: INFO=2, INFO=2, ERROR=4 — 9 bits in 2 bytes.
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.LEVEL, nullable: false,
        values: [LEVEL.INFO, LEVEL.INFO, LEVEL.ERROR] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [LEVEL.INFO, LEVEL.INFO, LEVEL.ERROR])
  })

  it("rejects reserved level values (6 and 7)", () => {
    assert.throws(() => {
      encodeBatch(makeBatch([0], [0], [
        { colId: 2, ctype: CTYPE.LEVEL, nullable: false, values: [6] },
      ]))
    }, /unknown_level/)
  })

  it("level column nullable round-trip", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.LEVEL, nullable: true,
        values: [LEVEL.INFO, null, LEVEL.ERROR] },
    ])
    const rt = roundTrip(batch)
    assert.strictEqual(rt.columns[0].values[0], LEVEL.INFO)
    assert.strictEqual(rt.columns[0].values[1], null)
    assert.strictEqual(rt.columns[0].values[2], LEVEL.ERROR)
  })
})

// ── Nullable columns ───────────────────────────────────────────────────────

describe("weavepack-log nullable columns", () => {
  it("nullable string column with nulls", () => {
    const batch = makeBatch([0,1,2,3], [0,1,2,3], [
      { colId: 2, ctype: CTYPE.STRING, nullable: true,
        values: ["hello", null, "world", null] },
    ])
    const rt = roundTrip(batch)
    assert.strictEqual(rt.columns[0].values[0], "hello")
    assert.strictEqual(rt.columns[0].values[1], null)
    assert.strictEqual(rt.columns[0].values[2], "world")
    assert.strictEqual(rt.columns[0].values[3], null)
  })

  it("nullable int32 column all nulls", () => {
    const batch = makeBatch([0,1,2], [0,1,2], [
      { colId: 2, ctype: CTYPE.INT32, nullable: true, values: [null, null, null] },
    ])
    const rt = roundTrip(batch)
    assert.deepStrictEqual(rt.columns[0].values, [null, null, null])
  })
})

// ── Mandatory column encoding ──────────────────────────────────────────────

describe("weavepack-log mandatory columns", () => {
  it("seq block round-trips with dense seq values", () => {
    const batch = makeBatch([0,1,2,3,4], [100,200,300,400,500], [])
    const rt = roundTrip(batch)
    for (let i = 0; i < 5; i++) assert.ok(bigEq(rt.seqs[i], i))
  })

  it("seq block round-trips with sparse seq values", () => {
    const batch = makeBatch([0, 100, 500, 1000], [0,1,2,3], [])
    const rt = roundTrip(batch)
    assert.ok(bigEq(rt.seqs[0], 0))
    assert.ok(bigEq(rt.seqs[1], 100))
    assert.ok(bigEq(rt.seqs[2], 500))
    assert.ok(bigEq(rt.seqs[3], 1000))
  })

  it("ts block round-trips with non-decreasing timestamps", () => {
    const base = 1700000000000000n
    const batch = makeBatch([0,1,2,3], [base, base, base+1000n, base+5000n], [])
    const rt = roundTrip(batch)
    assert.ok(bigEq(rt.tss[0], base))
    assert.ok(bigEq(rt.tss[1], base))
    assert.ok(bigEq(rt.tss[2], base + 1000n))
    assert.ok(bigEq(rt.tss[3], base + 5000n))
  })

  it("ts block round-trips with negative first_ts (zigzag encoding)", () => {
    const batch = makeBatch([0,1,2], [-1000000n, -500000n, 0n], [])
    const rt = roundTrip(batch)
    assert.ok(bigEq(rt.tss[0], -1000000n))
    assert.ok(bigEq(rt.tss[1], -500000n))
    assert.ok(bigEq(rt.tss[2], 0n))
  })

  it("rejects non-monotone seq deltas", () => {
    assert.throws(() => {
      encodeBatch(makeBatch([0, 0], [0,1], []))
    }, /duplicate_seq/)
  })

  it("rejects negative ts deltas", () => {
    assert.throws(() => {
      encodeBatch(makeBatch([0,1], [1000n, 999n], []))
    }, /non_monotone_timestamp/)
  })
})

// ── Multi-column batch ─────────────────────────────────────────────────────

describe("weavepack-log multi-column batch", () => {
  it("encodes a realistic log event batch (seq, ts, level, string, int32)", () => {
    const base = 1700000000000000n
    const batch = makeBatch(
      [0, 1, 2, 3, 4],
      [base, base+1000n, base+2000n, base+3000n, base+4000n],
      [
        { colId: 2, ctype: CTYPE.LEVEL, nullable: false,
          values: [LEVEL.INFO, LEVEL.DEBUG, LEVEL.WARN, LEVEL.INFO, LEVEL.ERROR] },
        { colId: 3, ctype: CTYPE.STRING, nullable: false,
          values: ["req/start", "db/query", "cache/miss", "req/end", "auth/fail"] },
        { colId: 4, ctype: CTYPE.UINT16, nullable: false,
          values: [200, 0, 0, 200, 401] },
        { colId: 5, ctype: CTYPE.FLOAT32, nullable: true,
          values: [12.5, null, null, 98.3, null] },
      ]
    )
    const rt = roundTrip(batch)
    assert.strictEqual(rt.seqs.length, 5)
    assert.strictEqual(rt.columns.length, 4)
    assert.deepStrictEqual(rt.columns[0].values,
      [LEVEL.INFO, LEVEL.DEBUG, LEVEL.WARN, LEVEL.INFO, LEVEL.ERROR])
    assert.deepStrictEqual(rt.columns[1].values,
      ["req/start", "db/query", "cache/miss", "req/end", "auth/fail"])
    assert.deepStrictEqual(rt.columns[2].values, [200, 0, 0, 200, 401])
    assert.strictEqual(rt.columns[3].values[1], null)
  })
})

// ── Stream header ──────────────────────────────────────────────────────────

describe("weavepack-log stream header", () => {
  it("encodes and decodes a stream header", () => {
    const streamId = new Uint8Array(16).fill(0xAB)
    const header = {
      streamId,
      source: "service-a/logs",
      schemaHash: new Uint8Array(32),
      seqStart: 1000n,
    }
    const encoded = encodeStreamHeader(header)
    const rt = decodeStreamHeader(encoded)
    assert.deepStrictEqual([...rt.streamId], [...streamId])
    assert.strictEqual(rt.source, "service-a/logs")
    assert.ok(bigEq(rt.seqStart, 1000n))
  })

  it("encodes and decodes a stream header with empty source", () => {
    const header = {
      streamId: new Uint8Array(16),
      source: "",
      schemaHash: new Uint8Array(32),
      seqStart: 0n,
    }
    const rt = decodeStreamHeader(encodeStreamHeader(header))
    assert.strictEqual(rt.source, "")
    assert.ok(bigEq(rt.seqStart, 0n))
  })

  it("rejects wrong frame flag in decodeStreamHeader", () => {
    const batch = encodeBatch(makeBatch([], [], []))
    assert.throws(() => decodeStreamHeader(batch), /expected stream header/)
  })
})

// ── Schema hash ────────────────────────────────────────────────────────────

describe("weavepack-log schema hash", () => {
  it("preserves non-zero schema hash in snapshot", () => {
    const hash = new Uint8Array(32)
    for (let i = 0; i < 32; i++) hash[i] = i
    const batch = { schemaHash: hash, seqs: [0n], tss: [0n], columns: [] }
    const rt = roundTrip(batch)
    assert.deepStrictEqual([...rt.schemaHash], [...hash])
  })
})

// ── Delta ops — event_append ───────────────────────────────────────────────

describe("weavepack-log event_append", () => {
  it("round-trips an event_append delta chain", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{
        op: OP.EVENT_APPEND,
        seqs: [5n, 6n, 7n],
        tss:  [1000n, 2000n, 3000n],
        columns: [
          { colId: 2, ctype: CTYPE.LEVEL, nullable: false,
            values: [LEVEL.INFO, LEVEL.WARN, LEVEL.ERROR] },
        ],
      }],
    })
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops.length, 1)
    const op = rt.ops[0]
    assert.strictEqual(op.op, OP.EVENT_APPEND)
    assert.strictEqual(op.seqs.length, 3)
    assert.ok(bigEq(op.seqs[0], 5n))
    assert.ok(bigEq(op.seqs[2], 7n))
    assert.deepStrictEqual(op.columns[0].values, [LEVEL.INFO, LEVEL.WARN, LEVEL.ERROR])
  })

  it("applyChain event_append extends the stream", () => {
    const snap = makeBatch([0n, 1n], [100n, 200n], [
      { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [10, 20] },
    ])
    let state = initState(decodeBatch(encodeBatch(snap)))

    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{
        op: OP.EVENT_APPEND,
        seqs: [2n, 3n],
        tss:  [300n, 400n],
        columns: [
          { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [30, 40] },
        ],
      }],
    }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.seqs.length, 4)
    assert.ok(bigEq(state.seqs[3], 3n))
    assert.deepStrictEqual(state.columns[0].values, [10, 20, 30, 40])
  })

  it("applyChain rejects non-monotone seq in event_append", () => {
    const snap = makeBatch([0n, 5n], [0n, 1n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    // Try to append seqs [3, 4] which are less than max existing seq 5.
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.EVENT_APPEND, seqs: [3n, 4n], tss: [2n, 3n], columns: [] }],
    }))
    assert.throws(() => applyChain(state, chain.ops), /seq_not_monotone/)
  })
})

// ── Delta ops — field_update ───────────────────────────────────────────────

describe("weavepack-log field_update", () => {
  it("round-trips a field_update delta chain", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{
        op: OP.FIELD_UPDATE,
        seq: 42n,
        columns: [
          { colId: 2, ctype: CTYPE.STRING, hasValue: true, value: "redacted" },
          { colId: 3, ctype: CTYPE.INT32,  hasValue: false, value: null },
        ],
      }],
    })
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops.length, 1)
    const op = rt.ops[0]
    assert.strictEqual(op.op, OP.FIELD_UPDATE)
    assert.ok(bigEq(op.seq, 42n))
    assert.strictEqual(op.columns[0].value, "redacted")
    assert.strictEqual(op.columns[1].value, null)
    assert.strictEqual(op.columns[1].hasValue, false)
  })

  it("applyChain field_update corrects a value", () => {
    const snap = makeBatch([0n, 1n], [0n, 1n], [
      { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [10, 20] },
    ])
    let state = initState(decodeBatch(encodeBatch(snap)))

    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{
        op: OP.FIELD_UPDATE,
        seq: 1n,
        columns: [{ colId: 2, ctype: CTYPE.INT32, hasValue: true, value: 99 }],
      }],
    }))
    state = applyChain(state, chain.ops)
    assert.deepStrictEqual(state.columns[0].values, [10, 99])
  })

  it("applyChain field_update rejects unknown seq", () => {
    const snap = makeBatch([0n], [0n], [
      { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [42] },
    ])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.FIELD_UPDATE, seq: 99n, columns: [{ colId: 2, ctype: CTYPE.INT32, hasValue: true, value: 1 }] }],
    }))
    assert.throws(() => applyChain(state, chain.ops), /unknown_seq/)
  })
})

// ── Delta ops — event_expire ───────────────────────────────────────────────

describe("weavepack-log event_expire", () => {
  it("round-trips an event_expire delta chain", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.EVENT_EXPIRE, seqLo: 10n, seqHi: 20n }],
    })
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops.length, 1)
    assert.ok(bigEq(rt.ops[0].seqLo, 10n))
    assert.ok(bigEq(rt.ops[0].seqHi, 20n))
  })

  it("applyChain event_expire marks events as expired", () => {
    const snap = makeBatch([0n,1n,2n,3n,4n], [0n,1n,2n,3n,4n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.EVENT_EXPIRE, seqLo: 1n, seqHi: 3n }],
    }))
    state = applyChain(state, chain.ops)
    assert.ok(state.expired.has("1"))
    assert.ok(state.expired.has("2"))
    assert.ok(state.expired.has("3"))
    assert.ok(!state.expired.has("0"))
    assert.ok(!state.expired.has("4"))
  })

  it("applyChain event_expire is idempotent", () => {
    const snap = makeBatch([0n,1n,2n], [0n,1n,2n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [
        { op: OP.EVENT_EXPIRE, seqLo: 0n, seqHi: 1n },
        { op: OP.EVENT_EXPIRE, seqLo: 0n, seqHi: 2n },
      ],
    }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.expired.size, 3)
  })

  it("rejects invalid seq range (lo > hi)", () => {
    assert.throws(() => {
      encodeChain({ ops: [{ op: OP.EVENT_EXPIRE, seqLo: 10n, seqHi: 5n }] })
    }, /invalid_seq_range/)
  })
})

// ── Delta ops — schema_evolve ──────────────────────────────────────────────

describe("weavepack-log schema_evolve", () => {
  it("round-trips column_add sub-op", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{
        op: OP.SCHEMA_EVOLVE,
        subOp: SCHEMA_SUB_OP.COLUMN_ADD,
        colId: 2, ctype: CTYPE.STRING, nullable: true,
        name: "request_id",
      }],
    })
    const rt = decodeChain(chain)
    const op = rt.ops[0]
    assert.strictEqual(op.op, OP.SCHEMA_EVOLVE)
    assert.strictEqual(op.subOp, SCHEMA_SUB_OP.COLUMN_ADD)
    assert.strictEqual(op.colId, 2)
    assert.strictEqual(op.ctype, CTYPE.STRING)
    assert.strictEqual(op.nullable, true)
    assert.strictEqual(op.name, "request_id")
  })

  it("round-trips column_drop sub-op", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_DROP, colId: 3 }],
    })
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops[0].subOp, SCHEMA_SUB_OP.COLUMN_DROP)
    assert.strictEqual(rt.ops[0].colId, 3)
  })

  it("round-trips column_rename sub-op", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_RENAME, colId: 4, name: "latency_ms" }],
    })
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops[0].subOp, SCHEMA_SUB_OP.COLUMN_RENAME)
    assert.strictEqual(rt.ops[0].colId, 4)
    assert.strictEqual(rt.ops[0].name, "latency_ms")
  })

  it("applyChain schema_evolve column_add tracks schema", () => {
    const snap = makeBatch([], [], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD,
              colId: 2, ctype: CTYPE.LEVEL, nullable: false, name: "severity" }],
    }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.schema.length, 1)
    assert.strictEqual(state.schema[0].name, "severity")
    assert.strictEqual(state.schema[0].ctype, CTYPE.LEVEL)
  })

  it("applyChain schema_evolve column_rename renames", () => {
    const snap = makeBatch([], [], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const ops1 = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD,
              colId: 2, ctype: CTYPE.STRING, nullable: false, name: "msg" }],
    }))
    const ops2 = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_RENAME, colId: 2, name: "message" }],
    }))
    state = applyChain(state, [...ops1.ops, ...ops2.ops])
    assert.strictEqual(state.schema[0].name, "message")
  })

  it("applyChain schema_evolve column_drop removes from schema", () => {
    const snap = makeBatch([], [], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const combined = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [
        { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD,
          colId: 2, ctype: CTYPE.INT32, nullable: false, name: "status" },
        { op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_DROP, colId: 2 },
      ],
    }))
    state = applyChain(state, combined.ops)
    assert.strictEqual(state.schema.length, 0)
  })

  it("rejects empty column name", () => {
    assert.throws(() => {
      encodeChain({ ops: [{ op: OP.SCHEMA_EVOLVE, subOp: SCHEMA_SUB_OP.COLUMN_ADD,
                            colId: 2, ctype: CTYPE.INT32, nullable: false, name: "" }] })
    }, /invalid_col_name/)
  })
})

// ── Delta ops — cursor_checkpoint ─────────────────────────────────────────

describe("weavepack-log cursor_checkpoint", () => {
  it("round-trips a cursor_checkpoint delta chain", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.CURSOR_CHECKPOINT, seq: 50000n, name: "analytics-pipeline" }],
    })
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops.length, 1)
    assert.ok(bigEq(rt.ops[0].seq, 50000n))
    assert.strictEqual(rt.ops[0].name, "analytics-pipeline")
  })

  it("applyChain cursor_checkpoint records cursor position", () => {
    const snap = makeBatch([0n,1n,2n], [0n,1n,2n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.CURSOR_CHECKPOINT, seq: 1n, name: "consumer-A" }],
    }))
    state = applyChain(state, chain.ops)
    assert.ok(bigEq(state.cursors.get("consumer-A"), 1n))
  })

  it("applyChain cursor_checkpoint is idempotent at same seq", () => {
    const snap = makeBatch([0n], [0n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [
        { op: OP.CURSOR_CHECKPOINT, seq: 0n, name: "consumer-A" },
        { op: OP.CURSOR_CHECKPOINT, seq: 0n, name: "consumer-A" },
      ],
    }))
    state = applyChain(state, chain.ops)
    assert.ok(bigEq(state.cursors.get("consumer-A"), 0n))
  })

  it("applyChain cursor_checkpoint rejects unknown seq", () => {
    const snap = makeBatch([0n], [0n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [{ op: OP.CURSOR_CHECKPOINT, seq: 99n, name: "consumer-A" }],
    }))
    assert.throws(() => applyChain(state, chain.ops), /unknown_seq/)
  })

  it("rejects empty cursor name", () => {
    assert.throws(() => {
      encodeChain({ ops: [{ op: OP.CURSOR_CHECKPOINT, seq: 0n, name: "" }] })
    }, /invalid_cursor_name/)
  })

  it("multiple cursors in the same stream", () => {
    const snap = makeBatch([0n,1n,2n,3n], [0n,1n,2n,3n], [])
    let state = initState(decodeBatch(encodeBatch(snap)))
    const chain = decodeChain(encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [
        { op: OP.CURSOR_CHECKPOINT, seq: 1n, name: "consumer-A" },
        { op: OP.CURSOR_CHECKPOINT, seq: 3n, name: "consumer-B" },
      ],
    }))
    state = applyChain(state, chain.ops)
    assert.ok(bigEq(state.cursors.get("consumer-A"), 1n))
    assert.ok(bigEq(state.cursors.get("consumer-B"), 3n))
  })
})

// ── Delta chain: multiple ops in one chain ─────────────────────────────────

describe("weavepack-log multi-op delta chains", () => {
  it("chain with event_append + cursor_checkpoint", () => {
    const chain = encodeChain({
      schemaHash: new Uint8Array(32),
      ops: [
        { op: OP.EVENT_APPEND, seqs: [10n,11n], tss: [1n,2n], columns: [] },
        { op: OP.CURSOR_CHECKPOINT, seq: 10n, name: "pipeline" },
      ],
    })
    // Decode and verify both ops round-trip.
    const rt = decodeChain(chain)
    assert.strictEqual(rt.ops.length, 2)
    assert.strictEqual(rt.ops[0].op, OP.EVENT_APPEND)
    assert.strictEqual(rt.ops[1].op, OP.CURSOR_CHECKPOINT)
  })
})

// ── Error paths ────────────────────────────────────────────────────────────

describe("weavepack-log error paths", () => {
  it("rejects reserved col_id < 2 in column block", () => {
    assert.throws(() => {
      encodeBatch(makeBatch([0n], [0n], [
        { colId: 1, ctype: CTYPE.INT32, nullable: false, values: [42] },
      ]))
    }, /reserved_col_id/)
  })

  it("rejects unknown_ctype ≥ 17", () => {
    assert.throws(() => {
      encodeBatch(makeBatch([0n], [0n], [
        { colId: 2, ctype: 17, nullable: false, values: [0] },
      ]))
    }, /unknown_ctype/)
  })

  it("rejects unknown_delta_op > 4", () => {
    assert.throws(() => {
      encodeChain({ ops: [{ op: 7, seq: 0n, name: "x" }] })
    }, /unknown_delta_op/)
  })

  it("decodeBatch rejects a delta chain byte stream", () => {
    const chain = encodeChain({ ops: [] })
    assert.throws(() => decodeBatch(chain), /expected event batch/)
  })

  it("decodeChain rejects a snapshot byte stream", () => {
    const snap = encodeBatch(makeBatch([], [], []))
    assert.throws(() => decodeChain(snap), /expected delta chain/)
  })
})
