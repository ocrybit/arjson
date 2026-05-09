// Generator: produce weavepack-graph conformance test vector corpus.
// Run from the repo root:
//   node weavepack/tools/gen-graph-vectors.js
//
// Writes to weavepack/profiles/graph/test-vectors/.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CTYPE, OP, PATH_KIND,
  encodeGraph, decodeGraph, encodeChain,
  initState, applyChain,
} from "../../sdk/src/profiles/graph/index.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..", "profiles", "graph", "test-vectors")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")

// BigInt ctypes: values stored as strings in JSON, BigInt in JS.
const BIGINT_CTYPES = new Set([CTYPE.INT64, CTYPE.UINT64, CTYPE.TIMESTAMP64, CTYPE.NODE_ID])

// ── Spec <-> JS conversion ─────────────────────────────────────────────────

function specValToJs(ctype, v) {
  if (v === null || v === undefined) return null
  if (typeof v === "object" && v._bytes !== undefined) return new Uint8Array(v._bytes)
  if (BIGINT_CTYPES.has(ctype) && typeof v === "string") return BigInt(v)
  return v
}

function specToBlock(blk) {
  if (blk.type === "node") {
    return {
      type: "node",
      label: blk.label ?? null,
      nids: (blk.nids || []).map(n => BigInt(n)),
      columns: (blk.columns || []).map(col => ({
        colId: col.colId, ctype: col.ctype, nullable: col.nullable,
        values: col.values.map(v => specValToJs(col.ctype, v)),
      })),
    }
  } else {
    return {
      type: "edge",
      label: blk.label ?? null,
      eids: (blk.eids || []).map(e => BigInt(e)),
      srcs: (blk.srcs || []).map(s => BigInt(s)),
      dsts: (blk.dsts || []).map(d => BigInt(d)),
      columns: (blk.columns || []).map(col => ({
        colId: col.colId, ctype: col.ctype, nullable: col.nullable,
        values: col.values.map(v => specValToJs(col.ctype, v)),
      })),
    }
  }
}

function specToGraph(spec) {
  return {
    schemaHash: spec.schemaHash ? new Uint8Array(spec.schemaHash._bytes) : undefined,
    blocks: (spec.blocks || []).map(specToBlock),
  }
}

function specToPath(p) {
  const out = { kind: p.kind }
  if (p.nid !== undefined) out.nid = BigInt(p.nid)
  if (p.eid !== undefined) out.eid = BigInt(p.eid)
  if (p.colId !== undefined) out.colId = p.colId
  if (p.label !== undefined) out.label = p.label
  if (p.prop !== undefined) out.prop = p.prop
  return out
}

function specToOp(op) {
  const o = { op: op.op }
  switch (op.op) {
    case OP.NODE_INSERT:
      o.block = specToBlock(op.block); break
    case OP.NODE_DELETE:
      o.nids = (op.nids || []).map(n => BigInt(n)); break
    case OP.EDGE_INSERT:
      o.block = specToBlock(op.block); break
    case OP.EDGE_DELETE:
      o.eids = (op.eids || []).map(e => BigInt(e)); break
    case OP.PROP_SET:
      o.path = specToPath(op.path)
      o.ctype = op.ctype
      o.nullable = op.nullable
      o.value = op.value != null ? specValToJs(op.ctype, op.value) : null
      break
    case OP.SUBGRAPH_REPLACE:
      o.label = op.label ?? null
      if (op.nodeBlock) o.nodeBlock = specToBlock(op.nodeBlock)
      if (op.edgeBlock) o.edgeBlock = specToBlock(op.edgeBlock)
      break
  }
  return o
}

// ── JS state -> spec (for expected_final) ─────────────────────────────────

function jsValToSpec(ctype, v) {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) return { _bytes: Array.from(v) }
  if (typeof v === "bigint") return v.toString()
  return v
}

function stateToSpec(state) {
  const sortBigKey = ([a], [b]) => BigInt(a) < BigInt(b) ? -1 : 1
  const sortColKey = ([a], [b]) => typeof a === typeof b
    ? (typeof a === "number" ? a - b : String(a).localeCompare(String(b)))
    : typeof a === "number" ? -1 : 1
  const nodes = Array.from(state.nodes.entries()).sort(sortBigKey)
    .map(([nid, node]) => ({
      nid,
      label: node.label,
      props: Array.from(node.props.entries()).sort(sortColKey)
        .map(([colId, { ctype, value }]) => ({ colId, ctype, value: jsValToSpec(ctype, value) })),
    }))
  const edges = Array.from(state.edges.entries()).sort(sortBigKey)
    .map(([eid, edge]) => ({
      eid,
      src: edge.src.toString(),
      dst: edge.dst.toString(),
      label: edge.label,
      props: Array.from(edge.props.entries()).sort(sortColKey)
        .map(([colId, { ctype, value }]) => ({ colId, ctype, value: jsValToSpec(ctype, value) })),
    }))
  return { nodes, edges }
}

// ── Snap / chain helpers ───────────────────────────────────────────────────

function snap(spec) {
  return toHex(encodeGraph(specToGraph(spec)))
}

function deltaChainHex(opsSpec) {
  return toHex(encodeChain({ ops: opsSpec.map(specToOp) }))
}

function applyAndSpec(initialSpec, opsSpec) {
  const graph = specToGraph(initialSpec)
  const decoded = decodeGraph(encodeGraph(graph))
  const state = initState(decoded)
  const jsOps = opsSpec.map(specToOp)
  const final = applyChain(state, jsOps)
  return stateToSpec(final)
}

function deltaVec(name, description, initial, ops) {
  return {
    name, description, initial, ops,
    expected_chain_bytes_hex: deltaChainHex(ops),
    expected_final: applyAndSpec(initial, ops),
  }
}

function writeFile(relPath, data) {
  const full = join(ROOT, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(data, null, 2))
  console.log("wrote", relPath)
}

// ── types/scalars.json ─────────────────────────────────────────────────────
// One node_block (nid=1, no label) with one property column per ctype.

function scalarVec(name, description, ctype, value) {
  const input = {
    blocks: [{ type: "node", nids: ["1"], columns: [{ colId: 2, ctype, nullable: false, values: [value] }] }],
  }
  return { name, description, input, expected_bytes_hex: snap(input) }
}

const scalarsVectors = [
  scalarVec("bool false",       "ctype 0: bool false as node property",     CTYPE.BOOL,        false),
  scalarVec("bool true",        "ctype 0: bool true as node property",      CTYPE.BOOL,        true),
  scalarVec("int8 min",         "ctype 1: int8 -128",                        CTYPE.INT8,        -128),
  scalarVec("int8 zero",        "ctype 1: int8 zero",                        CTYPE.INT8,        0),
  scalarVec("int8 max",         "ctype 1: int8 127",                         CTYPE.INT8,        127),
  scalarVec("int16 min",        "ctype 2: int16 -32768",                     CTYPE.INT16,       -32768),
  scalarVec("int16 max",        "ctype 2: int16 32767",                      CTYPE.INT16,       32767),
  scalarVec("int32 min",        "ctype 3: int32 min",                        CTYPE.INT32,       -2147483648),
  scalarVec("int32 max",        "ctype 3: int32 max",                        CTYPE.INT32,       2147483647),
  scalarVec("int64 zero",       "ctype 4: int64 zero",                       CTYPE.INT64,       "0"),
  scalarVec("int64 max",        "ctype 4: int64 max",                        CTYPE.INT64,       "9223372036854775807"),
  scalarVec("int64 min",        "ctype 4: int64 min",                        CTYPE.INT64,       "-9223372036854775808"),
  scalarVec("uint8 zero",       "ctype 5: uint8 zero",                       CTYPE.UINT8,       0),
  scalarVec("uint8 max",        "ctype 5: uint8 max",                        CTYPE.UINT8,       255),
  scalarVec("uint16 zero",      "ctype 6: uint16 zero",                      CTYPE.UINT16,      0),
  scalarVec("uint16 max",       "ctype 6: uint16 max",                       CTYPE.UINT16,      65535),
  scalarVec("uint32 zero",      "ctype 7: uint32 zero",                      CTYPE.UINT32,      0),
  scalarVec("uint32 max",       "ctype 7: uint32 max",                       CTYPE.UINT32,      4294967295),
  scalarVec("uint64 zero",      "ctype 8: uint64 zero",                      CTYPE.UINT64,      "0"),
  scalarVec("uint64 max",       "ctype 8: uint64 max",                       CTYPE.UINT64,      "18446744073709551615"),
  scalarVec("float32 zero",     "ctype 9: float32 zero",                     CTYPE.FLOAT32,     0),
  scalarVec("float32 pi",       "ctype 9: float32 ~3.14159",                 CTYPE.FLOAT32,     Math.fround(3.14159)),
  scalarVec("float32 neg",      "ctype 9: float32 -1.5",                     CTYPE.FLOAT32,     -1.5),
  scalarVec("float64 zero",     "ctype 10: float64 zero",                    CTYPE.FLOAT64,     0),
  scalarVec("float64 pi",       "ctype 10: float64 pi",                      CTYPE.FLOAT64,     3.141592653589793),
  scalarVec("bytes empty",      "ctype 12: empty bytes",                     CTYPE.BYTES,       { _bytes: [] }),
  scalarVec("bytes data",       "ctype 12: 4-byte blob",                     CTYPE.BYTES,       { _bytes: [0xDE, 0xAD, 0xBE, 0xEF] }),
  scalarVec("string empty",     "ctype 11: empty string",                    CTYPE.STRING,      ""),
  scalarVec("string ascii",     "ctype 11: ascii string",                    CTYPE.STRING,      "hello"),
  scalarVec("string unicode",   "ctype 11: unicode string",                  CTYPE.STRING,      "こんにちは"),
  scalarVec("date32 zero",      "ctype 13: date32 epoch day",                CTYPE.DATE32,      0),
  scalarVec("date32 pos",       "ctype 13: date32 2024-04-24 (day 19845)",   CTYPE.DATE32,      19845),
  scalarVec("date32 neg",       "ctype 13: date32 before epoch",             CTYPE.DATE32,      -1),
  scalarVec("timestamp64 zero", "ctype 14: timestamp64 epoch",               CTYPE.TIMESTAMP64, "0"),
  scalarVec("timestamp64 pos",  "ctype 14: timestamp64 microseconds",        CTYPE.TIMESTAMP64, "1715200000000000"),
  scalarVec("node_id zero",     "ctype 15: node_id zero (null reference)",   CTYPE.NODE_ID,     "0"),
  scalarVec("node_id nonzero",  "ctype 15: node_id referencing nid=42",      CTYPE.NODE_ID,     "42"),
  scalarVec("node_id large",    "ctype 15: node_id large value",             CTYPE.NODE_ID,     "9999999999"),
]

writeFile("types/scalars.json", scalarsVectors)

// ── types/nulls.json ───────────────────────────────────────────────────────
// Nullable property columns in node blocks.

const nullsVectors = [
  (() => {
    const input = {
      blocks: [{ type: "node", nids: ["1"], columns: [{ colId: 2, ctype: CTYPE.INT32, nullable: true, values: [null] }] }],
    }
    return { name: "all-null int32", description: "one-node nullable int32 column with null value", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{ type: "node", nids: ["1", "2", "3"], columns: [{ colId: 2, ctype: CTYPE.INT32, nullable: true, values: [null, 42, null] }] }],
    }
    return { name: "mixed null int32", description: "three-node nullable int32: null, 42, null", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{ type: "node", nids: ["1", "2", "3", "4"], columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: true, values: ["hello", null, "world", null] }] }],
    }
    return { name: "mixed null string", description: "four-node nullable string: hello, null, world, null", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{ type: "node", nids: ["1", "2"], columns: [{ colId: 2, ctype: CTYPE.NODE_ID, nullable: true, values: [null, "99"] }] }],
    }
    return { name: "nullable node_id", description: "two-node nullable node_id: null, 99", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{
        type: "node", nids: ["1", "2"],
        columns: [
          { colId: 2, ctype: CTYPE.INT32,  nullable: false, values: [10, 20] },
          { colId: 3, ctype: CTYPE.STRING, nullable: true,  values: ["ok", null] },
        ],
      }],
    }
    return { name: "two cols one nullable", description: "non-nullable int32 + nullable string, two nodes", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("types/nulls.json", nullsVectors)

// ── containers/node_blocks.json ────────────────────────────────────────────

const nodeBlocksVectors = [
  (() => {
    const input = { blocks: [{ type: "node", nids: [], columns: [] }] }
    return { name: "empty node block", description: "node block with zero nodes and no columns", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = { blocks: [{ type: "node", nids: ["1"], columns: [] }] }
    return { name: "single node no label", description: "one node, no label, no property columns", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{
        type: "node", label: "Person", nids: ["1", "2", "3"],
        columns: [
          { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Alice", "Bob", "Carol"] },
          { colId: 3, ctype: CTYPE.UINT32, nullable: false, values: [30, 25, 35] },
        ],
      }],
    }
    return { name: "labeled node block", description: "Person nodes: three nodes with name + age columns", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [
        { type: "node", label: "User",    nids: ["1", "2"], columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice", "bob"] }] },
        { type: "node", label: "Product", nids: ["100"],    columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["widget"] }] },
      ],
    }
    return { name: "two labeled node blocks", description: "User and Product blocks in one document", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // Large nid gap (delta encoding must encode the delta, not the absolute value)
    const input = {
      blocks: [{ type: "node", nids: ["1000000", "2000000", "3000000"], columns: [] }],
    }
    return { name: "large nid values", description: "nids with large gaps to exercise LEB128 delta encoding", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("containers/node_blocks.json", nodeBlocksVectors)

// ── containers/edge_blocks.json ────────────────────────────────────────────

const edgeBlocksVectors = [
  (() => {
    const input = {
      blocks: [{
        type: "edge", eids: ["10", "11"], srcs: ["1", "1"], dsts: ["2", "3"],
        columns: [],
      }],
    }
    return { name: "simple edge block", description: "two directed edges with no property columns", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{
        type: "edge", label: "follows", eids: ["1", "2", "3"],
        srcs: ["1", "2", "1"], dsts: ["2", "3", "3"], columns: [],
      }],
    }
    return { name: "labeled edge block", description: "'follows' edges: three directed edges with label", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{
        type: "edge", label: "rated", eids: ["100", "101"],
        srcs: ["1", "2"], dsts: ["10", "10"],
        columns: [{ colId: 4, ctype: CTYPE.FLOAT32, nullable: false, values: [4.5, 3.0] }],
      }],
    }
    return { name: "edge block with property", description: "'rated' edges with float32 score property", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [{
        type: "edge", eids: ["1", "2"],
        srcs: ["1", "2"], dsts: ["2", "1"],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["primary", null] }],
      }],
    }
    return { name: "edge block nullable property", description: "edges with nullable string property", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("containers/edge_blocks.json", edgeBlocksVectors)

// ── containers/graph.json ──────────────────────────────────────────────────

const graphVectors = [
  (() => {
    const input = { blocks: [] }
    return { name: "empty graph", description: "graph document with zero blocks", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      blocks: [
        {
          type: "node", label: "Person", nids: ["1", "2", "3"],
          columns: [
            { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Alice", "Bob", "Carol"] },
            { colId: 3, ctype: CTYPE.UINT32, nullable: false, values: [30, 25, 35] },
          ],
        },
        {
          type: "edge", label: "follows", eids: ["10", "11", "12"],
          srcs: ["1", "2", "1"], dsts: ["2", "3", "3"], columns: [],
        },
      ],
    }
    return { name: "social graph snapshot", description: "Person nodes + follows edges in one document", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // Multiple node labels + edge labels
    const input = {
      blocks: [
        { type: "node", label: "User",    nids: ["1"],   columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice"] }] },
        { type: "node", label: "Product", nids: ["100"], columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["widget"] }] },
        { type: "edge", label: "bought",  eids: ["200"], srcs: ["1"], dsts: ["100"], columns: [{ colId: 4, ctype: CTYPE.DATE32, nullable: false, values: [19845] }] },
      ],
    }
    return { name: "multi-label graph", description: "User+Product nodes with bought edge and date property", input, expected_bytes_hex: snap(input) }
  })(),
]

writeFile("containers/graph.json", graphVectors)

// ── deltas/node_insert.json ────────────────────────────────────────────────

const nodeInsertVectors = [
  (() => {
    const initial = { blocks: [] }
    const ops = [{
      op: OP.NODE_INSERT,
      block: { type: "node", label: "Person", nids: ["1"], columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Alice"] }] },
    }]
    return deltaVec("insert one node", "node_insert into empty graph", initial, ops)
  })(),
  (() => {
    const initial = {
      blocks: [{ type: "node", label: "Person", nids: ["1"], columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Alice"] }] }],
    }
    const ops = [{
      op: OP.NODE_INSERT,
      block: { type: "node", label: "Person", nids: ["2", "3"], columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Bob", "Carol"] }] },
    }]
    return deltaVec("append two nodes", "node_insert appends two more Person nodes", initial, ops)
  })(),
  (() => {
    // Two sequential node_insert ops
    const initial = { blocks: [] }
    const ops = [
      { op: OP.NODE_INSERT, block: { type: "node", nids: ["1"], columns: [] } },
      { op: OP.NODE_INSERT, block: { type: "node", nids: ["2"], columns: [] } },
    ]
    return deltaVec("two sequential inserts", "two node_insert ops in one chain", initial, ops)
  })(),
]

writeFile("deltas/node_insert.json", nodeInsertVectors)

// ── deltas/node_delete.json ────────────────────────────────────────────────

const nodeDeleteVectors = [
  (() => {
    const initial = {
      blocks: [{ type: "node", nids: ["1", "2", "3"], columns: [] }],
    }
    const ops = [{ op: OP.NODE_DELETE, nids: ["2"] }]
    return deltaVec("delete middle node", "remove nid=2 from three-node graph", initial, ops)
  })(),
  (() => {
    // Delete node with incident edges → cascade
    const initial = {
      blocks: [
        { type: "node", nids: ["1", "2", "3"], columns: [] },
        { type: "edge", eids: ["10", "11"], srcs: ["1", "2"], dsts: ["2", "3"], columns: [] },
      ],
    }
    const ops = [{ op: OP.NODE_DELETE, nids: ["2"] }]
    return deltaVec("node delete cascades edges", "delete nid=2 implicitly removes incident edges eid=10 and eid=11", initial, ops)
  })(),
  (() => {
    const initial = {
      blocks: [{ type: "node", label: "Person", nids: ["1", "2", "3"], columns: [] }],
    }
    const ops = [{ op: OP.NODE_DELETE, nids: ["1", "3"] }]
    return deltaVec("delete multiple nodes", "delete nid=1 and nid=3 in one op", initial, ops)
  })(),
]

writeFile("deltas/node_delete.json", nodeDeleteVectors)

// ── deltas/edge_insert.json ────────────────────────────────────────────────

const edgeInsertVectors = [
  (() => {
    const initial = {
      blocks: [{ type: "node", nids: ["1", "2"], columns: [] }],
    }
    const ops = [{
      op: OP.EDGE_INSERT,
      block: { type: "edge", label: "follows", eids: ["10"], srcs: ["1"], dsts: ["2"], columns: [] },
    }]
    return deltaVec("insert one edge", "edge_insert adds follows edge between two existing nodes", initial, ops)
  })(),
  (() => {
    const initial = {
      blocks: [
        { type: "node", nids: ["1", "2", "3"], columns: [] },
        { type: "edge", eids: ["10"], srcs: ["1"], dsts: ["2"], columns: [] },
      ],
    }
    const ops = [{
      op: OP.EDGE_INSERT,
      block: { type: "edge", eids: ["11", "12"], srcs: ["2", "3"], dsts: ["3", "1"], columns: [] },
    }]
    return deltaVec("append edges", "edge_insert appends two more edges to existing edge block", initial, ops)
  })(),
  (() => {
    // Sequential edge_insert ops with properties
    const initial = {
      blocks: [{ type: "node", nids: ["1", "2", "3"], columns: [] }],
    }
    const ops = [
      {
        op: OP.EDGE_INSERT,
        block: { type: "edge", label: "rated", eids: ["1"], srcs: ["1"], dsts: ["2"], columns: [{ colId: 4, ctype: CTYPE.FLOAT32, nullable: false, values: [5.0] }] },
      },
      {
        op: OP.EDGE_INSERT,
        block: { type: "edge", label: "rated", eids: ["2"], srcs: ["2"], dsts: ["3"], columns: [{ colId: 4, ctype: CTYPE.FLOAT32, nullable: false, values: [3.5] }] },
      },
    ]
    return deltaVec("edge inserts with properties", "two edge_insert ops adding rated edges with float scores", initial, ops)
  })(),
]

writeFile("deltas/edge_insert.json", edgeInsertVectors)

// ── deltas/edge_delete.json ────────────────────────────────────────────────

const edgeDeleteVectors = [
  (() => {
    const initial = {
      blocks: [
        { type: "node", nids: ["1", "2", "3"], columns: [] },
        { type: "edge", eids: ["10", "11", "12"], srcs: ["1", "2", "1"], dsts: ["2", "3", "3"], columns: [] },
      ],
    }
    const ops = [{ op: OP.EDGE_DELETE, eids: ["11"] }]
    return deltaVec("delete one edge", "edge_delete removes eid=11 from three-edge graph", initial, ops)
  })(),
  (() => {
    const initial = {
      blocks: [
        { type: "node", nids: ["1", "2", "3"], columns: [] },
        { type: "edge", eids: ["1", "2", "3", "4"], srcs: ["1", "2", "3", "1"], dsts: ["2", "3", "1", "3"], columns: [] },
      ],
    }
    const ops = [{ op: OP.EDGE_DELETE, eids: ["1", "3"] }]
    return deltaVec("delete multiple edges", "edge_delete removes eid=1 and eid=3", initial, ops)
  })(),
]

writeFile("deltas/edge_delete.json", edgeDeleteVectors)

// ── deltas/prop_set.json ───────────────────────────────────────────────────

const propSetVectors = [
  (() => {
    // prop_set on node via NODE_COL path (kind=1)
    const initial = {
      blocks: [{
        type: "node", nids: ["1", "2"],
        columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Alice", "Bob"] }],
      }],
    }
    const ops = [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: "2", colId: 2 },
      ctype: CTYPE.STRING, nullable: false, value: "Robert",
    }]
    return deltaVec("prop_set node string", "update Bob's name to Robert via NODE_COL path", initial, ops)
  })(),
  (() => {
    // prop_set on edge via EDGE_COL path (kind=3)
    const initial = {
      blocks: [
        { type: "node", nids: ["1", "2"], columns: [] },
        { type: "edge", eids: ["10"], srcs: ["1"], dsts: ["2"], columns: [{ colId: 4, ctype: CTYPE.FLOAT32, nullable: false, values: [3.0] }] },
      ],
    }
    const ops = [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.EDGE_COL, eid: "10", colId: 4 },
      ctype: CTYPE.FLOAT32, nullable: false, value: 5.0,
    }]
    return deltaVec("prop_set edge float", "update edge rating from 3.0 to 5.0 via EDGE_COL path", initial, ops)
  })(),
  (() => {
    // prop_set to null (requires nullable column)
    const initial = {
      blocks: [{
        type: "node", nids: ["1"],
        columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: true, values: ["sensitive"] }],
      }],
    }
    const ops = [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 2 },
      ctype: CTYPE.STRING, nullable: true, value: null,
    }]
    return deltaVec("prop_set to null", "erase nullable string property (compliance/GDPR use case)", initial, ops)
  })(),
  (() => {
    // prop_set node via NODE path (kind=0) with named prop
    const initial = {
      blocks: [{ type: "node", nids: ["1"], columns: [] }],
    }
    const ops = [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_PROP, nid: "1", prop: "status" },
      ctype: CTYPE.STRING, nullable: false, value: "active",
    }]
    return deltaVec("prop_set named prop", "set named prop 'status' on node via NODE_PROP path", initial, ops)
  })(),
]

writeFile("deltas/prop_set.json", propSetVectors)

// ── schemas/schemaful.json ─────────────────────────────────────────────────
// Graphs with a non-zero 32-byte schema hash.

const schemaHash1 = new Array(32).fill(0)
schemaHash1[0] = 0x01; schemaHash1[31] = 0xFF

const schemaHash2 = new Array(32).fill(0xAB)

const schemafulVectors = [
  (() => {
    const input = {
      schemaHash: { _bytes: schemaHash1 },
      blocks: [{
        type: "node", label: "Person", nids: ["1", "2"],
        columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["Alice", "Bob"] }],
      }],
    }
    return { name: "node block with schema hash", description: "Person node block with non-zero schema_hash[0]=1, [31]=255", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    const input = {
      schemaHash: { _bytes: schemaHash2 },
      blocks: [
        {
          type: "node", label: "User", nids: ["1"],
          columns: [{ colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice"] }],
        },
        {
          type: "edge", label: "follows", eids: ["10"], srcs: ["1"], dsts: ["1"],
          columns: [],
        },
      ],
    }
    return { name: "graph with schema hash 0xAB*32", description: "User+follows graph with all-0xAB schema hash", input, expected_bytes_hex: snap(input) }
  })(),
  (() => {
    // Delta chain against a schemaful initial snapshot (chain itself uses all-zero hash)
    const initial = {
      schemaHash: { _bytes: schemaHash1 },
      blocks: [{ type: "node", nids: ["1"], columns: [] }],
    }
    const ops = [{ op: OP.NODE_INSERT, block: { type: "node", nids: ["2"], columns: [] } }]
    return deltaVec("delta against schemaful snapshot", "node_insert chain applied to initial graph with non-zero schema hash", initial, ops)
  })(),
]

writeFile("schemas/schemaful.json", schemafulVectors)

console.log("Done. All graph test vectors written.")
