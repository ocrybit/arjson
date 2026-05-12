// weavepack-ast — reference implementation tests (AS.2).
//
// Covers: all 16 ctypes including node_id (ctype 15), nullable parent_nid,
// node_block + mixed_block round-trips, tree document encode/decode,
// delta chains (node_insert, node_delete, node_move, prop_set, kind_rename,
// subtree_replace), and applyChain semantics.

import { describe, it } from "node:test"
import assert from "assert"
import {
  CTYPE, OP, PATH_KIND,
  encodeTree, decodeTree,
  encodeChain, decodeChain,
  initState, applyChain,
} from "../src/profiles/ast/index.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function roundTrip(tree) {
  return decodeTree(encodeTree(tree))
}

function makeTree(blocks, schemaHash) {
  return { schemaHash: schemaHash ?? new Uint8Array(32), blocks }
}

function nodeBlock(kind, nids, parentNids, childIndices, columns) {
  return {
    type: 'node',
    kind,
    nids: nids.map(BigInt),
    parentNids: parentNids.map(p => p === null ? null : BigInt(p)),
    childIndices,
    columns,
  }
}

function mixedBlock(nids, parentNids, childIndices, kinds, columns) {
  return {
    type: 'mixed',
    nids: nids.map(BigInt),
    parentNids: parentNids.map(p => p === null ? null : BigInt(p)),
    childIndices,
    kinds,
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

// ── Empty tree ─────────────────────────────────────────────────────────────

describe("weavepack-ast empty tree", () => {
  it("encodes and decodes an empty tree (0 blocks)", () => {
    const t = makeTree([])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks.length, 0)
  })

  it("round-trips schema_hash", () => {
    const hash = new Uint8Array(32).fill(0xAB)
    const t = makeTree([], hash)
    const rt = roundTrip(t)
    assert.deepStrictEqual(rt.schemaHash, hash)
  })
})

// ── node_block round-trips ─────────────────────────────────────────────────

describe("weavepack-ast node_block round-trip", () => {
  it("encodes and decodes an empty node_block", () => {
    const t = makeTree([nodeBlock("Program", [], [], [], [])])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks.length, 1)
    assert.strictEqual(rt.blocks[0].type, 'node')
    assert.strictEqual(rt.blocks[0].nids.length, 0)
    assert.strictEqual(rt.blocks[0].kind, "Program")
  })

  it("round-trips a single-node tree (root with null parent)", () => {
    const t = makeTree([nodeBlock("Program", [1n], [null], [0], [])])
    const rt = roundTrip(t)
    assert.ok(bigEq(rt.blocks[0].nids[0], 1n))
    assert.strictEqual(rt.blocks[0].parentNids[0], null)
    assert.strictEqual(rt.blocks[0].childIndices[0], 0)
    assert.strictEqual(rt.blocks[0].kind, "Program")
  })

  it("round-trips parent_nid (non-null)", () => {
    // root nid=1, child nid=2 (parent=1, child_index=0)
    const t = makeTree([nodeBlock("FunctionDeclaration", [1n, 2n], [null, 1n], [0, 0], [])])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks[0].parentNids[0], null)
    assert.ok(bigEq(rt.blocks[0].parentNids[1], 1n))
  })

  it("round-trips child_index values", () => {
    // Three siblings: parent=1, indices 0,1,2
    const t = makeTree([nodeBlock("BlockStatement", [1n, 2n, 3n, 4n], [null, 1n, 1n, 1n], [0, 0, 1, 2], [])])
    const rt = roundTrip(t)
    assert.deepStrictEqual(rt.blocks[0].childIndices, [0, 0, 1, 2])
  })

  it("round-trips user columns: string", () => {
    const t = makeTree([nodeBlock("Identifier", [1n], [null], [0], [
      { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["foo"] },
    ])])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks[0].columns[0].values[0], "foo")
  })

  it("round-trips user columns: nullable string", () => {
    const t = makeTree([nodeBlock("Literal", [1n, 2n], [null, null], [0, 1], [
      { colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["hello", null] },
    ])])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks[0].columns[0].values[0], "hello")
    assert.strictEqual(rt.blocks[0].columns[0].values[1], null)
  })

  it("round-trips a tree with multiple node_blocks", () => {
    const t = makeTree([
      nodeBlock("Program", [1n], [null], [0], []),
      nodeBlock("FunctionDeclaration", [2n], [1n], [0], [
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["greet"] },
      ]),
      nodeBlock("Identifier", [3n, 4n], [2n, 2n], [0, 1], [
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["greet", "name"] },
      ]),
    ])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks.length, 3)
    assert.strictEqual(rt.blocks[1].columns[0].values[0], "greet")
    assert.strictEqual(rt.blocks[2].columns[0].values[1], "name")
  })
})

// ── mixed_block round-trips ────────────────────────────────────────────────

describe("weavepack-ast mixed_block round-trip", () => {
  it("encodes and decodes an empty mixed_block", () => {
    const t = makeTree([mixedBlock([], [], [], [], [])])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks[0].type, 'mixed')
    assert.strictEqual(rt.blocks[0].nids.length, 0)
  })

  it("round-trips per-row kinds in mixed_block", () => {
    const t = makeTree([mixedBlock(
      [10n, 11n, 12n], [null, 10n, 10n], [0, 0, 1],
      ["ExpressionStatement", "IfStatement", "ReturnStatement"],
      []
    )])
    const rt = roundTrip(t)
    assert.deepStrictEqual(rt.blocks[0].kinds, ["ExpressionStatement", "IfStatement", "ReturnStatement"])
    assert.ok(bigEq(rt.blocks[0].nids[2], 12n))
    assert.ok(bigEq(rt.blocks[0].parentNids[1], 10n))
  })

  it("round-trips mixed_block with user columns", () => {
    const t = makeTree([mixedBlock(
      [1n, 2n], [null, 1n], [0, 0],
      ["Literal", "Identifier"],
      [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["42", null] }]
    )])
    const rt = roundTrip(t)
    assert.strictEqual(rt.blocks[0].columns[0].values[0], "42")
    assert.strictEqual(rt.blocks[0].columns[0].values[1], null)
  })
})

// ── All 16 ctypes ─────────────────────────────────────────────────────────

describe("weavepack-ast ctype round-trips", () => {
  function singleColTree(colId, ctype, nullable, values) {
    return makeTree([nodeBlock("X", values.map((_, i) => BigInt(i + 1)), values.map(() => null), values.map((_, i) => i), [
      { colId, ctype, nullable, values },
    ])])
  }

  it("BOOL (0)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.BOOL, false, [true, false, true]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [true, false, true])
  })
  it("INT8 (1)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.INT8, false, [-128, 0, 127]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [-128, 0, 127])
  })
  it("INT16 (2)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.INT16, false, [-32768, 0, 32767]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [-32768, 0, 32767])
  })
  it("INT32 (3)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.INT32, false, [-2147483648, 0, 2147483647]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [-2147483648, 0, 2147483647])
  })
  it("INT64 (4)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.INT64, false, [-9223372036854775808n, 0n, 9223372036854775807n]))
    const vals = rt.blocks[0].columns[0].values
    assert.ok(vals[0] === -9223372036854775808n)
    assert.ok(vals[1] === 0n)
    assert.ok(vals[2] === 9223372036854775807n)
  })
  it("UINT8 (5)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.UINT8, false, [0, 127, 255]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [0, 127, 255])
  })
  it("UINT16 (6)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.UINT16, false, [0, 1000, 65535]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [0, 1000, 65535])
  })
  it("UINT32 (7)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.UINT32, false, [0, 1000000, 4294967295]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [0, 1000000, 4294967295])
  })
  it("UINT64 (8)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.UINT64, false, [0n, 1000000n, 18446744073709551615n]))
    const vals = rt.blocks[0].columns[0].values
    assert.ok(vals[0] === 0n)
    assert.ok(vals[2] === 18446744073709551615n)
  })
  it("FLOAT32 (9)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.FLOAT32, false, [1.5, -2.5]))
    assert.ok(Math.abs(rt.blocks[0].columns[0].values[0] - 1.5) < 1e-5)
  })
  it("FLOAT64 (10)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.FLOAT64, false, [Math.PI]))
    assert.ok(Math.abs(rt.blocks[0].columns[0].values[0] - Math.PI) < 1e-10)
  })
  it("STRING (11)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.STRING, false, ["hello", "world"]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, ["hello", "world"])
  })
  it("BYTES (12)", () => {
    const b = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])
    const rt = roundTrip(singleColTree(4, CTYPE.BYTES, false, [b]))
    assert.ok(rt.blocks[0].columns[0].values[0] instanceof Uint8Array)
    assert.deepStrictEqual(Array.from(rt.blocks[0].columns[0].values[0]), [0xDE, 0xAD, 0xBE, 0xEF])
  })
  it("DATE32 (13)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.DATE32, false, [19000, -1]))
    assert.deepStrictEqual(rt.blocks[0].columns[0].values, [19000, -1])
  })
  it("TIMESTAMP64 (14)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.TIMESTAMP64, false, [1700000000000000n]))
    assert.ok(rt.blocks[0].columns[0].values[0] === 1700000000000000n)
  })
  it("NODE_ID (15)", () => {
    const rt = roundTrip(singleColTree(4, CTYPE.NODE_ID, false, [0n, 999n, 18446744073709551615n]))
    const vals = rt.blocks[0].columns[0].values
    assert.ok(vals[0] === 0n)
    assert.ok(vals[1] === 999n)
    assert.ok(vals[2] === 18446744073709551615n)
  })
})

// ── Delta chain tests ──────────────────────────────────────────────────────

describe("weavepack-ast delta chain: node_insert", () => {
  it("node_insert adds nodes to the live state", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_INSERT,
      block: nodeBlock("Program", [1n], [null], [0], []),
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 1)
    assert.ok(state.nodes.has("1"))
    assert.strictEqual(state.nodes.get("1").kind, "Program")
    assert.strictEqual(state.nodes.get("1").parentNid, null)
    assert.strictEqual(state.nodes.get("1").childIndex, 0)
  })

  it("node_insert (mixed block) adds heterogeneous nodes", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_INSERT,
      mixed: true,
      block: mixedBlock(
        [1n, 2n, 3n], [null, 1n, 1n], [0, 0, 1],
        ["Program", "FunctionDeclaration", "ReturnStatement"],
        []
      ),
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 3)
    assert.strictEqual(state.nodes.get("1").kind, "Program")
    assert.strictEqual(state.nodes.get("2").kind, "FunctionDeclaration")
    assert.strictEqual(state.nodes.get("3").kind, "ReturnStatement")
  })

  it("node_insert rejects duplicate nid", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Program", [1n], [null], [0], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_INSERT,
      block: nodeBlock("Program", [1n], [null], [0], []),
    }] }))
    assert.throws(() => applyChain(initial, chain.ops), /duplicate_element_id/)
  })
})

describe("weavepack-ast delta chain: node_delete", () => {
  it("node_delete removes a leaf node", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Program", [1n, 2n], [null, 1n], [0, 0], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{ op: OP.NODE_DELETE, nids: [2n] }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 1)
    assert.ok(!state.nodes.has("2"))
  })

  it("node_delete removes subtree descendants recursively", () => {
    // Tree: 1 (root) → 2 → 3, 4; delete 2 removes 2, 3, 4
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("X", [1n, 2n, 3n, 4n], [null, 1n, 2n, 2n], [0, 0, 0, 1], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{ op: OP.NODE_DELETE, nids: [2n] }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 1)
    assert.ok(state.nodes.has("1"))
  })

  it("node_delete is idempotent for non-existent nid", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([]))))
    const chain = decodeChain(encodeChain({ ops: [{ op: OP.NODE_DELETE, nids: [999n] }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 0)
  })
})

describe("weavepack-ast delta chain: node_move", () => {
  it("node_move changes parent and child_index", () => {
    // Tree: root(1) → A(2), B(3); move B under A
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("X", [1n, 2n, 3n], [null, 1n, 1n], [0, 0, 1], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_MOVE,
      nid: 3n,
      newParentNid: 2n,
      newChildIndex: 0,
    }] }))
    const state = applyChain(initial, chain.ops)
    const node3 = state.nodes.get("3")
    assert.ok(bigEq(node3.parentNid, 2n))
    assert.strictEqual(node3.childIndex, 0)
  })

  it("node_move with newParentNid=0 makes a root", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("X", [1n, 2n], [null, 1n], [0, 0], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_MOVE,
      nid: 2n,
      newParentNid: 0n,
      newChildIndex: 0,
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.get("2").parentNid, null)
  })

  it("node_move rejects non-existent nid", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.NODE_MOVE,
      nid: 999n,
      newParentNid: 0n,
      newChildIndex: 0,
    }] }))
    assert.throws(() => applyChain(initial, chain.ops), /element_not_found/)
  })
})

describe("weavepack-ast delta chain: prop_set", () => {
  it("prop_set updates a user property by col_id", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Identifier", [1n], [null], [0], [
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["oldName"] },
      ]),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 1n, colId: 4 },
      ctype: CTYPE.STRING,
      nullable: false,
      value: "newName",
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.get("1").props.get(4).value, "newName")
  })

  it("prop_set with is_null removes the property", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Literal", [1n], [null], [0], [
        { colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["42"] },
      ]),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 1n, colId: 4 },
      ctype: CTYPE.STRING,
      nullable: true,
      value: null,
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.ok(!state.nodes.get("1").props.has(4))
  })

  it("prop_set by prop name (NODE_PROP path kind)", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Identifier", [1n], [null], [0], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_PROP, nid: 1n, prop: "name" },
      ctype: CTYPE.STRING,
      nullable: false,
      value: "x",
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.get("1").props.get("name").value, "x")
  })

  it("prop_set rejects non-existent node", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 999n, colId: 4 },
      ctype: CTYPE.INT32,
      nullable: false,
      value: 1,
    }] }))
    assert.throws(() => applyChain(initial, chain.ops), /element_not_found/)
  })
})

describe("weavepack-ast delta chain: kind_rename", () => {
  it("kind_rename renames all matching nodes in one op", () => {
    // 50 Identifier nodes, 5 Program nodes; rename Identifier → Id
    const nids = Array.from({ length: 55 }, (_, i) => BigInt(i + 1))
    const parents = nids.map((_, i) => i < 50 ? null : null)
    const ci = nids.map((_, i) => i)
    const kinds50 = new Array(50).fill("Identifier")
    const kinds5 = new Array(5).fill("Program")
    const initial = initState(decodeTree(encodeTree(makeTree([
      mixedBlock(
        nids.slice(0, 50), parents.slice(0, 50), ci.slice(0, 50),
        kinds50, []
      ),
      mixedBlock(
        nids.slice(50), parents.slice(50), ci.slice(50),
        kinds5, []
      ),
    ]))))
    assert.strictEqual([...initial.nodes.values()].filter(n => n.kind === "Identifier").length, 50)

    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.KIND_RENAME,
      oldKind: "Identifier",
      newKind: "Id",
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual([...state.nodes.values()].filter(n => n.kind === "Identifier").length, 0)
    assert.strictEqual([...state.nodes.values()].filter(n => n.kind === "Id").length, 50)
    assert.strictEqual([...state.nodes.values()].filter(n => n.kind === "Program").length, 5)
  })

  it("kind_rename is idempotent for same old/new kind pair", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("A", [1n], [null], [0], []),
    ]))))
    const op = { op: OP.KIND_RENAME, oldKind: "A", newKind: "B" }
    const chain = decodeChain(encodeChain({ ops: [op, op] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.get("1").kind, "B")
  })

  it("kind_rename on non-existent kind is a no-op", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Program", [1n], [null], [0], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.KIND_RENAME,
      oldKind: "Identifier",
      newKind: "Id",
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.get("1").kind, "Program")
  })
})

describe("weavepack-ast delta chain: subtree_replace", () => {
  it("subtree_replace replaces descendants of root_nid", () => {
    // Tree: root(1) → body(2) → stmt(3); replace body's subtree
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("X", [1n, 2n, 3n], [null, 1n, 2n], [0, 0, 0], []),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.SUBTREE_REPLACE,
      rootNid: 2n,
      block: nodeBlock("ReturnStatement", [10n, 11n], [2n, 2n], [0, 1], []),
    }] }))
    const state = applyChain(initial, chain.ops)
    // nid=3 (old descendant) removed; nids 10, 11 added
    assert.ok(!state.nodes.has("3"))
    assert.ok(state.nodes.has("10"))
    assert.ok(state.nodes.has("11"))
    // root(1) and body(2) still present
    assert.ok(state.nodes.has("1"))
    assert.ok(state.nodes.has("2"))
  })

  it("subtree_replace on a leaf node (no descendants to remove)", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([
      nodeBlock("Identifier", [1n], [null], [0], [
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] },
      ]),
    ]))))
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.SUBTREE_REPLACE,
      rootNid: 1n,
      block: nodeBlock("Literal", [2n], [1n], [0], [
        { colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["42"] },
      ]),
    }] }))
    const state = applyChain(initial, chain.ops)
    assert.ok(state.nodes.has("1"))
    assert.ok(state.nodes.has("2"))
    assert.strictEqual(state.nodes.get("2").props.get(4).value, "42")
  })
})

// ── Multi-op chain ─────────────────────────────────────────────────────────

describe("weavepack-ast multi-op chain", () => {
  it("insert, rename, delete, prop_set in one chain", () => {
    const initial = initState(decodeTree(encodeTree(makeTree([]))))
    const chain = decodeChain(encodeChain({ ops: [
      {
        op: OP.NODE_INSERT,
        block: nodeBlock("Identifier", [1n, 2n, 3n], [null, null, null], [0, 1, 2], [
          { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a", "b", "c"] },
        ]),
      },
      { op: OP.KIND_RENAME, oldKind: "Identifier", newKind: "Id" },
      { op: OP.NODE_DELETE, nids: [2n] },
      {
        op: OP.PROP_SET,
        path: { kind: PATH_KIND.NODE_COL, nid: 1n, colId: 4 },
        ctype: CTYPE.STRING,
        nullable: false,
        value: "alpha",
      },
    ] }))
    const state = applyChain(initial, chain.ops)
    assert.strictEqual(state.nodes.size, 2)
    assert.strictEqual(state.nodes.get("1").kind, "Id")
    assert.strictEqual(state.nodes.get("1").props.get(4).value, "alpha")
    assert.strictEqual(state.nodes.get("3").props.get(4).value, "c")
    assert.ok(!state.nodes.has("2"))
  })
})

// ── Path kinds round-trips ────────────────────────────────────────────────

describe("weavepack-ast path kinds round-trip", () => {
  it("NODE path (kind=0)", () => {
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE, nid: 42n },
      ctype: CTYPE.INT32, nullable: false, value: 1,
    }] }))
    assert.strictEqual(chain.ops[0].path.kind, PATH_KIND.NODE)
    assert.ok(bigEq(chain.ops[0].path.nid, 42n))
  })

  it("NODE_COL path (kind=1)", () => {
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_COL, nid: 7n, colId: 5 },
      ctype: CTYPE.STRING, nullable: false, value: "x",
    }] }))
    assert.strictEqual(chain.ops[0].path.kind, PATH_KIND.NODE_COL)
    assert.ok(bigEq(chain.ops[0].path.nid, 7n))
    assert.strictEqual(chain.ops[0].path.colId, 5)
  })

  it("NODE_KIND path (kind=2)", () => {
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_KIND, nodeKind: "Identifier" },
      ctype: CTYPE.STRING, nullable: false, value: "x",
    }] }))
    assert.strictEqual(chain.ops[0].path.nodeKind, "Identifier")
  })

  it("NODE_PROP path (kind=7)", () => {
    const chain = decodeChain(encodeChain({ ops: [{
      op: OP.PROP_SET,
      path: { kind: PATH_KIND.NODE_PROP, nid: 3n, prop: "name" },
      ctype: CTYPE.STRING, nullable: false, value: "y",
    }] }))
    const p = chain.ops[0].path
    assert.ok(bigEq(p.nid, 3n))
    assert.strictEqual(p.prop, "name")
  })
})

// ── Error classes ──────────────────────────────────────────────────────────

describe("weavepack-ast error class coverage", () => {
  it("unknown_ctype: rejected at encode time", () => {
    assert.throws(
      () => encodeTree(makeTree([nodeBlock("X", [1n], [null], [0], [
        { colId: 4, ctype: 16, nullable: false, values: [0] },
      ])])),
      /unknown_ctype/
    )
  })

  it("reserved_col_id: col_id < 4 rejected for user columns", () => {
    assert.throws(
      () => encodeTree(makeTree([nodeBlock("X", [1n], [null], [0], [
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

  it("unknown_path_kind: path kind >= 8", () => {
    assert.throws(
      () => encodeChain({ ops: [{
        op: OP.PROP_SET,
        path: { kind: 8, nid: 1n },
        ctype: CTYPE.INT32, nullable: false, value: 1,
      }] }),
      /unknown_path_kind/
    )
  })

  it("unsupported_version: wrong ast_version in header", () => {
    const bytes = encodeTree(makeTree([]))
    const tampered = new Uint8Array(bytes)
    tampered[0] = 0x02  // version 2, not 1
    assert.throws(() => decodeTree(tampered), /unsupported_version/)
  })

  it("wrong_profile: wrong profile_id in header", () => {
    const bytes = encodeTree(makeTree([]))
    const tampered = new Uint8Array(bytes)
    tampered[1] = 0x06  // profile 6 (graph), not 7 (ast)
    assert.throws(() => decodeTree(tampered), /wrong_profile/)
  })

  it("duplicate_nid: nid delta < 1 rejected by encoder", () => {
    assert.throws(
      () => encodeTree(makeTree([nodeBlock("X", [2n, 1n], [null, null], [0, 1], [])])),
      /duplicate_element_id/
    )
  })
})

// ── Profile isolation ──────────────────────────────────────────────────────

describe("weavepack-ast profile isolation", () => {
  it("NODE_ID ctype (15) is present in ast and graph; absent in log", async () => {
    const { CTYPE: astCtype }   = await import("../src/profiles/ast/index.js")
    const { CTYPE: graphCtype } = await import("../src/profiles/graph/index.js")
    const { CTYPE: logCtype }   = await import("../src/profiles/log/index.js")
    assert.strictEqual(astCtype.NODE_ID,   15)
    assert.strictEqual(graphCtype.NODE_ID, 15)
    assert.strictEqual(logCtype.NODE_ID,   undefined)
  })

  it("ast PROFILE_NUM is 7 (distinct from graph=6, log=5, tabular=4)", async () => {
    const { PROFILE_NUM } = await import("../src/profiles/ast/index.js")
    assert.strictEqual(PROFILE_NUM, 7)
  })
})
