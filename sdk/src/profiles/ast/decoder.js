// weavepack-ast — decoder (AST documents + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire/tabular/log/graph code.

import {
  CTYPE, OP, PATH_KIND,
  BLOCK_TYPE_NODE, BLOCK_TYPE_MIXED,
  SCHEMA_HASH_BYTES, AST_VERSION, PROFILE_NUM,
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

// ── NID delta-pack column ──────────────────────────────────────────────────

function readNidDeltaColumn(r, count) {
  if (count === 0) return []
  const ids = []
  const first = r.readLEB128Big()
  ids.push(first)
  let prev = first
  for (let i = 1; i < count; i++) {
    const delta = r.readLEB128Big()
    if (delta < 1n) throw new Error("duplicate_element_id: nid delta must be ≥1")
    prev = prev + delta
    ids.push(prev)
  }
  return ids
}

// ── parent_nid nullable column ─────────────────────────────────────────────

function readParentNidColumn(r, numNodes) {
  const nBytes = nullBitmapBytes(numNodes)
  const bitmapBytes = r.readBytes(nBytes)

  const rem = numNodes & 7
  if (rem !== 0) {
    const lastByte = bitmapBytes[nBytes - 1]
    const mask = 0xFF >> rem
    if (lastByte & mask) throw new Error("invalid_null_bitmap: padding bits must be zero")
  }

  const nullFlags = []
  for (let i = 0; i < numNodes; i++) nullFlags.push(getNullBit(bitmapBytes, i) === 1)

  const values = []
  for (let i = 0; i < numNodes; i++) {
    if (nullFlags[i]) {
      values.push(null)
    } else {
      const bytes = r.readBytes(8)
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
      const lo = BigInt(dv.getUint32(0, true))
      const hi = BigInt(dv.getUint32(4, true))
      values.push((hi << 32n) | lo)
    }
  }
  return values
}

// ── child_index column (LEB128 per value) ─────────────────────────────────

function readChildIndexColumn(r, count) {
  const values = []
  for (let i = 0; i < count; i++) values.push(r.readLEB128())
  return values
}

// ── per-row kind column (mixed_block only) ─────────────────────────────────

function readKindColumn(r, count) {
  const values = []
  for (let i = 0; i < count; i++) {
    const len = r.readLEB128()
    values.push(_dec.decode(r.readBytes(len)))
  }
  return values
}

// ── User column schema ─────────────────────────────────────────────────────

function readUserColSchema(r) {
  const colId = r.readLEB128()
  if (colId < 4)
    throw new Error(`reserved_col_id: col_id ${colId} is reserved (must be ≥ 4 for user columns)`)
  const typeByte = r.readByte()
  const ctype    = typeByte & 0xF
  const nullable = ((typeByte >> 4) & 1) === 1
  if (ctype > 15)
    throw new Error(`unknown_ctype: ctype ${ctype} ≥ 16 is reserved`)
  return { colId, ctype, nullable }
}

function readUserColData(r, schema, numElems) {
  if (schema.nullable) {
    return { ...schema, values: readNullableColumn(r, schema.ctype, numElems) }
  } else {
    return { ...schema, values: readValueColumn(r, schema.ctype, numElems) }
  }
}

// ── node_block / mixed_block decoding ─────────────────────────────────────

function readNodeBlockPayload(r, isMixed) {
  const kindLen  = r.readLEB128()
  const kind     = kindLen > 0 ? _dec.decode(r.readBytes(kindLen)) : (isMixed ? null : "")
  const numNodes = r.readLEB128()
  const numCols  = r.readLEB128()

  const schemas  = []
  for (let c = 0; c < numCols; c++) schemas.push(readUserColSchema(r))

  const nids         = readNidDeltaColumn(r, numNodes)
  const parentNids   = readParentNidColumn(r, numNodes)
  const childIndices = readChildIndexColumn(r, numNodes)

  let kinds = null
  if (isMixed) kinds = readKindColumn(r, numNodes)

  const columns = schemas.map(s => readUserColData(r, s, numNodes))

  const block = {
    type: isMixed ? 'mixed' : 'node',
    nids,
    parentNids,
    childIndices,
    columns,
  }
  if (!isMixed) block.kind = kind
  else block.kinds = kinds
  return block
}

// ── AST document header ────────────────────────────────────────────────────

function readDocHeader(r) {
  const version = r.readLEB128()
  if (version !== AST_VERSION)
    throw new Error(`unsupported_version: expected ast_version ${AST_VERSION}, got ${version}`)
  const profileId = r.readLEB128()
  if (profileId !== PROFILE_NUM)
    throw new Error(`wrong_profile: expected profile_id ${PROFILE_NUM}, got ${profileId}`)
  const schemaHash = r.readBytes(SCHEMA_HASH_BYTES)
  return { schemaHash }
}

// ── Public: AST document (snapshot) ───────────────────────────────────────

export function decodeTree(bytes) {
  const r = new ByteReader(bytes)
  const { schemaHash } = readDocHeader(r)
  const numBlocks = r.readLEB128()
  const blocks = []
  for (let i = 0; i < numBlocks; i++) {
    const blockType = r.readByte()
    if (blockType === BLOCK_TYPE_NODE) {
      blocks.push(readNodeBlockPayload(r, false))
    } else if (blockType === BLOCK_TYPE_MIXED) {
      blocks.push(readNodeBlockPayload(r, true))
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
  if (kind >= 8)
    throw new Error(`unknown_path_kind: path kind ${kind} is reserved (must be 0–7)`)
  switch (kind) {
    case PATH_KIND.NODE:
      return { kind, nid: r.readLEB128Big() }
    case PATH_KIND.NODE_COL:
      return { kind, nid: r.readLEB128Big(), colId: r.readLEB128() }
    case PATH_KIND.NODE_KIND: {
      const len = r.readLEB128()
      const nodeKind = _dec.decode(r.readBytes(len))
      return { kind, nodeKind }
    }
    case PATH_KIND.AT_NID:
    case PATH_KIND.AT_PARENT:
    case PATH_KIND.AT_CHILD_INDEX:
    case PATH_KIND.AT_KIND:
      return { kind }
    case PATH_KIND.NODE_PROP: {
      const nid = r.readLEB128Big()
      const len = r.readLEB128()
      const prop = _dec.decode(r.readBytes(len))
      return { kind, nid, prop }
    }
    default:
      throw new Error(`unknown_path_kind: path kind ${kind}`)
  }
}

// ── Op decoding ────────────────────────────────────────────────────────────

function readNodeInsert(r) {
  const blockType = r.readByte()
  const isMixed = blockType === BLOCK_TYPE_MIXED
  if (blockType !== BLOCK_TYPE_NODE && blockType !== BLOCK_TYPE_MIXED)
    throw new Error(`unknown_block_type: block type ${blockType}`)
  const block = readNodeBlockPayload(r, isMixed)
  return { op: OP.NODE_INSERT, block, mixed: isMixed }
}

function readNodeDelete(r) {
  const count = Number(r.readLEB128Big())
  const nids = []
  for (let i = 0; i < count; i++) nids.push(r.readLEB128Big())
  return { op: OP.NODE_DELETE, nids }
}

function readNodeMove(r) {
  const nid          = r.readLEB128Big()
  const newParentNid = r.readLEB128Big()
  const newChildIndex = r.readLEB128()
  return { op: OP.NODE_MOVE, nid, newParentNid, newChildIndex }
}

function readPropSet(r) {
  const path      = readPath(r)
  const ctypeByte = r.readByte()
  const ctype     = ctypeByte & 0xF
  const flagsByte = r.readByte()
  const nullable  = (flagsByte & 1) === 1
  const isNull    = ((flagsByte >> 1) & 1) === 1
  const value     = isNull ? null : readValue(r, ctype)
  return { op: OP.PROP_SET, path, ctype, nullable, isNull, value }
}

function readKindRename(r) {
  const oldLen  = r.readLEB128()
  const oldKind = _dec.decode(r.readBytes(oldLen))
  const newLen  = r.readLEB128()
  const newKind = _dec.decode(r.readBytes(newLen))
  return { op: OP.KIND_RENAME, oldKind, newKind }
}

function readSubtreeReplace(r) {
  const rootNid   = r.readLEB128Big()
  const blockType = r.readByte()
  const isMixed   = blockType === BLOCK_TYPE_MIXED
  if (blockType !== BLOCK_TYPE_NODE && blockType !== BLOCK_TYPE_MIXED)
    throw new Error(`unknown_block_type: block type ${blockType}`)
  const block = readNodeBlockPayload(r, isMixed)
  return { op: OP.SUBTREE_REPLACE, rootNid, block, mixed: isMixed }
}

function readOp(r) {
  const opByte = r.readByte()
  const opCode = opByte & 0x7
  if (opCode > 5)
    throw new Error(`unknown_delta_op: op code ${opCode} is reserved (must be 0–5)`)
  switch (opCode) {
    case OP.NODE_INSERT:     return readNodeInsert(r)
    case OP.NODE_DELETE:     return readNodeDelete(r)
    case OP.NODE_MOVE:       return readNodeMove(r)
    case OP.PROP_SET:        return readPropSet(r)
    case OP.KIND_RENAME:     return readKindRename(r)
    case OP.SUBTREE_REPLACE: return readSubtreeReplace(r)
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
