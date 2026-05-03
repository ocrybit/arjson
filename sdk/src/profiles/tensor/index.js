// weavepack-tensor profile — v0.1 (Phase 5.5: schemaful sidecar added).
//
// Wire format discriminant (updated in Phase 5.5):
//
//   bit 0 = 0, bit 1 = 0  →  schemaless document
//   bit 0 = 0, bit 1 = 1  →  schemaful document (256-bit hash + data only)
//   bit 0 = 1              →  delta (op list)
//
// All implementations MUST use the 5.5+ format (2-bit doc prefix, 1-bit
// delta prefix). The pre-5.5 format (1-bit doc prefix, 2-bit delta prefix)
// is retired.
//
// Profile isolation: this file imports ONLY from:
//   - ../../encoder.js  (generic Encoder)
//   - ./types.js        (tensor-specific constants)
//   - ./schema.js       (schema hashing — tensor-only, no JSON profile code)
// It MUST NOT import from sdk/src/profiles/json/*.

import { Encoder } from "../../encoder.js"
import { DTYPE, DTYPE_BITS, DTYPE_BITS_PER_ELEM, OP, OP_BITS, dataBytes, PROFILE_ID, PROFILE_VERSION } from "./types.js"
import { schemaHash, schemaHashHex, canonicalizeSchema } from "./schema.js"
import {
  fp16BitsToF32, f32ToFp16Bits, bf16BitsToF32, f32ToBf16Bits,
  f32ArrayToFp16Bits, fp16BitsToF32Array,
  f32ArrayToBf16Bits, bf16BitsToF32Array,
} from "./half.js"

export { DTYPE, DTYPE_BITS, OP, dataBytes, PROFILE_ID, PROFILE_VERSION }
export { schemaHash, schemaHashHex, canonicalizeSchema }
export {
  fp16BitsToF32, f32ToFp16Bits, bf16BitsToF32, f32ToBf16Bits,
  f32ArrayToFp16Bits, fp16BitsToF32Array,
  f32ArrayToBf16Bits, bf16BitsToF32Array,
}

// ── bit-stream helpers ────────────────────────────────────────────────────

function utf8Bytes(s) {
  return new TextEncoder().encode(s)
}

// LEB128 encoded into dc column (8 bits per group).
function leb128_dc(u, v) {
  while (v >= 128) {
    u.add_dc((v & 0x7f) | 0x80, 8)
    v = Math.floor(v / 128)
  }
  u.add_dc(v, 8)
}

// Variable-length short integer (2-bit prefix + value).
function short_dc(u, v) {
  if (v < 4) {
    u.add_dc(0, 2); u.add_dc(v, 2)
  } else if (v < 8) {
    u.add_dc(1, 2); u.add_dc(v, 3)
  } else if (v < 16) {
    u.add_dc(2, 2); u.add_dc(v, 4)
  } else {
    u.add_dc(3, 2); leb128_dc(u, v)
  }
}

function finalize(u) {
  u.single = false
  u.dcount = 0
  u.rcount = 0
  return u.dump()
}

// ── bool packing ─────────────────────────────────────────────────────────

function packBools(arr) {
  const len = arr.length
  const out = new Uint8Array(Math.ceil(len / 8))
  for (let i = 0; i < len; i++) {
    if (arr[i]) out[i >> 3] |= 1 << (7 - (i & 7))
  }
  return out
}

function packBoolFromTensor(t) {
  let total = 1
  for (const d of t.shape) total *= d
  const data = t.data
  const len = Math.min(total, data.length)
  const out = new Uint8Array(Math.ceil(total / 8))
  for (let i = 0; i < len; i++) {
    if (data[i]) out[i >> 3] |= 1 << (7 - (i & 7))
  }
  return out
}

function unpackBools(bytes, count) {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1
  }
  return out
}

function toBytes(tensor) {
  const d = tensor.data
  if (d instanceof Float32Array || d instanceof Float64Array ||
      d instanceof Int8Array    || d instanceof Uint8Array   ||
      d instanceof Int16Array   || d instanceof Uint16Array  ||
      d instanceof Int32Array   || d instanceof Uint32Array) {
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }
  if (typeof BigInt64Array !== "undefined" &&
      (d instanceof BigInt64Array || d instanceof BigUint64Array)) {
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }
  if (d instanceof ArrayBuffer) return new Uint8Array(d)
  if (Array.isArray(d)) return packBools(d)
  throw new Error("unsupported tensor data type")
}

// Emit raw data block bytes for one tensor into dc.
function emitDataBlock(u, t) {
  const expectedBytes = dataBytes(t.dtype, t.shape)
  let dataView
  if (t.dtype === DTYPE.BOOL) {
    dataView = packBoolFromTensor(t)
  } else if (t.dtype === DTYPE.FP16 || t.dtype === DTYPE.BF16) {
    // Accept either Float32Array (convert) or Uint16Array (raw bits).
    if (t.data instanceof Uint16Array) {
      dataView = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)
    } else if (t.data instanceof Float32Array) {
      const u16 = t.dtype === DTYPE.FP16
        ? f32ArrayToFp16Bits(t.data)
        : f32ArrayToBf16Bits(t.data)
      dataView = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength)
    } else {
      dataView = toBytes(t)
    }
  } else {
    dataView = toBytes(t)
  }
  if (dataView.length < expectedBytes) {
    throw new Error(`tensor data length ${dataView.length} < expected ${expectedBytes}`)
  }
  for (let i = 0; i < expectedBytes; i++) u.add_dc(dataView[i], 8)
}

// Emit tensor name (length-prefixed UTF-8) into dc.
function emitName(u, name) {
  const nameBytes = utf8Bytes(name)
  short_dc(u, nameBytes.length)
  for (let i = 0; i < nameBytes.length; i++) u.add_dc(nameBytes[i], 8)
}

// ── schemaless encode ─────────────────────────────────────────────────────
//
// Wire: [0][0][leb128-count][per tensor: name + dtype + shape + data]

export function encodeDocument(doc) {
  const u = new Encoder()
  u.reset({})
  u.add_dc(0, 1)  // bit 0: document
  u.add_dc(0, 1)  // bit 1: no schema

  const names = Object.keys(doc.tensors)
  leb128_dc(u, names.length)

  for (const name of names) {
    const t = doc.tensors[name]
    emitName(u, name)
    u.add_dc(t.dtype, DTYPE_BITS)
    short_dc(u, t.shape.length)
    for (const dim of t.shape) leb128_dc(u, dim)
    emitDataBlock(u, t)
  }

  return finalize(u)
}

// ── schemaful encode ──────────────────────────────────────────────────────
//
// Wire: [0][1][256-bit hash][per tensor in canonical name order: data only]
//
// schema: { "<name>": { dtype, shape }, ... }
// doc:    { tensors: { "<name>": { dtype, shape, data } } }

export function encodeDocumentSchemaful(doc, schema) {
  const sortedNames = Object.keys(schema).sort()
  const hash = schemaHash(schema)

  const u = new Encoder()
  u.reset({})
  u.add_dc(0, 1)  // bit 0: document
  u.add_dc(1, 1)  // bit 1: schema present

  // Emit 256-bit hash (32 bytes × 8 bits each).
  for (let i = 0; i < 32; i++) u.add_dc(hash[i], 8)

  for (const name of sortedNames) {
    if (!(name in doc.tensors)) {
      throw new Error(`schema requires tensor "${name}" but it is absent from the document`)
    }
    const t = doc.tensors[name]
    const sDef = schema[name]
    if (t.dtype !== sDef.dtype) {
      throw new Error(`tensor "${name}": schema dtype ${sDef.dtype} != document dtype ${t.dtype}`)
    }
    if (!shapesEqual(t.shape, sDef.shape)) {
      throw new Error(`tensor "${name}": schema shape [${sDef.shape}] != document shape [${t.shape}]`)
    }
    emitDataBlock(u, t)
  }

  return finalize(u)
}

// ── schemaless decode ─────────────────────────────────────────────────────

export function decodeDocument(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bitPos = 0

  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      val = (val << 1) | ((u8[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return val
  }
  function readShort() {
    const p = readBits(2)
    if (p === 0) return readBits(2)
    if (p === 1) return readBits(3)
    if (p === 2) return readBits(4)
    return readLeb128()
  }
  function readLeb128() {
    let result = 0, shift = 0, byte
    do {
      byte = readBits(8)
      result += (byte & 0x7f) * Math.pow(2, shift)
      shift += 7
    } while (byte & 0x80)
    return result
  }

  const type = readBits(1)
  if (type !== 0) throw new Error("expected document (bit 0 = 0), got delta (bit 0 = 1)")
  const hasSchema = readBits(1)
  if (hasSchema !== 0) {
    throw new Error("payload is schemaful; use decodeDocumentSchemaful() with a schema registry")
  }

  const tensorCount = readLeb128()
  const tensors = {}

  for (let t = 0; t < tensorCount; t++) {
    const nameLen = readShort()
    const nameBytes = new Uint8Array(nameLen)
    for (let i = 0; i < nameLen; i++) nameBytes[i] = readBits(8)
    const name = new TextDecoder().decode(nameBytes)

    const dtype = readBits(DTYPE_BITS)
    const rank = readShort()
    const shape = []
    for (let r = 0; r < rank; r++) shape.push(readLeb128())

    const byteCount = dataBytes(dtype, shape)
    const dataU8 = new Uint8Array(byteCount)
    for (let i = 0; i < byteCount; i++) dataU8[i] = readBits(8)

    let total = 1
    for (const d of shape) total *= d
    tensors[name] = { dtype, shape, data: materializeData(dtype, dataU8, total) }
  }

  return { tensors }
}

// ── schemaful decode ──────────────────────────────────────────────────────
//
// registry: Map<hex-hash-string, schema-object>
// Throws if the schema-id in the payload is not in the registry.

export function decodeDocumentSchemaful(bytes, registry) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bitPos = 0

  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      val = (val << 1) | ((u8[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return val
  }

  const type = readBits(1)
  if (type !== 0) throw new Error("expected document (bit 0 = 0), got delta")
  const hasSchema = readBits(1)
  if (hasSchema !== 1) {
    throw new Error("payload is schemaless; use decodeDocument() instead")
  }

  // Read 256-bit hash.
  const hashBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) hashBytes[i] = readBits(8)
  const hex = Array.from(hashBytes, b => b.toString(16).padStart(2, "0")).join("")

  const schema = registry.get(hex)
  if (!schema) {
    throw new Error(`unknown schema-id ${hex}; register the schema before decoding`)
  }

  // Verify: the registry entry actually hashes to this id.
  const actualHex = schemaHashHex(schema)
  if (actualHex !== hex) {
    throw new Error(`schema registry entry for ${hex} hashes to ${actualHex}; registry is corrupt`)
  }

  const sortedNames = Object.keys(schema).sort()
  const tensors = {}

  for (const name of sortedNames) {
    const sDef = schema[name]
    const byteCount = dataBytes(sDef.dtype, sDef.shape)
    const dataU8 = new Uint8Array(byteCount)
    for (let i = 0; i < byteCount; i++) dataU8[i] = readBits(8)
    let total = 1
    for (const d of sDef.shape) total *= d
    tensors[name] = { dtype: sDef.dtype, shape: sDef.shape, data: materializeData(sDef.dtype, dataU8, total) }
  }

  return { tensors }
}

// ── delta encoding ────────────────────────────────────────────────────────
//
// Wire: [1][leb128-op-count][ops...]
// Updated from pre-5.5 format ([0][1][leb128...]) to use bit 0 = 1 (delta).

const ELEMENT_SET_DENSITY_THRESHOLD = 0.3

function shapesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function flatToIndex(flat, shape) {
  const idx = new Array(shape.length)
  let remaining = flat
  for (let i = shape.length - 1; i >= 0; i--) {
    idx[i] = remaining % shape[i]
    remaining = Math.floor(remaining / shape[i])
  }
  return idx
}

function findChangedElements(baseT, newT) {
  if (baseT.dtype === DTYPE.BOOL) return null
  let total = 1
  for (const d of baseT.shape) total *= d
  const changed = []
  for (let i = 0; i < total; i++) {
    const differs = (baseT.dtype === DTYPE.FP32 || baseT.dtype === DTYPE.FP64)
      ? baseT.data[i] !== newT.data[i]
      : baseT.data[i] !== newT.data[i]
    if (differs) changed.push({ flat: i, indices: flatToIndex(i, baseT.shape) })
  }
  return changed
}

function computeDelta(baseDoc, newDoc) {
  const ops = []
  const baseTensors = baseDoc.tensors || {}
  const newTensors = newDoc.tensors || {}

  for (const name of Object.keys(baseTensors)) {
    if (!(name in newTensors)) ops.push({ op: OP.TENSOR_REMOVE, name })
  }
  for (const name of Object.keys(newTensors)) {
    if (!(name in baseTensors)) ops.push({ op: OP.TENSOR_ADD, name, ...newTensors[name] })
  }
  for (const name of Object.keys(newTensors)) {
    if (!(name in baseTensors)) continue
    const baseT = baseTensors[name]
    const newT = newTensors[name]
    if (baseT.dtype !== newT.dtype || !shapesEqual(baseT.shape, newT.shape)) {
      ops.push({ op: OP.TENSOR_REMOVE, name })
      ops.push({ op: OP.TENSOR_ADD, name, ...newT })
      continue
    }
    const baseBytes = baseT.dtype === DTYPE.BOOL ? packBoolFromTensor(baseT) : toBytes(baseT)
    const newBytes  = newT.dtype  === DTYPE.BOOL ? packBoolFromTensor(newT)  : toBytes(newT)
    const expected = dataBytes(baseT.dtype, baseT.shape)
    if (bytesEqual(baseBytes.subarray(0, expected), newBytes.subarray(0, expected))) continue

    let total = 1
    for (const d of baseT.shape) total *= d
    const changed = findChangedElements(baseT, newT)
    if (changed && changed.length / total < ELEMENT_SET_DENSITY_THRESHOLD) {
      ops.push({
        op: OP.ELEMENT_SET, name, dtype: newT.dtype, shape: newT.shape,
        elements: changed.map(c => ({ indices: c.indices, value: newT.data[c.flat] })),
      })
    } else {
      ops.push({ op: OP.TENSOR_REPLACE, name, ...newT })
    }
  }

  return ops
}

export function encodeDelta(baseDoc, newDoc) {
  const ops = computeDelta(baseDoc, newDoc)
  if (ops.length === 0) return null

  const u = new Encoder()
  u.reset({})
  u.add_dc(1, 1)  // bit 0: delta

  leb128_dc(u, ops.length)

  for (const op of ops) {
    u.add_dc(op.op, OP_BITS)
    if (op.op === OP.TENSOR_REMOVE) {
      emitName(u, op.name)
    } else if (op.op === OP.TENSOR_REPLACE || op.op === OP.TENSOR_ADD) {
      emitName(u, op.name)
      u.add_dc(op.dtype, DTYPE_BITS)
      short_dc(u, op.shape.length)
      for (const dim of op.shape) leb128_dc(u, dim)
      emitDataBlock(u, op)
    } else if (op.op === OP.ELEMENT_SET) {
      emitName(u, op.name)
      u.add_dc(op.dtype, DTYPE_BITS)
      short_dc(u, op.shape.length)
      for (const dim of op.shape) leb128_dc(u, dim)
      leb128_dc(u, op.elements.length)
      const vb = bytesPerElem(op.dtype)
      for (const elem of op.elements) {
        for (const idx of elem.indices) leb128_dc(u, idx)
        const eb = encodeSingleElement(op.dtype, elem.value)
        for (let b = 0; b < vb; b++) u.add_dc(eb[b], 8)
      }
    } else {
      throw new Error(`unsupported op code ${op.op} (region/quant ops not in v0.1)`)
    }
  }

  return finalize(u)
}

export function applyDelta(baseDoc, deltaBytes) {
  const u8 = deltaBytes instanceof Uint8Array ? deltaBytes : new Uint8Array(deltaBytes)
  let bitPos = 0

  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      val = (val << 1) | ((u8[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return val
  }
  function readShort() {
    const p = readBits(2)
    if (p === 0) return readBits(2)
    if (p === 1) return readBits(3)
    if (p === 2) return readBits(4)
    return readLeb128()
  }
  function readLeb128() {
    let result = 0, shift = 0, byte
    do {
      byte = readBits(8)
      result += (byte & 0x7f) * Math.pow(2, shift)
      shift += 7
    } while (byte & 0x80)
    return result
  }

  const type = readBits(1)
  if (type !== 1) throw new Error("expected delta (bit 0 = 1), got document (bit 0 = 0)")

  const opCount = readLeb128()
  const tensors = { ...(baseDoc.tensors || {}) }

  for (let i = 0; i < opCount; i++) {
    const opCode = readBits(OP_BITS)

    if (opCode === OP.TENSOR_REMOVE) {
      const nameLen = readShort()
      const nb = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nb[j] = readBits(8)
      delete tensors[new TextDecoder().decode(nb)]

    } else if (opCode === OP.TENSOR_REPLACE || opCode === OP.TENSOR_ADD) {
      const nameLen = readShort()
      const nb = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nb[j] = readBits(8)
      const name = new TextDecoder().decode(nb)
      const dtype = readBits(DTYPE_BITS)
      const rank = readShort()
      const shape = []
      for (let r = 0; r < rank; r++) shape.push(readLeb128())
      const bc = dataBytes(dtype, shape)
      const dataU8 = new Uint8Array(bc)
      for (let j = 0; j < bc; j++) dataU8[j] = readBits(8)
      let total = 1
      for (const d of shape) total *= d
      tensors[name] = { dtype, shape, data: materializeData(dtype, dataU8, total) }

    } else if (opCode === OP.ELEMENT_SET) {
      const nameLen = readShort()
      const nb = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nb[j] = readBits(8)
      const name = new TextDecoder().decode(nb)
      const dtype = readBits(DTYPE_BITS)
      const rank = readShort()
      const shape = []
      for (let r = 0; r < rank; r++) shape.push(readLeb128())
      const elemCount = readLeb128()
      if (!(name in tensors)) throw new Error(`element_set on unknown tensor ${name}`)
      const baseT = tensors[name]
      const newData = (baseT.data instanceof Uint8Array) ? new Uint8Array(baseT.data) : baseT.data.slice()
      const vb = bytesPerElem(dtype)
      for (let e = 0; e < elemCount; e++) {
        const idx = []
        for (let r = 0; r < rank; r++) idx.push(readLeb128())
        const eb = new Uint8Array(vb)
        for (let b = 0; b < vb; b++) eb[b] = readBits(8)
        const value = decodeSingleElement(dtype, eb)
        let flat = 0
        for (let r = 0; r < rank; r++) flat = flat * shape[r] + idx[r]
        newData[flat] = value
      }
      tensors[name] = { dtype, shape, data: newData }

    } else {
      throw new Error(`unsupported op code ${opCode} (region/quant ops not in v0.1)`)
    }
  }

  return { tensors }
}

// ── element helpers ───────────────────────────────────────────────────────

function bytesPerElem(dtype) {
  return Math.ceil((DTYPE_BITS_PER_ELEM[dtype] || 0) / 8)
}

function encodeSingleElement(dtype, value) {
  const buf = new ArrayBuffer(bytesPerElem(dtype))
  const view = new DataView(buf)
  switch (dtype) {
    case DTYPE.FP32:   view.setFloat32(0, value, true); break
    case DTYPE.FP64:   view.setFloat64(0, value, true); break
    case DTYPE.INT8:   view.setInt8(0, value); break
    case DTYPE.UINT8:  view.setUint8(0, value); break
    case DTYPE.INT16:  view.setInt16(0, value, true); break
    case DTYPE.UINT16: view.setUint16(0, value, true); break
    case DTYPE.INT32:  view.setInt32(0, value, true); break
    case DTYPE.UINT32: view.setUint32(0, value, true); break
    case DTYPE.INT64:  view.setBigInt64(0, BigInt(value), true); break
    case DTYPE.UINT64: view.setBigUint64(0, BigInt(value), true); break
    default: throw new Error(`element_set not supported for dtype ${dtype}`)
  }
  return new Uint8Array(buf)
}

function decodeSingleElement(dtype, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (dtype) {
    case DTYPE.FP32:   return view.getFloat32(0, true)
    case DTYPE.FP64:   return view.getFloat64(0, true)
    case DTYPE.INT8:   return view.getInt8(0)
    case DTYPE.UINT8:  return view.getUint8(0)
    case DTYPE.INT16:  return view.getInt16(0, true)
    case DTYPE.UINT16: return view.getUint16(0, true)
    case DTYPE.INT32:  return view.getInt32(0, true)
    case DTYPE.UINT32: return view.getUint32(0, true)
    case DTYPE.INT64:  return view.getBigInt64(0, true)
    case DTYPE.UINT64: return view.getBigUint64(0, true)
    default: throw new Error(`element_set not supported for dtype ${dtype}`)
  }
}

function materializeData(dtype, dataU8, total) {
  switch (dtype) {
    case DTYPE.FP32:   return new Float32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.FP64:   return new Float64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT8:   return new Int8Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT8:  return dataU8
    case DTYPE.INT16:  return new Int16Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT16: return new Uint16Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT32:  return new Int32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT32: return new Uint32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT64:  return new BigInt64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT64: return new BigUint64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.BOOL:   return unpackBools(dataU8, total)
    case DTYPE.FP16:
    case DTYPE.BF16: {
      // Decode raw 16-bit bits to a Uint16Array view. Callers wanting
      // f32 values use fp16BitsToF32Array / bf16BitsToF32Array. We
      // return raw bits to preserve bit-exact round-trip; lossy f32
      // conversion is opt-in.
      // Copy the bytes (don't share) because dataU8 may be a slice
      // not aligned for Uint16Array.
      const copy = new Uint8Array(dataU8.buffer.slice(dataU8.byteOffset, dataU8.byteOffset + total * 2))
      return new Uint16Array(copy.buffer, 0, total)
    }
    default:           return dataU8
  }
}

// ── TensorPack high-level API ─────────────────────────────────────────────

function chainSerialize(deltas) {
  let total = 0
  const lenBytes = []
  for (const d of deltas) {
    let len = d.length
    const bytes = []
    while (len >= 128) { bytes.push((len & 0x7f) | 0x80); len = Math.floor(len / 128) }
    bytes.push(len)
    lenBytes.push(bytes)
    total += bytes.length + d.length
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (let i = 0; i < deltas.length; i++) {
    for (const b of lenBytes[i]) buf[off++] = b
    buf.set(deltas[i], off); off += deltas[i].length
  }
  return buf
}

function chainParse(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let off = 0
  const deltas = []
  while (off < u8.length) {
    let len = 0, shift = 0, byte
    do { byte = u8[off++]; len += (byte & 0x7f) * Math.pow(2, shift); shift += 7 } while (byte & 0x80)
    deltas.push(u8.slice(off, off + len)); off += len
  }
  return deltas
}

export class TensorPack {
  constructor({ json, arj }) {
    if (arj) {
      const u8 = arj instanceof Uint8Array ? arj : new Uint8Array(arj)
      const deltas = chainParse(u8)
      let doc = decodeDocument(deltas[0])
      for (let i = 1; i < deltas.length; i++) doc = applyDelta(doc, deltas[i])
      this.json = doc
      this.deltas = deltas
    } else if (json) {
      this.json = json
      this.deltas = [encodeDocument(json)]
    } else {
      throw new Error("TensorPack requires either { json } or { arj }")
    }
  }

  update(newDoc) {
    const deltaBytes = encodeDelta(this.json, newDoc)
    if (deltaBytes === null) return []
    this.json = applyDelta(this.json, deltaBytes)
    this.deltas.push(deltaBytes)
    return [deltaBytes]
  }

  toBuffer() { return chainSerialize(this.deltas) }
}
