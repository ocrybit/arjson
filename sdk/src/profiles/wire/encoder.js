// weavepack-wire — encoder (schemaless snapshots + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor profile code.
//
// Binary format summary:
//   byte 0: FLAG_SCHEMALESS (0x00) | FLAG_DELTA (0x01) | FLAG_SCHEMAFUL (0x02)
//
// Schemaless snapshot body:
//   LEB128(field_count)
//   for each field (ascending field_number order):
//     LEB128(field_number)
//     1 byte type_tag  (scalarTag or containerTag)
//     value bytes
//
// Delta chain body:
//   LEB128(op_count)
//   for each op: 1 byte op_code + path bytes + value bytes

import {
  VTYPE, CTYPE, OP, PC,
  FLAG_SCHEMALESS, FLAG_DELTA,
  scalarTag, containerTag, isContainer,
  TAG_MESSAGE, TAG_REPEATED, TAG_MAP, TAG_ONEOF,
  MAX_PAYLOAD_BYTES,
} from "./types.js"

const _enc = new TextEncoder()

// ── ByteWriter ─────────────────────────────────────────────────────────────

class ByteWriter {
  constructor() {
    this._buf = []
  }

  writeByte(b) {
    this._buf.push(b & 0xFF)
  }

  writeBytes(src) {
    for (let i = 0; i < src.length; i++) this._buf.push(src[i] & 0xFF)
  }

  writeLEB128(v) {
    if (typeof v === "bigint") {
      while (v >= 128n) {
        this._buf.push(Number(v & 0x7Fn) | 0x80)
        v >>= 7n
      }
      this._buf.push(Number(v))
    } else {
      v = Math.floor(v) >>> 0
      while (v >= 128) {
        this._buf.push((v & 0x7F) | 0x80)
        v = (v >>> 7)
      }
      this._buf.push(v)
    }
  }

  toBytes() { return new Uint8Array(this._buf) }
}

// ── Scalar encoding ────────────────────────────────────────────────────────

function writeScalar(w, vtype, value) {
  switch (vtype) {
    case VTYPE.BOOL:
      w.writeByte(value ? 1 : 0)
      break
    case VTYPE.INT32: {
      // Two's-complement bit pattern as unsigned LEB128.
      w.writeLEB128((value | 0) >>> 0)
      break
    }
    case VTYPE.INT64: {
      // Caller provides BigInt.
      const bv = BigInt(value)
      const u = bv < 0n ? bv + (1n << 64n) : bv
      w.writeLEB128(u)
      break
    }
    case VTYPE.UINT32:
      w.writeLEB128(value >>> 0)
      break
    case VTYPE.UINT64:
      w.writeLEB128(BigInt(value))
      break
    case VTYPE.SINT32: {
      const v = value | 0
      // Zigzag: small negatives → small positives.
      const z = ((v << 1) ^ (v >> 31)) >>> 0
      w.writeLEB128(z)
      break
    }
    case VTYPE.SINT64: {
      const bv = BigInt(value)
      const z = ((bv << 1n) ^ (bv >> 63n)) & 0xFFFFFFFFFFFFFFFFn
      w.writeLEB128(z)
      break
    }
    case VTYPE.FLOAT32: {
      const tmp = new ArrayBuffer(4)
      new DataView(tmp).setFloat32(0, value, true)
      w.writeBytes(new Uint8Array(tmp))
      break
    }
    case VTYPE.FLOAT64: {
      const tmp = new ArrayBuffer(8)
      new DataView(tmp).setFloat64(0, value, true)
      w.writeBytes(new Uint8Array(tmp))
      break
    }
    case VTYPE.STRING: {
      const utf8 = _enc.encode(value)
      if (utf8.length > MAX_PAYLOAD_BYTES) throw new Error("string exceeds 256 MiB limit")
      w.writeLEB128(utf8.length)
      w.writeBytes(utf8)
      break
    }
    case VTYPE.BYTES: {
      const src = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (src.length > MAX_PAYLOAD_BYTES) throw new Error("bytes exceeds 256 MiB limit")
      w.writeLEB128(src.length)
      w.writeBytes(src)
      break
    }
    case VTYPE.ENUM: {
      // Stored as int32 two's-complement unsigned LEB128.
      w.writeLEB128((value | 0) >>> 0)
      break
    }
    default:
      throw new Error(`unknown vtype ${vtype}`)
  }
}

// ── Path encoding ──────────────────────────────────────────────────────────
//
// Path: sequence of components, each prefixed by 1 byte component-type.
//   0 (PC.FIELD): LEB128 field_number
//   1 (PC.MAP):   1 byte key_type (0=string,1=uint32) + key
//   2 (PC.INDEX): LEB128 index
//   3 (PC.END):   (no payload) — terminates the path
//
// A path of [] (root message) is encoded as just a single END byte.

function writePath(w, path) {
  for (const comp of path) {
    if (comp.field !== undefined) {
      w.writeByte(PC.FIELD)
      w.writeLEB128(comp.field >>> 0)
    } else if (comp.map !== undefined) {
      w.writeByte(PC.MAP)
      if (typeof comp.map === "string") {
        w.writeByte(0)  // string key
        const utf8 = _enc.encode(comp.map)
        w.writeLEB128(utf8.length)
        w.writeBytes(utf8)
      } else {
        w.writeByte(1)  // uint32 key
        w.writeLEB128(comp.map >>> 0)
      }
    } else if (comp.index !== undefined) {
      w.writeByte(PC.INDEX)
      w.writeLEB128(comp.index >>> 0)
    }
  }
  w.writeByte(PC.END)
}

// ── Field/message encoding ─────────────────────────────────────────────────
//
// A field object is one of:
//   {num, vtype, value}                                          — scalar
//   {num, message: Field[]}                                      — nested message
//   {num, repeated: {elemType, values}}                          — repeated scalar
//   {num, map: {keyType, valueType, entries}}                    — map
//     entries: Array of [key, value] pairs
//     keyType: 'string' | 'uint32'
//     valueType: vtype (scalar only in v0.1)
//   {num, oneof: {activeField, valueType, value}}                — oneof

function writeFieldBody(w, field) {
  if (field.message !== undefined) {
    w.writeByte(TAG_MESSAGE)
    writeMessageBody(w, field.message)
  } else if (field.repeated !== undefined) {
    w.writeByte(TAG_REPEATED)
    const { elemType, values } = field.repeated
    w.writeByte(scalarTag(elemType))
    w.writeLEB128(values.length)
    for (const v of values) writeScalar(w, elemType, v)
  } else if (field.map !== undefined) {
    w.writeByte(TAG_MAP)
    const { keyType, valueType, entries } = field.map
    w.writeByte(keyType === "string" ? 0 : 1)
    w.writeByte(scalarTag(valueType))
    w.writeLEB128(entries.length)
    for (const [k, v] of entries) {
      if (keyType === "string") {
        const utf8 = _enc.encode(k)
        w.writeLEB128(utf8.length)
        w.writeBytes(utf8)
      } else {
        w.writeLEB128(k >>> 0)
      }
      writeScalar(w, valueType, v)
    }
  } else if (field.oneof !== undefined) {
    w.writeByte(TAG_ONEOF)
    const { activeField, valueType, value } = field.oneof
    w.writeLEB128(activeField >>> 0)
    w.writeByte(scalarTag(valueType))
    writeScalar(w, valueType, value)
  } else {
    // Scalar
    const { vtype, value } = field
    w.writeByte(scalarTag(vtype))
    writeScalar(w, vtype, value)
  }
}

function writeMessageBody(w, fields) {
  // Sort by field number ascending (canonical form).
  const sorted = [...fields].sort((a, b) => a.num - b.num)
  w.writeLEB128(sorted.length)
  for (const f of sorted) {
    w.writeLEB128(f.num >>> 0)
    writeFieldBody(w, f)
  }
}

// ── Public API: snapshots ──────────────────────────────────────────────────

export function encodeDocument(fields) {
  const w = new ByteWriter()
  w.writeByte(FLAG_SCHEMALESS)
  writeMessageBody(w, fields)
  return w.toBytes()
}

// ── Delta op encoding ──────────────────────────────────────────────────────

function writeOp(w, op) {
  w.writeByte(op.op)
  writePath(w, op.path ?? [])

  switch (op.op) {
    case OP.FIELD_SET:
      // path + type_tag + value
      writeFieldBody(w, { num: 0, ...op.value })
      break
    case OP.FIELD_DELETE:
      // path only (no value)
      break
    case OP.MESSAGE_REPLACE:
      // path + message body
      writeMessageBody(w, op.message)
      break
    case OP.REPEATED_APPEND: {
      const { elemType, values } = op.elements
      w.writeByte(scalarTag(elemType))
      w.writeLEB128(values.length)
      for (const v of values) writeScalar(w, elemType, v)
      break
    }
    case OP.REPEATED_SPLICE: {
      const { index, deleteCount, elemType, insertValues } = op
      w.writeLEB128(index >>> 0)
      w.writeLEB128(deleteCount >>> 0)
      w.writeByte(scalarTag(elemType))
      w.writeLEB128(insertValues.length)
      for (const v of insertValues) writeScalar(w, elemType, v)
      break
    }
    case OP.MAP_SET: {
      const { keyType, key, valueType, value } = op
      w.writeByte(keyType === "string" ? 0 : 1)
      if (keyType === "string") {
        const utf8 = _enc.encode(key)
        w.writeLEB128(utf8.length)
        w.writeBytes(utf8)
      } else {
        w.writeLEB128(key >>> 0)
      }
      w.writeByte(scalarTag(valueType))
      writeScalar(w, valueType, value)
      break
    }
    case OP.MAP_DELETE: {
      const { keyType, key } = op
      w.writeByte(keyType === "string" ? 0 : 1)
      if (keyType === "string") {
        const utf8 = _enc.encode(key)
        w.writeLEB128(utf8.length)
        w.writeBytes(utf8)
      } else {
        w.writeLEB128(key >>> 0)
      }
      break
    }
    case OP.ONEOF_SWITCH: {
      const { activeField, valueType, value } = op
      w.writeLEB128(activeField >>> 0)
      w.writeByte(scalarTag(valueType))
      writeScalar(w, valueType, value)
      break
    }
    default:
      throw new Error(`unknown op ${op.op}`)
  }
}

export function encodeChain(ops) {
  const w = new ByteWriter()
  w.writeByte(FLAG_DELTA)
  w.writeLEB128(ops.length)
  for (const op of ops) writeOp(w, op)
  return w.toBytes()
}
