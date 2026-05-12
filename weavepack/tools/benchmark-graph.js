#!/usr/bin/env node
// weavepack/tools/benchmark-graph.js
//
// G.6: benchmark weavepack-graph vs GraphML + gzip and JSON-LD + gzip.
// Three scenarios from weavepack/profiles/graph/07-benchmarks.md.
//
// Usage (from repo root):
//   node weavepack/tools/benchmark-graph.js
//
// Comparison methodology:
//   - Snapshot: weavepack-graph (raw + brotli-6) vs GraphML + gzip-6.
//     Gate: weavepack brotli ≤ 2× GraphML gzip (gzip has strong back-reference
//     advantage on repetitive XML; column encoding + brotli matches it).
//   - Incremental edge stream: weavepack delta sum (raw) vs per-snapshot
//     GraphML gzip sum (sampled every 100 steps and scaled, to bound runtime).
//     Gate: weavepack raw ≥ 10× smaller than GraphML per-snapshot gzip sum.
//   - Mixed CDC updates: weavepack delta sum (raw) vs per-snapshot JSON-LD gzip
//     (computed exactly: state grows modestly, each gzip is fast).
//     Gate: weavepack raw ≥ 5× smaller than JSON-LD per-snapshot gzip sum.

import { brotliCompressSync, gzipSync, constants } from "node:zlib"
import {
  CTYPE, OP, PATH_KIND,
  encodeGraph, encodeChain,
} from "../../sdk/src/profiles/graph/index.js"

// ── LCG PRNG ──────────────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0
  return {
    nextUint32() { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s },
    nextFloat()  { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0xFFFFFFFF },
    pick(arr) { return arr[this.nextUint32() % arr.length] },
    range(lo, hi) { return lo + (this.nextUint32() % (hi - lo + 1)) },
  }
}

// ── Compression helpers ────────────────────────────────────────────────────────────

const BROTLI_Q6 = { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }

function brotli(bytes) {
  return brotliCompressSync(bytes instanceof Buffer ? bytes : Buffer.from(bytes), BROTLI_Q6).length
}

function gzip6(bytes) {
  return gzipSync(bytes instanceof Buffer ? bytes : Buffer.from(bytes), { level: 6 }).length
}

// ── Data constants ─────────────────────────────────────────────────────────────────

const NAMES = [
  "Alice","Bob","Carol","Dave","Eve","Frank","Grace","Heidi",
  "Ivan","Judy","Karl","Laura","Mallory","Niaj","Oscar","Peggy",
  "Quinn","Rupert","Sybil","Trent",
]

const COUNTRIES = [
  "US","GB","DE","FR","JP","CN","IN","BR","CA","AU",
  "MX","ES","IT","KR","RU","ZA","NG","EG","AR","SE",
]

// Days since Unix epoch: 2010-01-01 = 14610, 2023-12-31 = 19723
const DATE_BASE  = 14610
const DATE_RANGE = 5113

function genNode(rng, nid) {
  return {
    nid,
    name:        rng.pick(NAMES),
    country:     rng.pick(COUNTRIES),
    joined_date: DATE_BASE + (rng.nextUint32() % DATE_RANGE),
  }
}

function genNodes(rng, startNid, count) {
  return Array.from({ length: count }, (_, i) => genNode(rng, startNid + i))
}

function genEdges(rng, startEid, count, numNodes) {
  const edges = []
  for (let i = 0; i < count; i++) {
    const src = rng.nextUint32() % numNodes
    let   dst = rng.nextUint32() % numNodes
    if (dst === src) dst = (dst + 1) % numNodes
    edges.push({ eid: startEid + i, src, dst })
  }
  return edges
}

// ── GraphML encoder ────────────────────────────────────────────────────────────────

const GRAPHML_HEADER = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<graphml xmlns="http://graphml.graphdrawing.org/graphml">',
  '  <key id="d0" for="node" attr.name="name" attr.type="string"/>',
  '  <key id="d1" for="node" attr.name="country" attr.type="string"/>',
  '  <key id="d2" for="node" attr.name="joined_date" attr.type="int"/>',
  '  <graph id="G" edgedefault="directed">',
].join("\n") + "\n"

const GRAPHML_FOOTER = "  </graph>\n</graphml>\n"

function buildNodeSection(nodes) {
  return nodes.map(n =>
    `    <node id="n${n.nid}"><data key="d0">${n.name}</data>` +
    `<data key="d1">${n.country}</data><data key="d2">${n.joined_date}</data></node>\n`
  ).join("")
}

function buildEdgeSection(edges) {
  return edges.map(e =>
    `    <edge id="e${e.eid}" source="n${e.src}" target="n${e.dst}"/>\n`
  ).join("")
}

function encodeGraphML(nodes, edges) {
  return Buffer.from(
    GRAPHML_HEADER + buildNodeSection(nodes) + buildEdgeSection(edges) + GRAPHML_FOOTER,
    "utf8"
  )
}

// ── JSON-LD encoder ────────────────────────────────────────────────────────────────

function encodeJsonLD(nodes, edges) {
  const graph = []
  for (const n of nodes) {
    graph.push({ "@id": `u:${n.nid}`, "@type": "Person",
      name: n.name, country: n.country, joined_date: n.joined_date })
  }
  for (const e of edges) {
    graph.push({ "@id": `f:${e.eid}`, "@type": "follows",
      src: `u:${e.src}`, dst: `u:${e.dst}` })
  }
  return Buffer.from(JSON.stringify({
    "@context": { u: "http://eg.com/u/", f: "http://eg.com/f/" },
    "@graph": graph,
  }), "utf8")
}

// ── Scenario 1 — Social graph snapshot ────────────────────────────────────────────
//
// 10 000 nodes (Person: name, country, joined_date) + 100 000 edges (follows).
// weavepack: one snapshot document with one node_block + one edge_block.
// GraphML baseline: single file, gzip-6.
// Gate: weavepack brotli ≤ 2× GraphML gzip.

function scenario1() {
  console.log("\n── Scenario 1: Social graph snapshot (10 000 nodes, 100 000 edges) ───────────────")

  const rng = makeRng(1)
  const NUM_NODES = 10_000
  const NUM_EDGES = 100_000

  const nodes = genNodes(rng, 0, NUM_NODES)
  const edges = genEdges(rng, 0, NUM_EDGES, NUM_NODES)

  // weavepack snapshot
  const wpBytes = encodeGraph({
    blocks: [
      {
        type: "node", label: "Person",
        nids: nodes.map(n => BigInt(n.nid)),
        columns: [
          { colId: 2, ctype: CTYPE.STRING, nullable: false, values: nodes.map(n => n.name)        },
          { colId: 3, ctype: CTYPE.STRING, nullable: false, values: nodes.map(n => n.country)     },
          { colId: 4, ctype: CTYPE.DATE32, nullable: false, values: nodes.map(n => n.joined_date) },
        ],
      },
      {
        type: "edge", label: "follows",
        eids: edges.map(e => BigInt(e.eid)),
        srcs: edges.map(e => BigInt(e.src)),
        dsts: edges.map(e => BigInt(e.dst)),
        columns: [],
      },
    ],
  })
  const wpRaw    = wpBytes.length
  const wpBrotli = brotli(wpBytes)

  // GraphML baseline
  const xmlBytes = encodeGraphML(nodes, edges)
  const xmlRaw   = xmlBytes.length
  const xmlGzip  = gzip6(xmlBytes)

  const ratio = wpBrotli / xmlGzip

  console.log(`  weavepack raw:              ${wpRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  weavepack brotli-6:         ${wpBrotli.toLocaleString().padStart(12)} bytes`)
  console.log(`  GraphML raw:                ${xmlRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  GraphML gzip-6:             ${xmlGzip.toLocaleString().padStart(12)} bytes`)
  console.log(`  ratio (wp-brotli / gml-gz):  ${ratio.toFixed(2)}×`)
  const gate = ratio <= 2.0
  console.log(`  Gate (weavepack brotli ≤ 2× GraphML gzip): ${gate ? "PASS" : "FAIL"}`)
  return { gate, wpRaw, wpBrotli, xmlRaw, xmlGzip, ratio }
}

// ── Scenario 2 — Incremental edge stream ──────────────────────────────────────────
//
// Initial graph: 10 000 nodes. Then 1 000 edge_insert frames, 100 edges each.
// weavepack: one delta frame per step.
// GraphML baseline: per-snapshot (full node + edge list) gzip per step.
//   Sampled every 100 steps (10 gzip calls total) and scaled ×100 for efficiency.
// Gate: weavepack raw sum ≥ 10× smaller than GraphML per-snapshot gzip sum.

function scenario2() {
  console.log("\n── Scenario 2: Incremental edge stream (1 000 steps × 100 edges) ──────────────────")

  const rng = makeRng(2)
  const NUM_INIT_NODES = 10_000
  const STEPS          = 1_000
  const EDGES_PER_STEP = 100
  const SAMPLE_EVERY   = 100  // gzip every 100 steps; scale ×100 for total estimate

  const initNodes = genNodes(rng, 0, NUM_INIT_NODES)
  const nodeSection = buildNodeSection(initNodes)
  const nodePlusBuf = Buffer.from(GRAPHML_HEADER + nodeSection, "utf8")
  const footerBuf   = Buffer.from(GRAPHML_FOOTER, "utf8")

  let totalWpRaw    = 0
  let totalWpBrotli = 0
  let totalGmlGzip  = 0

  const allEdgeLines = []
  let eidCounter = 0

  for (let step = 1; step <= STEPS; step++) {
    const stepEdges = genEdges(rng, eidCounter, EDGES_PER_STEP, NUM_INIT_NODES)
    eidCounter += EDGES_PER_STEP

    // weavepack: one edge_insert delta frame per step
    const chainBytes = encodeChain({
      ops: [{
        op: OP.EDGE_INSERT,
        block: {
          label: "follows",
          eids: stepEdges.map(e => BigInt(e.eid)),
          srcs: stepEdges.map(e => BigInt(e.src)),
          dsts: stepEdges.map(e => BigInt(e.dst)),
          columns: [],
        },
      }],
    })
    totalWpRaw    += chainBytes.length
    totalWpBrotli += brotli(chainBytes)

    // Accumulate edge lines
    for (const e of stepEdges) {
      allEdgeLines.push(
        `    <edge id="e${e.eid}" source="n${e.src}" target="n${e.dst}"/>\n`
      )
    }

    // Sample gzip at each SAMPLE_EVERY boundary and scale ×SAMPLE_EVERY
    if (step % SAMPLE_EVERY === 0) {
      const edgeBuf = Buffer.from(allEdgeLines.join(""), "utf8")
      const fullBuf = Buffer.concat([nodePlusBuf, edgeBuf, footerBuf])
      totalGmlGzip += gzip6(fullBuf) * SAMPLE_EVERY
    }
  }

  const ratioRaw    = totalGmlGzip / totalWpRaw
  const ratioBrotli = totalGmlGzip / totalWpBrotli

  console.log(`  weavepack delta sum raw:    ${totalWpRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  weavepack delta sum brotli: ${totalWpBrotli.toLocaleString().padStart(12)} bytes`)
  console.log(`  GraphML per-step gzip sum:  ${totalGmlGzip.toLocaleString().padStart(12)} bytes  (10 samples × ${SAMPLE_EVERY}×)`)
  console.log(`  ratio raw    (gml / wp):     ${ratioRaw.toFixed(1)}×`)
  console.log(`  ratio brotli (gml / wp):     ${ratioBrotli.toFixed(1)}×`)
  const gate = ratioRaw >= 10.0
  console.log(`  Gate (weavepack raw ≥ 10× smaller than GraphML per-snapshot gzip): ${gate ? "PASS" : "FAIL"}`)
  return { gate, totalWpRaw, totalWpBrotli, totalGmlGzip, ratioRaw, ratioBrotli }
}

// ── Scenario 3 — Mixed CDC updates ────────────────────────────────────────────────
//
// Initial graph: 500 nodes + 2 000 edges. Then 500 mixed-op delta frames.
// Op mix (uniform): node_insert(5), edge_insert(10), edge_delete(3), prop_set.
// weavepack: one delta frame per frame.
// JSON-LD baseline: full re-snapshot per frame, gzip-6.
// Gate: weavepack raw sum ≥ 5× smaller than JSON-LD per-snapshot gzip sum.

function scenario3() {
  console.log("\n── Scenario 3: Mixed CDC updates (500 frames) ──────────────────────────────────────")

  const rng = makeRng(3)
  const FRAMES      = 500
  const INIT_NODES  = 500
  const INIT_EDGES  = 2_000

  let liveNodes = genNodes(rng, 0, INIT_NODES)
  let liveEdges = genEdges(rng, 0, INIT_EDGES, INIT_NODES)
  let nidCounter = INIT_NODES
  let eidCounter = INIT_EDGES

  let totalWpRaw    = 0
  let totalWpBrotli = 0
  let totalJldGzip  = 0

  for (let frame = 0; frame < FRAMES; frame++) {
    const die = rng.nextUint32() % 4
    let ops = []

    if (die === 0) {
      // node_insert: 5 new nodes
      const newNodes = genNodes(rng, nidCounter, 5)
      nidCounter += 5
      liveNodes = liveNodes.concat(newNodes)
      ops = [{
        op: OP.NODE_INSERT,
        block: {
          label: "Person",
          nids:    newNodes.map(n => BigInt(n.nid)),
          columns: [
            { colId: 2, ctype: CTYPE.STRING, nullable: false, values: newNodes.map(n => n.name)        },
            { colId: 3, ctype: CTYPE.STRING, nullable: false, values: newNodes.map(n => n.country)     },
            { colId: 4, ctype: CTYPE.DATE32, nullable: false, values: newNodes.map(n => n.joined_date) },
          ],
        },
      }]
    } else if (die === 1) {
      // edge_insert: 10 new edges
      const newEdges = genEdges(rng, eidCounter, 10, nidCounter)
      eidCounter += 10
      liveEdges = liveEdges.concat(newEdges)
      ops = [{
        op: OP.EDGE_INSERT,
        block: {
          label: "follows",
          eids: newEdges.map(e => BigInt(e.eid)),
          srcs: newEdges.map(e => BigInt(e.src)),
          dsts: newEdges.map(e => BigInt(e.dst)),
          columns: [],
        },
      }]
    } else if (die === 2 && liveEdges.length >= 3) {
      // edge_delete: remove 3 edges
      const startIdx = rng.nextUint32() % liveEdges.length
      const toDelete = new Set()
      for (let i = 0; i < 3; i++) {
        toDelete.add(liveEdges[(startIdx + i) % liveEdges.length].eid)
      }
      liveEdges = liveEdges.filter(e => !toDelete.has(e.eid))
      ops = [{ op: OP.EDGE_DELETE, eids: [...toDelete].map(e => BigInt(e)) }]
    } else {
      // prop_set: update a random node's country (fallback when die===2 and few edges)
      if (liveNodes.length > 0) {
        const targetNode = liveNodes[rng.nextUint32() % liveNodes.length]
        const newCountry = rng.pick(COUNTRIES)
        targetNode.country = newCountry
        ops = [{
          op:       OP.PROP_SET,
          path:     { kind: PATH_KIND.NODE_PROP, nid: targetNode.nid, prop: "country" },
          ctype:    CTYPE.STRING,
          nullable: false,
          value:    newCountry,
        }]
      }
    }

    if (ops.length > 0) {
      const chainBytes = encodeChain({ ops })
      totalWpRaw    += chainBytes.length
      totalWpBrotli += brotli(chainBytes)
    }

    // JSON-LD per-snapshot baseline
    const jldBytes = encodeJsonLD(liveNodes, liveEdges)
    totalJldGzip  += gzip6(jldBytes)
  }

  const ratioRaw    = totalJldGzip / totalWpRaw
  const ratioBrotli = totalJldGzip / totalWpBrotli

  console.log(`  weavepack delta sum raw:    ${totalWpRaw.toLocaleString().padStart(12)} bytes`)
  console.log(`  weavepack delta sum brotli: ${totalWpBrotli.toLocaleString().padStart(12)} bytes`)
  console.log(`  JSON-LD per-frame gzip sum: ${totalJldGzip.toLocaleString().padStart(12)} bytes`)
  console.log(`  ratio raw    (jld / wp):     ${ratioRaw.toFixed(1)}×`)
  console.log(`  ratio brotli (jld / wp):     ${ratioBrotli.toFixed(1)}×`)
  const gate = ratioRaw >= 5.0
  console.log(`  Gate (weavepack raw ≥ 5× smaller than JSON-LD per-snapshot gzip): ${gate ? "PASS" : "FAIL"}`)
  return { gate, totalWpRaw, totalWpBrotli, totalJldGzip, ratioRaw, ratioBrotli }
}

// ── Main ──────────────────────────────────────────────────────────────────────────────

console.log("weavepack-graph benchmark vs GraphML + gzip / JSON-LD + gzip")
console.log("=============================================================")

const r1 = scenario1()
const r2 = scenario2()
const r3 = scenario3()

const allPass = r1.gate && r2.gate && r3.gate
console.log(`\nAll gates ${allPass ? "PASS ✓" : "FAIL ✗"}`)
process.exit(allPass ? 0 : 1)
