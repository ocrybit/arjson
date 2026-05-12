// weavepack-geo — delta application (applyChain).
//
// Live collection state:
//   {
//     name:    string,
//     fidKind: number,   // FID_KIND constant; -1 = not yet established
//     features: LiveFeature[],
//   }
//
// LiveFeature:
//   {
//     fid:     string | BigInt | null,
//     geomType:       number,
//     coordPrecision: number,
//     hasZ:           boolean,
//     geom:           object (same shape as encoder geom sections),
//     props:          Map<string, { ctype, value }>,
//   }
//
// Profile isolation: imports only from ./types.js.

import { FID_KIND, OP, PATH_KIND } from "./types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function cloneState(state) {
  return {
    name:     state.name,
    fidKind:  state.fidKind,
    features: state.features.map(f => ({
      fid:            f.fid,
      geomType:       f.geomType,
      coordPrecision: f.coordPrecision,
      hasZ:           f.hasZ,
      geom:           f.geom,
      props:          new Map(f.props),
    })),
  }
}

// Extract per-feature data from a decoded feature_block or gc_block.
function featuresFromBlock(blk) {
  const features = []
  const n = blk.numFeatures

  if (blk.type === 'feature') {
    for (let i = 0; i < n; i++) {
      const fid = blk.fids ? blk.fids[i] : null
      const geom = extractSingleFeatureGeom(blk, i)
      const props = new Map()
      for (const col of (blk.propCols ?? [])) {
        if (col.values[i] !== null && col.values[i] !== undefined) {
          props.set(col.name, { ctype: col.ctype, value: col.values[i] })
        }
      }
      features.push({
        fid,
        geomType:       blk.geomType,
        coordPrecision: blk.coordPrecision ?? 0,
        hasZ:           blk.hasZ ?? false,
        geom,
        props,
      })
    }
  } else if (blk.type === 'geometry_collection') {
    for (let i = 0; i < n; i++) {
      const fid = blk.fids ? blk.fids[i] : null
      const props = new Map()
      for (const col of (blk.propCols ?? [])) {
        if (col.values[i] !== null && col.values[i] !== undefined) {
          props.set(col.name, { ctype: col.ctype, value: col.values[i] })
        }
      }
      features.push({
        fid,
        geomType:       6, // GEOMETRY_COLLECTION
        coordPrecision: blk.coordPrecision ?? 0,
        hasZ:           blk.hasZ ?? false,
        geom:           { type: 'gc', subGeomCounts: blk.subGeomCounts, subGeoms: blk.subGeoms },
        props,
      })
    }
  }

  return features
}

// Slice the columnar geom section to get a single feature's geometry.
function extractSingleFeatureGeom(blk, i) {
  const g = blk.geom ?? {}
  switch (blk.geomType) {
    case 0: // POINT
      return {
        xCol: [g.xCol[i]],
        yCol: [g.yCol[i]],
        ...(blk.hasZ ? { zCol: [g.zCol[i]] } : {}),
      }
    case 1: { // LINESTRING
      const count  = g.coordCounts[i]
      const offset = g.coordCounts.slice(0, i).reduce((s, c) => s + c, 0)
      return {
        coordCounts: [count],
        xCol: g.xCol.slice(offset, offset + count),
        yCol: g.yCol.slice(offset, offset + count),
        ...(blk.hasZ ? { zCol: g.zCol.slice(offset, offset + count) } : {}),
      }
    }
    case 2: { // POLYGON
      const ringsForFeature = g.ringsPerFeature[i]
      const ringOffset      = g.ringsPerFeature.slice(0, i).reduce((s, c) => s + c, 0)
      const myRingCounts    = g.ringCounts.slice(ringOffset, ringOffset + ringsForFeature)
      const vertexOffset    = g.ringCounts.slice(0, ringOffset).reduce((s, c) => s + c, 0)
      const totalV          = myRingCounts.reduce((s, c) => s + c, 0)
      return {
        ringsPerFeature: [ringsForFeature],
        ringCounts:      myRingCounts,
        xCol: g.xCol.slice(vertexOffset, vertexOffset + totalV),
        yCol: g.yCol.slice(vertexOffset, vertexOffset + totalV),
        ...(blk.hasZ ? { zCol: g.zCol.slice(vertexOffset, vertexOffset + totalV) } : {}),
      }
    }
    case 3: { // MULTIPOINT
      const count  = g.partCounts[i]
      const offset = g.partCounts.slice(0, i).reduce((s, c) => s + c, 0)
      return {
        partCounts: [count],
        xCol: g.xCol.slice(offset, offset + count),
        yCol: g.yCol.slice(offset, offset + count),
        ...(blk.hasZ ? { zCol: g.zCol.slice(offset, offset + count) } : {}),
      }
    }
    case 4: { // MULTILINESTRING
      const lineCount  = g.partCounts[i]
      const lineOffset = g.partCounts.slice(0, i).reduce((s, c) => s + c, 0)
      const myCoordCounts  = g.coordCounts.slice(lineOffset, lineOffset + lineCount)
      const vertexOffset   = g.coordCounts.slice(0, lineOffset).reduce((s, c) => s + c, 0)
      const totalV         = myCoordCounts.reduce((s, c) => s + c, 0)
      return {
        partCounts:  [lineCount],
        coordCounts: myCoordCounts,
        xCol: g.xCol.slice(vertexOffset, vertexOffset + totalV),
        yCol: g.yCol.slice(vertexOffset, vertexOffset + totalV),
        ...(blk.hasZ ? { zCol: g.zCol.slice(vertexOffset, vertexOffset + totalV) } : {}),
      }
    }
    case 5: { // MULTIPOLYGON
      const polyCount  = g.partCounts[i]
      const polyOffset = g.partCounts.slice(0, i).reduce((s, c) => s + c, 0)
      const myRingsPerPart = g.ringsPerPart.slice(polyOffset, polyOffset + polyCount)
      const ringOffset     = g.ringsPerPart.slice(0, polyOffset).reduce((s, c) => s + c, 0)
      const totalRings     = myRingsPerPart.reduce((s, c) => s + c, 0)
      const myRingCounts   = g.ringCounts.slice(ringOffset, ringOffset + totalRings)
      const vertexOffset   = g.ringCounts.slice(0, ringOffset).reduce((s, c) => s + c, 0)
      const totalV         = myRingCounts.reduce((s, c) => s + c, 0)
      return {
        partCounts:  [polyCount],
        ringsPerPart: myRingsPerPart,
        ringCounts:  myRingCounts,
        xCol: g.xCol.slice(vertexOffset, vertexOffset + totalV),
        yCol: g.yCol.slice(vertexOffset, vertexOffset + totalV),
        ...(blk.hasZ ? { zCol: g.zCol.slice(vertexOffset, vertexOffset + totalV) } : {}),
      }
    }
    case 7: // NULL_GEOMETRY
      return {}
    default:
      return g
  }
}

// ── Feature lookup ─────────────────────────────────────────────────────────

function resolveInnerPath(state, path) {
  if (path.kind === PATH_KIND.FEAT_BY_IDX) {
    if (path.index >= state.features.length)
      throw new Error(`feature_index_out_of_bounds: ${path.index}`)
    return path.index
  }
  if (path.kind === PATH_KIND.FEAT_BY_STR_FID) {
    if (state.fidKind !== FID_KIND.FID_STRING)
      throw new Error("fid_kind_mismatch")
    const idx = state.features.findIndex(f => f.fid === path.fid)
    if (idx < 0) throw new Error(`feature_not_found: ${path.fid}`)
    return idx
  }
  if (path.kind === PATH_KIND.FEAT_BY_INT_FID) {
    if (state.fidKind !== FID_KIND.FID_UINT64)
      throw new Error("fid_kind_mismatch")
    const target = BigInt(path.fid)
    const idx = state.features.findIndex(f => BigInt(f.fid) === target)
    if (idx < 0) throw new Error(`feature_not_found: ${path.fid}`)
    return idx
  }
  throw new Error(`expected feature path, got kind ${path.kind}`)
}

// ── Op application ─────────────────────────────────────────────────────────

function applyOp(state, op) {
  state = cloneState(state)

  switch (op.op) {
    case OP.FEATURE_INSERT: {
      const inserted = featuresFromBlock(op.block)
      const newFidKind = op.block.fidKind ?? FID_KIND.FID_ABSENT
      if (state.fidKind === -1) {
        state.fidKind = newFidKind
      } else if (state.fidKind !== newFidKind) {
        throw new Error("fid_kind_mismatch")
      }
      if (newFidKind !== FID_KIND.FID_ABSENT) {
        const existingFids = new Set()
        if (newFidKind === FID_KIND.FID_UINT64) {
          for (const f of state.features) existingFids.add(String(BigInt(f.fid)))
          for (const f of inserted) {
            const k = String(BigInt(f.fid))
            if (existingFids.has(k)) throw new Error("duplicate_fid")
            existingFids.add(k)
          }
        } else {
          for (const f of state.features) existingFids.add(f.fid)
          for (const f of inserted) {
            if (existingFids.has(f.fid)) throw new Error("duplicate_fid")
            existingFids.add(f.fid)
          }
        }
      }
      state.features.push(...inserted)
      break
    }

    case OP.FEATURE_DELETE: {
      if (op.mode === 0) {
        // path_list — delete in descending index order to avoid shift issues
        const indices = op.paths.map(p => resolveInnerPath(state, p))
        const seen = new Set()
        for (const idx of indices) {
          if (seen.has(idx)) throw new Error("duplicate_delete_target")
          seen.add(idx)
        }
        indices.sort((a, b) => b - a)
        for (const idx of indices) state.features.splice(idx, 1)
      } else if (op.mode === 1) {
        if (op.start + op.count > state.features.length)
          throw new Error("feature_index_out_of_bounds")
        state.features.splice(op.start, op.count)
      }
      break
    }

    case OP.GEOMETRY_REPLACE: {
      const path  = op.path
      if (path.kind !== PATH_KIND.FEAT_GEOMETRY)
        throw new Error(`geometry_replace: expected FEAT_GEOMETRY path, got kind ${path.kind}`)
      const idx   = resolveInnerPath(state, path.inner)
      const feat  = state.features[idx]
      const newBlk = op.block
      const newGeom = extractSingleFeatureGeom({ ...newBlk, numFeatures: 1 }, 0)
      state.features[idx] = {
        ...feat,
        geomType:       newBlk.geomType,
        coordPrecision: newBlk.coordPrecision ?? feat.coordPrecision,
        hasZ:           newBlk.hasZ ?? feat.hasZ,
        geom:           newGeom,
      }
      break
    }

    case OP.PROP_SET: {
      const path = op.path
      let featIdx, propKey
      if (path.kind === PATH_KIND.FEAT_PROP_NAME) {
        featIdx = resolveInnerPath(state, path.inner)
        propKey = path.name
      } else if (path.kind === PATH_KIND.FEAT_PROP_IDX) {
        featIdx = resolveInnerPath(state, path.inner)
        // Translate column index to property name via existing props order
        const keys = [...state.features[featIdx].props.keys()]
        if (path.colIdx >= keys.length) throw new Error("col_idx_out_of_bounds")
        propKey = keys[path.colIdx]
      } else {
        throw new Error(`prop_set: unsupported path kind ${path.kind}`)
      }
      state.features[featIdx].props.set(propKey, { ctype: op.ctype, value: op.value })
      break
    }

    case OP.PROP_DELETE: {
      const path = op.path
      let featIdx, propKey
      if (path.kind === PATH_KIND.FEAT_PROP_NAME) {
        featIdx = resolveInnerPath(state, path.inner)
        propKey = path.name
      } else if (path.kind === PATH_KIND.FEAT_PROP_IDX) {
        featIdx = resolveInnerPath(state, path.inner)
        const keys = [...state.features[featIdx].props.keys()]
        if (path.colIdx >= keys.length) throw new Error("col_idx_out_of_bounds")
        propKey = keys[path.colIdx]
      } else {
        throw new Error(`prop_delete: unsupported path kind ${path.kind}`)
      }
      // idempotent: no error if property absent
      state.features[featIdx].props.delete(propKey)
      break
    }

    case OP.COLLECTION_REPLACE: {
      state.features = []
      state.fidKind  = -1
      for (const blk of (op.blocks ?? [])) {
        const inserted = featuresFromBlock(blk)
        const newFidKind = blk.fidKind ?? FID_KIND.FID_ABSENT
        if (state.fidKind === -1) state.fidKind = newFidKind
        else if (state.fidKind !== newFidKind) throw new Error("fid_kind_mismatch")
        state.features.push(...inserted)
      }
      if (state.fidKind === -1) state.fidKind = FID_KIND.FID_ABSENT
      break
    }

    default:
      throw new Error(`unknown_delta_op: ${op.op}`)
  }

  return state
}

// ── Public ─────────────────────────────────────────────────────────────────

export function initState(doc) {
  const state = {
    name:     doc.name ?? "",
    fidKind:  -1,
    features: [],
  }
  for (const blk of (doc.blocks ?? [])) {
    if (blk.type === 'delta') continue  // snapshots only
    const inserted = featuresFromBlock(blk)
    const newFidKind = blk.fidKind ?? FID_KIND.FID_ABSENT
    if (state.fidKind === -1) state.fidKind = newFidKind
    else if (state.fidKind !== newFidKind) throw new Error("fid_kind_mismatch")
    state.features.push(...inserted)
  }
  if (state.fidKind === -1) state.fidKind = FID_KIND.FID_ABSENT
  return state
}

export function applyChain(state, ops) {
  let s = state
  for (const op of ops) s = applyOp(s, op)
  return s
}
