// weavepack-log — encoder (event batches + delta chains + stream header).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire/tabular code.
//
// Binary layout:
//   Snapshot: 0x00 + schema_hash(32B) + LEB128(num_events)
//             + seq_block + ts_block + LEB128(num_user_cols) + column_block[*]
//   Delta:    0x01 + schema_hash(32B) + LEB128(num_ops) + op[*]
//   Header:   0x02 + stream_id(16B) + LEB128(source_len) + source + schema_hash(32B)
//             + LEB128(seq_start)
//
// See weavepack/profiles/log/02-containers.md and 04-deltas.md.

import {
  CTYPE, OP, SCHEMA_SUB_OP, FRAME_SNAPSHOT, FRAME_DELTA, FRAME_STREAM_HEADER,
  SCHEMA_HASH_BYTES, STREAM_ID_BYTES, MAX_STRING_BYTES,
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

  writeLEB128(v) {
    v = v >>> 0
    while (v >= 128) {
      this._buf.push((v & 0x7F) | 0x80)
      v >>>= 7
    }
    this._buf.push(v)
  }

  writeLEB128Big(v) {
    v = BigInt(v)
    while (v >= 128n) {
      this._buf.push(Number(v & 0x7Fn) | 0x80)
      v >>= 7n
    }
    this._buf.push(Number(v))
  }

  toBytes() { return new Uint8Array(this._buf) }
}

// ── Level column encoding (3-bit LSB-first per 01-types.md) ───────────────

function writeLevelColumn(w, values) {
  const n = values.length
  const nBytes = Math.ceil(n * 3 / 8)
  const bytes = new Uint8Array(nBytes)
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v < 0 || v > 5) throw new Error(`unknown_level: level value ${v} is reserved (must be 0–5)`)
    const bitBase = i * 3
    for (let b = 0; b < 3; b++) {
      if ((v >> b) & 1) {
        const pos = bitBase + b
        bytes[pos >> 3] |= (1 << (pos & 7))
      }
    }
  }
  // Validate padding bits are zero (they are, since we start with zeroed bytes).
  w.writeBytes(bytes)
}

// ── Per-ctype single value encoding ───────────────────────────────────────

function writeValue(w, ctype, value) {
  switch (ctype) {
    case CTYPE.BOOL:
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
    case CTYPE.TIMESTAMP64: {
      const bv = BigInt(value)
      const lo = Number(bv & 0xFFFFFFFFn)
      const hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
      break
    }
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
      const lo = Number(bv & 0xFFFFFFFFn)
      const hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
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
      throw new Error("unknown_ext_type: EXT ctype encoding not implemented in v0.1")
    case CTYPE.LEVEL:
      // Single level value: write as 1 byte (0-5).
      if (value < 0 || value > 5) throw new Error(`unknown_level: level value ${value} is reserved`)
      w.writeByte(value & 0xFF)
      break
    default:
      throw new Error(`unknown_ctype: ctype ${ctype}`)
  }
}

// Write bool values packed MSB-first into ceil(N/8) bytes.
function writeBoolColumn(w, values) {
  const n = values.length
  const bytes = new Uint8Array(Math.ceil(n / 8))
  for (let i = 0; i < n; i++) {
    if (values[i]) bytes[i >> 3] |= (1 << (7 - (i & 7)))
  }
  w.writeBytes(bytes)
}

// Write null bitmap for a nullable column.
function writeNullBitmap(w, values, numEvents) {
  const bytes = new Uint8Array(nullBitmapBytes(numEvents))
  for (let i = 0; i < numEvents; i++) {
    if (values[i] === null || values[i] === undefined) setNullBit(bytes, i)
  }
  w.writeBytes(bytes)
}

// Write value column for a given ctype.
// Nulls (null/undefined) are skipped; caller wrote the null bitmap.
// Level columns use 3-bit LSB-first packing; bool uses MSB-first bit packing;
// all other ctypes are byte-level.
function writeValueColumn(w, ctype, values) {
  const nonNull = values.filter(v => v !== null && v !== undefined)
  if (ctype === CTYPE.BOOL) {
    writeBoolColumn(w, nonNull)
  } else if (ctype === CTYPE.LEVEL) {
    writeLevelColumn(w, nonNull)
  } else {
    for (const v of nonNull) writeValue(w, ctype, v)
  }
}

// ── Column block (snapshot / event_append) ────────────────────────────────
//
// type_byte = (nullable<<5) | (ctype & 0x1F)  [5-bit ctype, 1-bit nullable]

function writeColumnBlock(w, colId, ctype, nullable, values, numEvents) {
  if (colId < 2) throw new Error(`reserved_col_id: col_id ${colId} is reserved (must be ≥ 2)`)
  if (ctype > 16) throw new Error(`unknown_ctype: ctype ${ctype} ≥ 17 is reserved`)
  w.writeLEB128(colId >>> 0)
  w.writeByte(((nullable ? 1 : 0) << 5) | (ctype & 0x1F))
  if (nullable) writeNullBitmap(w, values, numEvents)
  writeValueColumn(w, ctype, values)
}

// ── Mandatory seq block ────────────────────────────────────────────────────
//
// first_seq (LEB128 uint64) + (N-1) deltas (each LEB128 uint64, ≥1).

function writeSeqBlock(w, seqs) {
  if (seqs.length === 0) return
  w.writeLEB128Big(BigInt(seqs[0]))
  for (let i = 1; i < seqs.length; i++) {
    const delta = BigInt(seqs[i]) - BigInt(seqs[i - 1])
    if (delta < 1n) throw new Error(`duplicate_seq: seq delta must be ≥1; got ${delta} at index ${i}`)
    w.writeLEB128Big(delta)
  }
}

// ── Mandatory ts block ─────────────────────────────────────────────────────
//
// first_ts zigzag-encoded as LEB128 uint64 + (N-1) deltas (each ≥0).
// Zigzag: enc = (v << 1) ^ (v >> 63)

function writeZigzag64(w, v) {
  const bv = BigInt(v)
  const enc = (bv << 1n) ^ (bv >> 63n)
  w.writeLEB128Big(enc < 0n ? enc + (1n << 64n) : enc)
}

function writeTsBlock(w, tss) {
  if (tss.length === 0) return
  writeZigzag64(w, tss[0])
  for (let i = 1; i < tss.length; i++) {
    const delta = BigInt(tss[i]) - BigInt(tss[i - 1])
    if (delta < 0n) throw new Error(`non_monotone_timestamp: ts delta must be ≥0; got ${delta} at index ${i}`)
    w.writeLEB128Big(delta)
  }
}

// ── Public: snapshot frame (event batch) ──────────────────────────────────
//
// batch = {
//   schemaHash?: Uint8Array (32 bytes; omit → all-zero),
//   seqs:        BigInt[],  (num_events seq values, strictly ascending)
//   tss:         BigInt[],  (num_events timestamp values, non-decreasing)
//   columns:     [{ colId, ctype, nullable, values }],  (col_id ≥ 2)
// }
//
// columns[i].values is parallel to seqs/tss; null entries mean NULL cell.

export function encodeBatch(batch) {
  const w = new ByteWriter()
  const { seqs = [], tss = [], columns = [] } = batch
  const numEvents = seqs.length

  if (tss.length !== numEvents)
    throw new Error(`tss.length (${tss.length}) must equal seqs.length (${numEvents})`)

  // Header.
  w.writeByte(FRAME_SNAPSHOT)
  const schemaHash = batch.schemaHash instanceof Uint8Array
    ? batch.schemaHash
    : new Uint8Array(SCHEMA_HASH_BYTES)
  if (schemaHash.length !== SCHEMA_HASH_BYTES)
    throw new Error(`schema_hash must be exactly ${SCHEMA_HASH_BYTES} bytes`)
  w.writeBytes(schemaHash)

  // num_events.
  w.writeLEB128Big(BigInt(numEvents))

  // Mandatory columns.
  writeSeqBlock(w, seqs)
  writeTsBlock(w, tss)

  // User columns.
  w.writeLEB128(columns.length)
  for (const col of columns) {
    if (col.values.length !== numEvents)
      throw new Error(`column ${col.colId} has ${col.values.length} values but batch has ${numEvents} events`)
    writeColumnBlock(w, col.colId, col.ctype, col.nullable, col.values, numEvents)
  }

  return w.toBytes()
}

// ── Public: stream header ─────────────────────────────────────────────────
//
// header = {
//   streamId:   Uint8Array (16 bytes UUID),
//   source:     string,
//   schemaHash: Uint8Array (32 bytes; omit → all-zero),
//   seqStart:   BigInt,
// }

export function encodeStreamHeader(header) {
  const w = new ByteWriter()
  w.writeByte(FRAME_STREAM_HEADER)

  const streamId = header.streamId instanceof Uint8Array
    ? header.streamId
    : new Uint8Array(STREAM_ID_BYTES)
  if (streamId.length !== STREAM_ID_BYTES)
    throw new Error(`stream_id must be exactly ${STREAM_ID_BYTES} bytes`)
  w.writeBytes(streamId)

  const sourceBytes = _enc.encode(header.source ?? "")
  w.writeLEB128(sourceBytes.length)
  w.writeBytes(sourceBytes)

  const schemaHash = header.schemaHash instanceof Uint8Array
    ? header.schemaHash
    : new Uint8Array(SCHEMA_HASH_BYTES)
  if (schemaHash.length !== SCHEMA_HASH_BYTES)
    throw new Error(`schema_hash must be exactly ${SCHEMA_HASH_BYTES} bytes`)
  w.writeBytes(schemaHash)

  w.writeLEB128Big(BigInt(header.seqStart ?? 0))

  return w.toBytes()
}

// ── Delta op encoding ──────────────────────────────────────────────────────

function writeEventAppend(w, op) {
  const seqs = op.seqs ?? []
  const tss  = op.tss  ?? []
  const numEvents = seqs.length
  if (tss.length !== numEvents)
    throw new Error(`event_append: tss.length (${tss.length}) must equal seqs.length (${numEvents})`)
  w.writeLEB128Big(BigInt(numEvents))
  writeSeqBlock(w, seqs)
  writeTsBlock(w, tss)
  const cols = op.columns ?? []
  w.writeLEB128(cols.length)
  for (const col of cols) {
    if (col.values.length !== numEvents)
      throw new Error(`event_append column ${col.colId} has ${col.values.length} values but op has ${numEvents} events`)
    writeColumnBlock(w, col.colId, col.ctype, col.nullable, col.values, numEvents)
  }
}

function writeFieldUpdate(w, op) {
  w.writeLEB128Big(BigInt(op.seq))
  const cols = op.columns ?? []
  w.writeLEB128(cols.length)
  for (const col of cols) {
    if (col.colId < 2) throw new Error(`reserved_col_id: col_id ${col.colId} is reserved`)
    if (col.ctype > 16) throw new Error(`unknown_ctype: ctype ${col.ctype} ≥ 17 is reserved`)
    const hasValue = col.value !== null && col.value !== undefined
    // type_byte for update col: (has_value<<5) | (ctype & 0x1F)
    w.writeLEB128(col.colId >>> 0)
    w.writeByte(((hasValue ? 1 : 0) << 5) | (col.ctype & 0x1F))
    if (hasValue) writeValue(w, col.ctype, col.value)
  }
}

function writeEventExpire(w, op) {
  const lo = BigInt(op.seqLo)
  const hi = BigInt(op.seqHi)
  if (lo > hi) throw new Error(`invalid_seq_range: seq_lo (${lo}) > seq_hi (${hi})`)
  w.writeLEB128Big(lo)
  w.writeLEB128Big(hi)
}

function writeSchemaEvolve(w, op) {
  const sub = op.subOp
  if (sub > 2) throw new Error(`unknown_schema_sub_op: sub_op ${sub} is reserved`)
  w.writeByte(sub & 0xFF)
  switch (sub) {
    case SCHEMA_SUB_OP.COLUMN_ADD: {
      if (op.colId < 2) throw new Error(`reserved_col_id: col_id ${op.colId} is reserved`)
      if (op.ctype > 16) throw new Error(`unknown_ctype: ctype ${op.ctype} ≥ 17 is reserved`)
      const nameBytes = _enc.encode(op.name ?? "")
      if (nameBytes.length === 0) throw new Error("invalid_col_name: empty name")
      w.writeLEB128(op.colId >>> 0)
      w.writeByte(((op.nullable ? 1 : 0) << 5) | (op.ctype & 0x1F))
      w.writeLEB128(nameBytes.length)
      w.writeBytes(nameBytes)
      break
    }
    case SCHEMA_SUB_OP.COLUMN_DROP:
      w.writeLEB128(op.colId >>> 0)
      break
    case SCHEMA_SUB_OP.COLUMN_RENAME: {
      const nameBytes = _enc.encode(op.name ?? "")
      if (nameBytes.length === 0) throw new Error("invalid_col_name: empty name")
      w.writeLEB128(op.colId >>> 0)
      w.writeLEB128(nameBytes.length)
      w.writeBytes(nameBytes)
      break
    }
  }
}

function writeCursorCheckpoint(w, op) {
  w.writeLEB128Big(BigInt(op.seq))
  const nameBytes = _enc.encode(op.name ?? "")
  if (nameBytes.length === 0) throw new Error("invalid_cursor_name: empty cursor name")
  w.writeLEB128(nameBytes.length)
  w.writeBytes(nameBytes)
}

function writeOp(w, op) {
  const opCode = op.op
  if (opCode > 4) throw new Error(`unknown_delta_op: op code ${opCode} is reserved`)
  w.writeByte(opCode & 0xFF)
  switch (opCode) {
    case OP.EVENT_APPEND:      writeEventAppend(w, op);      break
    case OP.FIELD_UPDATE:      writeFieldUpdate(w, op);      break
    case OP.EVENT_EXPIRE:      writeEventExpire(w, op);      break
    case OP.SCHEMA_EVOLVE:     writeSchemaEvolve(w, op);     break
    case OP.CURSOR_CHECKPOINT: writeCursorCheckpoint(w, op); break
    default:
      throw new Error(`unknown_delta_op: op code ${opCode}`)
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
