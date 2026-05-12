// weavepack-ast — delta application (applyChain).
//
// AST live state:
//   {
//     schemaHash: Uint8Array,
//     nodes: Map<string, {
//       kind:        string,
//       parentNid:   BigInt|null,
//       childIndex:  number,
//       props:       Map<number|string, { ctype, value }>,
//     }>,
//   }
//
// Map keys are nid.toString() (BigInt identity).
//
// Profile isolation: imports only from ./types.js.

import { OP, PATH_KIND } from "./types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function cloneState(state) {
  const nodes = new Map()
  for (const [k, v] of state.nodes) {
    nodes.set(k, {
      kind:       v.kind,
      parentNid:  v.parentNid,
      childIndex: v.childIndex,
      props:      new Map(v.props),
    })
  }
  return { schemaHash: state.schemaHash.slice(), nodes }
}

// Recursively collect all descendant nids of a given nid.
function collectDescendants(nodes, rootKey) {
  const result = new Set()
  const queue  = [rootKey]
  while (queue.length > 0) {
    const key = queue.shift()
    for (const [k, v] of nodes) {
      if (v.parentNid !== null && String(v.parentNid) === key) {
        if (!result.has(k)) {
          result.add(k)
          queue.push(k)
        }
      }
    }
  }
  return result
}

function populateNodesFromBlock(nodes, block, isMixed) {
  const { nids, parentNids, childIndices, columns } = block
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
    const kind = isMixed ? block.kinds[i] : block.kind
    nodes.set(key, {
      kind:       kind ?? "",
      parentNid:  parentNids[i] ?? null,
      childIndex: childIndices[i] ?? 0,
      props,
    })
  }
}

// ── Path resolution for prop_set ───────────────────────────────────────────

function resolveNodeColId(state, path) {
  switch (path.kind) {
    case PATH_KIND.NODE_COL:
      return { nodeKey: String(path.nid), colId: path.colId }
    case PATH_KIND.NODE:
      return { nodeKey: String(path.nid), colId: null }
    case PATH_KIND.NODE_PROP:
      return { nodeKey: String(path.nid), colId: null, prop: path.prop }
    default:
      throw new Error(`prop_set: path kind ${path.kind} is not a valid node address for prop_set`)
  }
}

// ── Op application ─────────────────────────────────────────────────────────

function applyOp(state, op) {
  state = cloneState(state)

  switch (op.op) {
    case OP.NODE_INSERT: {
      populateNodesFromBlock(state.nodes, op.block, op.mixed ?? false)
      break
    }

    case OP.NODE_DELETE: {
      for (const nid of op.nids) {
        const key = String(BigInt(nid))
        const descendants = collectDescendants(state.nodes, key)
        state.nodes.delete(key)
        for (const dk of descendants) state.nodes.delete(dk)
      }
      break
    }

    case OP.NODE_MOVE: {
      const key = String(BigInt(op.nid))
      const node = state.nodes.get(key)
      if (!node) throw new Error(`element_not_found: node ${key} not found`)
      // 0 in newParentNid means make root
      const newParent = op.newParentNid === 0n || op.newParentNid === 0
        ? null
        : BigInt(op.newParentNid)
      node.parentNid  = newParent
      node.childIndex = op.newChildIndex >>> 0
      break
    }

    case OP.PROP_SET: {
      const { nodeKey, colId, prop } = resolveNodeColId(state, op.path)
      const node = state.nodes.get(nodeKey)
      if (!node) throw new Error(`element_not_found: node ${nodeKey} not found`)
      if (op.isNull) {
        if (colId !== null) node.props.delete(colId)
      } else {
        if (colId !== null) {
          node.props.set(colId, { ctype: op.ctype, value: op.value })
        } else if (prop !== undefined) {
          node.props.set(prop, { ctype: op.ctype, value: op.value })
        }
      }
      break
    }

    case OP.KIND_RENAME: {
      for (const [, node] of state.nodes) {
        if (node.kind === op.oldKind) node.kind = op.newKind
      }
      break
    }

    case OP.SUBTREE_REPLACE: {
      const key = String(BigInt(op.rootNid))
      // Delete descendants (but keep root node itself)
      const descendants = collectDescendants(state.nodes, key)
      for (const dk of descendants) state.nodes.delete(dk)
      // Insert replacement subtree under root
      populateNodesFromBlock(state.nodes, op.block, op.mixed ?? false)
      break
    }

    default:
      throw new Error(`unknown_delta_op: op code ${op.op}`)
  }

  return state
}

// ── Public ─────────────────────────────────────────────────────────────────

export function initState(tree) {
  const state = {
    schemaHash: tree.schemaHash.slice(),
    nodes: new Map(),
  }
  for (const blk of (tree.blocks ?? [])) {
    populateNodesFromBlock(state.nodes, blk, blk.type === 'mixed')
  }
  return state
}

export function applyChain(state, ops) {
  let s = state
  for (const op of ops) s = applyOp(s, op)
  return s
}
