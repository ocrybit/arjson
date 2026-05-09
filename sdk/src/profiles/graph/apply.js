// weavepack-graph — delta application (applyChain).
//
// Operates on decoded graph state. No byte-level work here.
//
// Graph state:
//   {
//     schemaHash: Uint8Array,
//     nodes: Map<string, { label: string|null, props: Map<number, { ctype, value }> }>,
//     edges: Map<string, { label: string|null, src: BigInt, dst: BigInt,
//                          props: Map<number, { ctype, value }> }>,
//   }
//
// Map keys are nid.toString() / eid.toString() for BigInt identity.
//
// Profile isolation: imports only from ./types.js.

import { OP, PATH_KIND, CTYPE } from "./types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function cloneState(state) {
  const nodes = new Map()
  for (const [k, v] of state.nodes) {
    nodes.set(k, { label: v.label, props: new Map(v.props) })
  }
  const edges = new Map()
  for (const [k, v] of state.edges) {
    edges.set(k, { label: v.label, src: v.src, dst: v.dst, props: new Map(v.props) })
  }
  return { schemaHash: state.schemaHash.slice(), nodes, edges }
}

// Extract all nids/eids from a block into the state.
function populateNodesFromBlock(nodes, block) {
  const { label, nids, columns } = block
  for (let i = 0; i < nids.length; i++) {
    const key = String(nids[i])
    if (nodes.has(key))
      throw new Error(`duplicate_element_id: nid ${nids[i]} already exists`)
    const props = new Map()
    for (const col of columns) {
      if (col.values[i] !== null && col.values[i] !== undefined) {
        props.set(col.colId, { ctype: col.ctype, value: col.values[i] })
      }
    }
    nodes.set(key, { label: label ?? null, props })
  }
}

function populateEdgesFromBlock(edges, block) {
  const { label, eids, srcs, dsts, columns } = block
  for (let i = 0; i < eids.length; i++) {
    const key = String(eids[i])
    if (edges.has(key))
      throw new Error(`duplicate_element_id: eid ${eids[i]} already exists`)
    const props = new Map()
    for (const col of columns) {
      if (col.values[i] !== null && col.values[i] !== undefined) {
        props.set(col.colId, { ctype: col.ctype, value: col.values[i] })
      }
    }
    edges.set(key, { label: label ?? null, src: srcs[i], dst: dsts[i], props })
  }
}

// ── Path resolution for prop_set ───────────────────────────────────────────

function resolveElementColId(state, path) {
  switch (path.kind) {
    case PATH_KIND.NODE_COL:
      return { elementKey: String(path.nid), isNode: true, colId: path.colId }
    case PATH_KIND.EDGE_COL:
      return { elementKey: String(path.eid), isNode: false, colId: path.colId }
    case PATH_KIND.NODE:
      // node/N without col_id: in schemaless prop_set, use col_id from op context
      return { elementKey: String(path.nid), isNode: true, colId: null }
    case PATH_KIND.EDGE:
      return { elementKey: String(path.eid), isNode: false, colId: null }
    case PATH_KIND.NODE_PROP:
      // prop_name requires schema; not resolved here — treated as named prop
      return { elementKey: String(path.nid), isNode: true, colId: null, prop: path.prop }
    case PATH_KIND.EDGE_PROP:
      return { elementKey: String(path.eid), isNode: false, colId: null, prop: path.prop }
    default:
      throw new Error(`prop_set: path kind ${path.kind} is not a valid element address for prop_set`)
  }
}

// ── Op application ─────────────────────────────────────────────────────────

function applyOp(state, op) {
  state = cloneState(state)

  switch (op.op) {
    case OP.NODE_INSERT: {
      populateNodesFromBlock(state.nodes, op.block)
      break
    }

    case OP.NODE_DELETE: {
      for (const nid of op.nids) {
        const key = String(BigInt(nid))
        state.nodes.delete(key)
        // Implicitly remove incident edges.
        const nidBig = BigInt(nid)
        for (const [ek, ev] of state.edges) {
          if (ev.src === nidBig || ev.dst === nidBig) state.edges.delete(ek)
        }
      }
      break
    }

    case OP.EDGE_INSERT: {
      populateEdgesFromBlock(state.edges, op.block)
      break
    }

    case OP.EDGE_DELETE: {
      for (const eid of op.eids) state.edges.delete(String(BigInt(eid)))
      break
    }

    case OP.PROP_SET: {
      const { elementKey, isNode, colId, prop } = resolveElementColId(state, op.path)
      const target = isNode ? state.nodes.get(elementKey) : state.edges.get(elementKey)
      if (!target)
        throw new Error(`element_not_found: ${isNode ? 'node' : 'edge'} ${elementKey} not found`)
      if (op.isNull) {
        // Set to null: remove the property entry.
        if (colId !== null) target.props.delete(colId)
      } else {
        if (colId !== null) {
          target.props.set(colId, { ctype: op.ctype, value: op.value })
        } else if (prop !== undefined) {
          // Named prop in schemaless mode: use prop name as a pseudo-colId string.
          target.props.set(prop, { ctype: op.ctype, value: op.value })
        }
      }
      break
    }

    case OP.SUBGRAPH_REPLACE: {
      const label = op.label ?? null
      // Step 1: remove all nodes with matching label.
      for (const [k, v] of state.nodes) {
        if (v.label === label) state.nodes.delete(k)
      }
      // Step 2: remove all edges with matching label (+ cascade from step 1).
      for (const [k, v] of state.edges) {
        if (v.label === label) state.edges.delete(k)
      }
      // Step 3: insert replacement node block.
      if (op.nodeBlock) populateNodesFromBlock(state.nodes, op.nodeBlock)
      // Step 4: insert replacement edge block.
      if (op.edgeBlock) populateEdgesFromBlock(state.edges, op.edgeBlock)
      break
    }

    default:
      throw new Error(`unknown_delta_op: op code ${op.op}`)
  }

  return state
}

// ── Public ─────────────────────────────────────────────────────────────────

// Build initial state from a decoded graph document.
export function initState(graph) {
  const state = {
    schemaHash: graph.schemaHash.slice(),
    nodes: new Map(),
    edges: new Map(),
  }
  for (const blk of (graph.blocks ?? [])) {
    if (blk.type === 'node') {
      populateNodesFromBlock(state.nodes, blk)
    } else if (blk.type === 'edge') {
      populateEdgesFromBlock(state.edges, blk)
    }
  }
  return state
}

export function applyChain(state, ops) {
  let s = state
  for (const op of ops) s = applyOp(s, op)
  return s
}
