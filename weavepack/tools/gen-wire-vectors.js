// Generator: compute expected_bytes_hex for wire profile test vectors.
// Run once to produce the JSON files; output goes to stdout.
// Usage: node weavepack/tools/gen-wire-vectors.js

import {
  encodeDocument, encodeChain, decodeDocument, decodeChain, applyChain,
  VTYPE, OP,
} from "../../sdk/src/profiles/wire/index.js"

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
}

// Serialize BigInt and Uint8Array values in JSON output.
// - BigInt → string (e.g. "9007199254740992")
// - Uint8Array → {"_bytes": [0, 1, 255, ...]} tagged object
function safeJSON(v) {
  return JSON.stringify(v, (_k, val) => {
    if (typeof val === "bigint") return val.toString()
    if (val instanceof Uint8Array) return { _bytes: Array.from(val) }
    return val
  }, 2)
}

function snap(fields) { return toHex(encodeDocument(fields)) }
function chain(ops)   { return toHex(encodeChain(ops)) }

// ── types/scalars.json ─────────────────────────────────────────────────────

const scalarsVectors = [
  { name: "bool false", description: "single bool false", input: [{num:1, vtype:VTYPE.BOOL, value:false}] },
  { name: "bool true",  description: "single bool true",  input: [{num:1, vtype:VTYPE.BOOL, value:true}] },
  { name: "int32 zero",    description: "int32 zero",        input: [{num:1, vtype:VTYPE.INT32, value:0}] },
  { name: "int32 pos",     description: "int32 positive",    input: [{num:1, vtype:VTYPE.INT32, value:300}] },
  { name: "int32 neg",     description: "int32 negative",    input: [{num:1, vtype:VTYPE.INT32, value:-1}] },
  { name: "int32 min",     description: "int32 min",         input: [{num:1, vtype:VTYPE.INT32, value:-2147483648}] },
  { name: "int32 max",     description: "int32 max",         input: [{num:1, vtype:VTYPE.INT32, value:2147483647}] },
  { name: "uint32 zero",   description: "uint32 zero",       input: [{num:1, vtype:VTYPE.UINT32, value:0}] },
  { name: "uint32 max",    description: "uint32 max",        input: [{num:1, vtype:VTYPE.UINT32, value:4294967295}] },
  { name: "sint32 zero",   description: "sint32 zero",       input: [{num:1, vtype:VTYPE.SINT32, value:0}] },
  { name: "sint32 pos",    description: "sint32 positive",   input: [{num:1, vtype:VTYPE.SINT32, value:1}] },
  { name: "sint32 neg",    description: "sint32 negative",   input: [{num:1, vtype:VTYPE.SINT32, value:-1}] },
  { name: "int64 zero",    description: "int64 zero",        input: [{num:1, vtype:VTYPE.INT64, value:0n}] },
  { name: "int64 large",   description: "int64 large pos",   input: [{num:1, vtype:VTYPE.INT64, value:9007199254740992n}] },
  { name: "int64 neg",     description: "int64 negative",    input: [{num:1, vtype:VTYPE.INT64, value:-1n}] },
  { name: "uint64 zero",   description: "uint64 zero",       input: [{num:1, vtype:VTYPE.UINT64, value:0n}] },
  { name: "uint64 large",  description: "uint64 large",      input: [{num:1, vtype:VTYPE.UINT64, value:18446744073709551615n}] },
  { name: "sint64 zero",   description: "sint64 zero",       input: [{num:1, vtype:VTYPE.SINT64, value:0n}] },
  { name: "sint64 neg",    description: "sint64 negative",   input: [{num:1, vtype:VTYPE.SINT64, value:-1n}] },
  { name: "float32 zero",  description: "float32 zero",      input: [{num:1, vtype:VTYPE.FLOAT32, value:0.0}] },
  { name: "float32 pi",    description: "float32 pi",        input: [{num:1, vtype:VTYPE.FLOAT32, value:Math.fround(3.14159)}] },
  { name: "float32 neg",   description: "float32 negative",  input: [{num:1, vtype:VTYPE.FLOAT32, value:-1.5}] },
  { name: "float64 zero",  description: "float64 zero",      input: [{num:1, vtype:VTYPE.FLOAT64, value:0.0}] },
  { name: "float64 pi",    description: "float64 pi",        input: [{num:1, vtype:VTYPE.FLOAT64, value:3.141592653589793}] },
  { name: "float64 neg",   description: "float64 negative",  input: [{num:1, vtype:VTYPE.FLOAT64, value:-1e100}] },
  { name: "enum zero",     description: "enum value 0",      input: [{num:1, vtype:VTYPE.ENUM, value:0}] },
  { name: "enum positive", description: "enum value 3",      input: [{num:1, vtype:VTYPE.ENUM, value:3}] },
]

const scalarsResult = scalarsVectors.map(v => ({
  name: v.name,
  description: v.description,
  input: v.input,
  expected_bytes_hex: snap(v.input),
}))

// ── types/strings.json ─────────────────────────────────────────────────────

const stringsVectors = [
  { name: "empty string",     input: [{num:1, vtype:VTYPE.STRING, value:""}] },
  { name: "ascii string",     input: [{num:1, vtype:VTYPE.STRING, value:"hello"}] },
  { name: "unicode BMP",      input: [{num:1, vtype:VTYPE.STRING, value:"héllo wörld"}] },
  { name: "emoji",            input: [{num:1, vtype:VTYPE.STRING, value:"hi 🎉 emoji"}] },
  { name: "null byte string", input: [{num:1, vtype:VTYPE.STRING, value:"a\x00b"}] },
  { name: "empty bytes",      input: [{num:1, vtype:VTYPE.BYTES, value:new Uint8Array([])}] },
  { name: "bytes sequence",   input: [{num:1, vtype:VTYPE.BYTES, value:new Uint8Array([0,1,127,128,255])}] },
]

const stringsResult = stringsVectors.map(v => ({
  name: v.name,
  input: v.input,
  expected_bytes_hex: snap(v.input),
}))

// ── containers/messages.json ───────────────────────────────────────────────

const messagesVectors = [
  {
    name: "empty message",
    input: [],
    description: "zero-field message",
  },
  {
    name: "single scalar field",
    input: [{num:1, vtype:VTYPE.INT32, value:42}],
    description: "one int32 field",
  },
  {
    name: "multiple scalar fields",
    input: [
      {num:1, vtype:VTYPE.STRING, value:"alice"},
      {num:2, vtype:VTYPE.INT32, value:30},
      {num:3, vtype:VTYPE.BOOL, value:true},
    ],
    description: "three scalar fields of different types",
  },
  {
    name: "nested message",
    input: [
      {num:1, vtype:VTYPE.STRING, value:"outer"},
      {num:2, message: [
        {num:1, vtype:VTYPE.INT32, value:99},
        {num:2, vtype:VTYPE.STRING, value:"inner"},
      ]},
    ],
    description: "one level of nesting",
  },
  {
    name: "doubly nested message",
    input: [
      {num:1, message: [
        {num:1, message: [
          {num:1, vtype:VTYPE.BOOL, value:true},
        ]},
      ]},
    ],
    description: "two levels of nesting",
  },
  {
    name: "field order canonicalized",
    description: "fields provided out-of-order but encoded in ascending field-number order",
    input: [
      {num:3, vtype:VTYPE.INT32, value:3},
      {num:1, vtype:VTYPE.INT32, value:1},
      {num:2, vtype:VTYPE.INT32, value:2},
    ],
  },
]

const messagesResult = messagesVectors.map(v => ({
  name: v.name,
  description: v.description,
  input: v.input,
  expected_bytes_hex: snap(v.input),
}))

// ── containers/repeated.json ───────────────────────────────────────────────

const repeatedVectors = [
  {
    name: "empty repeated int32",
    input: [{num:1, repeated:{elemType:VTYPE.INT32, values:[]}}],
  },
  {
    name: "single element repeated",
    input: [{num:1, repeated:{elemType:VTYPE.UINT32, values:[42]}}],
  },
  {
    name: "multi-element repeated int32",
    input: [{num:1, repeated:{elemType:VTYPE.INT32, values:[1,2,3,4,5]}}],
  },
  {
    name: "repeated bool",
    input: [{num:1, repeated:{elemType:VTYPE.BOOL, values:[true,false,true]}}],
  },
  {
    name: "repeated string",
    input: [{num:2, repeated:{elemType:VTYPE.STRING, values:["alpha","beta","gamma"]}}],
  },
  {
    name: "repeated float32",
    input: [{num:3, repeated:{elemType:VTYPE.FLOAT32, values:[1.0, 2.0, 3.0]}}],
  },
]

const repeatedResult = repeatedVectors.map(v => ({
  name: v.name,
  input: v.input,
  expected_bytes_hex: snap(v.input),
}))

// ── containers/maps.json ───────────────────────────────────────────────────

const mapsVectors = [
  {
    name: "empty string-key map",
    input: [{num:1, map:{keyType:"string", valueType:VTYPE.INT32, entries:[]}}],
  },
  {
    name: "string-key map single entry",
    input: [{num:1, map:{keyType:"string", valueType:VTYPE.INT32, entries:[["score", 100]]}}],
  },
  {
    name: "string-key map multi entry",
    input: [{num:1, map:{keyType:"string", valueType:VTYPE.STRING, entries:[["a","alpha"],["b","beta"],["c","gamma"]]}}],
  },
  {
    name: "uint32-key map",
    input: [{num:1, map:{keyType:"uint32", valueType:VTYPE.BOOL, entries:[[1,true],[2,false],[3,true]]}}],
  },
  {
    name: "map with float64 values",
    input: [{num:2, map:{keyType:"string", valueType:VTYPE.FLOAT64, entries:[["pi", 3.14159265358979],["e", 2.71828182845904]]}}],
  },
]

const mapsResult = mapsVectors.map(v => ({
  name: v.name,
  input: v.input,
  expected_bytes_hex: snap(v.input),
}))

// ── containers/oneofs.json ─────────────────────────────────────────────────

const oneofsVectors = [
  {
    name: "oneof string case",
    input: [{num:1, oneof:{activeField:1, valueType:VTYPE.STRING, value:"hello"}}],
  },
  {
    name: "oneof int32 case",
    input: [{num:1, oneof:{activeField:2, valueType:VTYPE.INT32, value:42}}],
  },
  {
    name: "oneof bool case",
    input: [{num:1, oneof:{activeField:3, valueType:VTYPE.BOOL, value:true}}],
  },
]

const oneofsResult = oneofsVectors.map(v => ({
  name: v.name,
  input: v.input,
  expected_bytes_hex: snap(v.input),
}))

// ── deltas/field_ops.json ──────────────────────────────────────────────────

const fieldOpsVectors = [
  {
    name: "field_set scalar",
    description: "set field 1 to a new int32 value",
    initial: [{num:1, vtype:VTYPE.INT32, value:10}, {num:2, vtype:VTYPE.STRING, value:"hello"}],
    ops: [{ op:OP.FIELD_SET, path:[{field:1}], value:{vtype:VTYPE.INT32, value:99} }],
  },
  {
    name: "field_set adds missing field",
    description: "set creates field if not present",
    initial: [{num:1, vtype:VTYPE.STRING, value:"x"}],
    ops: [{ op:OP.FIELD_SET, path:[{field:2}], value:{vtype:VTYPE.UINT32, value:777} }],
  },
  {
    name: "field_delete removes field",
    description: "delete removes an existing field",
    initial: [{num:1, vtype:VTYPE.INT32, value:5}, {num:2, vtype:VTYPE.BOOL, value:true}],
    ops: [{ op:OP.FIELD_DELETE, path:[{field:1}] }],
  },
  {
    name: "field_delete absent field is no-op",
    description: "deleting a non-existent field is a no-op",
    initial: [{num:1, vtype:VTYPE.INT32, value:5}],
    ops: [{ op:OP.FIELD_DELETE, path:[{field:99}] }],
  },
  {
    name: "message_replace root",
    description: "replace the entire root message",
    initial: [{num:1, vtype:VTYPE.INT32, value:1}, {num:2, vtype:VTYPE.INT32, value:2}],
    ops: [{ op:OP.MESSAGE_REPLACE, path:[], message:[{num:1, vtype:VTYPE.STRING, value:"new"}] }],
  },
  {
    name: "message_replace nested",
    description: "replace a nested sub-message",
    initial: [{num:1, message:[{num:1, vtype:VTYPE.INT32, value:1}]}],
    ops: [{ op:OP.MESSAGE_REPLACE, path:[{field:1}], message:[{num:1, vtype:VTYPE.INT32, value:99}] }],
  },
  {
    name: "field_set then field_delete",
    description: "last-write-wins + delete composition",
    initial: [{num:1, vtype:VTYPE.INT32, value:1}],
    ops: [
      { op:OP.FIELD_SET, path:[{field:1}], value:{vtype:VTYPE.INT32, value:2} },
      { op:OP.FIELD_DELETE, path:[{field:1}] },
    ],
  },
]

const fieldOpsResult = fieldOpsVectors.map(v => {
  const opsChain = encodeChain(v.ops)
  const final = applyChain(v.initial, v.ops)
  return {
    name: v.name,
    description: v.description,
    initial: v.initial,
    ops: v.ops,
    expected_chain_bytes_hex: toHex(opsChain),
    expected_final: final,
  }
})

// ── deltas/repeated_ops.json ───────────────────────────────────────────────

const repeatedOpsVectors = [
  {
    name: "repeated_append to empty",
    description: "append creates the repeated field if absent",
    initial: [],
    ops: [{ op:OP.REPEATED_APPEND, path:[{field:1}], elements:{elemType:VTYPE.INT32, values:[10,20,30]} }],
  },
  {
    name: "repeated_append to existing",
    description: "appends to an existing repeated field",
    initial: [{num:1, repeated:{elemType:VTYPE.INT32, values:[1,2,3]}}],
    ops: [{ op:OP.REPEATED_APPEND, path:[{field:1}], elements:{elemType:VTYPE.INT32, values:[4,5]} }],
  },
  {
    name: "repeated_splice delete middle",
    description: "delete 2 elements from the middle",
    initial: [{num:1, repeated:{elemType:VTYPE.UINT32, values:[10,20,30,40,50]}}],
    ops: [{ op:OP.REPEATED_SPLICE, path:[{field:1}], index:1, deleteCount:2, elemType:VTYPE.UINT32, insertValues:[] }],
  },
  {
    name: "repeated_splice insert at head",
    description: "insert at position 0",
    initial: [{num:1, repeated:{elemType:VTYPE.INT32, values:[3,4,5]}}],
    ops: [{ op:OP.REPEATED_SPLICE, path:[{field:1}], index:0, deleteCount:0, elemType:VTYPE.INT32, insertValues:[1,2] }],
  },
  {
    name: "repeated_splice replace element",
    description: "delete 1 and insert 1 at same position",
    initial: [{num:1, repeated:{elemType:VTYPE.INT32, values:[1,2,3]}}],
    ops: [{ op:OP.REPEATED_SPLICE, path:[{field:1}], index:1, deleteCount:1, elemType:VTYPE.INT32, insertValues:[99] }],
  },
]

const repeatedOpsResult = repeatedOpsVectors.map(v => {
  const opsChain = encodeChain(v.ops)
  const final = applyChain(v.initial, v.ops)
  return {
    name: v.name,
    description: v.description,
    initial: v.initial,
    ops: v.ops,
    expected_chain_bytes_hex: toHex(opsChain),
    expected_final: final,
  }
})

// ── deltas/map_ops.json ────────────────────────────────────────────────────

const mapOpsVectors = [
  {
    name: "map_set creates entry",
    description: "set a map entry in a map that doesn't exist yet",
    initial: [],
    ops: [{ op:OP.MAP_SET, path:[{field:1}], keyType:"string", key:"x", valueType:VTYPE.INT32, value:42 }],
  },
  {
    name: "map_set updates entry",
    description: "update an existing map entry",
    initial: [{num:1, map:{keyType:"string", valueType:VTYPE.INT32, entries:[["x",1],["y",2]]}}],
    ops: [{ op:OP.MAP_SET, path:[{field:1}], keyType:"string", key:"x", valueType:VTYPE.INT32, value:99 }],
  },
  {
    name: "map_delete removes entry",
    description: "delete an existing entry from a map",
    initial: [{num:1, map:{keyType:"string", valueType:VTYPE.STRING, entries:[["a","alpha"],["b","beta"]]}}],
    ops: [{ op:OP.MAP_DELETE, path:[{field:1}], keyType:"string", key:"a" }],
  },
  {
    name: "map_set with uint32 key",
    description: "integer-keyed map entry set",
    initial: [{num:1, map:{keyType:"uint32", valueType:VTYPE.BOOL, entries:[[1,true]]}}],
    ops: [{ op:OP.MAP_SET, path:[{field:1}], keyType:"uint32", key:2, valueType:VTYPE.BOOL, value:false }],
  },
  {
    name: "map_delete absent key is no-op",
    description: "deleting a key that is not in the map is a no-op",
    initial: [{num:1, map:{keyType:"string", valueType:VTYPE.INT32, entries:[["x",1]]}}],
    ops: [{ op:OP.MAP_DELETE, path:[{field:1}], keyType:"string", key:"z" }],
  },
]

const mapOpsResult = mapOpsVectors.map(v => {
  const opsChain = encodeChain(v.ops)
  const final = applyChain(v.initial, v.ops)
  return {
    name: v.name,
    description: v.description,
    initial: v.initial,
    ops: v.ops,
    expected_chain_bytes_hex: toHex(opsChain),
    expected_final: final,
  }
})

// ── deltas/oneof_ops.json ──────────────────────────────────────────────────

const oneofOpsVectors = [
  {
    name: "oneof_switch string to int32",
    description: "switch the active case from string to int32",
    initial: [{num:1, oneof:{activeField:1, valueType:VTYPE.STRING, value:"hello"}}],
    ops: [{ op:OP.ONEOF_SWITCH, path:[{field:1}], activeField:2, valueType:VTYPE.INT32, value:42 }],
  },
  {
    name: "oneof_switch creates oneof",
    description: "oneof_switch creates the oneof field if absent",
    initial: [],
    ops: [{ op:OP.ONEOF_SWITCH, path:[{field:1}], activeField:1, valueType:VTYPE.BOOL, value:true }],
  },
  {
    name: "oneof_switch idempotent same case",
    description: "switching to the same case with a new value",
    initial: [{num:1, oneof:{activeField:3, valueType:VTYPE.FLOAT32, value:1.0}}],
    ops: [{ op:OP.ONEOF_SWITCH, path:[{field:1}], activeField:3, valueType:VTYPE.FLOAT32, value:2.5 }],
  },
]

const oneofOpsResult = oneofOpsVectors.map(v => {
  const opsChain = encodeChain(v.ops)
  const final = applyChain(v.initial, v.ops)
  return {
    name: v.name,
    description: v.description,
    initial: v.initial,
    ops: v.ops,
    expected_chain_bytes_hex: toHex(opsChain),
    expected_final: final,
  }
})

// ── schemas/schemaful.json ─────────────────────────────────────────────────
// Note: schemaful encoding is not yet implemented in v0.1.
// These vectors are placeholders for when FLAG_SCHEMAFUL is wired up.
// The verifier skips them with a "pending" marker.

const schemafulResult = [
  {
    name: "schemaful placeholder",
    description: "schemaful wire encoding is deferred to a later spec revision; this slot is reserved",
    status: "pending",
  },
]

// ── Output ─────────────────────────────────────────────────────────────────

const OUTPUT = {
  "types/scalars.json":       scalarsResult,
  "types/strings.json":       stringsResult,
  "containers/messages.json": messagesResult,
  "containers/repeated.json": repeatedResult,
  "containers/maps.json":     mapsResult,
  "containers/oneofs.json":   oneofsResult,
  "deltas/field_ops.json":    fieldOpsResult,
  "deltas/repeated_ops.json": repeatedOpsResult,
  "deltas/map_ops.json":      mapOpsResult,
  "deltas/oneof_ops.json":    oneofOpsResult,
  "schemas/schemaful.json":   schemafulResult,
}

// Print as a JSON object so the build script can write the files.
console.log(safeJSON(OUTPUT))
