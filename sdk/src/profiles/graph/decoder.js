// weavepack-graph — decoder (graph documents + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire/tabular/log code.

import {
  CTYPE, OP, PATH_KIND,
  BLOCK_TYPE_NODE, BLOCK_TYPE_EDGE,
  SCHEMA_HASH_BYTES, GRAPH_VERSION, PROFILE_NUM,
  MAX_STRING_BYTES,
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
}

// ── Per-ctype single value decoding ──────────────────────────────────────

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
    case CTYPE.UINT64:
    case CTYPE.NODE_ID: {
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
      if (len > MAX_STRING_BYTES) throw new Error("string_too_large: string exceeds 1 GiB limit")
      const bytes = r.readBytes(len)
      try { return _dec.decode(bytes) }
      catch { throw new Error("invalid_utf8: string column contains invalid UTF-8") }
    }
    case CTYPE.BYTES: {
      const len = r.readLEB128()
      if (len > MAX_STRING_BYTES) throw new Error("string_too_large: bytes exceeds 1 GiB limit")
      return r.readBytes(len)
    }
    case CTYPE.DATE32: {
      const bytes = r.readBytes(4)
      const u = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
      return u > 0x7FFFFFFF ? u - 0x100000000 : u
    }
    default:
      throw new Error(`unknown_ctype: ctype ${ctype}`)
  }
}

// Bool value column: 1 bit per value, LSB-first within each byte.
function readBoolColumn(r, count) {
  const nBytes = Math.ceil(count / 8)
  const bytes = r.readBytes(nBytes)
  const values = []
  for (let i = 0; i < count; i++) {
    values.push(((bytes[i >> 3] >> (i & 7)) & 1) === 1)
  }
  return values
}

function readValueColumn(r, ctype, count) {
  if (ctype === CTYPE.BOOL) return readBoolColumn(r, count)
  const values = []
  for (let i = 0; i < count; i++) values.push(readValue(r, ctype))
  return values
}

// Read null bitmap and rebuild full values array (nulls as null).
function readNullableColumn(r, ctype, numElems) {
  const nBytes = nullBitmapBytes(numElems)
  const bitmapBytes = r.readBytes(nBytes)

  const rem = numElems & 7
  if (rem !== 0) {
    const lastByte = bitmapBytes[nBytes - 1]
    const mask = 0xFF >> rem
    if (lastByte & mask) throw new Error("invalid_null_bitmap: padding bits must be zero")
  }

  const nullFlags = []
  for (let i = 0; i < numElems; i++) nullFlags.push(getNullBit(bitmapBytes, i) === 1)

  const nonNullCount = nullFlags.filter(b => !b).length
  const nonNullValues = readValueColumn(r, ctype, nonNullCount)
  const values = []
  let vi = 0
  for (let i = 0; i < numElems; i++) {
    values.push(nullFlags[i] ? null : nonNullValues[vi++])
  }
  return values
}

// ── NID / EID delta-pack column ────────────────────────────────────────────

function readIdDeltaColumn(r, count) {
  if (count === 0) return []
  const ids = []
  const first = r.readLEB128Big()
  ids.push(first)
  let prev = first
  for (let i = 1; i < count; i++) {
    const delta = r.readLEB128Big()
    if (delta < 1n) throw new Error("duplicate_element_id: id delta must be ≥1")
    prev = prev + delta
    ids.push(prev)
  }
  return ids
}

// ── SRC / DST plain uint64 column ─────────────────────────────────────────

function readPlainUint64Column(r, count) {
  const values = []
  for (let i = 0; i < count; i++) {
    const bytes = r.readBytes(8)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
    const lo = BigInt(dv.getUint32(0, true))
    const hi = BigInt(dv.getUint32(4, true))
    values.push((hi << 32n) | lo)
  }
  return values
}

// ── Property column schema ─────────────────────────────────────────────────

function readPropColSchema(r, minColId) {
  const colId = r.readLEB128()
  if (colId < minColId)
    throw new Error(`reserved_col_id: col_id ${colId} is reserved (must be ≥ ${minColId})`)
  const typeByte = r.readByte()
  const ctype    = typeByte & 0xF
  const nullable = ((typeByte >> 4) & 1) === 1
  if (ctype > 15)
    throw new Error(`unknown_ctype: ctype ${ctype} ≥ 16 is reserved`)
  return { colId, ctype, nullable }
}

function readPropColData(r, schema, numElems) {
  if (schema.nullable) {
    return { ...schema, values: readNullableColumn(r, schema.ctype, numElems) }
  } else {
    return { ...schema, values: readValueColumn(r, schema.ctype, numElems) }
  }
}

// ── Node block ─────────────────────────────────────────────────────────────

function readNodeBlock(r) {
  const numNodes  = Number(r.readLEB128Big())
  const labelLen  = r.readLEB128()
  const label     = labelLen > 0 ? _dec.decode(r.readBytes(labelLen)) : null
  const numCols   = r.readLEB128()
  const schemas   = []
  for (let c = 0; c < numCols; c++) schemas.push(readPropColSchema(r, 2))

  const nids      = readIdDeltaColumn(r, numNodes)
  const columns   = schemas.map(s => readPropColData(r, s, numNodes))

  return { type: 'node', label, nids, columns }
}

// ── Edge block ─────────────────────────────────────────────────────────────

function readEdgeBlock(r) {
  const numEdges  = Number(r.readLEB128Big())
  const labelLen  = r.readLEB128()
  const label     = labelLen > 0 ? _dec.decode(r.readBytes(labelLen)) : null
  const numCols   = r.readLEB128()
  const schemas   = []
  for (let c = 0; c < numCols; c++) schemas.push(readPropColSchema(r, 4))

  const eids      = readIdDeltaColumn(r, numEdges)
  const srcs      = readPlainUint64Column(r, numEdges)
  const dsts      = readPlainUint64Column(r, numEdges)
  const columns   = schemas.map(s => readPropColData(r, s, numEdges))

  return { type: 'edge', label, eids, srcs, dsts, columns }
}

// ── Graph document header ──────────────────────────────────────────────────

function readDocHeader(r) {
  const version = r.readLEB128()
  if (version !== GRAPH_VERSION)
    throw new Error(`unsupported_version: expected graph_version ${GRAPH_VERSION}, got ${version}`)
  const profileId = r.readLEB128()
  if (profileId !== PROFILE_NUM)
    throw new Error(`wrong_profile: expected profile_id ${PROFILE_NUM}, got ${profileId}`)
  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  return { schemaHash }
}

// ── Public: graph document (snapshot) ─────────────────────────────────────

export function decodeGraph(bytes) {
  const r = new ByteReader(bytes)
  const { schemaHash } = readDocHeader(r)
  const numBlocks = r.readLEB128()
  const blocks = []
  for (let i = 0; i < numBlocks; i++) {
    const blockType = r.readByte()
    if (blockType === BLOCK_TYPE_NODE) {
      blocks.push(readNodeBlock(r))
    } else if (blockType === BLOCK_TYPE_EDGE) {
      blocks.push(readEdgeBlock(r))
    } else {
      throw new Error(`unknown_block_type: block type ${blockType}`)
    }
  }
  return { schemaHash, blocks }
}

// ── Path decoding ──────────────────────────────────────────────────────────

function readPath(r) {
  const pathByte = r.readByte()
  const kind = (pathByte >> 4) & 0xF
  if (kind === 15) throw new Error("unknown_path_kind: path kind 15 is reserved")
  switch (kind) {
    case PATH_KIND.NODE:
      return { kind, nid: r.readLEB128Big() }
    case PATH_KIND.NODE_COL:
      return { kind, nid: r.readLEB128Big(), colId: r.readLEB128() }
    case PATH_KIND.EDGE:
      return { kind, eid: r.readLEB128Big() }
    case PATH_KIND.EDGE_COL:
      return { kind, eid: r.readLEB128Big(), colId: r.readLEB128() }
    case PATH_KIND.NODE_LABEL: {
      const len = r.readLEB128()
      const label = _dec.decode(r.readBytes(len))
      return { kind, label }
    }
    case PATH_KIND.NODE_LABEL_COL: {
      const len = r.readLEB128()
      const label = _dec.decode(r.readBytes(len))
      return { kind, label, colId: r.readLEB128() }
    }
    case PATH_KIND.EDGE_LABEL: {
      const len = r.readLEB128()
      const label = _dec.decode(r.readBytes(len))
      return { kind, label }
    }
    case PATH_KIND.EDGE_LABEL_COL: {
      const len = r.readLEB128()
      const label = _dec.decode(r.readBytes(len))
      return { kind, label, colId: r.readLEB128() }
    }
    case PATH_KIND.AT_NID:   return { kind }
    case PATH_KIND.AT_EID:   return { kind }
    case PATH_KIND.AT_SRC:   return { kind }
    case PATH_KIND.AT_DST:   return { kind }
    case PATH_KIND.AT_LABEL: {
      const len = r.readLEB128()
      const label = _dec.decode(r.readBytes(len))
      return { kind, label }
    }
    case PATH_KIND.NODE_PROP: {
      const nid = r.readLEB128Big()
      const len = r.readLEB128()
      const prop = _dec.decode(r.readBytes(len))
      return { kind, nid, prop }
    }
    case PATH_KIND.EDGE_PROP: {
      const eid = r.readLEB128Big()
      const len = r.readLEB128()
      const prop = _dec.decode(r.readBytes(len))
      return { kind, eid, prop }
    }
    default:
      throw new Error(`unknown_path_kind: path kind ${kind}`)
  }
}

// ── Op decoding ────────────────────────────────────────────────────────────

function readNodeInsert(r) {
  const block = readNodeBlock(r)
  return { op: OP.NODE_INSERT, block }
}

function readNodeDelete(r) {
  const count = Number(r.readLEB128Big())
  const nids = []
  for (let i = 0; i < count; i++) nids.push(r.readLEB128Big())
  return { op: OP.NODE_DELETE, nids }
}

function readEdgeInsert(r) {
  const block = readEdgeBlock(r)
  return { op: OP.EDGE_INSERT, block }
}

function readEdgeDelete(r) {
  const count = Number(r.readLEB128Big())
  const eids = []
  for (let i = 0; i < count; i++) eids.push(r.readLEB128Big())
  return { op: OP.EDGE_DELETE, eids }
}

function readPropSet(r) {
  const path     = readPath(r)
  const ctypeByte = r.readByte()
  const ctype    = ctypeByte & 0xF
  const flagsByte = r.readByte()
  const nullable = (flagsByte & 1) === 1
  const isNull   = ((flagsByte >> 1) & 1) === 1
  const value    = isNull ? null : readValue(r, ctype)
  return { op: OP.PROP_SET, path, ctype, nullable, isNull, value }
}

function readSubgraphReplace(r) {
  const flags    = r.readByte()
  const hasNode  = (flags & 1) === 1
  const hasEdge  = ((flags >> 1) & 1) === 1
  const labelLen = r.readLEB128()
  const label    = labelLen > 0 ? _dec.decode(r.readBytes(labelLen)) : null
  const nodeBlock = hasNode ? readNodeBlock(r) : null
  const edgeBlock = hasEdge ? readEdgeBlock(r) : null
  return { op: OP.SUBGRAPH_REPLACE, label, nodeBlock, edgeBlock }
}

function readOp(r) {
  const opByte = r.readByte()
  const opCode = opByte & 0x7
  if (opCode > 5)
    throw new Error(`unknown_delta_op: op code ${opCode} is reserved (must be 0–5)`)
  switch (opCode) {
    case OP.NODE_INSERT:      return readNodeInsert(r)
    case OP.NODE_DELETE:      return readNodeDelete(r)
    case OP.EDGE_INSERT:      return readEdgeInsert(r)
    case OP.EDGE_DELETE:      return readEdgeDelete(r)
    case OP.PROP_SET:         return readPropSet(r)
    case OP.SUBGRAPH_REPLACE: return readSubgraphReplace(r)
    default:
      throw new Error(`unknown_delta_op: op code ${opCode}`)
  }
}

// ── Public: delta chain ────────────────────────────────────────────────────

export function decodeChain(bytes) {
  const r = new ByteReader(bytes)
  const { schemaHash } = readDocHeader(r)
  const numOps = r.readLEB128()
  const ops = []
  for (let i = 0; i < numOps; i++) ops.push(readOp(r))
  return { schemaHash, ops }
}
