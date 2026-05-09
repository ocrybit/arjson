// weavepack-log — decoder (event batches + delta chains + stream header).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire/tabular code.

import {
  CTYPE, OP, SCHEMA_SUB_OP, FRAME_SNAPSHOT, FRAME_DELTA, FRAME_STREAM_HEADER,
  SCHEMA_HASH_BYTES, STREAM_ID_BYTES, MAX_STRING_BYTES,
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

  // Read a zigzag-encoded sint64 (LEB128 uint64 then decode).
  readZigzag64() {
    const enc = this.readLEB128Big()
    return (enc >> 1n) ^ -(enc & 1n)
  }
}

// ── Level column decoding (3-bit LSB-first) ────────────────────────────────

function readLevelColumn(r, count) {
  const nBytes = Math.ceil(count * 3 / 8)
  const bytes = r.readBytes(nBytes)
  const values = []
  for (let i = 0; i < count; i++) {
    const bitBase = i * 3
    let v = 0
    for (let b = 0; b < 3; b++) {
      const pos = bitBase + b
      if ((bytes[pos >> 3] >> (pos & 7)) & 1) v |= (1 << b)
    }
    if (v >= 6) throw new Error(`unknown_level: level value ${v} is reserved`)
    values.push(v)
  }
  // Validate padding bits in final byte are zero.
  const totalBits = count * 3
  const usedInLastByte = totalBits & 7
  if (usedInLastByte !== 0) {
    const lastByte = bytes[nBytes - 1]
    const mask = 0xFF << usedInLastByte
    if (lastByte & mask & 0xFF) throw new Error("invalid_level_padding: padding bits must be zero")
  }
  return values
}

// ── Per-ctype single value decoding ───────────────────────────────────────

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
    case CTYPE.TIMESTAMP64: {
      const bytes = r.readBytes(8)
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
      const lo = BigInt(dv.getUint32(0, true))
      const hi = BigInt(dv.getUint32(4, true))
      const u = (hi << 32n) | lo
      return u > 0x7FFFFFFFFFFFFFFFn ? u - (1n << 64n) : u
    }
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
    case CTYPE.LEVEL:
      // Single level value (used in field_update): 1 byte.
      return r.readByte()
    default:
      throw new Error(`unknown_ctype: ctype ${ctype}`)
  }
}

// Read bool column: N values, MSB-first packed.
function readBoolColumn(r, count) {
  const nBytes = Math.ceil(count / 8)
  const bytes = r.readBytes(nBytes)
  const values = []
  for (let i = 0; i < count; i++) {
    values.push(((bytes[i >> 3] >> (7 - (i & 7))) & 1) === 1)
  }
  return values
}

// Read value column.
function readValueColumn(r, ctype, count) {
  if (ctype === CTYPE.BOOL)  return readBoolColumn(r, count)
  if (ctype === CTYPE.LEVEL) return readLevelColumn(r, count)
  const values = []
  for (let i = 0; i < count; i++) values.push(readValue(r, ctype))
  return values
}

// Read null bitmap and reconstruct the full values array.
function readNullBitmap(r, numEvents) {
  const nBytes = nullBitmapBytes(numEvents)
  const bytes = r.readBytes(nBytes)

  const rem = numEvents & 7
  if (rem !== 0) {
    const lastByte = bytes[nBytes - 1]
    const mask = 0xFF >> rem
    if (lastByte & mask) throw new Error("invalid_null_bitmap: padding bits must be zero")
  }

  const nulls = []
  for (let i = 0; i < numEvents; i++) {
    nulls.push(getNullBit(bytes, i) === 1)
  }
  return nulls
}

// ── Column block (5-bit ctype, 1-bit nullable) ─────────────────────────────

function readColumnBlock(r, numEvents) {
  const colId = r.readLEB128()
  if (colId < 2) throw new Error(`reserved_col_id: col_id ${colId} is reserved (must be ≥ 2)`)
  const typeByte = r.readByte()
  const ctype    = typeByte & 0x1F
  const nullable = ((typeByte >> 5) & 1) === 1
  if (ctype > 16) throw new Error(`unknown_ctype: ctype ${ctype} ≥ 17 is reserved`)

  let values
  if (nullable) {
    const nullFlags = readNullBitmap(r, numEvents)
    const nonNullCount = nullFlags.filter(b => !b).length
    const nonNullValues = readValueColumn(r, ctype, nonNullCount)
    values = []
    let vi = 0
    for (let i = 0; i < numEvents; i++) {
      values.push(nullFlags[i] ? null : nonNullValues[vi++])
    }
  } else {
    values = readValueColumn(r, ctype, numEvents)
  }

  return { colId, ctype, nullable, values }
}

// ── Mandatory seq block ────────────────────────────────────────────────────

function readSeqBlock(r, numEvents) {
  if (numEvents === 0) return []
  const seqs = []
  const firstSeq = r.readLEB128Big()
  seqs.push(firstSeq)
  let prev = firstSeq
  for (let i = 1; i < numEvents; i++) {
    const delta = r.readLEB128Big()
    if (delta < 1n) throw new Error("duplicate_seq: seq delta must be ≥1")
    prev = prev + delta
    seqs.push(prev)
  }
  return seqs
}

// ── Mandatory ts block ─────────────────────────────────────────────────────

function readTsBlock(r, numEvents) {
  if (numEvents === 0) return []
  const tss = []
  const firstTs = r.readZigzag64()
  tss.push(firstTs)
  let prev = firstTs
  for (let i = 1; i < numEvents; i++) {
    const delta = r.readLEB128Big()
    if (delta < 0n) throw new Error("non_monotone_timestamp: ts delta must be ≥0")
    prev = prev + BigInt(delta)
    tss.push(prev)
  }
  return tss
}

// ── Public: snapshot frame (event batch) ──────────────────────────────────
//
// Returns { schemaHash: Uint8Array, seqs: BigInt[], tss: BigInt[], columns: [...] }.

export function decodeBatch(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FRAME_SNAPSHOT) {
    if (flag === FRAME_DELTA) throw new Error("expected event batch (0x00), got delta chain (0x01)")
    if (flag === FRAME_STREAM_HEADER) throw new Error("expected event batch (0x00), got stream header (0x02)")
    throw new Error(`unknown frame flag 0x${flag.toString(16)}`)
  }

  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  const numEvents  = Number(r.readLEB128Big())

  const seqs = readSeqBlock(r, numEvents)
  const tss  = readTsBlock(r, numEvents)

  const numUserCols = r.readLEB128()
  const columns = []
  for (let c = 0; c < numUserCols; c++) {
    columns.push(readColumnBlock(r, numEvents))
  }

  return { schemaHash, seqs, tss, columns }
}

// ── Public: stream header ─────────────────────────────────────────────────
//
// Returns { streamId: Uint8Array, source: string, schemaHash: Uint8Array, seqStart: BigInt }.

export function decodeStreamHeader(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FRAME_STREAM_HEADER)
    throw new Error(`expected stream header (0x02), got 0x${flag.toString(16)}`)

  const streamId    = r.readBytes(STREAM_ID_BYTES)
  const sourceLen   = r.readLEB128()
  const sourceBytes = r.readBytes(sourceLen)
  let source
  try { source = _dec.decode(sourceBytes) }
  catch { throw new Error("invalid_utf8: source contains invalid UTF-8") }

  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  const seqStart   = r.readLEB128Big()

  return { streamId, source, schemaHash, seqStart }
}

// ── Op decoding ────────────────────────────────────────────────────────────

function readEventAppend(r) {
  const numEvents = Number(r.readLEB128Big())
  const seqs = readSeqBlock(r, numEvents)
  const tss  = readTsBlock(r, numEvents)
  const numCols = r.readLEB128()
  const columns = []
  for (let c = 0; c < numCols; c++) columns.push(readColumnBlock(r, numEvents))
  return { op: OP.EVENT_APPEND, seqs, tss, columns }
}

function readFieldUpdate(r) {
  const seq = r.readLEB128Big()
  const numCols = r.readLEB128()
  const columns = []
  for (let c = 0; c < numCols; c++) {
    const colId    = r.readLEB128()
    const typeByte = r.readByte()
    const ctype    = typeByte & 0x1F
    const hasValue = ((typeByte >> 5) & 1) === 1
    if (ctype > 16) throw new Error(`unknown_ctype: ctype ${ctype} ≥ 17 is reserved`)
    const value = hasValue ? readValue(r, ctype) : null
    columns.push({ colId, ctype, hasValue, value })
  }
  return { op: OP.FIELD_UPDATE, seq, columns }
}

function readEventExpire(r) {
  const seqLo = r.readLEB128Big()
  const seqHi = r.readLEB128Big()
  if (seqLo > seqHi) throw new Error(`invalid_seq_range: seq_lo (${seqLo}) > seq_hi (${seqHi})`)
  return { op: OP.EVENT_EXPIRE, seqLo, seqHi }
}

function readSchemaEvolve(r) {
  const subOp = r.readByte()
  if (subOp > 2) throw new Error(`unknown_schema_sub_op: sub_op ${subOp} is reserved`)
  switch (subOp) {
    case SCHEMA_SUB_OP.COLUMN_ADD: {
      const colId    = r.readLEB128()
      const typeByte = r.readByte()
      const ctype    = typeByte & 0x1F
      const nullable = ((typeByte >> 5) & 1) === 1
      if (ctype > 16) throw new Error(`unknown_ctype: ctype ${ctype} ≥ 17 is reserved`)
      const nameLen = r.readLEB128()
      if (nameLen === 0) throw new Error("invalid_col_name: empty name")
      const nameBytes = r.readBytes(nameLen)
      const name = _dec.decode(nameBytes)
      return { op: OP.SCHEMA_EVOLVE, subOp, colId, ctype, nullable, name }
    }
    case SCHEMA_SUB_OP.COLUMN_DROP: {
      const colId = r.readLEB128()
      return { op: OP.SCHEMA_EVOLVE, subOp, colId }
    }
    case SCHEMA_SUB_OP.COLUMN_RENAME: {
      const colId = r.readLEB128()
      const nameLen = r.readLEB128()
      if (nameLen === 0) throw new Error("invalid_col_name: empty name")
      const nameBytes = r.readBytes(nameLen)
      const name = _dec.decode(nameBytes)
      return { op: OP.SCHEMA_EVOLVE, subOp, colId, name }
    }
  }
}

function readCursorCheckpoint(r) {
  const seq = r.readLEB128Big()
  const nameLen = r.readLEB128()
  if (nameLen === 0) throw new Error("invalid_cursor_name: empty cursor name")
  const nameBytes = r.readBytes(nameLen)
  const name = _dec.decode(nameBytes)
  return { op: OP.CURSOR_CHECKPOINT, seq, name }
}

function readOp(r) {
  const opCode = r.readByte()
  switch (opCode) {
    case OP.EVENT_APPEND:      return readEventAppend(r)
    case OP.FIELD_UPDATE:      return readFieldUpdate(r)
    case OP.EVENT_EXPIRE:      return readEventExpire(r)
    case OP.SCHEMA_EVOLVE:     return readSchemaEvolve(r)
    case OP.CURSOR_CHECKPOINT: return readCursorCheckpoint(r)
    default:
      throw new Error(`unknown_delta_op: op code ${opCode} is reserved`)
  }
}

// ── Public: delta chain ────────────────────────────────────────────────────
//
// Returns { schemaHash: Uint8Array, ops: [...] }.

export function decodeChain(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FRAME_DELTA)
    throw new Error(`expected delta chain (0x01), got 0x${flag.toString(16)}`)

  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  const numOps = r.readLEB128()
  const ops = []
  for (let i = 0; i < numOps; i++) ops.push(readOp(r))
  return { schemaHash, ops }
}
