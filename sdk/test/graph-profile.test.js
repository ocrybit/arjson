// weavepack-graph — reference implementation tests (G.2).
//
// Covers: all 16 ctypes including node_id (ctype 15), nullable property columns,
// node_block + edge_block round-trips, graph document encode/decode, delta chains
// (node_insert, node_delete, edge_insert, edge_delete, prop_set,
// subgraph_replace), and applyChain semantics.

import { describe, it } from "node:test"
import assert from "assert"
import {
  CTYPE, OP, PATH_KIND,
  encodeGraph, decodeGraph,
  encodeChain, decodeChain,
  initState, applyChain,
} from "../src/profiles/graph/index.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function roundTrip(graph) {
  return decodeGraph(encodeGraph(graph))
}

function makeGraph(blocks, schemaHash) {
  return { schemaHash: schemaHash ?? new Uint8Array(32), blocks }
}

function nodeBlock(label, nids, columns) {
  return { type: 'node', label: label ?? null, nids: nids.map(BigInt), columns }
}

function edgeBlock(label, eids, srcs, dsts, columns) {
  return {
    type: 'edge',
    label: label ?? null,
    eids: eids.map(BigInt),
    srcs: srcs.map(BigInt),
    dsts: dsts.map(BigInt),
    columns,
  }
}

function bigEq(a, b) { return BigInt(a) === BigInt(b) }

function colValuesEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i]
    if (av === null && bv === null) continue
    if (av === null || bv === null) return false
    if (av instanceof Uint8Array) {
      if (!(bv instanceof Uint8Array) || av.length !== bv.length) return false
      for (let j = 0; j < av.length; j++) if (av[j] !== bv[j]) return false
    } else if (typeof av === "bigint" || typeof bv === "bigint") {
      if (BigInt(av) !== BigInt(bv)) return false
    } else if (typeof av === "number" && Number.isNaN(av)) {
      if (!Number.isNaN(bv)) return false
    } else {
      if (av !== bv) return false
    }
  }
  return true
}

function colEq(a, b) {
  return a.colId === b.colId && a.ctype === b.ctype && a.nullable === b.nullable
    && colValuesEq(a.values, b.values)
}

// ── Empty graph ────────────────────────────────────────────────────────────

describe("weavepack-graph empty graph", () => {
  it("encodes and decodes an empty graph (0 blocks)", () => {
    const g = makeGraph([])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks.length, 0)
  })

  it("round-trips schema_hash", () => {
    const hash = new Uint8Array(32).fill(0xAB)
    const g = makeGraph([], hash)
    const rt = roundTrip(g)
    assert.deepStrictEqual(rt.schemaHash, hash)
  })
})

// ── Node block round-trips ─────────────────────────────────────────────────

describe("weavepack-graph node_block round-trip", () => {
  it("encodes and decodes an empty node_block (0 nodes)", () => {
    const g = makeGraph([nodeBlock(null, [], [])])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks.length, 1)
    assert.strictEqual(rt.blocks[0].type, 'node')
    assert.strictEqual(rt.blocks[0].nids.length, 0)
  })

  it("round-trips a node_block with a label", () => {
    const g = makeGraph([nodeBlock("User", [1n, 2n, 3n], [])])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks[0].label, "User")
    assert.strictEqual(rt.blocks[0].nids.length, 3)
    assert.ok(rt.blocks[0].nids.every((id, i) => bigEq(id, [1n, 2n, 3n][i])))
  })

  it("round-trips a node_block with no label", () => {
    const g = makeGraph([nodeBlock(null, [10n, 20n], [])])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks[0].label, null)
    assert.ok(bigEq(rt.blocks[0].nids[0], 10n))
    assert.ok(bigEq(rt.blocks[0].nids[1], 20n))
  })

  it("delta-pack: sparse nids (delta > 1)", () => {
    const g = makeGraph([nodeBlock("X", [0n, 100n, 1000n], [])])
    const rt = roundTrip(g)
    assert.ok(bigEq(rt.blocks[0].nids[0], 0n))
    assert.ok(bigEq(rt.blocks[0].nids[1], 100n))
    assert.ok(bigEq(rt.blocks[0].nids[2], 1000n))
  })

  it("rejects duplicate nids in a block", () => {
    assert.throws(
      () => encodeGraph(makeGraph([nodeBlock(null, [1n, 2n, 2n], [])])),
      /duplicate_element_id/
    )
  })
})

// ── Edge block round-trips ─────────────────────────────────────────────────

describe("weavepack-graph edge_block round-trip", () => {
  it("encodes and decodes an empty edge_block (0 edges)", () => {
    const g = makeGraph([edgeBlock(null, [], [], [], [])])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks[0].type, 'edge')
    assert.strictEqual(rt.blocks[0].eids.length, 0)
  })

  it("round-trips an edge_block with a label and edges", () => {
    const g = makeGraph([edgeBlock("follows", [1n, 2n], [10n, 20n], [20n, 10n], [])])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks[0].label, "follows")
    assert.ok(bigEq(rt.blocks[0].eids[0], 1n))
    assert.ok(bigEq(rt.blocks[0].srcs[0], 10n))
    assert.ok(bigEq(rt.blocks[0].dsts[0], 20n))
    assert.ok(bigEq(rt.blocks[0].srcs[1], 20n))
    assert.ok(bigEq(rt.blocks[0].dsts[1], 10n))
  })

  it("rejects duplicate eids", () => {
    assert.throws(
      () => encodeGraph(makeGraph([edgeBlock(null, [1n, 1n], [1n, 2n], [2n, 3n], [])])),
      /duplicate_element_id/
    )
  })

  it("rejects mismatched srcs/dsts length", () => {
    assert.throws(
      () => encodeGraph(makeGraph([edgeBlock(null, [1n], [1n, 2n], [3n], [])])),
      /srcs\.length/
    )
  })
})

// ── Property column types ──────────────────────────────────────────────────

describe("weavepack-graph property column ctypes", () => {
  function rtNodeCol(ctype, nullable, values) {
    const g = makeGraph([nodeBlock(null, values.map((_, i) => BigInt(i + 1)), [
      { colId: 2, ctype, nullable, values },
    ])])
    const rt = roundTrip(g)
    return rt.blocks[0].columns[0]
  }

  it("ctype BOOL", () => {
    const col = rtNodeCol(CTYPE.BOOL, false, [true, false, true])
    assert.deepStrictEqual(col.values, [true, false, true])
  })

  it("ctype INT8 negative and positive", () => {
    const col = rtNodeCol(CTYPE.INT8, false, [-128, 0, 127])
    assert.deepStrictEqual(col.values, [-128, 0, 127])
  })

  it("ctype INT16", () => {
    const col = rtNodeCol(CTYPE.INT16, false, [-32768, 0, 32767])
    assert.deepStrictEqual(col.values, [-32768, 0, 32767])
  })

  it("ctype INT32", () => {
    const col = rtNodeCol(CTYPE.INT32, false, [-2147483648, 0, 2147483647])
    assert.deepStrictEqual(col.values, [-2147483648, 0, 2147483647])
  })

  it("ctype INT64 (BigInt)", () => {
    const col = rtNodeCol(CTYPE.INT64, false, [-(1n << 62n), 0n, (1n << 62n)])
    assert.ok(colValuesEq(col.values, [-(1n << 62n), 0n, (1n << 62n)]))
  })

  it("ctype UINT8", () => {
    const col = rtNodeCol(CTYPE.UINT8, false, [0, 128, 255])
    assert.deepStrictEqual(col.values, [0, 128, 255])
  })

  it("ctype UINT16", () => {
    const col = rtNodeCol(CTYPE.UINT16, false, [0, 1000, 65535])
    assert.deepStrictEqual(col.values, [0, 1000, 65535])
  })

  it("ctype UINT32", () => {
    const col = rtNodeCol(CTYPE.UINT32, false, [0, 1, 4294967295])
    assert.deepStrictEqual(col.values, [0, 1, 4294967295])
  })

  it("ctype UINT64 (BigInt)", () => {
    const col = rtNodeCol(CTYPE.UINT64, false, [0n, 1n, (1n << 63n)])
    assert.ok(colValuesEq(col.values, [0n, 1n, (1n << 63n)]))
  })

  it("ctype FLOAT32 round-trip (32-bit precision)", () => {
    // Use a value that round-trips exactly through float32.
    const col = rtNodeCol(CTYPE.FLOAT32, false, [0.0, 1.0, -1.5])
    assert.strictEqual(col.values[0], 0.0)
    assert.strictEqual(col.values[1], 1.0)
    assert.strictEqual(col.values[2], -1.5)
  })

  it("ctype FLOAT64", () => {
    const col = rtNodeCol(CTYPE.FLOAT64, false, [1.23456789, -9.87654321, 0.0])
    assert.ok(Math.abs(col.values[0] - 1.23456789) < 1e-9)
    assert.ok(Math.abs(col.values[1] - (-9.87654321)) < 1e-9)
  })

  it("ctype STRING", () => {
    const col = rtNodeCol(CTYPE.STRING, false, ["hello", "world", ""])
    assert.deepStrictEqual(col.values, ["hello", "world", ""])
  })

  it("ctype BYTES", () => {
    const v1 = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])
    const v2 = new Uint8Array(0)
    const col = rtNodeCol(CTYPE.BYTES, false, [v1, v2])
    assert.ok(col.values[0] instanceof Uint8Array)
    assert.deepStrictEqual([...col.values[0]], [...v1])
    assert.strictEqual(col.values[1].length, 0)
  })

  it("ctype DATE32", () => {
    const col = rtNodeCol(CTYPE.DATE32, false, [-1, 0, 19490])
    assert.deepStrictEqual(col.values, [-1, 0, 19490])
  })

  it("ctype TIMESTAMP64 (BigInt)", () => {
    const col = rtNodeCol(CTYPE.TIMESTAMP64, false, [0n, 1_000_000n, -1n])
    assert.ok(colValuesEq(col.values, [0n, 1_000_000n, -1n]))
  })

  it("ctype NODE_ID (ctype 15) — wire-identical to uint64", () => {
    const col = rtNodeCol(CTYPE.NODE_ID, false, [0n, 42n, 9999999n])
    assert.ok(colValuesEq(col.values, [0n, 42n, 9999999n]))
  })
})

// ── Nullable property columns ──────────────────────────────────────────────

describe("weavepack-graph nullable property columns", () => {
  it("round-trips a nullable INT32 column with NULLs", () => {
    const g = makeGraph([nodeBlock(null, [1n, 2n, 3n], [
      { colId: 2, ctype: CTYPE.INT32, nullable: true, values: [10, null, 30] },
    ])])
    const rt = roundTrip(g)
    const col = rt.blocks[0].columns[0]
    assert.strictEqual(col.values[0], 10)
    assert.strictEqual(col.values[1], null)
    assert.strictEqual(col.values[2], 30)
  })

  it("round-trips a nullable STRING column — all nulls", () => {
    const g = makeGraph([nodeBlock(null, [1n, 2n], [
      { colId: 2, ctype: CTYPE.STRING, nullable: true, values: [null, null] },
    ])])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks[0].columns[0].values[0], null)
    assert.strictEqual(rt.blocks[0].columns[0].values[1], null)
  })

  it("round-trips a nullable BOOL column", () => {
    const g = makeGraph([nodeBlock(null, [1n, 2n, 3n], [
      { colId: 2, ctype: CTYPE.BOOL, nullable: true, values: [true, null, false] },
    ])])
    const rt = roundTrip(g)
    const col = rt.blocks[0].columns[0]
    assert.strictEqual(col.values[0], true)
    assert.strictEqual(col.values[1], null)
    assert.strictEqual(col.values[2], false)
  })
})

// ── Edge block property columns ────────────────────────────────────────────

describe("weavepack-graph edge_block with property columns", () => {
  it("round-trips an edge_block with a FLOAT32 weight column", () => {
    const g = makeGraph([edgeBlock("follows", [1n, 2n], [10n, 20n], [30n, 40n], [
      { colId: 4, ctype: CTYPE.FLOAT32, nullable: false, values: [0.5, 1.0] },
    ])])
    const rt = roundTrip(g)
    const col = rt.blocks[0].columns[0]
    assert.strictEqual(col.colId, 4)
    assert.strictEqual(col.values[0], 0.5)
    assert.strictEqual(col.values[1], 1.0)
  })

  it("rejects edge property col_id < 4", () => {
    assert.throws(
      () => encodeGraph(makeGraph([edgeBlock(null, [1n], [2n], [3n], [
        { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [1] },
      ])])),
      /reserved_col_id/
    )
  })
})

// ── Mixed graph document ───────────────────────────────────────────────────

describe("weavepack-graph mixed node+edge document", () => {
  it("round-trips a graph with node_blocks and edge_blocks", () => {
    const g = makeGraph([
      nodeBlock("User", [1n, 2n, 3n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice", "bob", "carol"] },
      ]),
      nodeBlock("Tag", [100n, 101n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["sports", "tech"] },
      ]),
      edgeBlock("follows", [1000n, 1001n], [1n, 2n], [2n, 3n], []),
      edgeBlock("tagged_as", [2000n], [1n], [100n], []),
    ])
    const rt = roundTrip(g)
    assert.strictEqual(rt.blocks.length, 4)
    assert.strictEqual(rt.blocks[0].type, 'node')
    assert.strictEqual(rt.blocks[0].label, "User")
    assert.strictEqual(rt.blocks[0].nids.length, 3)
    assert.strictEqual(rt.blocks[1].type, 'node')
    assert.strictEqual(rt.blocks[1].label, "Tag")
    assert.strictEqual(rt.blocks[2].type, 'edge')
    assert.strictEqual(rt.blocks[2].label, "follows")
    assert.strictEqual(rt.blocks[3].type, 'edge')
    assert.strictEqual(rt.blocks[3].label, "tagged_as")
    // Check a property value.
    assert.strictEqual(rt.blocks[0].columns[0].values[1], "bob")
  })
})

// ── Delta chain: node_insert / node_delete ─────────────────────────────────

describe("weavepack-graph delta chain — node_insert / node_delete", () => {
  function encDecChain(chain) {
    return decodeChain(encodeChain(chain))
  }

  it("encodes and decodes node_insert op", () => {
    const chain = { ops: [{
      op: OP.NODE_INSERT,
      block: nodeBlock("User", [1n, 2n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice", "bob"] },
      ]),
    }] }
    const rt = encDecChain(chain)
    assert.strictEqual(rt.ops.length, 1)
    assert.strictEqual(rt.ops[0].op, OP.NODE_INSERT)
    assert.strictEqual(rt.ops[0].block.type, 'node')
    assert.strictEqual(rt.ops[0].block.nids.length, 2)
  })

  it("encodes and decodes node_delete op", () => {
    const chain = { ops: [{ op: OP.NODE_DELETE, nids: [10n, 20n, 30n] }] }
    const rt = encDecChain(chain)
    assert.strictEqual(rt.ops[0].op, OP.NODE_DELETE)
    assert.ok(rt.ops[0].nids.every((id, i) => bigEq(id, [10n, 20n, 30n][i])))
  })

  it("encodes and decodes edge_insert op", () => {
    const chain = { ops: [{
      op: OP.EDGE_INSERT,
      block: edgeBlock("follows", [100n], [1n], [2n], []),
    }] }
    const rt = encDecChain(chain)
    assert.strictEqual(rt.ops[0].op, OP.EDGE_INSERT)
    assert.ok(bigEq(rt.ops[0].block.eids[0], 100n))
  })

  it("encodes and decodes edge_delete op", () => {
    const chain = { ops: [{ op: OP.EDGE_DELETE, eids: [5n, 6n] }] }
    const rt = encDecChain(chain)
    assert.strictEqual(rt.ops[0].op, OP.EDGE_DELETE)
    assert.ok(bigEq(rt.ops[0].eids[0], 5n))
    assert.ok(bigEq(rt.ops[0].eids[1], 6n))
  })

  it("encodes and decodes prop_set op (node, col-addressed)", () => {
    const chain = { ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 1n, colId: 2 },
      ctype: CTYPE.STRING,
      nullable: false,
      value: "alice_updated",
    }] }
    const rt = encDecChain(chain)
    const op = rt.ops[0]
    assert.strictEqual(op.op, OP.PROP_SET)
    assert.strictEqual(op.path.kind, PATH_KIND.NODE_COL)
    assert.ok(bigEq(op.path.nid, 1n))
    assert.strictEqual(op.path.colId, 2)
    assert.strictEqual(op.value, "alice_updated")
  })

  it("encodes and decodes prop_set op (edge, col-addressed)", () => {
    const chain = { ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.EDGE_COL, eid: 100n, colId: 4 },
      ctype: CTYPE.FLOAT32,
      nullable: false,
      value: 0.75,
    }] }
    const rt = encDecChain(chain)
    const op = rt.ops[0]
    assert.strictEqual(op.path.kind, PATH_KIND.EDGE_COL)
    assert.ok(bigEq(op.path.eid, 100n))
    assert.strictEqual(op.value, 0.75)
  })

  it("encodes and decodes subgraph_replace op (node+edge)", () => {
    const chain = { ops: [{
      op: OP.SUBGRAPH_REPLACE,
      label: "User",
      nodeBlock: nodeBlock("User", [1n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice_v2"] },
      ]),
      edgeBlock: null,
    }] }
    const rt = encDecChain(chain)
    const op = rt.ops[0]
    assert.strictEqual(op.op, OP.SUBGRAPH_REPLACE)
    assert.strictEqual(op.label, "User")
    assert.ok(op.nodeBlock != null)
    assert.strictEqual(op.nodeBlock.nids.length, 1)
    assert.strictEqual(op.edgeBlock, null)
  })

  it("rejects unknown op code > 5", () => {
    // Manually craft a chain byte sequence with op code 6 to test decoder.
    // encodeChain writes: version + profile_id + schema_hash(32) + num_ops + op_byte
    const bytes = encodeChain({ ops: [{ op: OP.NODE_DELETE, nids: [] }] })
    // The first op byte comes after: 1(version) + 1(profile) + 32(hash) + 1(num_ops) = 35 bytes
    const tampered = new Uint8Array(bytes)
    tampered[35] = 6  // op code 6 is reserved
    assert.throws(() => decodeChain(tampered), /unknown_delta_op/)
  })
})

// ── applyChain semantics ───────────────────────────────────────────────────

describe("weavepack-graph applyChain", () => {
  it("initState from empty graph", () => {
    const g = decodeGraph(encodeGraph(makeGraph([])))
    const state = initState(g)
    assert.strictEqual(state.nodes.size, 0)
    assert.strictEqual(state.edges.size, 0)
  })

  it("initState populates nodes and edges", () => {
    const g = decodeGraph(encodeGraph(makeGraph([
      nodeBlock("User", [1n, 2n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice", "bob"] },
      ]),
      edgeBlock("follows", [10n], [1n], [2n], []),
    ])))
    const state = initState(g)
    assert.strictEqual(state.nodes.size, 2)
    assert.strictEqual(state.edges.size, 1)
    assert.ok(state.nodes.has("1"))
    assert.strictEqual(state.nodes.get("1").label, "User")
    assert.strictEqual(state.nodes.get("1").props.get(2).value, "alice")
    const edge = state.edges.get("10")
    assert.ok(bigEq(edge.src, 1n))
    assert.ok(bigEq(edge.dst, 2n))
  })

  it("node_insert adds new nodes", () => {
    const initial = initState(decodeGraph(encodeGraph(makeGraph([]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_INSERT,
      block: nodeBlock("User", [1n, 2n], [
        { colId: 2, ctype: CTYPE.INT32, nullable: false, values: [100, 200] },
      ]),
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 2)
    assert.strictEqual(state.nodes.get("1").props.get(2).value, 100)
  })

  it("node_delete removes nodes and incident edges", () => {
    const g = decodeGraph(encodeGraph(makeGraph([
      nodeBlock(null, [1n, 2n, 3n], []),
      edgeBlock(null, [10n, 11n], [1n, 2n], [2n, 3n], []),
    ])))
    let state = initState(g)
    assert.strictEqual(state.nodes.size, 3)
    assert.strictEqual(state.edges.size, 2)

    // Delete node 2: edges 10 (1→2) and 11 (2→3) are both incident.
    const chain = decodeChain(encodeChain({ ops: [{ op: OP.NODE_DELETE, nids: [2n] }] }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.nodes.size, 2)
    assert.strictEqual(state.edges.size, 0)
  })

  it("edge_insert adds edges", () => {
    const g = decodeGraph(encodeGraph(makeGraph([
      nodeBlock(null, [1n, 2n], []),
    ])))
    let state = initState(g)
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.EDGE_INSERT,
      block: edgeBlock("likes", [100n], [1n], [2n], []),
    }] }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.edges.size, 1)
    assert.ok(state.edges.has("100"))
  })

  it("edge_delete removes only the specified edges", () => {
    const g = decodeGraph(encodeGraph(makeGraph([
      nodeBlock(null, [1n, 2n, 3n], []),
      edgeBlock(null, [10n, 11n, 12n], [1n, 2n, 3n], [2n, 3n, 1n], []),
    ])))
    let state = initState(g)
    const chain = decodeChain(encodeChain({ ops: [{ op: OP.EDGE_DELETE, eids: [10n, 12n] }] }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.edges.size, 1)
    assert.ok(state.edges.has("11"))
  })

  it("prop_set updates a node property", () => {
    const g = decodeGraph(encodeGraph(makeGraph([
      nodeBlock("User", [1n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice"] },
      ]),
    ])))
    let state = initState(g)
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 1n, colId: 2 },
      ctype: CTYPE.STRING,
      nullable: false,
      value: "alice_renamed",
    }] }))
    state = applyChain(state, chain.ops)
    assert.strictEqual(state.nodes.get("1").props.get(2).value, "alice_renamed")
  })

  it("prop_set rejects update on non-existent node", () => {
    const initial = initState(decodeGraph(encodeGraph(makeGraph([]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 999n, colId: 2 },
      ctype: CTYPE.INT32,
      nullable: false,
      value: 42,
    }] }))
    assert.throws(() => applyChain(initial, chain.ops), /element_not_found/)
  })

  it("subgraph_replace atomically replaces labeled nodes", () => {
    const g = decodeGraph(encodeGraph(makeGraph([
      nodeBlock("User", [1n, 2n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["alice", "bob"] },
      ]),
      nodeBlock("Admin", [10n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["root"] },
      ]),
    ])))
    let state = initState(g)
    assert.strictEqual(state.nodes.size, 3)

    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.SUBGRAPH_REPLACE,
      label: "User",
      nodeBlock: nodeBlock("User", [3n], [
        { colId: 2, ctype: CTYPE.STRING, nullable: false, values: ["carol"] },
      ]),
      edgeBlock: null,
    }] }))
    state = applyChain(state, chain.ops)
    // Old User nodes (1, 2) gone; new User node (3) added; Admin node (10) unchanged.
    assert.strictEqual(state.nodes.size, 2)
    assert.ok(!state.nodes.has("1"))
    assert.ok(!state.nodes.has("2"))
    assert.ok(state.nodes.has("3"))
    assert.ok(state.nodes.has("10"))
    assert.strictEqual(state.nodes.get("3").props.get(2).value, "carol")
    assert.strictEqual(state.nodes.get("10").props.get(2).value, "root")
  })

  it("node_insert rejects duplicate nid in existing graph", () => {
    const g = decodeGraph(encodeGraph(makeGraph([nodeBlock(null, [1n], [])])))
    const state = initState(g)
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_INSERT,
      block: nodeBlock(null, [1n], []),
    }] }))
    assert.throws(() => applyChain(state, chain.ops), /duplicate_element_id/)
  })

  it("edge_delete is idempotent on non-existent eid", () => {
    const initial = initState(decodeGraph(encodeGraph(makeGraph([]))))
    const chain = decodeChain(encodeChain({ ops: [{ op: OP.EDGE_DELETE, eids: [999n] }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.edges.size, 0)  // no-op, no throw
  })

  it("multi-op chain: insert nodes, insert edges, delete edge", () => {
    const initial = initState(decodeGraph(encodeGraph(makeGraph([]))))
    const chain = decodeChain(encodeChain({ ops: [
      { op: OP.NODE_INSERT, block: nodeBlock(null, [1n, 2n, 3n], []) },
      { op: OP.EDGE_INSERT, block: edgeBlock(null, [10n, 11n], [1n, 2n], [2n, 3n], []) },
      { op: OP.EDGE_DELETE, eids: [10n] },
    ] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 3)
    assert.strictEqual(state.edges.size, 1)
    assert.ok(!state.edges.has("10"))
    assert.ok(state.edges.has("11"))
  })
})

// ── Error classes ──────────────────────────────────────────────────────────

describe("weavepack-graph error class coverage", () => {
  it("unknown_ctype: rejected at encode time", () => {
    assert.throws(
      () => encodeGraph(makeGraph([nodeBlock(null, [1n], [
        { colId: 2, ctype: 16, nullable: false, values: [0] },
      ])])),
      /unknown_ctype/
    )
  })

  it("reserved_col_id for node block (col_id < 2)", () => {
    assert.throws(
      () => encodeGraph(makeGraph([nodeBlock(null, [1n], [
        { colId: 1, ctype: CTYPE.INT32, nullable: false, values: [1] },
      ])])),
      /reserved_col_id/
    )
  })

  it("reserved_col_id for edge block (col_id < 4)", () => {
    assert.throws(
      () => encodeGraph(makeGraph([edgeBlock(null, [1n], [2n], [3n], [
        { colId: 3, ctype: CTYPE.INT32, nullable: false, values: [1] },
      ])])),
      /reserved_col_id/
    )
  })

  it("unknown_delta_op: op code > 5", () => {
    assert.throws(
      () => encodeChain({ ops: [{ op: 6, nids: [] }] }),
      /unknown_delta_op/
    )
  })

  it("unsupported_version: wrong graph_version in header", () => {
    const bytes = encodeGraph(makeGraph([]))
    const tampered = new Uint8Array(bytes)
    tampered[0] = 0x02  // version 2, not 1
    assert.throws(() => decodeGraph(tampered), /unsupported_version/)
  })

  it("wrong_profile: wrong profile_id in header", () => {
    const bytes = encodeGraph(makeGraph([]))
    const tampered = new Uint8Array(bytes)
    tampered[1] = 0x05  // profile 5 (log), not 6 (graph)
    assert.throws(() => decodeGraph(tampered), /wrong_profile/)
  })
})

// ── Profile isolation (no cross-profile imports) ───────────────────────────

describe("weavepack-graph profile isolation", () => {
  it("CTYPE.NODE_ID (15) is graph-specific and not exported by log profile", async () => {
    const { CTYPE: graphCtype } = await import("../src/profiles/graph/index.js")
    const { CTYPE: logCtype } = await import("../src/profiles/log/index.js")
    assert.strictEqual(graphCtype.NODE_ID, 15)
    assert.strictEqual(logCtype.NODE_ID, undefined)
    assert.strictEqual(logCtype.EXT, 15)  // log uses ctype 15 for EXT, not NODE_ID
  })
})
