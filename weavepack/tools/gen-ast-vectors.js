// Generator: produce weavepack-ast conformance test vector corpus.
// Run from the repo root:
//   node weavepack/tools/gen-ast-vectors.js
//
// Writes to weavepack/profiles/ast/test-vectors/.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CTYPE, OP, PATH_KIND,
  encodeTree, decodeTree, encodeChain,
  initState, applyChain,
} from "../../sdk/src/profiles/ast/index.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..", "profiles", "ast", "test-vectors")

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
  const out = {
    type: blk.type,
    nids: (blk.nids || []).map(n => BigInt(n)),
    parentNids: (blk.parentNids || []).map(p => p === null ? null : BigInt(p)),
    childIndices: (blk.childIndices || new Array(blk.nids?.length ?? 0).fill(0)),
    columns: (blk.columns || []).map(col => ({
      colId: col.colId, ctype: col.ctype, nullable: col.nullable,
      values: col.values.map(v => specValToJs(col.ctype, v)),
    })),
  }
  if (blk.type === "node") {
    out.kind = blk.kind ?? ""
  } else {
    out.kinds = blk.kinds ?? new Array(blk.nids?.length ?? 0).fill("")
  }
  return out
}

function specToTree(spec) {
  return {
    schemaHash: spec.schemaHash ? new Uint8Array(spec.schemaHash._bytes) : undefined,
    blocks: (spec.blocks || []).map(specToBlock),
  }
}

function specToPath(p) {
  const out = { kind: p.kind }
  if (p.nid !== undefined) out.nid = BigInt(p.nid)
  if (p.colId !== undefined) out.colId = p.colId
  if (p.prop !== undefined) out.prop = p.prop
  if (p.nodeKind !== undefined) out.nodeKind = p.nodeKind
  return out
}

function specToOp(op) {
  const o = { op: op.op }
  switch (op.op) {
    case OP.NODE_INSERT:
      o.block = specToBlock(op.block)
      o.mixed = op.mixed ?? false
      break
    case OP.NODE_DELETE:
      o.nids = (op.nids || []).map(n => BigInt(n))
      break
    case OP.NODE_MOVE:
      o.nid = BigInt(op.nid)
      o.newParentNid = op.newParentNid !== null ? BigInt(op.newParentNid) : 0n
      o.newChildIndex = op.newChildIndex ?? 0
      break
    case OP.PROP_SET:
      o.path = specToPath(op.path)
      o.ctype = op.ctype
      o.nullable = op.nullable ?? false
      o.value = op.value !== null && op.value !== undefined
        ? specValToJs(op.ctype, op.value)
        : null
      break
    case OP.KIND_RENAME:
      o.oldKind = op.oldKind
      o.newKind = op.newKind
      break
    case OP.SUBTREE_REPLACE:
      o.rootNid = BigInt(op.rootNid)
      o.block = specToBlock(op.block)
      o.mixed = op.mixed ?? false
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
      kind:        node.kind,
      parentNid:   node.parentNid === null ? null : String(node.parentNid),
      childIndex:  node.childIndex,
      props: Array.from(node.props.entries()).sort(sortColKey)
        .map(([colId, { ctype, value }]) => ({ colId, ctype, value: jsValToSpec(ctype, value) })),
    }))
  return { nodes }
}

// ── Helpers to build and encode vectors ───────────────────────────────────

function snapshotVector(name, description, inputSpec) {
  const jsTree  = specToTree(inputSpec)
  const bytes   = encodeTree(jsTree)
  const hex     = toHex(bytes)
  // Verify round-trip
  const decoded = decodeTree(bytes)
  const reenc   = encodeTree(decoded)
  if (toHex(reenc) !== hex)
    throw new Error(`round-trip mismatch in "${name}"`)
  return { name, description, input: inputSpec, expected_bytes_hex: hex }
}

function deltaVector(name, description, initialSpec, opsSpec) {
  const jsOps      = opsSpec.map(specToOp)
  const chainBytes = encodeChain({ ops: jsOps })
  const chainHex   = toHex(chainBytes)

  const jsTree  = specToTree(initialSpec)
  const initDec = decodeTree(encodeTree(jsTree))
  const state   = initState(initDec)
  const final   = applyChain(state, jsOps)
  const finalSpec = stateToSpec(final)

  return {
    name, description,
    initial:                  initialSpec,
    ops:                      opsSpec,
    expected_chain_bytes_hex: chainHex,
    expected_final:           finalSpec,
  }
}

function write(relPath, vectors) {
  const fullPath = join(ROOT, relPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, JSON.stringify(vectors, null, 2) + "\n")
  console.log(`wrote ${relPath} (${vectors.length} vectors)`)
}

// ═════════════════════════════════════════════════════════════════════════════
// types/scalars.json
// ═════════════════════════════════════════════════════════════════════════════

const scalarVectors = [
  snapshotVector("bool false", "ctype 0: bool false as user prop", {
    blocks: [{ type: "node", kind: "Leaf", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.BOOL, nullable: false, values: [false] }] }],
  }),
  snapshotVector("bool true", "ctype 0: bool true as user prop", {
    blocks: [{ type: "node", kind: "Leaf", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.BOOL, nullable: false, values: [true] }] }],
  }),
  snapshotVector("int8 min", "ctype 1: int8 -128", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT8, nullable: false, values: [-128] }] }],
  }),
  snapshotVector("int8 zero", "ctype 1: int8 zero", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT8, nullable: false, values: [0] }] }],
  }),
  snapshotVector("int8 max", "ctype 1: int8 127", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT8, nullable: false, values: [127] }] }],
  }),
  snapshotVector("int16 min", "ctype 2: int16 -32768", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT16, nullable: false, values: [-32768] }] }],
  }),
  snapshotVector("int16 max", "ctype 2: int16 32767", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT16, nullable: false, values: [32767] }] }],
  }),
  snapshotVector("int32 min", "ctype 3: int32 -2147483648", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT32, nullable: false, values: [-2147483648] }] }],
  }),
  snapshotVector("int32 max", "ctype 3: int32 2147483647", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT32, nullable: false, values: [2147483647] }] }],
  }),
  snapshotVector("int64 min", "ctype 4: int64 -9223372036854775808", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT64, nullable: false, values: ["-9223372036854775808"] }] }],
  }),
  snapshotVector("int64 max", "ctype 4: int64 9223372036854775807", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.INT64, nullable: false, values: ["9223372036854775807"] }] }],
  }),
  snapshotVector("uint8 zero", "ctype 5: uint8 0", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.UINT8, nullable: false, values: [0] }] }],
  }),
  snapshotVector("uint8 max", "ctype 5: uint8 255", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.UINT8, nullable: false, values: [255] }] }],
  }),
  snapshotVector("uint16 max", "ctype 6: uint16 65535", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.UINT16, nullable: false, values: [65535] }] }],
  }),
  snapshotVector("uint32 max", "ctype 7: uint32 4294967295", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.UINT32, nullable: false, values: [4294967295] }] }],
  }),
  snapshotVector("uint64 max", "ctype 8: uint64 18446744073709551615", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.UINT64, nullable: false, values: ["18446744073709551615"] }] }],
  }),
  snapshotVector("float32", "ctype 9: float32 3.14", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.FLOAT32, nullable: false, values: [3.140000104904175] }] }],
  }),
  snapshotVector("float64", "ctype 10: float64 3.141592653589793", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.FLOAT64, nullable: false, values: [3.141592653589793] }] }],
  }),
  snapshotVector("string ascii", "ctype 11: ASCII string", {
    blocks: [{ type: "node", kind: "Identifier", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["hello"] }] }],
  }),
  snapshotVector("string utf8", "ctype 11: UTF-8 string with multibyte", {
    blocks: [{ type: "node", kind: "Identifier", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["café"] }] }],
  }),
  snapshotVector("string empty", "ctype 11: empty string", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: [""] }] }],
  }),
  snapshotVector("bytes empty", "ctype 12: empty bytes", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.BYTES, nullable: false,
        values: [{ _bytes: [] }] }] }],
  }),
  snapshotVector("bytes non-empty", "ctype 12: bytes [0xde, 0xad, 0xbe, 0xef]", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.BYTES, nullable: false,
        values: [{ _bytes: [0xde, 0xad, 0xbe, 0xef] }] }] }],
  }),
  snapshotVector("date32 zero", "ctype 13: date32 0 (1970-01-01)", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.DATE32, nullable: false, values: [0] }] }],
  }),
  snapshotVector("date32 positive", "ctype 13: date32 19000 (2022-01-05)", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.DATE32, nullable: false, values: [19000] }] }],
  }),
  snapshotVector("timestamp64 zero", "ctype 14: timestamp64 0 (epoch)", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.TIMESTAMP64, nullable: false, values: ["0"] }] }],
  }),
  snapshotVector("timestamp64 positive", "ctype 14: timestamp64 1000000 microseconds", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.TIMESTAMP64, nullable: false, values: ["1000000"] }] }],
  }),
  snapshotVector("node_id ref", "ctype 15: node_id reference", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.NODE_ID, nullable: false, values: ["42"] }] }],
  }),
]

write("types/scalars.json", scalarVectors)

// ═════════════════════════════════════════════════════════════════════════════
// types/nulls.json
// ═════════════════════════════════════════════════════════════════════════════

const nullVectors = [
  snapshotVector("root node null parent", "root node has null parentNid", {
    blocks: [{ type: "node", kind: "Program", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [] }],
  }),
  snapshotVector("non-root node", "non-root node with non-null parentNid", {
    blocks: [{ type: "node", kind: "Identifier", nids: ["1", "2"],
      parentNids: [null, "1"], childIndices: [0, 0],
      columns: [] }],
  }),
  snapshotVector("nullable string prop null", "nullable string prop with null value", {
    blocks: [{ type: "node", kind: "Literal", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: [null] }] }],
  }),
  snapshotVector("nullable string prop present", "nullable string prop with non-null value", {
    blocks: [{ type: "node", kind: "Literal", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["hello"] }] }],
  }),
  snapshotVector("mixed nullable", "two nodes: first has null prop, second has value", {
    blocks: [{ type: "node", kind: "Literal", nids: ["1", "2"],
      parentNids: [null, "1"], childIndices: [0, 0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: [null, "world"] }] }],
  }),
  snapshotVector("nullable uint64 prop null", "nullable node_id with null", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.NODE_ID, nullable: true, values: [null] }] }],
  }),
  snapshotVector("nullable uint64 prop present", "nullable node_id with value", {
    blocks: [{ type: "node", kind: "N", nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.NODE_ID, nullable: true, values: ["99"] }] }],
  }),
]

write("types/nulls.json", nullVectors)

// ═════════════════════════════════════════════════════════════════════════════
// containers/node_blocks.json
// ═════════════════════════════════════════════════════════════════════════════

const nodeBlockVectors = [
  snapshotVector("empty node block", "node_block with zero nodes", {
    blocks: [{ type: "node", kind: "Program", nids: [], parentNids: [], childIndices: [],
      columns: [] }],
  }),
  snapshotVector("single node block", "node_block with one node", {
    blocks: [{ type: "node", kind: "Identifier",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] }],
  }),
  snapshotVector("multi-node block", "node_block with three nodes of the same kind", {
    blocks: [{ type: "node", kind: "Identifier",
      nids: ["1", "2", "3"], parentNids: [null, "1", "1"], childIndices: [0, 0, 1],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x", "y", "z"] }] }],
  }),
  snapshotVector("multiple blocks", "two node_blocks of different kinds", {
    blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["main"] }] },
    ],
  }),
  snapshotVector("mixed block", "mixed_block with heterogeneous kinds", {
    blocks: [{ type: "mixed",
      nids: ["1", "2", "3"],
      parentNids: [null, "1", "1"],
      childIndices: [0, 0, 1],
      kinds: ["Program", "FunctionDeclaration", "Identifier"],
      columns: [] }],
  }),
  snapshotVector("mixed block with props", "mixed_block with user property columns", {
    blocks: [{ type: "mixed",
      nids: ["1", "2", "3"],
      parentNids: [null, "1", "1"],
      childIndices: [0, 0, 1],
      kinds: ["Program", "Identifier", "Literal"],
      columns: [
        { colId: 4, ctype: CTYPE.STRING, nullable: true, values: [null, "x", null] },
        { colId: 5, ctype: CTYPE.STRING, nullable: true, values: [null, null, "42"] },
      ] }],
  }),
  snapshotVector("large nid jump", "nids with large delta (nid delta > 127 = multi-byte LEB128)", {
    blocks: [{ type: "node", kind: "N",
      nids: ["1", "200"], parentNids: [null, "1"], childIndices: [0, 0],
      columns: [] }],
  }),
  snapshotVector("multiple user cols", "node_block with multiple user columns", {
    blocks: [{ type: "node", kind: "FunctionDeclaration",
      nids: ["10"], parentNids: [null], childIndices: [0],
      columns: [
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["myFunc"] },
        { colId: 5, ctype: CTYPE.UINT32, nullable: false, values: [0] },
        { colId: 6, ctype: CTYPE.UINT32, nullable: false, values: [42] },
      ] }],
  }),
]

write("containers/node_blocks.json", nodeBlockVectors)

// ═════════════════════════════════════════════════════════════════════════════
// containers/tree.json — root + children + grandchildren
// ═════════════════════════════════════════════════════════════════════════════

const treeVectors = [
  snapshotVector("single root node", "tree with only a root", {
    blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["module"] }] }],
  }),
  snapshotVector("root with two children", "Program > [ExpressionStatement, ExpressionStatement]", {
    blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "ExpressionStatement",
        nids: ["2", "3"], parentNids: ["1", "1"], childIndices: [0, 1], columns: [] },
    ],
  }),
  snapshotVector("three level tree", "Program > FunctionDecl > [Identifier, BlockStatement]", {
    blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "FunctionDeclaration",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["hello"] }] },
      { type: "node", kind: "BlockStatement",
        nids: ["3"], parentNids: ["2"], childIndices: [0], columns: [] },
      { type: "node", kind: "ReturnStatement",
        nids: ["4"], parentNids: ["3"], childIndices: [0], columns: [] },
    ],
  }),
  snapshotVector("synthetic JS AST", "Program > FuncDecl > [Identifier, BlockStatement > ReturnStatement > Literal]", {
    blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["module"] }] },
      { type: "node", kind: "FunctionDeclaration",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [
          { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["add"] },
          { colId: 5, ctype: CTYPE.UINT32, nullable: true, values: [0] },
          { colId: 6, ctype: CTYPE.UINT32, nullable: true, values: [60] },
        ] },
      { type: "node", kind: "BlockStatement",
        nids: ["3"], parentNids: ["2"], childIndices: [0], columns: [] },
      { type: "node", kind: "ReturnStatement",
        nids: ["4"], parentNids: ["3"], childIndices: [0], columns: [] },
      { type: "node", kind: "BinaryExpression",
        nids: ["5"], parentNids: ["4"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["+"] }] },
      { type: "node", kind: "Identifier",
        nids: ["6", "7"], parentNids: ["5", "5"], childIndices: [0, 1],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a", "b"] }] },
    ],
  }),
  snapshotVector("empty tree", "tree with zero blocks", {
    blocks: [],
  }),
]

write("containers/tree.json", treeVectors)

// ═════════════════════════════════════════════════════════════════════════════
// deltas/node_insert.json
// ═════════════════════════════════════════════════════════════════════════════

const nodeInsertVectors = [
  deltaVector("insert root into empty tree", "node_insert into empty initial state",
    { blocks: [] },
    [{ op: OP.NODE_INSERT, block: {
      type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0], columns: [],
    }, mixed: false }],
  ),
  deltaVector("insert child node", "node_insert adds child to existing root",
    { blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0], columns: [] }] },
    [{ op: OP.NODE_INSERT, block: {
      type: "node", kind: "Identifier",
      nids: ["2"], parentNids: ["1"], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }],
    }, mixed: false }],
  ),
  deltaVector("insert two siblings", "node_insert adds two sibling nodes",
    { blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0], columns: [] }] },
    [{ op: OP.NODE_INSERT, block: {
      type: "node", kind: "ExpressionStatement",
      nids: ["2", "3"], parentNids: ["1", "1"], childIndices: [0, 1],
      columns: [],
    }, mixed: false }],
  ),
  deltaVector("insert mixed block", "node_insert with mixed block (heterogeneous kinds)",
    { blocks: [] },
    [{ op: OP.NODE_INSERT, block: {
      type: "mixed",
      nids: ["1", "2"],
      parentNids: [null, "1"],
      childIndices: [0, 0],
      kinds: ["Program", "Identifier"],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: [null, "y"] }],
    }, mixed: true }],
  ),
  deltaVector("insert with props", "node_insert with multiple user columns",
    { blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0], columns: [] }] },
    [{ op: OP.NODE_INSERT, block: {
      type: "node", kind: "FunctionDeclaration",
      nids: ["2"], parentNids: ["1"], childIndices: [0],
      columns: [
        { colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["greet"] },
        { colId: 5, ctype: CTYPE.UINT32, nullable: false, values: [0] },
        { colId: 6, ctype: CTYPE.UINT32, nullable: false, values: [100] },
      ],
    }, mixed: false }],
  ),
]

write("deltas/node_insert.json", nodeInsertVectors)

// ═════════════════════════════════════════════════════════════════════════════
// deltas/node_delete.json
// ═════════════════════════════════════════════════════════════════════════════

const nodeDeleteVectors = [
  deltaVector("delete single leaf", "delete a leaf node from tree",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] },
    ]},
    [{ op: OP.NODE_DELETE, nids: ["2"] }],
  ),
  deltaVector("delete subtree", "delete a parent and its children",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "FunctionDeclaration",
        nids: ["2"], parentNids: ["1"], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["3", "4"], parentNids: ["2", "2"], childIndices: [0, 1],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a", "b"] }] },
    ]},
    [{ op: OP.NODE_DELETE, nids: ["2"] }],
  ),
  deltaVector("delete root", "delete root node removes entire tree",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2"], parentNids: ["1"], childIndices: [0], columns: [] },
    ]},
    [{ op: OP.NODE_DELETE, nids: ["1"] }],
  ),
  deltaVector("delete nonexistent nid is no-op", "idempotent delete on missing nid",
    { blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0], columns: [] }] },
    [{ op: OP.NODE_DELETE, nids: ["999"] }],
  ),
  deltaVector("delete multiple leaves", "delete two sibling leaves at once",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2", "3"], parentNids: ["1", "1"], childIndices: [0, 1],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a", "b"] }] },
    ]},
    [{ op: OP.NODE_DELETE, nids: ["2", "3"] }],
  ),
]

write("deltas/node_delete.json", nodeDeleteVectors)

// ═════════════════════════════════════════════════════════════════════════════
// deltas/node_move.json
// ═════════════════════════════════════════════════════════════════════════════

const nodeMoveVectors = [
  deltaVector("move to new parent", "move a leaf node to a different parent",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "FunctionDeclaration",
        nids: ["2", "3"], parentNids: ["1", "1"], childIndices: [0, 1], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["4"], parentNids: ["2"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] },
    ]},
    [{ op: OP.NODE_MOVE, nid: "4", newParentNid: "3", newChildIndex: 0 }],
  ),
  deltaVector("move to root", "move a node to become new root (newParentNid=0)",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["main"] }] },
    ]},
    [{ op: OP.NODE_MOVE, nid: "2", newParentNid: "0", newChildIndex: 0 }],
  ),
  deltaVector("move subtree", "move a subtree to a different parent",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "BlockStatement",
        nids: ["2", "3"], parentNids: ["1", "1"], childIndices: [0, 1], columns: [] },
      { type: "node", kind: "ReturnStatement",
        nids: ["4"], parentNids: ["2"], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["5"], parentNids: ["4"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["result"] }] },
    ]},
    [{ op: OP.NODE_MOVE, nid: "2", newParentNid: "3", newChildIndex: 0 }],
  ),
  deltaVector("move within same parent", "reorder siblings by moving to different child_index",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Statement",
        nids: ["2", "3", "4"], parentNids: ["1", "1", "1"], childIndices: [0, 1, 2],
        columns: [{ colId: 4, ctype: CTYPE.UINT32, nullable: false, values: [0, 1, 2] }] },
    ]},
    [{ op: OP.NODE_MOVE, nid: "4", newParentNid: "1", newChildIndex: 0 }],
  ),
]

write("deltas/node_move.json", nodeMoveVectors)

// ═════════════════════════════════════════════════════════════════════════════
// deltas/prop_set.json
// ═════════════════════════════════════════════════════════════════════════════

const propSetVectors = [
  deltaVector("prop_set by col_id", "update a property via NODE_COL path",
    { blocks: [{ type: "node", kind: "Identifier",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] }] },
    [{ op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 4 },
      ctype: CTYPE.STRING, nullable: false, value: "renamed" }],
  ),
  deltaVector("prop_set by prop name", "update a property via NODE_PROP path",
    { blocks: [{ type: "node", kind: "Identifier",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["oldName"] }] }] },
    [{ op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_PROP, nid: "1", prop: "name" },
      ctype: CTYPE.STRING, nullable: false, value: "newName" }],
  ),
  deltaVector("prop_set null (clear)", "set nullable property to null via NODE_COL path",
    { blocks: [{ type: "node", kind: "Literal",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["42"] }] }] },
    [{ op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 4 },
      ctype: CTYPE.STRING, nullable: true, value: null }],
  ),
  deltaVector("prop_set uint32", "set a uint32 property",
    { blocks: [{ type: "node", kind: "FunctionDeclaration",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 5, ctype: CTYPE.UINT32, nullable: false, values: [0] }] }] },
    [{ op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 5 },
      ctype: CTYPE.UINT32, nullable: false, value: 999 }],
  ),
  deltaVector("prop_set adds new prop", "prop_set on a node that has no existing props",
    { blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [] }] },
    [{ op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 4 },
      ctype: CTYPE.STRING, nullable: false, value: "module" }],
  ),
  deltaVector("multiple prop_sets", "two prop_set ops on same node (last wins)",
    { blocks: [{ type: "node", kind: "Identifier",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a"] }] }] },
    [
      { op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 4 },
        ctype: CTYPE.STRING, nullable: false, value: "b" },
      { op: OP.PROP_SET, path: { kind: PATH_KIND.NODE_COL, nid: "1", colId: 4 },
        ctype: CTYPE.STRING, nullable: false, value: "c" },
    ],
  ),
]

write("deltas/prop_set.json", propSetVectors)

// ═════════════════════════════════════════════════════════════════════════════
// deltas/kind_rename.json
// ═════════════════════════════════════════════════════════════════════════════

const kindRenameVectors = [
  deltaVector("rename single kind", "rename 'Identifier' to 'Name' — one node affected",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] },
    ]},
    [{ op: OP.KIND_RENAME, oldKind: "Identifier", newKind: "Name" }],
  ),
  deltaVector("rename affects many nodes", "rename 'Identifier' to 'Id' — three nodes",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2", "3", "4"], parentNids: ["1", "1", "1"], childIndices: [0, 1, 2],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a", "b", "c"] }] },
    ]},
    [{ op: OP.KIND_RENAME, oldKind: "Identifier", newKind: "Id" }],
  ),
  deltaVector("rename nonexistent kind is no-op", "kind_rename where no nodes match",
    { blocks: [{ type: "node", kind: "Program",
      nids: ["1"], parentNids: [null], childIndices: [0], columns: [] }] },
    [{ op: OP.KIND_RENAME, oldKind: "NonExistent", newKind: "Something" }],
  ),
  deltaVector("rename idempotent", "same kind_rename applied twice",
    { blocks: [{ type: "node", kind: "Identifier",
      nids: ["1"], parentNids: [null], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] }] },
    [
      { op: OP.KIND_RENAME, oldKind: "Identifier", newKind: "Name" },
      { op: OP.KIND_RENAME, oldKind: "Identifier", newKind: "Name" },
    ],
  ),
  deltaVector("chained renames", "chain: Identifier -> TmpKind -> NameNode",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2", "3"], parentNids: ["1", "1"], childIndices: [0, 1],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x", "y"] }] },
    ]},
    [
      { op: OP.KIND_RENAME, oldKind: "Identifier", newKind: "TmpKind" },
      { op: OP.KIND_RENAME, oldKind: "TmpKind", newKind: "NameNode" },
    ],
  ),
]

write("deltas/kind_rename.json", kindRenameVectors)

// ═════════════════════════════════════════════════════════════════════════════
// deltas/subtree_replace.json
// ═════════════════════════════════════════════════════════════════════════════

const subtreeReplaceVectors = [
  deltaVector("replace leaf subtree", "subtree_replace on a leaf node (no children)",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Identifier",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["old"] }] },
    ]},
    [{ op: OP.SUBTREE_REPLACE, rootNid: "2", block: {
      type: "node", kind: "Literal",
      nids: ["10"], parentNids: ["1"], childIndices: [0],
      columns: [
        { colId: 4, ctype: CTYPE.STRING, nullable: true, values: ["42"] },
        { colId: 5, ctype: CTYPE.STRING, nullable: false, values: ["42"] },
      ],
    }, mixed: false }],
  ),
  deltaVector("replace subtree with children", "subtree_replace on a node with children",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "BinaryExpression",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["+"] }] },
      { type: "node", kind: "Identifier",
        nids: ["3", "4"], parentNids: ["2", "2"], childIndices: [0, 1],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["a", "b"] }] },
    ]},
    [{ op: OP.SUBTREE_REPLACE, rootNid: "2", block: {
      type: "node", kind: "Identifier",
      nids: ["20"], parentNids: ["1"], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["result"] }],
    }, mixed: false }],
  ),
  deltaVector("replace with mixed block", "subtree_replace using a mixed_block payload",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "OldKind",
        nids: ["2"], parentNids: ["1"], childIndices: [0], columns: [] },
    ]},
    [{ op: OP.SUBTREE_REPLACE, rootNid: "2", block: {
      type: "mixed",
      nids: ["30", "31"],
      parentNids: ["1", "30"],
      childIndices: [0, 0],
      kinds: ["Container", "Child"],
      columns: [],
    }, mixed: true }],
  ),
  deltaVector("last-write-wins", "subtree_replace twice on same root = last wins",
    { blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      { type: "node", kind: "Placeholder",
        nids: ["2"], parentNids: ["1"], childIndices: [0], columns: [] },
    ]},
    [
      { op: OP.SUBTREE_REPLACE, rootNid: "2", block: {
        type: "node", kind: "First",
        nids: ["10"], parentNids: ["1"], childIndices: [0], columns: [],
      }, mixed: false },
      { op: OP.SUBTREE_REPLACE, rootNid: "2", block: {
        type: "node", kind: "Second",
        nids: ["20"], parentNids: ["1"], childIndices: [0], columns: [],
      }, mixed: false },
    ],
  ),
]

write("deltas/subtree_replace.json", subtreeReplaceVectors)

// ═════════════════════════════════════════════════════════════════════════════
// schemas/schemaful.json
// ═════════════════════════════════════════════════════════════════════════════

// ESTree-style JS AST subset schema hash (arbitrary known bytes for testing).
// In production this would be SHA-256 of canonical JSON schema; we use a
// fixed all-0xAB pattern for the conformance test.
const SCHEMA_HASH = new Uint8Array(32).fill(0xAB)
const SCHEMA_HASH_SPEC = { _bytes: Array.from(SCHEMA_HASH) }

const schemafulVectors = [
  snapshotVector("schemaful snapshot", "tree with a non-zero schema hash in the header", {
    schemaHash: SCHEMA_HASH_SPEC,
    blocks: [
      { type: "node", kind: "Program",
        nids: ["1"], parentNids: [null], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["module"] }] },
      { type: "node", kind: "FunctionDeclaration",
        nids: ["2"], parentNids: ["1"], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["render"] }] },
    ],
  }),
  snapshotVector("zero schema hash", "tree with all-zero schema hash (no schema)", {
    blocks: [
      { type: "node", kind: "Identifier",
        nids: ["5"], parentNids: [null], childIndices: [0],
        columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["x"] }] },
    ],
  }),
  deltaVector("schemaful chain", "delta chain with non-zero schema hash in header",
    {
      schemaHash: SCHEMA_HASH_SPEC,
      blocks: [
        { type: "node", kind: "Program",
          nids: ["1"], parentNids: [null], childIndices: [0], columns: [] },
      ],
    },
    [{ op: OP.NODE_INSERT, block: {
      type: "node", kind: "Identifier",
      nids: ["2"], parentNids: ["1"], childIndices: [0],
      columns: [{ colId: 4, ctype: CTYPE.STRING, nullable: false, values: ["myVar"] }],
    }, mixed: false }],
  ),
]

write("schemas/schemaful.json", schemafulVectors)

// ═════════════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════════════

const total = scalarVectors.length + nullVectors.length + nodeBlockVectors.length +
  treeVectors.length + nodeInsertVectors.length + nodeDeleteVectors.length +
  nodeMoveVectors.length + propSetVectors.length + kindRenameVectors.length +
  subtreeReplaceVectors.length + schemafulVectors.length

console.log(`\nTotal AST test vectors: ${total}`)
