// weavepack-tabular — delta application (applyChain, applyOp).
//
// Operates on decoded frame state (same representation as decodeFrame returns).
// No byte-level work here.
//
// Frame state:
//   { schemaHash: Uint8Array, rowIds: BigInt[], columns: [{ colId, ctype, nullable, values, name? }] }
//
// Profile isolation: imports only from ./types.js.

import { OP } from "./types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function cloneFrame(frame) {
  return {
    schemaHash: frame.schemaHash.slice(),
    rowIds: [...frame.rowIds],
    columns: frame.columns.map(c => ({
      ...c,
      values: [...c.values],
    })),
  }
}

function findColIdx(columns, colId) {
  return columns.findIndex(c => c.colId === colId)
}

// Build a Map<string, number> mapping rowId.toString() → array index.
function buildRowIndex(rowIds) {
  const idx = new Map()
  for (let i = 0; i < rowIds.length; i++) idx.set(String(rowIds[i]), i)
  return idx
}

// ── Op application ─────────────────────────────────────────────────────────

function applyOp(frame, op) {
  frame = cloneFrame(frame)
  const { rowIds, columns } = frame

  switch (op.op) {
    case OP.ROW_INSERT: {
      // Validate no duplicate row_ids.
      const existing = buildRowIndex(rowIds)
      for (const rid of op.rowIds) {
        if (existing.has(String(rid)))
          throw new Error(`duplicate_row_id: row_id ${rid} already exists`)
      }
      // Merge new rows into the existing sorted sequence.
      const insertSet = new Set(op.rowIds.map(r => String(r)))
      const colDataMap = new Map()
      for (const col of (op.columns ?? [])) {
        colDataMap.set(col.colId, col)
      }

      const allRowIds = [...rowIds, ...op.rowIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const oldIdxMap = buildRowIndex(rowIds)
      const insertIdxMap = buildRowIndex(op.rowIds)

      const newColumns = columns.map(col => {
        const insertColData = colDataMap.get(col.colId)
        const newValues = allRowIds.map(rid => {
          const ridStr = String(rid)
          if (oldIdxMap.has(ridStr)) return col.values[oldIdxMap.get(ridStr)]
          if (insertColData) {
            const iIdx = insertIdxMap.get(ridStr)
            return iIdx !== undefined ? insertColData.values[iIdx] : null
          }
          return null
        })
        return { ...col, values: newValues }
      })

      frame.rowIds = allRowIds
      frame.columns = newColumns
      break
    }

    case OP.ROW_UPDATE: {
      const rowIdx = buildRowIndex(rowIds)
      for (const rid of op.rowIds) {
        if (!rowIdx.has(String(rid)))
          throw new Error(`unknown_row_id: row_id ${rid} not found`)
      }
      const updateIdxMap = buildRowIndex(op.rowIds)
      for (const updateCol of (op.columns ?? [])) {
        const ci = findColIdx(columns, updateCol.colId)
        if (ci === -1) throw new Error(`unknown_col_id: col_id ${updateCol.colId} not found`)
        // ctype validation.
        if (columns[ci].ctype !== updateCol.ctype)
          throw new Error(`ctype_mismatch: col_id ${updateCol.colId} expected ctype ${columns[ci].ctype}, got ${updateCol.ctype}`)
        const newValues = [...columns[ci].values]
        for (let i = 0; i < op.rowIds.length; i++) {
          const ri = rowIdx.get(String(op.rowIds[i]))
          newValues[ri] = updateCol.values[i]
        }
        columns[ci] = { ...columns[ci], values: newValues }
      }
      break
    }

    case OP.ROW_DELETE: {
      const rowIdx = buildRowIndex(rowIds)
      for (const rid of op.rowIds) {
        if (!rowIdx.has(String(rid)))
          throw new Error(`unknown_row_id: row_id ${rid} not found`)
      }
      const deleteSet = new Set(op.rowIds.map(r => String(r)))
      const keepMask = rowIds.map(r => !deleteSet.has(String(r)))
      frame.rowIds = rowIds.filter((_, i) => keepMask[i])
      frame.columns = columns.map(col => ({
        ...col,
        values: col.values.filter((_, i) => keepMask[i]),
      }))
      break
    }

    case OP.COLUMN_ADD: {
      if (findColIdx(columns, op.colId) !== -1)
        throw new Error(`duplicate_col_id: col_id ${op.colId} already exists`)
      if (!op.nullable && !op.hasDefault && rowIds.length > 0)
        throw new Error(`column_add malformed: non-nullable column with no default cannot be added to non-empty table`)
      const defaultVal = op.hasDefault ? op.defaultValue : null
      const newCol = {
        colId:    op.colId,
        ctype:    op.ctype,
        nullable: op.nullable,
        values:   rowIds.map(() => defaultVal),
      }
      if (op.name !== undefined) newCol.name = op.name
      frame.columns = [...columns, newCol]
      break
    }

    case OP.COLUMN_DROP: {
      const ci = findColIdx(columns, op.colId)
      if (ci === -1) throw new Error(`unknown_col_id: col_id ${op.colId} not found`)
      frame.columns = columns.filter((_, i) => i !== ci)
      break
    }

    case OP.COLUMN_RENAME: {
      const ci = findColIdx(columns, op.colId)
      if (ci === -1) throw new Error(`unknown_col_id: col_id ${op.colId} not found`)
      if (!op.name || op.name.length === 0) throw new Error("invalid_col_name: empty name")
      // Check for duplicate name.
      for (let i = 0; i < columns.length; i++) {
        if (i !== ci && columns[i].name === op.name)
          throw new Error(`duplicate_col_name: name "${op.name}" already in use`)
      }
      frame.columns = columns.map((c, i) =>
        i === ci ? { ...c, name: op.name } : c
      )
      break
    }

    case OP.BATCH_UPSERT: {
      const rowIdx = buildRowIndex(rowIds)
      const toInsert = [], toUpdate = []
      for (let i = 0; i < op.rowIds.length; i++) {
        const rid = op.rowIds[i]
        if (rowIdx.has(String(rid))) toUpdate.push(i)
        else toInsert.push(i)
      }

      // Build sub-operations for updates and inserts.
      if (toUpdate.length > 0) {
        const updateRowIds = toUpdate.map(i => op.rowIds[i])
        const updateCols = (op.columns ?? []).map(col => ({
          ...col,
          values: toUpdate.map(i => col.values[i]),
        }))
        frame = applyOp(frame, { op: OP.ROW_UPDATE, rowIds: updateRowIds, columns: updateCols })
      }
      if (toInsert.length > 0) {
        const insertRowIds = toInsert.map(i => op.rowIds[i])
        const insertCols = (op.columns ?? []).map(col => ({
          ...col,
          values: toInsert.map(i => col.values[i]),
        }))
        frame = applyOp(frame, { op: OP.ROW_INSERT, rowIds: insertRowIds, columns: insertCols })
      }
      break
    }

    default:
      throw new Error(`unknown_delta_op: op code ${op.op}`)
  }

  return frame
}

export function applyChain(frame, ops) {
  let state = frame
  for (const op of ops) state = applyOp(state, op)
  return state
}
