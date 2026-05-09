// weavepack-log — delta application (applyChain).
//
// Operates on decoded batch state. No byte-level work here.
//
// Batch state:
//   {
//     schemaHash: Uint8Array,
//     seqs:     BigInt[],      // mandatory seq column (strictly ascending)
//     tss:      BigInt[],      // mandatory ts column (non-decreasing)
//     columns:  [{ colId, ctype, nullable, values }],  // user columns
//     expired:  Set<string>,   // seq.toString() for expired events
//     cursors:  Map<string, BigInt>,  // cursor name → seq
//     schema:   [{ colId, ctype, nullable, name }],  // current schema definition
//   }
//
// Profile isolation: imports only from ./types.js.

import { OP, SCHEMA_SUB_OP } from "./types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function cloneBatch(state) {
  return {
    schemaHash: state.schemaHash.slice(),
    seqs:    [...state.seqs],
    tss:     [...state.tss],
    columns: state.columns.map(c => ({ ...c, values: [...c.values] })),
    expired: new Set(state.expired),
    cursors: new Map(state.cursors),
    schema:  state.schema ? [...state.schema.map(s => ({ ...s }))] : [],
  }
}

// Build a Map<string, number> mapping seq.toString() → array index.
function buildSeqIndex(seqs) {
  const idx = new Map()
  for (let i = 0; i < seqs.length; i++) idx.set(String(seqs[i]), i)
  return idx
}

function findColIdx(columns, colId) {
  return columns.findIndex(c => c.colId === colId)
}

function findSchemaIdx(schema, colId) {
  return schema.findIndex(s => s.colId === colId)
}

// ── Op application ─────────────────────────────────────────────────────────

function applyOp(state, op) {
  state = cloneBatch(state)

  switch (op.op) {
    case OP.EVENT_APPEND: {
      const maxExistingSeq = state.seqs.length > 0
        ? state.seqs[state.seqs.length - 1]
        : -1n
      const firstNewSeq = op.seqs.length > 0 ? BigInt(op.seqs[0]) : null
      if (firstNewSeq !== null && firstNewSeq <= maxExistingSeq)
        throw new Error(`seq_not_monotone: first appended seq (${firstNewSeq}) must be > last seq (${maxExistingSeq})`)

      const numNew = op.seqs.length
      const newColData = new Map()
      for (const col of (op.columns ?? [])) {
        newColData.set(col.colId, col)
      }

      // Extend existing user columns.
      for (const col of state.columns) {
        const src = newColData.get(col.colId)
        if (src) {
          if (src.values.length !== numNew)
            throw new Error(`event_append column ${col.colId} has wrong value count`)
          for (const v of src.values) col.values.push(v)
        } else {
          // Column absent from append data → fill with null for nullable, error for non-nullable.
          if (!col.nullable)
            throw new Error(`non_nullable_null: non-nullable col_id ${col.colId} missing from event_append`)
          for (let i = 0; i < numNew; i++) col.values.push(null)
        }
      }

      // Add new columns that don't exist yet.
      for (const [colId, src] of newColData) {
        if (findColIdx(state.columns, colId) === -1) {
          // New column: back-fill existing events with null.
          const backFill = state.seqs.map(() => null)
          state.columns.push({
            colId: src.colId,
            ctype: src.ctype,
            nullable: src.nullable,
            values: [...backFill, ...src.values],
          })
        }
      }

      state.seqs = [...state.seqs, ...op.seqs.map(BigInt)]
      state.tss  = [...state.tss,  ...op.tss.map(BigInt)]
      break
    }

    case OP.FIELD_UPDATE: {
      const seqStr = String(BigInt(op.seq))
      const seqIdx = buildSeqIndex(state.seqs)
      if (!seqIdx.has(seqStr))
        throw new Error(`unknown_seq: seq ${op.seq} not found in stream`)

      const rowIdx = seqIdx.get(seqStr)
      for (const updateCol of (op.columns ?? [])) {
        const ci = findColIdx(state.columns, updateCol.colId)
        if (ci === -1) throw new Error(`unknown_col_id: col_id ${updateCol.colId} not found`)
        if (state.columns[ci].ctype !== updateCol.ctype)
          throw new Error(`ctype_mismatch: col_id ${updateCol.colId} expected ctype ${state.columns[ci].ctype}, got ${updateCol.ctype}`)
        if (!updateCol.hasValue && !state.columns[ci].nullable)
          throw new Error(`non_nullable_null: col_id ${updateCol.colId} is not nullable`)
        state.columns[ci] = {
          ...state.columns[ci],
          values: state.columns[ci].values.map((v, i) => i === rowIdx ? updateCol.value : v),
        }
      }
      break
    }

    case OP.EVENT_EXPIRE: {
      const seqIdx = buildSeqIndex(state.seqs)
      const lo = BigInt(op.seqLo)
      const hi = BigInt(op.seqHi)
      // Validate bounds exist in the logical stream.
      if (!seqIdx.has(String(lo)))
        throw new Error(`unknown_seq: seq_lo ${lo} not found in stream`)
      if (!seqIdx.has(String(hi)))
        throw new Error(`unknown_seq: seq_hi ${hi} not found in stream`)
      for (const seq of state.seqs) {
        if (seq >= lo && seq <= hi) state.expired.add(String(seq))
      }
      break
    }

    case OP.SCHEMA_EVOLVE: {
      const schema = state.schema
      switch (op.subOp) {
        case SCHEMA_SUB_OP.COLUMN_ADD: {
          if (findSchemaIdx(schema, op.colId) !== -1)
            throw new Error(`duplicate_col_id: col_id ${op.colId} already in schema`)
          if (schema.some(s => s.name === op.name))
            throw new Error(`duplicate_col_name: name "${op.name}" already in schema`)
          state.schema = [...schema, { colId: op.colId, ctype: op.ctype, nullable: op.nullable, name: op.name }]
          break
        }
        case SCHEMA_SUB_OP.COLUMN_DROP: {
          const si = findSchemaIdx(schema, op.colId)
          if (si === -1) throw new Error(`unknown_col_id: col_id ${op.colId} not found in schema`)
          state.schema = schema.filter((_, i) => i !== si)
          break
        }
        case SCHEMA_SUB_OP.COLUMN_RENAME: {
          const si = findSchemaIdx(schema, op.colId)
          if (si === -1) throw new Error(`unknown_col_id: col_id ${op.colId} not found in schema`)
          if (schema.some((s, i) => i !== si && s.name === op.name))
            throw new Error(`duplicate_col_name: name "${op.name}" already in use`)
          state.schema = schema.map((s, i) => i === si ? { ...s, name: op.name } : s)
          break
        }
        default:
          throw new Error(`unknown_schema_sub_op: sub_op ${op.subOp}`)
      }
      break
    }

    case OP.CURSOR_CHECKPOINT: {
      const seq = BigInt(op.seq)
      const seqIdx = buildSeqIndex(state.seqs)
      if (!seqIdx.has(String(seq)))
        throw new Error(`unknown_seq: cursor seq ${seq} not found in stream`)
      state.cursors.set(op.name, seq)
      break
    }

    default:
      throw new Error(`unknown_delta_op: op code ${op.op}`)
  }

  return state
}

// ── Public ─────────────────────────────────────────────────────────────────

// Initialize state from a decoded batch (adds expired/cursors/schema fields).
export function initState(batch) {
  return {
    schemaHash: batch.schemaHash,
    seqs:       batch.seqs,
    tss:        batch.tss,
    columns:    batch.columns.map(c => ({ ...c, values: [...c.values] })),
    expired:    new Set(),
    cursors:    new Map(),
    schema:     [],
  }
}

export function applyChain(state, ops) {
  let s = state
  for (const op of ops) s = applyOp(s, op)
  return s
}
