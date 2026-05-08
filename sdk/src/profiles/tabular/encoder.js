// weavepack-tabular — encoder (snapshot frames + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire profile code.
//
// Binary layout:
//   Snapshot: FLAG(0x00) + schema_hash(32B) + LEB128(num_rows) + LEB128(num_cols)
//             + row_id_block + column_block[num_cols]
//   Delta:    FLAG(0x01) + schema_hash(32B) + LEB128(num_ops) + op[num_ops]
//
// See weavepack/profiles/tabular/02-containers.md and 04-deltas.md.

import {
  CTYPE, OP, FRAME_SNAPSHOT, FRAME_DELTA,
  SCHEMA_HASH_BYTES, MAX_STRING_BYTES,
  nullBitmapBytes, setNullBit,
} from "./types.js"

const _enc = new TextEncoder()

// ── ByteWriter ─────────────────────────────────────────────────────────────

class ByteWriter {
  constructor() { this._buf = [] }

  writeByte(b)  { this._buf.push(b & 0xFF) }

  writeBytes(src) {
    for (let i = 0; i < src.length; i++) this._buf.push(src[i] & 0xFF)
  }

  // LEB128 uint32 (number).
  writeLEB128(v) {
    v = v >>> 0
    while (v >= 128) {
      this._buf.push((v & 0x7F) | 0x80)
      v >>>= 7
    }
    this._buf.push(v)
  }

  // LEB128 uint64 (BigInt).
  writeLEB128Big(v) {
    v = BigInt(v)
    while (v >= 128n) {
      this._buf.push(Number(v & 0x7Fn) | 0x80)
      v >>= 7n
    }
    this._buf.push(Number(v))
  }

  // Write a signed int64 as 8 bytes little-endian.
  writeInt64LE(v) {
    v = BigInt(v)
    const lo = Number(v & 0xFFFFFFFFn)
    const hi = Number((v >> 32n) & 0xFFFFFFFFn)
    this._buf.push(lo & 0xFF, (lo >> 8) & 0xFF, (lo >> 16) & 0xFF, (lo >> 24) & 0xFF)
    this._buf.push(hi & 0xFF, (hi >> 8) & 0xFF, (hi >> 16) & 0xFF, (hi >> 24) & 0xFF)
  }

  toBytes() { return new Uint8Array(this._buf) }
}

// ── Row-ID block ───────────────────────────────────────────────────────────
//
// Delta coding: first_id (LEB128 uint64) then (n-1) delta LEB128 uint64s.
// Deltas must be ≥1 (strict ascent). Zero-row case: no bytes written.

function writeRowIdBlock(w, rowIds) {
  if (rowIds.length === 0) return
  w.writeLEB128Big(rowIds[0])
  for (let i = 1; i < rowIds.length; i++) {
    const delta = BigInt(rowIds[i]) - BigInt(rowIds[i - 1])
    if (delta < 1n) throw new Error(`row_ids must be strictly ascending; got delta ${delta} at index ${i}`)
    w.writeLEB128Big(delta)
  }
}

// ── Per-ctype value encoding ───────────────────────────────────────────────

function writeValue(w, ctype, value) {
  switch (ctype) {
    case CTYPE.BOOL:
      // Single bool value: 1 byte (caller batches into bit columns).
      w.writeByte(value ? 1 : 0)
      break
    case CTYPE.INT8:
      w.writeByte(value < 0 ? value + 256 : value)
      break
    case CTYPE.INT16: {
      const v = value < 0 ? value + 65536 : value
      w.writeByte(v & 0xFF); w.writeByte((v >> 8) & 0xFF)
      break
    }
    case CTYPE.INT32: {
      const v = value | 0
      const u = v < 0 ? v + 0x100000000 : v
      w.writeByte(u & 0xFF); w.writeByte((u >> 8) & 0xFF)
      w.writeByte((u >> 16) & 0xFF); w.writeByte((u >> 24) & 0xFF)
      break
    }
    case CTYPE.INT64:
    case CTYPE.TIMESTAMP64:
      w.writeInt64LE(value)
      break
    case CTYPE.UINT8:
      w.writeByte(value & 0xFF)
      break
    case CTYPE.UINT16:
      w.writeByte(value & 0xFF); w.writeByte((value >> 8) & 0xFF)
      break
    case CTYPE.UINT32: {
      const v = value >>> 0
      w.writeByte(v & 0xFF); w.writeByte((v >> 8) & 0xFF)
      w.writeByte((v >> 16) & 0xFF); w.writeByte((v >> 24) & 0xFF)
      break
    }
    case CTYPE.UINT64: {
      const bv = BigInt(value)
      w.writeInt64LE(bv)  // same bit pattern; re-interpret as unsigned in decoder
      break
    }
    case CTYPE.FLOAT32: {
      const tmp = new ArrayBuffer(4)
      new DataView(tmp).setFloat32(0, value, true)
      w.writeBytes(new Uint8Array(tmp))
      break
    }
    case CTYPE.FLOAT64: {
      const tmp = new ArrayBuffer(8)
      new DataView(tmp).setFloat64(0, value, true)
      w.writeBytes(new Uint8Array(tmp))
      break
    }
    case CTYPE.STRING: {
      const utf8 = _enc.encode(String(value))
      if (utf8.length > MAX_STRING_BYTES) throw new Error("string exceeds 256 MiB limit")
      w.writeLEB128(utf8.length)
      w.writeBytes(utf8)
      break
    }
    case CTYPE.BYTES: {
      const src = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (src.length > MAX_STRING_BYTES) throw new Error("bytes exceeds 256 MiB limit")
      w.writeLEB128(src.length)
      w.writeBytes(src)
      break
    }
    case CTYPE.DATE32: {
      const v = value | 0
      const u = v < 0 ? v + 0x100000000 : v
      w.writeByte(u & 0xFF); w.writeByte((u >> 8) & 0xFF)
      w.writeByte((u >> 16) & 0xFF); w.writeByte((u >> 24) & 0xFF)
      break
    }
    case CTYPE.EXT:
      throw new Error("EXT ctype encoding not implemented in v0.1")
    default:
      throw new Error(`unknown ctype ${ctype}`)
  }
}

// Write N bool values packed MSB-first into ceil(N/8) bytes.
function writeBoolColumn(w, values) {
  const n = values.length
  const bytes = new Uint8Array(Math.ceil(n / 8))
  for (let i = 0; i < n; i++) {
    if (values[i]) bytes[i >> 3] |= (1 << (7 - (i & 7)))
  }
  w.writeBytes(bytes)
}

// Write the null bitmap for a nullable column.
// nullables: Array<boolean|null>, true|null means NULL.
function writeNullBitmap(w, values, numRows) {
  const bytes = new Uint8Array(nullBitmapBytes(numRows))
  for (let i = 0; i < numRows; i++) {
    if (values[i] === null || values[i] === undefined) setNullBit(bytes, i)
  }
  w.writeBytes(bytes)
}

// Write value column for a given ctype and values array.
// NULL values (null/undefined) are skipped; caller provides the null bitmap.
// Bool values are bit-packed; all others are byte-level.
function writeValueColumn(w, ctype, values) {
  const nonNull = values.filter(v => v !== null && v !== undefined)
  if (ctype === CTYPE.BOOL) {
    writeBoolColumn(w, nonNull)
  } else {
    for (const v of nonNull) writeValue(w, ctype, v)
  }
}

// ── Column block ───────────────────────────────────────────────────────────
//
// col_id (LEB128 uint32) + type_byte ((nullable<<4)|ctype) + [null_bitmap] + values.

function writeColumnBlock(w, colId, ctype, nullable, values, numRows) {
  w.writeLEB128(colId >>> 0)
  w.writeByte(((nullable ? 1 : 0) << 4) | (ctype & 0x0F))
  if (nullable) writeNullBitmap(w, values, numRows)
  writeValueColumn(w, ctype, values)
}

// ── Public: snapshot frame ─────────────────────────────────────────────────
//
// frame = {
//   schemaHash?: Uint8Array (32 bytes; omit → all-zero),
//   rowIds:      BigInt[],
//   columns:     [{ colId, ctype, nullable, values }],
// }
//
// columns[i].values is parallel to rowIds; null entries mean NULL cell.

export function encodeFrame(frame) {
  const w = new ByteWriter()
  const { rowIds = [], columns = [] } = frame
  const numRows = rowIds.length
  const numCols = columns.length

  // Header.
  w.writeByte(FRAME_SNAPSHOT)
  const schemaHash = frame.schemaHash instanceof Uint8Array
    ? frame.schemaHash
    : new Uint8Array(SCHEMA_HASH_BYTES)
  if (schemaHash.length !== SCHEMA_HASH_BYTES)
    throw new Error(`schema_hash must be exactly ${SCHEMA_HASH_BYTES} bytes`)
  w.writeBytes(schemaHash)

  // num_rows, num_cols.
  w.writeLEB128Big(BigInt(numRows))
  w.writeLEB128(numCols)

  // Row-ID block (delta-coded).
  writeRowIdBlock(w, rowIds)

  // Column blocks.
  for (const col of columns) {
    if (col.values.length !== numRows)
      throw new Error(`column ${col.colId} has ${col.values.length} values but frame has ${numRows} rows`)
    writeColumnBlock(w, col.colId, col.ctype, col.nullable, col.values, numRows)
  }

  return w.toBytes()
}

// ── Per-column op data ─────────────────────────────────────────────────────
//
// Used by row_insert, row_update, batch_upsert.
// Format: col_id (LEB128) + type_byte + [null_bitmap] + values.
// Note: ctype is included in type_byte for all op column data (v0.1 design:
// self-describing format; decoders need not track schema to decode values).

function writeOpColumnData(w, col, numRows) {
  writeColumnBlock(w, col.colId, col.ctype, col.nullable, col.values, numRows)
}

// ── Delta op encoding ──────────────────────────────────────────────────────

function writeOp(w, op) {
  w.writeByte(op.op & 0xFF)

  switch (op.op) {
    case OP.ROW_INSERT: {
      const numRows = op.rowIds.length
      w.writeLEB128Big(BigInt(numRows))
      writeRowIdBlock(w, op.rowIds)
      const cols = op.columns ?? []
      w.writeLEB128(cols.length)
      for (const col of cols) writeOpColumnData(w, col, numRows)
      break
    }
    case OP.ROW_UPDATE: {
      const numRows = op.rowIds.length
      w.writeLEB128Big(BigInt(numRows))
      writeRowIdBlock(w, op.rowIds)
      const cols = op.columns ?? []
      w.writeLEB128(cols.length)
      for (const col of cols) writeOpColumnData(w, col, numRows)
      break
    }
    case OP.ROW_DELETE: {
      w.writeLEB128Big(BigInt(op.rowIds.length))
      writeRowIdBlock(w, op.rowIds)
      break
    }
    case OP.COLUMN_ADD: {
      w.writeLEB128(op.colId >>> 0)
      w.writeByte(((op.nullable ? 1 : 0) << 4) | (op.ctype & 0x0F))
      const hasDefault = op.hasDefault ? 1 : 0
      w.writeByte(hasDefault)
      if (hasDefault) writeValue(w, op.ctype, op.defaultValue)
      break
    }
    case OP.COLUMN_DROP: {
      w.writeLEB128(op.colId >>> 0)
      break
    }
    case OP.COLUMN_RENAME: {
      w.writeLEB128(op.colId >>> 0)
      const nameBytes = _enc.encode(op.name)
      if (nameBytes.length === 0) throw new Error("invalid_col_name: empty name")
      w.writeLEB128(nameBytes.length)
      w.writeBytes(nameBytes)
      break
    }
    case OP.BATCH_UPSERT: {
      const numRows = op.rowIds.length
      w.writeLEB128Big(BigInt(numRows))
      writeRowIdBlock(w, op.rowIds)
      const cols = op.columns ?? []
      w.writeLEB128(cols.length)
      for (const col of cols) writeOpColumnData(w, col, numRows)
      break
    }
    default:
      throw new Error(`unknown_delta_op: ${op.op}`)
  }
}

// ── Public: delta chain ────────────────────────────────────────────────────
//
// encodeChain({ schemaHash?, ops }) → Uint8Array

export function encodeChain({ schemaHash, ops = [] }) {
  const w = new ByteWriter()
  w.writeByte(FRAME_DELTA)
  const hash = schemaHash instanceof Uint8Array
    ? schemaHash
    : new Uint8Array(SCHEMA_HASH_BYTES)
  if (hash.length !== SCHEMA_HASH_BYTES)
    throw new Error(`schema_hash must be exactly ${SCHEMA_HASH_BYTES} bytes`)
  w.writeBytes(hash)
  w.writeLEB128(ops.length)
  for (const op of ops) writeOp(w, op)
  return w.toBytes()
}
