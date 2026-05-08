// weavepack-wire — reference implementation tests (W.2).
//
// Covers: all scalar types, containers (message, repeated, map, oneof),
// delta ops (field_set, field_delete, message_replace, repeated_append,
// repeated_splice, map_set, map_delete, oneof_switch), and round-trip
// invariants.

import { describe, it } from "node:test"
import assert from "assert"
import {
  VTYPE, CTYPE, OP,
  encodeDocument, decodeDocument,
  encodeChain, decodeChain,
  applyChain,
} from "../src/profiles/wire/index.js"

// ── helpers ────────────────────────────────────────────────────────────────

function roundTrip(fields) {
  return decodeDocument(encodeDocument(fields))
}

function fieldByNum(fields, num) {
  return fields.find(f => f.num === num)
}

function approxEq(a, b, eps = 1e-6) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  return Math.abs(a - b) < eps
}

// ── Scalar round-trips ─────────────────────────────────────────────────────

describe("weavepack-wire scalar types", () => {
  it("bool true/false", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.BOOL, value: true },
      { num: 2, vtype: VTYPE.BOOL, value: false },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, true)
    assert.strictEqual(fieldByNum(dec, 2).value, false)
  })

  it("int32 positive, zero, negative", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.INT32, value: 0 },
      { num: 2, vtype: VTYPE.INT32, value: 1 },
      { num: 3, vtype: VTYPE.INT32, value: 127 },
      { num: 4, vtype: VTYPE.INT32, value: -1 },
      { num: 5, vtype: VTYPE.INT32, value: -2147483648 },
      { num: 6, vtype: VTYPE.INT32, value: 2147483647 },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0)
    assert.strictEqual(fieldByNum(dec, 2).value, 1)
    assert.strictEqual(fieldByNum(dec, 3).value, 127)
    assert.strictEqual(fieldByNum(dec, 4).value, -1)
    assert.strictEqual(fieldByNum(dec, 5).value, -2147483648)
    assert.strictEqual(fieldByNum(dec, 6).value, 2147483647)
  })

  it("uint32 range", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.UINT32, value: 0 },
      { num: 2, vtype: VTYPE.UINT32, value: 4294967295 },
      { num: 3, vtype: VTYPE.UINT32, value: 128 },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0)
    assert.strictEqual(fieldByNum(dec, 2).value, 4294967295)
    assert.strictEqual(fieldByNum(dec, 3).value, 128)
  })

  it("sint32 zigzag round-trip", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.SINT32, value: 0 },
      { num: 2, vtype: VTYPE.SINT32, value: -1 },
      { num: 3, vtype: VTYPE.SINT32, value: 1 },
      { num: 4, vtype: VTYPE.SINT32, value: -64 },
      { num: 5, vtype: VTYPE.SINT32, value: 63 },
      { num: 6, vtype: VTYPE.SINT32, value: -2147483648 },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0)
    assert.strictEqual(fieldByNum(dec, 2).value, -1)
    assert.strictEqual(fieldByNum(dec, 3).value, 1)
    assert.strictEqual(fieldByNum(dec, 4).value, -64)
    assert.strictEqual(fieldByNum(dec, 5).value, 63)
    assert.strictEqual(fieldByNum(dec, 6).value, -2147483648)
  })

  it("int64 round-trip (BigInt)", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.INT64, value: 0n },
      { num: 2, vtype: VTYPE.INT64, value: -1n },
      { num: 3, vtype: VTYPE.INT64, value: 9007199254740992n },  // > Number.MAX_SAFE_INTEGER
      { num: 4, vtype: VTYPE.INT64, value: -9223372036854775808n },  // INT64_MIN
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0n)
    assert.strictEqual(fieldByNum(dec, 2).value, -1n)
    assert.strictEqual(fieldByNum(dec, 3).value, 9007199254740992n)
    assert.strictEqual(fieldByNum(dec, 4).value, -9223372036854775808n)
  })

  it("uint64 round-trip (BigInt)", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.UINT64, value: 0n },
      { num: 2, vtype: VTYPE.UINT64, value: 18446744073709551615n },  // UINT64_MAX
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0n)
    assert.strictEqual(fieldByNum(dec, 2).value, 18446744073709551615n)
  })

  it("sint64 zigzag round-trip (BigInt)", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.SINT64, value: 0n },
      { num: 2, vtype: VTYPE.SINT64, value: -1n },
      { num: 3, vtype: VTYPE.SINT64, value: 1n },
      { num: 4, vtype: VTYPE.SINT64, value: -9223372036854775808n },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0n)
    assert.strictEqual(fieldByNum(dec, 2).value, -1n)
    assert.strictEqual(fieldByNum(dec, 3).value, 1n)
    assert.strictEqual(fieldByNum(dec, 4).value, -9223372036854775808n)
  })

  it("float32 round-trip including NaN and Inf", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.FLOAT32, value: 0.0 },
      { num: 2, vtype: VTYPE.FLOAT32, value: 3.14 },
      { num: 3, vtype: VTYPE.FLOAT32, value: -0.0 },
      { num: 4, vtype: VTYPE.FLOAT32, value: Infinity },
      { num: 5, vtype: VTYPE.FLOAT32, value: -Infinity },
      { num: 6, vtype: VTYPE.FLOAT32, value: NaN },
    ])
    assert.ok(approxEq(fieldByNum(dec, 1).value, 0.0))
    assert.ok(approxEq(fieldByNum(dec, 2).value, 3.14, 1e-5))
    assert.ok(Object.is(fieldByNum(dec, 3).value, -0.0))
    assert.strictEqual(fieldByNum(dec, 4).value, Infinity)
    assert.strictEqual(fieldByNum(dec, 5).value, -Infinity)
    assert.ok(Number.isNaN(fieldByNum(dec, 6).value))
  })

  it("float64 round-trip", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.FLOAT64, value: Math.PI },
      { num: 2, vtype: VTYPE.FLOAT64, value: Number.MAX_VALUE },
      { num: 3, vtype: VTYPE.FLOAT64, value: -Number.MAX_VALUE },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, Math.PI)
    assert.strictEqual(fieldByNum(dec, 2).value, Number.MAX_VALUE)
    assert.strictEqual(fieldByNum(dec, 3).value, -Number.MAX_VALUE)
  })

  it("string: empty, ASCII, BMP Unicode, emoji", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.STRING, value: "" },
      { num: 2, vtype: VTYPE.STRING, value: "hello" },
      { num: 3, vtype: VTYPE.STRING, value: "こんにちは" },
      { num: 4, vtype: VTYPE.STRING, value: "🎉🚀" },
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, "")
    assert.strictEqual(fieldByNum(dec, 2).value, "hello")
    assert.strictEqual(fieldByNum(dec, 3).value, "こんにちは")
    assert.strictEqual(fieldByNum(dec, 4).value, "🎉🚀")
  })

  it("bytes: empty and non-empty", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.BYTES, value: new Uint8Array([]) },
      { num: 2, vtype: VTYPE.BYTES, value: new Uint8Array([0x00, 0xFF, 0x80]) },
    ])
    assert.deepStrictEqual(fieldByNum(dec, 1).value, new Uint8Array([]))
    assert.deepStrictEqual(fieldByNum(dec, 2).value, new Uint8Array([0x00, 0xFF, 0x80]))
  })

  it("enum (int32 semantics)", () => {
    const dec = roundTrip([
      { num: 1, vtype: VTYPE.ENUM, value: 0 },
      { num: 2, vtype: VTYPE.ENUM, value: 2 },
      { num: 3, vtype: VTYPE.ENUM, value: -1 },  // unknown value preserved (open enum)
    ])
    assert.strictEqual(fieldByNum(dec, 1).value, 0)
    assert.strictEqual(fieldByNum(dec, 2).value, 2)
    assert.strictEqual(fieldByNum(dec, 3).value, -1)
  })
})

// ── Container round-trips ──────────────────────────────────────────────────

describe("weavepack-wire containers", () => {
  it("nested message", () => {
    const dec = roundTrip([{
      num: 1,
      message: [
        { num: 1, vtype: VTYPE.STRING, value: "inner" },
        { num: 2, vtype: VTYPE.INT32, value: 42 },
      ],
    }])
    const outer = fieldByNum(dec, 1)
    assert.ok(outer.message)
    assert.strictEqual(fieldByNum(outer.message, 1).value, "inner")
    assert.strictEqual(fieldByNum(outer.message, 2).value, 42)
  })

  it("empty nested message", () => {
    const dec = roundTrip([{ num: 1, message: [] }])
    assert.ok(Array.isArray(fieldByNum(dec, 1).message))
    assert.strictEqual(fieldByNum(dec, 1).message.length, 0)
  })

  it("repeated int32", () => {
    const dec = roundTrip([{
      num: 1,
      repeated: { elemType: VTYPE.INT32, values: [10, 20, 30] },
    }])
    const f = fieldByNum(dec, 1)
    assert.ok(f.repeated)
    assert.deepStrictEqual(f.repeated.values, [10, 20, 30])
  })

  it("empty repeated", () => {
    const dec = roundTrip([{
      num: 1,
      repeated: { elemType: VTYPE.STRING, values: [] },
    }])
    assert.deepStrictEqual(fieldByNum(dec, 1).repeated.values, [])
  })

  it("map with string keys", () => {
    const dec = roundTrip([{
      num: 1,
      map: {
        keyType: "string",
        valueType: VTYPE.INT32,
        entries: [["alpha", 1], ["beta", 2]],
      },
    }])
    const f = fieldByNum(dec, 1)
    assert.ok(f.map)
    assert.strictEqual(f.map.keyType, "string")
    assert.strictEqual(f.map.entries.length, 2)
    const m = Object.fromEntries(f.map.entries)
    assert.strictEqual(m["alpha"], 1)
    assert.strictEqual(m["beta"], 2)
  })

  it("map with uint32 keys", () => {
    const dec = roundTrip([{
      num: 1,
      map: {
        keyType: "uint32",
        valueType: VTYPE.STRING,
        entries: [[42, "answer"], [1, "one"]],
      },
    }])
    const f = fieldByNum(dec, 1)
    assert.strictEqual(f.map.keyType, "uint32")
    const m = Object.fromEntries(f.map.entries)
    assert.strictEqual(m[42], "answer")
    assert.strictEqual(m[1], "one")
  })

  it("oneof field", () => {
    const dec = roundTrip([{
      num: 1,
      oneof: { activeField: 3, valueType: VTYPE.STRING, value: "chosen" },
    }])
    const f = fieldByNum(dec, 1)
    assert.ok(f.oneof)
    assert.strictEqual(f.oneof.activeField, 3)
    assert.strictEqual(f.oneof.value, "chosen")
  })
})

// ── Field ordering ─────────────────────────────────────────────────────────

describe("weavepack-wire field ordering", () => {
  it("fields round-trip in ascending field_number order regardless of insertion order", () => {
    const dec = roundTrip([
      { num: 5, vtype: VTYPE.INT32, value: 5 },
      { num: 1, vtype: VTYPE.INT32, value: 1 },
      { num: 3, vtype: VTYPE.INT32, value: 3 },
    ])
    assert.deepStrictEqual(dec.map(f => f.num), [1, 3, 5])
  })

  it("empty message round-trips", () => {
    const dec = roundTrip([])
    assert.deepStrictEqual(dec, [])
  })
})

// ── Delta chain round-trips ────────────────────────────────────────────────

describe("weavepack-wire delta chain encode/decode", () => {
  it("field_set scalar", () => {
    const ops = [{ op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 99 } }]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec.length, 1)
    assert.strictEqual(dec[0].op, OP.FIELD_SET)
    assert.strictEqual(dec[0].value.value, 99)
    assert.strictEqual(dec[0].value.vtype, VTYPE.INT32)
  })

  it("field_delete", () => {
    const ops = [{ op: OP.FIELD_DELETE, path: [{ field: 2 }] }]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec[0].op, OP.FIELD_DELETE)
    assert.deepStrictEqual(dec[0].path, [{ field: 2 }])
  })

  it("message_replace", () => {
    const msg = [{ num: 1, vtype: VTYPE.STRING, value: "replaced" }]
    const ops = [{ op: OP.MESSAGE_REPLACE, path: [], message: msg }]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec[0].op, OP.MESSAGE_REPLACE)
    assert.strictEqual(dec[0].message[0].value, "replaced")
  })

  it("repeated_append", () => {
    const ops = [{
      op: OP.REPEATED_APPEND,
      path: [{ field: 3 }],
      elements: { elemType: VTYPE.INT32, values: [7, 8, 9] },
    }]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec[0].op, OP.REPEATED_APPEND)
    assert.deepStrictEqual(dec[0].elements.values, [7, 8, 9])
  })

  it("repeated_splice", () => {
    const ops = [{
      op: OP.REPEATED_SPLICE,
      path: [{ field: 3 }],
      index: 1,
      deleteCount: 2,
      elemType: VTYPE.INT32,
      insertValues: [99, 100],
    }]
    const dec = decodeChain(encodeChain(ops))
    const d = dec[0]
    assert.strictEqual(d.op, OP.REPEATED_SPLICE)
    assert.strictEqual(d.index, 1)
    assert.strictEqual(d.deleteCount, 2)
    assert.deepStrictEqual(d.insertValues, [99, 100])
  })

  it("map_set string key", () => {
    const ops = [{
      op: OP.MAP_SET,
      path: [{ field: 4 }],
      keyType: "string", key: "x",
      valueType: VTYPE.FLOAT64, value: 1.23,
    }]
    const dec = decodeChain(encodeChain(ops))
    const d = dec[0]
    assert.strictEqual(d.op, OP.MAP_SET)
    assert.strictEqual(d.key, "x")
    assert.ok(approxEq(d.value, 1.23))
  })

  it("map_set uint32 key", () => {
    const ops = [{
      op: OP.MAP_SET,
      path: [{ field: 4 }],
      keyType: "uint32", key: 42,
      valueType: VTYPE.STRING, value: "v",
    }]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec[0].key, 42)
    assert.strictEqual(dec[0].value, "v")
  })

  it("map_delete", () => {
    const ops = [{ op: OP.MAP_DELETE, path: [{ field: 4 }], keyType: "string", key: "old" }]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec[0].op, OP.MAP_DELETE)
    assert.strictEqual(dec[0].key, "old")
  })

  it("oneof_switch", () => {
    const ops = [{
      op: OP.ONEOF_SWITCH,
      path: [{ field: 5 }],
      activeField: 2,
      valueType: VTYPE.BOOL,
      value: true,
    }]
    const dec = decodeChain(encodeChain(ops))
    const d = dec[0]
    assert.strictEqual(d.op, OP.ONEOF_SWITCH)
    assert.strictEqual(d.activeField, 2)
    assert.strictEqual(d.value, true)
  })

  it("multi-op chain round-trips", () => {
    const ops = [
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 1 } },
      { op: OP.FIELD_SET, path: [{ field: 2 }], value: { vtype: VTYPE.STRING, value: "hello" } },
      { op: OP.FIELD_DELETE, path: [{ field: 3 }] },
    ]
    const dec = decodeChain(encodeChain(ops))
    assert.strictEqual(dec.length, 3)
    assert.strictEqual(dec[0].value.value, 1)
    assert.strictEqual(dec[1].value.value, "hello")
    assert.strictEqual(dec[2].op, OP.FIELD_DELETE)
  })

  it("empty chain", () => {
    const dec = decodeChain(encodeChain([]))
    assert.deepStrictEqual(dec, [])
  })
})

// ── applyChain ─────────────────────────────────────────────────────────────

describe("weavepack-wire applyChain", () => {
  it("field_set adds a field", () => {
    const base = [{ num: 1, vtype: VTYPE.INT32, value: 10 }]
    const result = applyChain(base, [
      { op: OP.FIELD_SET, path: [{ field: 2 }], value: { vtype: VTYPE.STRING, value: "new" } },
    ])
    assert.strictEqual(result.length, 2)
    assert.strictEqual(fieldByNum(result, 2).value, "new")
  })

  it("field_set replaces existing field (last-write-wins)", () => {
    const base = [{ num: 1, vtype: VTYPE.INT32, value: 10 }]
    const result = applyChain(base, [
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 99 } },
    ])
    assert.strictEqual(fieldByNum(result, 1).value, 99)
  })

  it("field_delete removes a field", () => {
    const base = [
      { num: 1, vtype: VTYPE.INT32, value: 10 },
      { num: 2, vtype: VTYPE.STRING, value: "bye" },
    ]
    const result = applyChain(base, [{ op: OP.FIELD_DELETE, path: [{ field: 2 }] }])
    assert.strictEqual(result.length, 1)
    assert.ok(!fieldByNum(result, 2))
  })

  it("field_delete on absent field is no-op", () => {
    const base = [{ num: 1, vtype: VTYPE.INT32, value: 10 }]
    const result = applyChain(base, [{ op: OP.FIELD_DELETE, path: [{ field: 99 }] }])
    assert.strictEqual(result.length, 1)
  })

  it("message_replace replaces root", () => {
    const base = [{ num: 1, vtype: VTYPE.INT32, value: 10 }]
    const newMsg = [{ num: 2, vtype: VTYPE.STRING, value: "replaced" }]
    const result = applyChain(base, [{ op: OP.MESSAGE_REPLACE, path: [], message: newMsg }])
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].num, 2)
    assert.strictEqual(result[0].value, "replaced")
  })

  it("repeated_append appends elements", () => {
    const base = [{ num: 1, repeated: { elemType: VTYPE.INT32, values: [1, 2] } }]
    const result = applyChain(base, [{
      op: OP.REPEATED_APPEND,
      path: [{ field: 1 }],
      elements: { elemType: VTYPE.INT32, values: [3, 4] },
    }])
    assert.deepStrictEqual(fieldByNum(result, 1).repeated.values, [1, 2, 3, 4])
  })

  it("repeated_append creates field if absent", () => {
    const base = []
    const result = applyChain(base, [{
      op: OP.REPEATED_APPEND,
      path: [{ field: 5 }],
      elements: { elemType: VTYPE.INT32, values: [10] },
    }])
    assert.deepStrictEqual(fieldByNum(result, 5).repeated.values, [10])
  })

  it("repeated_splice deletes and inserts", () => {
    const base = [{ num: 1, repeated: { elemType: VTYPE.INT32, values: [10, 20, 30, 40] } }]
    const result = applyChain(base, [{
      op: OP.REPEATED_SPLICE,
      path: [{ field: 1 }],
      index: 1,
      deleteCount: 2,
      elemType: VTYPE.INT32,
      insertValues: [99],
    }])
    assert.deepStrictEqual(fieldByNum(result, 1).repeated.values, [10, 99, 40])
  })

  it("map_set adds entry", () => {
    const base = []
    const result = applyChain(base, [{
      op: OP.MAP_SET,
      path: [{ field: 1 }],
      keyType: "string", key: "k1",
      valueType: VTYPE.INT32, value: 100,
    }])
    const f = fieldByNum(result, 1)
    assert.ok(f.map)
    assert.strictEqual(Object.fromEntries(f.map.entries)["k1"], 100)
  })

  it("map_set updates existing entry", () => {
    const base = [{
      num: 1,
      map: { keyType: "string", valueType: VTYPE.INT32, entries: [["k1", 1]] },
    }]
    const result = applyChain(base, [{
      op: OP.MAP_SET,
      path: [{ field: 1 }],
      keyType: "string", key: "k1",
      valueType: VTYPE.INT32, value: 42,
    }])
    assert.strictEqual(Object.fromEntries(fieldByNum(result, 1).map.entries)["k1"], 42)
  })

  it("map_delete removes entry", () => {
    const base = [{
      num: 1,
      map: { keyType: "string", valueType: VTYPE.INT32, entries: [["a", 1], ["b", 2]] },
    }]
    const result = applyChain(base, [{
      op: OP.MAP_DELETE, path: [{ field: 1 }], keyType: "string", key: "a",
    }])
    const entries = fieldByNum(result, 1).map.entries
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0][0], "b")
  })

  it("oneof_switch changes active case", () => {
    const base = [{
      num: 1, oneof: { activeField: 1, valueType: VTYPE.STRING, value: "old" },
    }]
    const result = applyChain(base, [{
      op: OP.ONEOF_SWITCH,
      path: [{ field: 1 }],
      activeField: 2,
      valueType: VTYPE.INT32,
      value: 777,
    }])
    const f = fieldByNum(result, 1)
    assert.strictEqual(f.oneof.activeField, 2)
    assert.strictEqual(f.oneof.value, 777)
  })

  it("chain is applied in order (LWW on same field)", () => {
    const base = [{ num: 1, vtype: VTYPE.INT32, value: 0 }]
    const result = applyChain(base, [
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 1 } },
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 2 } },
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 3 } },
    ])
    assert.strictEqual(fieldByNum(result, 1).value, 3)
  })

  it("delete then set = field present with new value", () => {
    const base = [{ num: 1, vtype: VTYPE.INT32, value: 10 }]
    const result = applyChain(base, [
      { op: OP.FIELD_DELETE, path: [{ field: 1 }] },
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.INT32, value: 42 } },
    ])
    assert.strictEqual(fieldByNum(result, 1).value, 42)
  })

  it("apply then re-encode round-trips", () => {
    const base = [{ num: 1, vtype: VTYPE.STRING, value: "original" }]
    const updated = applyChain(base, [
      { op: OP.FIELD_SET, path: [{ field: 1 }], value: { vtype: VTYPE.STRING, value: "updated" } },
      { op: OP.FIELD_SET, path: [{ field: 2 }], value: { vtype: VTYPE.BOOL, value: true } },
    ])
    const reDecoded = decodeDocument(encodeDocument(updated))
    assert.strictEqual(fieldByNum(reDecoded, 1).value, "updated")
    assert.strictEqual(fieldByNum(reDecoded, 2).value, true)
  })
})
