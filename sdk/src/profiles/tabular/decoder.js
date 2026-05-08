// weavepack-tabular — decoder (snapshot frames + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire profile code.

import {
  CTYPE, OP, FRAME_SNAPSHOT, FRAME_DELTA,
  SCHEMA_HASH_BYTES, MAX_STRING_BYTES,
  nullBitmapBytes, getNullBit,
} from "./types.js"

const _dec = new TextDecoder()

// ── ByteReader ─────────────────────────────────────────────────────────────

class ByteReader {
  constructor(bytes) {
    this._buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    this._pos = 0
  }

  eof() { return this._pos >= this._buf.length }

  readByte() {
    if (this._pos >= this._buf.length) throw new Error("unexpected end of input")
    return this._buf[this._pos++]
  }

  readBytes(n) {
    if (this._pos + n > this._buf.length) throw new Error("unexpected end of input")
    const out = this._buf.slice(this._pos, this._pos + n)
    this._pos += n
    return out
  }

  // LEB128 uint32.
  readLEB128() {
    let result = 0, shift = 0
    while (true) {
      const b = this.readByte()
      result |= (b & 0x7F) << shift
      shift += 7
      if ((b & 0x80) === 0) break
      if (shift >= 35) throw new Error("LEB128 overflow for uint32")
    }
    return result >>> 0
  }

  // LEB128 uint64 (returns BigInt).
  readLEB128Big() {
    let result = 0n, shift = 0n
    while (true) {
      const b = BigInt(this.readByte())
      result |= (b & 0x7Fn) << shift
      shift += 7n
      if ((b & 0x80n) === 0n) break
      if (shift >= 70n) throw new Error("LEB128 overflow for uint64")
    }
    return result
  }

  // Signed int64 as 8 bytes little-endian (returns BigInt).
  readInt64LE() {
    const bytes = this.readBytes(8)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
    const lo = BigInt(dv.getUint32(0, true))
    const hi = BigInt(dv.getUint32(4, true))
    const u = (hi << 32n) | lo
    return u > 0x7FFFFFFFFFFFFFFFn ? u - (1n << 64n) : u
  }
}

// ── Row-ID block ───────────────────────────────────────────────────────────

function readRowIdBlock(r, numRows) {
  if (numRows === 0) return []
  const rowIds = []
  const firstId = r.readLEB128Big()
  rowIds.push(firstId)
  let prev = firstId
  for (let i = 1; i < numRows; i++) {
    const delta = r.readLEB128Big()
    if (delta < 1n) throw new Error("duplicate_row_id: row_id delta must be ≥1")
    prev = prev + delta
    rowIds.push(prev)
  }
  return rowIds
}

// ── Per-ctype value decoding ───────────────────────────────────────────────

function readValue(r, ctype) {
  switch (ctype) {
    case CTYPE.BOOL:
      return r.readByte() !== 0
    case CTYPE.INT8: {
      const b = r.readByte()
      return b > 127 ? b - 256 : b
    }
    case CTYPE.INT16: {
      const bytes = r.readBytes(2)
      const u = bytes[0] | (bytes[1] << 8)
      return u > 0x7FFF ? u - 0x10000 : u
    }
    case CTYPE.INT32: {
      const bytes = r.readBytes(4)
      const u = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
      return u > 0x7FFFFFFF ? u - 0x100000000 : u
    }
    case CTYPE.INT64:
    case CTYPE.TIMESTAMP64:
      return r.readInt64LE()
    case CTYPE.UINT8:
      return r.readByte()
    case CTYPE.UINT16: {
      const bytes = r.readBytes(2)
      return bytes[0] | (bytes[1] << 8)
    }
    case CTYPE.UINT32: {
      const bytes = r.readBytes(4)
      return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
    }
    case CTYPE.UINT64: {
      const bytes = r.readBytes(8)
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
      const lo = BigInt(dv.getUint32(0, true))
      const hi = BigInt(dv.getUint32(4, true))
      return (hi << 32n) | lo
    }
    case CTYPE.FLOAT32: {
      const bytes = r.readBytes(4)
      return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true)
    }
    case CTYPE.FLOAT64: {
      const bytes = r.readBytes(8)
      return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)
    }
    case CTYPE.STRING: {
      const len = r.readLEB128()
      if (len > MAX_STRING_BYTES) throw new Error("string exceeds 256 MiB limit")
      const bytes = r.readBytes(len)
      try { return _dec.decode(bytes) }
      catch { throw new Error("invalid_utf8: string column contains invalid UTF-8") }
    }
    case CTYPE.BYTES: {
      const len = r.readLEB128()
      if (len > MAX_STRING_BYTES) throw new Error("bytes exceeds 256 MiB limit")
      return r.readBytes(len)
    }
    case CTYPE.DATE32: {
      const bytes = r.readBytes(4)
      const u = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
      return u > 0x7FFFFFFF ? u - 0x100000000 : u
    }
    case CTYPE.EXT:
      throw new Error("unknown_ext_type: EXT ctype not implemented in v0.1")
    default:
      throw new Error(`unknown ctype ${ctype}`)
  }
}

// Read N bool values from bit-packed bytes (MSB-first).
function readBoolColumn(r, count) {
  const nBytes = Math.ceil(count / 8)
  const bytes = r.readBytes(nBytes)
  const values = []
  for (let i = 0; i < count; i++) {
    values.push(((bytes[i >> 3] >> (7 - (i & 7))) & 1) === 1)
  }
  return values
}

// Read a value column: count non-null values (bool = bit-packed, others byte-level).
function readValueColumn(r, ctype, count) {
  if (ctype === CTYPE.BOOL) return readBoolColumn(r, count)
  const values = []
  for (let i = 0; i < count; i++) values.push(readValue(r, ctype))
  return values
}

// Read null bitmap (ceil(numRows/8) bytes) and reconstruct the full values array.
// Returns { bitmap, nullCount } where bitmap[i] is true if row i is NULL.
function readNullBitmap(r, numRows) {
  const nBytes = nullBitmapBytes(numRows)
  const bytes = r.readBytes(nBytes)

  // Validate padding bits in final byte are zero.
  const rem = numRows & 7
  if (rem !== 0) {
    const lastByte = bytes[nBytes - 1]
    const mask = 0xFF >> rem
    if (lastByte & mask) throw new Error("invalid_null_bitmap: padding bits must be zero")
  }

  const nulls = []
  for (let i = 0; i < numRows; i++) {
    nulls.push(getNullBit(bytes, i) === 1)
  }
  return nulls
}

// ── Column block ───────────────────────────────────────────────────────────

function readColumnBlock(r, numRows) {
  const colId = r.readLEB128()
  const typeByte = r.readByte()
  const ctype  = typeByte & 0x0F
  const nullable = ((typeByte >> 4) & 1) === 1

  let values
  if (nullable) {
    const nullFlags = readNullBitmap(r, numRows)
    const nonNullCount = nullFlags.filter(b => !b).length
    const nonNullValues = readValueColumn(r, ctype, nonNullCount)
    values = []
    let vi = 0
    for (let i = 0; i < numRows; i++) {
      values.push(nullFlags[i] ? null : nonNullValues[vi++])
    }
  } else {
    values = readValueColumn(r, ctype, numRows)
  }

  return { colId, ctype, nullable, values }
}

// ── Public: snapshot frame ─────────────────────────────────────────────────
//
// Returns { schemaHash: Uint8Array, rowIds: BigInt[], columns: [...] }.

export function decodeFrame(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FRAME_SNAPSHOT) {
    if (flag === FRAME_DELTA) throw new Error("expected snapshot frame, got delta chain")
    throw new Error(`unknown frame flag 0x${flag.toString(16)}`)
  }

  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  const numRows    = Number(r.readLEB128Big())
  const numCols    = r.readLEB128()

  const rowIds  = readRowIdBlock(r, numRows)

  const columns = []
  for (let c = 0; c < numCols; c++) {
    columns.push(readColumnBlock(r, numRows))
  }

  return { schemaHash, rowIds, columns }
}

// ── Op decoding ────────────────────────────────────────────────────────────

function readOpColumnData(r, numRows) {
  return readColumnBlock(r, numRows)
}

function readOp(r) {
  const opCode = r.readByte()

  switch (opCode) {
    case OP.ROW_INSERT: {
      const numRows = Number(r.readLEB128Big())
      const rowIds  = readRowIdBlock(r, numRows)
      const numCols = r.readLEB128()
      const columns = []
      for (let c = 0; c < numCols; c++) columns.push(readOpColumnData(r, numRows))
      return { op: opCode, rowIds, columns }
    }
    case OP.ROW_UPDATE: {
      const numRows = Number(r.readLEB128Big())
      const rowIds  = readRowIdBlock(r, numRows)
      const numCols = r.readLEB128()
      const columns = []
      for (let c = 0; c < numCols; c++) columns.push(readOpColumnData(r, numRows))
      return { op: opCode, rowIds, columns }
    }
    case OP.ROW_DELETE: {
      const numRows = Number(r.readLEB128Big())
      const rowIds  = readRowIdBlock(r, numRows)
      return { op: opCode, rowIds }
    }
    case OP.COLUMN_ADD: {
      const colId    = r.readLEB128()
      const typeByte = r.readByte()
      const ctype    = typeByte & 0x0F
      const nullable = ((typeByte >> 4) & 1) === 1
      const hasDefault = r.readByte() === 1
      const defaultValue = hasDefault ? readValue(r, ctype) : undefined
      return { op: opCode, colId, ctype, nullable, hasDefault, defaultValue }
    }
    case OP.COLUMN_DROP: {
      const colId = r.readLEB128()
      return { op: opCode, colId }
    }
    case OP.COLUMN_RENAME: {
      const colId  = r.readLEB128()
      const nameLen = r.readLEB128()
      if (nameLen === 0) throw new Error("invalid_col_name: empty name")
      const nameBytes = r.readBytes(nameLen)
      const name = _dec.decode(nameBytes)
      return { op: opCode, colId, name }
    }
    case OP.BATCH_UPSERT: {
      const numRows = Number(r.readLEB128Big())
      const rowIds  = readRowIdBlock(r, numRows)
      const numCols = r.readLEB128()
      const columns = []
      for (let c = 0; c < numCols; c++) columns.push(readOpColumnData(r, numRows))
      return { op: opCode, rowIds, columns }
    }
    default:
      if (opCode === 7) throw new Error("unknown_delta_op: op code 7 is reserved")
      throw new Error(`unknown_delta_op: op code ${opCode}`)
  }
}

// ── Public: delta chain ────────────────────────────────────────────────────
//
// Returns { schemaHash: Uint8Array, ops: [...] }.

export function decodeChain(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FRAME_DELTA)
    throw new Error(`expected delta chain (flag 0x01), got 0x${flag.toString(16)}`)

  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  const numOps = r.readLEB128()
  const ops = []
  for (let i = 0; i < numOps; i++) ops.push(readOp(r))
  return { schemaHash, ops }
}
