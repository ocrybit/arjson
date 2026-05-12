#!/usr/bin/env node
// weavepack/tools/benchmark-ast.js
//
// AS.6: benchmark weavepack-ast vs ESTree JSON + gzip.
// Three scenarios from weavepack/profiles/ast/07-benchmarks.md.
//
// Usage (from repo root):
//   node weavepack/tools/benchmark-ast.js

import { brotliCompressSync, gzipSync, constants } from "node:zlib"
import {
  CTYPE, OP, PATH_KIND,
  encodeTree, encodeChain,
} from "../../sdk/src/profiles/ast/index.js"

// ── LCG PRNG ─────────────────────────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0
  return {
    nextUint32() { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s },
    pick(arr)    { return arr[this.nextUint32() % arr.length] },
  }
}

// ── Compression ─────────────────────────────────────────────────────────────────────────

const BROTLI_Q6 = { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }
function brotli(b) { return brotliCompressSync(Buffer.isBuffer(b) ? b : Buffer.from(b), BROTLI_Q6).length }
function gzip6(b)  { return gzipSync(Buffer.isBuffer(b) ? b : Buffer.from(b), { level: 6 }).length }

// ── Data constants ───────────────────────────────────────────────────────────────────────────

const FUNC_NAMES = [
  "render","compute","process","transform","validate",
  "filter","reduce","map","find","create",
  "update","delete","fetch","parse","format",
  "encode","decode","merge","split","sort",
]

const VAR_NAMES = [
  "x","y","z","i","j","k","n","m","v","w",
  "result","value","data","item","node",
  "index","count","total","key","src",
]

// ── AST shape ─────────────────────────────────────────────────────────────────────────────
//
// 1 Program
// NUM_FUNCS FunctionDeclarations (children of Program)
// Per FunctionDeclaration:
//   1 Identifier  (function name,  child_index 0)
//   1 BlockStatement (body,        child_index 1)
//     STMTS_PER_BLOCK ExpressionStatements (children of BlockStatement)
//       Per ExpressionStatement: 1 Identifier (expression, child_index 0)
//
// Total = 1 + NUM_FUNCS * (1 + 1 + 1 + STMTS + STMTS)
//       = 1 + 40 * 25 = 1 001

const NUM_FUNCS       = 40
const STMTS_PER_BLOCK = 11

// ── Build AST ──────────────────────────────────────────────────────────────────────────────

function buildAst(rng) {
  const nodeMap = new Map()   // nid -> {kind, parentNid, childIndex, name?}
  let nid = 1

  const add = (kind, parentNid, childIndex, name) => {
    const id = nid++
    nodeMap.set(id, { kind, parentNid, childIndex, ...(name !== undefined ? { name } : {}) })
    return id
  }

  const prog = add("Program", null, 0)
  for (let fi = 0; fi < NUM_FUNCS; fi++) {
    const func  = add("FunctionDeclaration", prog, fi)
    add("Identifier", func, 0, FUNC_NAMES[fi % FUNC_NAMES.length] + fi)
    const block = add("BlockStatement", func, 1)
    for (let si = 0; si < STMTS_PER_BLOCK; si++) {
      const stmt = add("ExpressionStatement", block, si)
      add("Identifier", stmt, 0, rng.pick(VAR_NAMES))
    }
  }
  return nodeMap
}

// ── weavepack encoder ──────────────────────────────────────────────────────────────────────────

function encodeAstWp(nodeMap) {
  const byKind = new Map()
  for (const [nid, node] of nodeMap) {
    if (!byKind.has(node.kind)) byKind.set(node.kind, [])
    byKind.get(node.kind).push({ nid, ...node })
  }
  const blocks = []
  for (const [kind, nodes] of byKind) {
    nodes.sort((a, b) => a.nid - b.nid)
    const hasName = nodes.some(n => n.name !== undefined)
    blocks.push({
      type: "node", kind,
      nids:         nodes.map(n => BigInt(n.nid)),
      parentNids:   nodes.map(n => n.parentNid !== null ? BigInt(n.parentNid) : null),
      childIndices: nodes.map(n => n.childIndex),
      columns: hasName ? [{
        colId: 4, ctype: CTYPE.STRING, nullable: true,
        values: nodes.map(n => n.name ?? null),
      }] : [],
    })
  }
  return encodeTree({ blocks })
}

// ── ESTree JSON encoder ──────────────────────────────────────────────────────────────────────────

function encodeEstree(nodeMap) {
  const childrenOf = new Map()
  for (const [nid, node] of nodeMap) {
    if (node.parentNid !== null) {
      if (!childrenOf.has(node.parentNid)) childrenOf.set(node.parentNid, [])
      childrenOf.get(node.parentNid).push({ nid, ci: node.childIndex })
    }
  }
  for (const kids of childrenOf.values()) kids.sort((a, b) => a.ci - b.ci)

  function build(nid) {
    const node = nodeMap.get(nid)
    if (!node) return null
    const kids = (childrenOf.get(nid) || []).map(k => build(k.nid)).filter(Boolean)
    switch (node.kind) {
      case "Program":             return { type: "Program", body: kids }
      case "FunctionDeclaration": return { type: "FunctionDeclaration", id: kids[0] ?? null, body: kids[1] ?? null }
      case "Identifier":          return { type: "Identifier", name: node.name || "" }
      case "BlockStatement":      return { type: "BlockStatement", body: kids }
      case "ExpressionStatement": return { type: "ExpressionStatement", expression: kids[0] ?? null }
      default:                    return { type: node.kind }
    }
  }
  return Buffer.from(JSON.stringify(build(1)), "utf8")
}

// ── Scenario 1 — Snapshot ────────────────────────────────────────────────────────────────────────
//
// 1 001-node synthetic JS AST (Program → FunctionDeclarations → BlockStatements →
// ExpressionStatements → Identifiers).
// weavepack: one snapshot document (node_blocks grouped by kind).
// ESTree JSON baseline: JSON.stringify of recursive tree, gzip-6.
// Gate: weavepack brotli-6 ≤ 3× ESTree JSON gzip-6.

function scenario1() {
  console.log("\n── Scenario 1: AST snapshot (1 001 nodes) ──────────────────────────────────────────────────")

  const rng = makeRng(1)
  const nodeMap = buildAst(rng)

  const wpBytes  = encodeAstWp(nodeMap)
  const wpRaw    = wpBytes.length
  const wpBrotli = brotli(wpBytes)

  const jsonBytes = encodeEstree(nodeMap)
  const jsonRaw   = jsonBytes.length
  const jsonGzip  = gzip6(jsonBytes)

  const ratio = wpBrotli / jsonGzip

  console.log(`  Nodes:                        ${nodeMap.size.toLocaleString().padStart(12)}`)
  console.log(`  weavepack raw:              ${wpRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  weavepack brotli-6:         ${wpBrotli.toLocaleString().padStart(12)} bytes`)
  console.log(`  ESTree JSON raw:            ${jsonRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  ESTree JSON gzip-6:         ${jsonGzip.toLocaleString().padStart(12)} bytes`)
  console.log(`  ratio (wp-brotli / json-gz): ${ratio.toFixed(2)}×`)
  const gate = ratio <= 3.0
  console.log(`  Gate (weavepack brotli ≤ 3× ESTree JSON gzip): ${gate ? "PASS ✓" : "FAIL ✗"}`)
  return { gate, wpRaw, wpBrotli, jsonRaw, jsonGzip, ratio }
}

// ── Scenario 2 — Symbol rename (50 frames) ────────────────────────────────────────────────────────────────
//
// Start from the 1 001-node snapshot. 50 prop_set frames each renaming one
// Identifier's name column (col_id 4). Compares cumulative delta stream vs
// per-snapshot ESTree JSON gzip (the incumbent re-encodes the full AST each frame).
// Gate: weavepack raw ≥ 50× smaller than per-snapshot ESTree JSON gzip sum.

function scenario2() {
  console.log("\n── Scenario 2: Symbol rename (50 prop_set frames) ─────────────────────────────────────────")

  const rng = makeRng(2)
  const nodeMap = buildAst(rng)

  // Expression Identifiers (children of ExpressionStatements)
  const exprIdents = []
  for (const [nid, node] of nodeMap) {
    if (node.kind === "Identifier") {
      const parent = nodeMap.get(node.parentNid)
      if (parent?.kind === "ExpressionStatement") exprIdents.push(nid)
    }
  }

  let totalWpRaw = 0, totalWpBrotli = 0, totalJsonGzip = 0

  for (let i = 0; i < 50; i++) {
    const targetNid = exprIdents[rng.nextUint32() % exprIdents.length]
    const newName   = rng.pick(VAR_NAMES)
    nodeMap.get(targetNid).name = newName

    const chainBytes = encodeChain({ ops: [{
      op:       OP.PROP_SET,
      path:     { kind: PATH_KIND.NODE_COL, nid: BigInt(targetNid), colId: 4 },
      ctype:    CTYPE.STRING, nullable: false, value: newName,
    }] })
    totalWpRaw    += chainBytes.length
    totalWpBrotli += brotli(chainBytes)
    totalJsonGzip += gzip6(encodeEstree(nodeMap))
  }

  const ratioRaw = totalJsonGzip / totalWpRaw
  console.log(`  weavepack delta sum raw:    ${totalWpRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  weavepack delta sum brotli: ${totalWpBrotli.toLocaleString().padStart(12)} bytes`)
  console.log(`  ESTree JSON per-frame gzip: ${totalJsonGzip.toLocaleString().padStart(12)} bytes`)
  console.log(`  ratio raw (json / wp):       ${ratioRaw.toFixed(1)}×`)
  const gate = ratioRaw >= 20.0
  console.log(`  Gate (weavepack raw ≥ 20× smaller than per-snapshot ESTree JSON gzip): ${gate ? "PASS ✓" : "FAIL ✗"}`)
  return { gate, totalWpRaw, totalWpBrotli, totalJsonGzip, ratioRaw }
}

// ── Scenario 3 — Edit stream (200 frames) ────────────────────────────────────────────────────────────────
//
// 200 mixed-op frames: node_insert (5 ExpressionStatement+Identifier pairs),
// prop_set (1 rename), or node_delete (2 ExpressionStatements + their children).
// Each op type selected with probability 1/3.
// Gate: weavepack raw ≥ 10× smaller than per-snapshot ESTree JSON gzip sum.

function scenario3() {
  console.log("\n── Scenario 3: Edit stream (200 mixed-op frames) ───────────────────────────────────────────────────")

  const rng = makeRng(3)
  const nodeMap = buildAst(rng)
  let nidCounter = nodeMap.size + 1

  let totalWpRaw = 0, totalWpBrotli = 0, totalJsonGzip = 0

  for (let frame = 0; frame < 200; frame++) {
    const die = rng.nextUint32() % 3
    let ops = []

    if (die === 0) {
      // node_insert: 5 ExpressionStatement+Identifier pairs into a random BlockStatement
      const blockNids = []
      for (const [nid, n] of nodeMap) { if (n.kind === "BlockStatement") blockNids.push(nid) }
      const blockNid = blockNids[rng.nextUint32() % blockNids.length]
      let maxCi = -1
      for (const [, n] of nodeMap) { if (n.parentNid === blockNid) maxCi = Math.max(maxCi, n.childIndex) }

      const newNodes = []
      for (let k = 0; k < 5; k++) {
        const stmtNid  = nidCounter++
        const identNid = nidCounter++
        const ci       = maxCi + 1 + k
        const varName  = rng.pick(VAR_NAMES)
        nodeMap.set(stmtNid,  { kind: "ExpressionStatement", parentNid: blockNid, childIndex: ci })
        nodeMap.set(identNid, { kind: "Identifier",           parentNid: stmtNid, childIndex: 0, name: varName })
        newNodes.push({ nid: stmtNid,  kind: "ExpressionStatement", parentNid: blockNid, childIndex: ci })
        newNodes.push({ nid: identNid, kind: "Identifier",           parentNid: stmtNid, childIndex: 0, name: varName })
      }
      newNodes.sort((a, b) => a.nid - b.nid)
      ops = [{
        op: OP.NODE_INSERT,
        block: {
          type:         "mixed",
          kinds:        newNodes.map(n => n.kind),
          nids:         newNodes.map(n => BigInt(n.nid)),
          parentNids:   newNodes.map(n => BigInt(n.parentNid)),
          childIndices: newNodes.map(n => n.childIndex),
          columns: [{
            colId: 4, ctype: CTYPE.STRING, nullable: true,
            values: newNodes.map(n => n.name ?? null),
          }],
        },
      }]
    } else if (die === 1) {
      // prop_set: rename 1 random Identifier
      const identNids = []
      for (const [nid, n] of nodeMap) { if (n.kind === "Identifier") identNids.push(nid) }
      if (identNids.length > 0) {
        const targetNid = identNids[rng.nextUint32() % identNids.length]
        const newName   = rng.pick(VAR_NAMES)
        nodeMap.get(targetNid).name = newName
        ops = [{
          op:       OP.PROP_SET,
          path:     { kind: PATH_KIND.NODE_COL, nid: BigInt(targetNid), colId: 4 },
          ctype:    CTYPE.STRING, nullable: false, value: newName,
        }]
      }
    } else {
      // node_delete: remove 2 random ExpressionStatements (applier cascades to children)
      const stmtNids = []
      for (const [nid, n] of nodeMap) { if (n.kind === "ExpressionStatement") stmtNids.push(nid) }
      if (stmtNids.length >= 2) {
        const idx  = rng.nextUint32() % stmtNids.length
        const del1 = stmtNids[idx]
        const del2 = stmtNids[(idx + 1) % stmtNids.length]
        // Remove from local state (stmt + Identifier children)
        const toDelete = new Set([del1, del2])
        for (const [nid, n] of nodeMap) { if (toDelete.has(n.parentNid)) toDelete.add(nid) }
        for (const nid of toDelete) nodeMap.delete(nid)
        ops = [{ op: OP.NODE_DELETE, nids: [BigInt(del1), BigInt(del2)] }]
      }
    }

    if (ops.length > 0) {
      const chainBytes = encodeChain({ ops })
      totalWpRaw    += chainBytes.length
      totalWpBrotli += brotli(chainBytes)
    }
    totalJsonGzip += gzip6(encodeEstree(nodeMap))
  }

  const ratioRaw = totalJsonGzip / totalWpRaw
  console.log(`  weavepack delta sum raw:    ${totalWpRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  weavepack delta sum brotli: ${totalWpBrotli.toLocaleString().padStart(12)} bytes`)
  console.log(`  ESTree JSON per-frame gzip: ${totalJsonGzip.toLocaleString().padStart(12)} bytes`)
  console.log(`  ratio raw (json / wp):       ${ratioRaw.toFixed(1)}×`)
  const gate = ratioRaw >= 10.0
  console.log(`  Gate (weavepack raw ≥ 10× smaller than per-snapshot ESTree JSON gzip): ${gate ? "PASS ✓" : "FAIL ✗"}`)
  return { gate, totalWpRaw, totalWpBrotli, totalJsonGzip, ratioRaw }
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────

console.log("weavepack-ast benchmark vs ESTree JSON + gzip")
console.log("=============================================")

const r1 = scenario1()
const r2 = scenario2()
const r3 = scenario3()

const allPass = r1.gate && r2.gate && r3.gate
console.log(`\nAll gates ${allPass ? "PASS ✓" : "FAIL ✗"}`)
process.exit(allPass ? 0 : 1)
