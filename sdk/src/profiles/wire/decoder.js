// weavepack-wire — decoder (schemaless snapshots + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor profile code.

import {
  VTYPE, CTYPE, OP, PC,
  FLAG_SCHEMALESS, FLAG_DELTA, FLAG_SCHEMAFUL,
  scalarTag, containerTag, isContainer, getVtype, getCtype,
  TAG_MESSAGE, TAG_REPEATED, TAG_MAP, TAG_ONEOF,
  MAX_PAYLOAD_BYTES,
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
    let result = 0
    let shift = 0
    while (true) {
      const b = this.readByte()
      result = result | ((b & 0x7F) << shift)
      shift += 7
      if ((b & 0x80) === 0) break
      if (shift >= 35) throw new Error("LEB128 overflow for uint32")
    }
    return result >>> 0
  }

  readLEB128Big() {
    let result = 0n
    let shift = 0n
    while (true) {
      const b = BigInt(this.readByte())
      result = result | ((b & 0x7Fn) << shift)
      shift += 7n
      if ((b & 0x80n) === 0n) break
      if (shift >= 70n) throw new Error("LEB128 overflow for uint64")
    }
    return result
  }
}

// ── Scalar decoding ────────────────────────────────────────────────────────

function readScalar(r, vtype) {
  switch (vtype) {
    case VTYPE.BOOL:
      return r.readByte() !== 0
    case VTYPE.INT32: {
      const u = r.readLEB128()
      return u > 0x7FFFFFFF ? u - 0x100000000 : u
    }
    case VTYPE.INT64: {
      const u = r.readLEB128Big()
      return u > 0x7FFFFFFFFFFFFFFFn ? u - (1n << 64n) : u
    }
    case VTYPE.UINT32:
      return r.readLEB128()
    case VTYPE.UINT64:
      return r.readLEB128Big()
    case VTYPE.SINT32: {
      const z = r.readLEB128()
      // Undo zigzag.
      return (z >>> 1) ^ -(z & 1)
    }
    case VTYPE.SINT64: {
      const z = r.readLEB128Big()
      return (z >> 1n) ^ -(z & 1n)
    }
    case VTYPE.FLOAT32: {
      const b = r.readBytes(4)
      return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true)
    }
    case VTYPE.FLOAT64: {
      const b = r.readBytes(8)
      return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)
    }
    case VTYPE.STRING: {
      const len = r.readLEB128()
      if (len > MAX_PAYLOAD_BYTES) throw new Error("string exceeds 256 MiB limit")
      const bytes = r.readBytes(len)
      return _dec.decode(bytes)
    }
    case VTYPE.BYTES: {
      const len = r.readLEB128()
      if (len > MAX_PAYLOAD_BYTES) throw new Error("bytes exceeds 256 MiB limit")
      return r.readBytes(len)
    }
    case VTYPE.ENUM: {
      const u = r.readLEB128()
      return u > 0x7FFFFFFF ? u - 0x100000000 : u
    }
    default:
      throw new Error(`unknown vtype ${vtype}`)
  }
}

// ── Path decoding ──────────────────────────────────────────────────────────

function readPath(r) {
  const path = []
  while (true) {
    const compType = r.readByte()
    if (compType === PC.END) break
    if (compType === PC.FIELD) {
      path.push({ field: r.readLEB128() })
    } else if (compType === PC.MAP) {
      const keyTypeByte = r.readByte()
      if (keyTypeByte === 0) {
        const len = r.readLEB128()
        const bytes = r.readBytes(len)
        path.push({ map: _dec.decode(bytes) })
      } else {
        path.push({ map: r.readLEB128() })
      }
    } else if (compType === PC.INDEX) {
      path.push({ index: r.readLEB128() })
    } else {
      throw new Error(`unknown path component type ${compType}`)
    }
  }
  return path
}

// ── Field/message decoding ─────────────────────────────────────────────────

function readFieldBody(r, fieldNum) {
  const tag = r.readByte()
  if (!isContainer(tag)) {
    const vtype = getVtype(tag)
    return { num: fieldNum, vtype, value: readScalar(r, vtype) }
  }
  const ctype = getCtype(tag)
  switch (ctype) {
    case CTYPE.MESSAGE:
      return { num: fieldNum, message: readMessageBody(r) }
    case CTYPE.REPEATED: {
      const elemTag = r.readByte()
      const elemType = getVtype(elemTag)
      const count = r.readLEB128()
      const values = []
      for (let i = 0; i < count; i++) values.push(readScalar(r, elemType))
      return { num: fieldNum, repeated: { elemType, values } }
    }
    case CTYPE.MAP: {
      const keyTypeByte = r.readByte()
      const keyType = keyTypeByte === 0 ? "string" : "uint32"
      const valueTag = r.readByte()
      const valueType = getVtype(valueTag)
      const count = r.readLEB128()
      const entries = []
      for (let i = 0; i < count; i++) {
        let key
        if (keyType === "string") {
          const len = r.readLEB128()
          key = _dec.decode(r.readBytes(len))
        } else {
          key = r.readLEB128()
        }
        entries.push([key, readScalar(r, valueType)])
      }
      return { num: fieldNum, map: { keyType, valueType, entries } }
    }
    case CTYPE.ONEOF: {
      const activeField = r.readLEB128()
      const valueTag = r.readByte()
      const valueType = getVtype(valueTag)
      const value = readScalar(r, valueType)
      return { num: fieldNum, oneof: { activeField, valueType, value } }
    }
    default:
      throw new Error(`unknown ctype ${ctype}`)
  }
}

function readMessageBody(r) {
  const count = r.readLEB128()
  const fields = []
  let lastNum = -1
  for (let i = 0; i < count; i++) {
    const num = r.readLEB128()
    if (num <= lastNum) throw new Error(`field_order_violation: field ${num} after ${lastNum}`)
    lastNum = num
    fields.push(readFieldBody(r, num))
  }
  return fields
}

// ── Public API: snapshots ──────────────────────────────────────────────────

export function decodeDocument(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FLAG_SCHEMALESS) {
    if (flag === FLAG_DELTA)    throw new Error("expected snapshot, got delta chain")
    if (flag === FLAG_SCHEMAFUL) throw new Error("schemaful decoding not yet implemented")
    throw new Error(`unknown document flag 0x${flag.toString(16)}`)
  }
  return readMessageBody(r)
}

// ── Op decoding ────────────────────────────────────────────────────────────

function readOp(r) {
  const opCode = r.readByte()
  const path = readPath(r)

  switch (opCode) {
    case OP.FIELD_SET: {
      const tag = r.readByte()
      if (isContainer(tag)) {
        const ctype = getCtype(tag)
        if (ctype === CTYPE.MESSAGE) {
          const message = readMessageBody(r)
          return { op: opCode, path, value: { message } }
        }
        throw new Error(`container field_set only supports MESSAGE in v0.1`)
      }
      const vtype = getVtype(tag)
      const value = readScalar(r, vtype)
      return { op: opCode, path, value: { vtype, value } }
    }
    case OP.FIELD_DELETE:
      return { op: opCode, path }
    case OP.MESSAGE_REPLACE: {
      const message = readMessageBody(r)
      return { op: opCode, path, message }
    }
    case OP.REPEATED_APPEND: {
      const elemTag = r.readByte()
      const elemType = getVtype(elemTag)
      const count = r.readLEB128()
      const values = []
      for (let i = 0; i < count; i++) values.push(readScalar(r, elemType))
      return { op: opCode, path, elements: { elemType, values } }
    }
    case OP.REPEATED_SPLICE: {
      const index = r.readLEB128()
      const deleteCount = r.readLEB128()
      const elemTag = r.readByte()
      const elemType = getVtype(elemTag)
      const insertCount = r.readLEB128()
      const insertValues = []
      for (let i = 0; i < insertCount; i++) insertValues.push(readScalar(r, elemType))
      return { op: opCode, path, index, deleteCount, elemType, insertValues }
    }
    case OP.MAP_SET: {
      const keyTypeByte = r.readByte()
      const keyType = keyTypeByte === 0 ? "string" : "uint32"
      let key
      if (keyType === "string") {
        const len = r.readLEB128()
        key = _dec.decode(r.readBytes(len))
      } else {
        key = r.readLEB128()
      }
      const valueTag = r.readByte()
      const valueType = getVtype(valueTag)
      const value = readScalar(r, valueType)
      return { op: opCode, path, keyType, key, valueType, value }
    }
    case OP.MAP_DELETE: {
      const keyTypeByte = r.readByte()
      const keyType = keyTypeByte === 0 ? "string" : "uint32"
      let key
      if (keyType === "string") {
        const len = r.readLEB128()
        key = _dec.decode(r.readBytes(len))
      } else {
        key = r.readLEB128()
      }
      return { op: opCode, path, keyType, key }
    }
    case OP.ONEOF_SWITCH: {
      const activeField = r.readLEB128()
      const valueTag = r.readByte()
      const valueType = getVtype(valueTag)
      const value = readScalar(r, valueType)
      return { op: opCode, path, activeField, valueType, value }
    }
    default:
      throw new Error(`unknown op code ${opCode}`)
  }
}

export function decodeChain(bytes) {
  const r = new ByteReader(bytes)
  const flag = r.readByte()
  if (flag !== FLAG_DELTA) throw new Error(`expected delta chain (flag 0x01), got 0x${flag.toString(16)}`)
  const count = r.readLEB128()
  const ops = []
  for (let i = 0; i < count; i++) ops.push(readOp(r))
  return ops
}
