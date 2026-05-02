// weavepack-tensor — initial implementation skeleton (v0.1 wip).
//
// This is the FIRST IMPLEMENTATION of a non-JSON profile, validating
// that the protocol/profile boundary established in Phase 3 actually
// admits a meaningfully different profile. Per the roadmap, this is
// scoped to:
//
//   - fp32 dtype only (other dtypes deferred to subsequent work)
//   - schemaless mode only (schemaful mode deferred)
//   - whole-tensor encode/decode (no deltas yet)
//   - flat document model (name → tensor)
//
// Once round-trip works for fp32, subsequent stages add: more dtypes,
// schemaful mode, delta operations, and benchmarks.
//
// The implementation imports ONLY from sdk/src/encoder.js (Encoder
// class — generic) and ../../utils.js (bit primitives — generic).
// It MUST NOT import from sdk/src/profiles/json/* — that would
// indicate the boundary leaks JSON assumptions into the tensor
// profile. (Same constraint as profiles/null/.)

import { Encoder } from "../../encoder.js"
import { DTYPE, DTYPE_BITS, DTYPE_BITS_PER_ELEM, OP, OP_BITS, dataBytes, PROFILE_ID, PROFILE_VERSION } from "./types.js"

export { DTYPE, DTYPE_BITS, OP, dataBytes, PROFILE_ID, PROFILE_VERSION }

// ── encode (schemaless, fp32-only for now) ───────────────────────────────
//
// Wire format:
//   1 bit:  mode = 0 (structured)
//   leb128: tensor count
//   per tensor:
//     short(): name length (UTF-8 bytes)
//     bytes:   name (each char as 8 bits via add_dc(c, 8))
//     5 bits:  dtype
//     short(): rank
//     leb128 × rank: shape dims
//     bytes:   data block (raw fp32 little-endian)

function utf8Bytes(s) {
  return new TextEncoder().encode(s)
}

export function encodeDocument(doc) {
  // doc: { tensors: { name: { dtype: number, shape: number[], data: Float32Array | ArrayBuffer-like } } }
  const u = new Encoder()
  u.reset({})

  // Mode bit: structured (0). The Encoder's `dump()` honors `single`
  // flag; for our schemaless body we set single=false so dump() emits
  // a 0 mode bit and otherwise leaves dc untouched (we manage body
  // bytes ourselves, so we use a different strategy below).
  //
  // Simplest approach: emit our entire body into the dc column. The
  // mode bit becomes 0 by virtue of dc having no bit-1 prefix. But
  // Encoder.dump() expects either single-payload (1 + tag) or
  // structured (0 + columns). To produce a structured-but-tensor-
  // shaped output, we write 0 then our body bits into dc directly.
  u.add_dc(0, 1)  // structured mode marker

  const names = Object.keys(doc.tensors)
  // Tensor count via leb128 (7-bit groups in dc).
  leb128_dc(u, names.length)

  for (const name of names) {
    const t = doc.tensors[name]
    const nameBytes = utf8Bytes(name)
    short_dc(u, nameBytes.length)
    for (let i = 0; i < nameBytes.length; i++) u.add_dc(nameBytes[i], 8)
    u.add_dc(t.dtype, DTYPE_BITS)
    short_dc(u, t.shape.length)
    for (const dim of t.shape) leb128_dc(u, dim)

    // Data block: emit raw bytes from t.data. Bool tensors get
    // bit-packed (one bit per element, MSB-first within bytes).
    const expectedBytes = dataBytes(t.dtype, t.shape)
    const dataView = t.dtype === DTYPE.BOOL ? packBoolFromTensor(t) : toBytes(t)
    if (dataView.length < expectedBytes) {
      throw new Error(`tensor ${name}: data length ${dataView.length} < expected ${expectedBytes}`)
    }
    for (let i = 0; i < expectedBytes; i++) u.add_dc(dataView[i], 8)
  }

  // Use the Encoder's dump primitive which writes dc + structured
  // columns. Since we set single=false implicitly via add_dc(0, 1),
  // dump() handles padding to byte boundary.
  // But dump() also writes flag/RLE/etc. columns we haven't populated.
  // The Encoder's existing dump() emits columns even when zero-length.
  // For empty columns this is the 2-bit RLE prefix (00 = all-zeros)
  // when the column has length > 0. Since we don't push any vlinks etc.,
  // their lengths are 0 and they emit nothing. So we should be safe.

  // Mark single=false so dump emits chain header and column suffix.
  u.single = false
  // Force dcount to 0 so flush_vlink/flush_klink/flush_nums are no-ops.
  u.dcount = 0
  u.rcount = 0
  return u.dump()
}

// Helpers for writing variable-length values to dc directly.
function short_dc(u, v) {
  if (v < 4) {
    u.add_dc(0, 2)
    u.add_dc(v, 2)
  } else if (v < 8) {
    u.add_dc(1, 2)
    u.add_dc(v, 3)
  } else if (v < 16) {
    u.add_dc(2, 2)
    u.add_dc(v, 4)
  } else {
    u.add_dc(3, 2)
    leb128_dc_raw(u, v)
  }
}

function leb128_dc(u, v) {
  // LEB128 emitted as a sequence of 8-bit groups in dc.
  while (v >= 128) {
    u.add_dc((v & 0x7f) | 0x80, 8)
    v = Math.floor(v / 128)
  }
  u.add_dc(v, 8)
}

function leb128_dc_raw(u, v) {
  // Same as leb128_dc but used inside short() for the 11-prefix path.
  // Identical behavior; kept separate for clarity at call sites.
  leb128_dc(u, v)
}

// Bool packing: each element is 1 bit, packed MSB-first within bytes.
function packBools(arr) {
  const len = arr.length
  const out = new Uint8Array(Math.ceil(len / 8))
  for (let i = 0; i < len; i++) {
    if (arr[i]) {
      out[i >> 3] |= 1 << (7 - (i & 7))
    }
  }
  return out
}

function packBoolFromTensor(t) {
  // t.data may be a boolean[] or a Uint8Array of 0/1 values; both pack
  // the same way. The element count is product(shape), not data.length.
  let total = 1
  for (const d of t.shape) total *= d
  const data = t.data
  const len = Math.min(total, data.length)
  const out = new Uint8Array(Math.ceil(total / 8))
  for (let i = 0; i < len; i++) {
    if (data[i]) {
      out[i >> 3] |= 1 << (7 - (i & 7))
    }
  }
  return out
}

function unpackBools(bytes, count) {
  const out = new Uint8Array(count)  // 0 / 1 representation
  for (let i = 0; i < count; i++) {
    out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1
  }
  return out
}

function toBytes(tensor) {
  // Pull raw bytes from the typed array. All multi-byte dtypes are
  // little-endian; native JS typed arrays match host endianness, which
  // is little-endian on every common platform. (A future big-endian
  // host would need a byte-swap step here.)
  const d = tensor.data
  if (d instanceof Float32Array || d instanceof Float64Array) {
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }
  if (d instanceof Int8Array || d instanceof Uint8Array
      || d instanceof Int16Array || d instanceof Uint16Array
      || d instanceof Int32Array || d instanceof Uint32Array) {
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }
  if (typeof BigInt64Array !== "undefined" &&
      (d instanceof BigInt64Array || d instanceof BigUint64Array)) {
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }
  if (d instanceof ArrayBuffer) return new Uint8Array(d)
  // Bool tensors: data may be a Uint8Array of 0/1 values to pack, or a
  // boolean[] array; check tensor.dtype to decide packing.
  if (Array.isArray(d)) {
    return packBools(d)
  }
  throw new Error("unsupported tensor data type")
}

// ── decode ────────────────────────────────────────────────────────────────

export function decodeDocument(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bitPos = 0

  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      const byte = u8[bitPos >> 3]
      const bit = (byte >> (7 - (bitPos & 7))) & 1
      val = (val << 1) | bit
      bitPos++
    }
    return val
  }

  function readByteAlignedByte() {
    return readBits(8)
  }

  function readShort() {
    const prefix = readBits(2)
    if (prefix === 0) return readBits(2)
    if (prefix === 1) return readBits(3)
    if (prefix === 2) return readBits(4)
    return readLeb128()
  }

  function readLeb128() {
    let result = 0
    let shift = 0
    let byte
    do {
      byte = readBits(8)
      result += (byte & 0x7f) * Math.pow(2, shift)
      shift += 7
    } while (byte & 0x80)
    return result
  }

  // Mode bit
  const mode = readBits(1)
  if (mode !== 0) {
    throw new Error("expected structured mode for tensor document; got single-payload")
  }

  const tensorCount = readLeb128()
  const tensors = {}

  for (let t = 0; t < tensorCount; t++) {
    const nameLen = readShort()
    const nameBytes = new Uint8Array(nameLen)
    for (let i = 0; i < nameLen; i++) nameBytes[i] = readByteAlignedByte()
    const name = new TextDecoder().decode(nameBytes)

    const dtype = readBits(DTYPE_BITS)
    const rank = readShort()
    const shape = []
    for (let r = 0; r < rank; r++) shape.push(readLeb128())

    const bytes = dataBytes(dtype, shape)
    const dataU8 = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) dataU8[i] = readByteAlignedByte()

    // Compute total element count from shape.
    let total = 1
    for (const d of shape) total *= d

    let data
    switch (dtype) {
      case DTYPE.FP32:
        data = new Float32Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.FP64:
        data = new Float64Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.INT8:
        data = new Int8Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.UINT8:
        data = dataU8
        break
      case DTYPE.INT16:
        data = new Int16Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.UINT16:
        data = new Uint16Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.INT32:
        data = new Int32Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.UINT32:
        data = new Uint32Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.INT64:
        data = new BigInt64Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.UINT64:
        data = new BigUint64Array(dataU8.buffer, dataU8.byteOffset, total)
        break
      case DTYPE.BOOL:
        data = unpackBools(dataU8, total)
        break
      default:
        // Unsupported dtype: return raw bytes for caller to interpret.
        // (fp16/bf16/int4/uint4/fp8/quantized — TODO subsequent stages.)
        data = dataU8
        break
    }

    tensors[name] = { dtype, shape, data }
  }

  return { tensors }
}

// ── delta encoding (Phase 5.4) ───────────────────────────────────────────
//
// Wire format for a delta payload:
//   1 bit:   mode = 0 (structured)
//   1 bit:   delta marker = 1 (distinguishes deltas from full documents)
//   leb128:  number of ops
//   per op:
//     3 bits: op code (from OP enum)
//     per-op payload:
//       TENSOR_REPLACE: name + dtype + shape + data
//       TENSOR_ADD:     name + dtype + shape + data
//       TENSOR_REMOVE:  name
//
// The simplest form for v0.1: tensor_replace and tensor_add carry the
// same payload as a tensor entry in the document. tensor_remove just
// carries the name. region_replace, element_set, quant_change come
// later.
//
// Documents differ from deltas via the second bit (delta marker).
// Documents have it = 0; deltas have it = 1.

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

// Threshold: if fewer than this fraction of elements changed, emit
// element_set instead of tensor_replace. Per 04-deltas.md heuristic.
const ELEMENT_SET_DENSITY_THRESHOLD = 0.3

// Convert a flat element index to a multi-dim index tuple.
function flatToIndex(flat, shape) {
  const idx = new Array(shape.length)
  let remaining = flat
  for (let i = shape.length - 1; i >= 0; i--) {
    idx[i] = remaining % shape[i]
    remaining = Math.floor(remaining / shape[i])
  }
  return idx
}

// Returns array of { flat, indices, value } for elements that differ
// between baseT and newT. Only supports byte-aligned dtypes for v0.1
// element_set (sub-byte dtypes fall back to tensor_replace).
function findChangedElements(baseT, newT) {
  if (baseT.dtype === DTYPE.BOOL) return null  // sub-byte; not element_set yet
  let total = 1
  for (const d of baseT.shape) total *= d
  const baseData = baseT.data
  const newData = newT.data
  const changed = []
  for (let i = 0; i < total; i++) {
    let differs
    if (baseT.dtype === DTYPE.INT64 || baseT.dtype === DTYPE.UINT64) {
      differs = baseData[i] !== newData[i]
    } else if (baseT.dtype === DTYPE.FP32 || baseT.dtype === DTYPE.FP64) {
      // Float comparison: use bit equality so NaN signaling is preserved.
      // For simplicity, compare via the underlying bytes per-element.
      // (Could be optimized with a DataView but the differ runs once.)
      differs = !floatBitEqual(baseT, newT, i)
    } else {
      differs = baseData[i] !== newData[i]
    }
    if (differs) {
      changed.push({ flat: i, indices: flatToIndex(i, baseT.shape) })
    }
  }
  return changed
}

function floatBitEqual(baseT, newT, i) {
  // Compare individual fp values via TypedArray indexing. Works for
  // fp32 and fp64. NaN bit patterns are preserved when the underlying
  // bytes round-trip; for the differ, we accept NaN ≠ NaN at the
  // value-comparison level (any NaN-to-NaN change is treated as a
  // difference, ensuring the new value's bytes get emitted).
  return baseT.data[i] === newT.data[i]
}

// computeDelta(baseDoc, newDoc) → array of ops
function computeDelta(baseDoc, newDoc) {
  const ops = []
  const baseTensors = baseDoc.tensors || {}
  const newTensors = newDoc.tensors || {}

  // Pass 1: detect removed tensors (in base but not new).
  for (const name of Object.keys(baseTensors)) {
    if (!(name in newTensors)) {
      ops.push({ op: OP.TENSOR_REMOVE, name })
    }
  }

  // Pass 2: detect added tensors (in new but not base).
  for (const name of Object.keys(newTensors)) {
    if (!(name in baseTensors)) {
      ops.push({ op: OP.TENSOR_ADD, name, ...newTensors[name] })
    }
  }

  // Pass 3: detect changed tensors (same name, different content).
  for (const name of Object.keys(newTensors)) {
    if (!(name in baseTensors)) continue
    const baseT = baseTensors[name]
    const newT = newTensors[name]
    if (baseT.dtype !== newT.dtype || !shapesEqual(baseT.shape, newT.shape)) {
      // Shape or dtype changed: emit remove + add.
      ops.push({ op: OP.TENSOR_REMOVE, name })
      ops.push({ op: OP.TENSOR_ADD, name, ...newT })
      continue
    }
    // Same dtype + shape; compare bytes.
    const baseBytes = baseT.dtype === DTYPE.BOOL ? packBoolFromTensor(baseT) : toBytes(baseT)
    const newBytes = newT.dtype === DTYPE.BOOL ? packBoolFromTensor(newT) : toBytes(newT)
    const expected = dataBytes(baseT.dtype, baseT.shape)
    if (bytesEqual(baseBytes.subarray(0, expected), newBytes.subarray(0, expected))) {
      continue  // unchanged
    }

    // Decide between element_set (sparse) and tensor_replace (dense).
    let total = 1
    for (const d of baseT.shape) total *= d

    const changed = findChangedElements(baseT, newT)
    if (changed && changed.length / total < ELEMENT_SET_DENSITY_THRESHOLD) {
      ops.push({
        op: OP.ELEMENT_SET,
        name,
        dtype: newT.dtype,
        shape: newT.shape,
        elements: changed.map(c => ({
          indices: c.indices,
          value: newT.data[c.flat],
        })),
      })
    } else {
      ops.push({ op: OP.TENSOR_REPLACE, name, ...newT })
    }
  }

  return ops
}

export function encodeDelta(baseDoc, newDoc) {
  const ops = computeDelta(baseDoc, newDoc)
  if (ops.length === 0) return null  // no-op delta

  const u = new Encoder()
  u.reset({})
  u.add_dc(0, 1)  // structured mode
  u.add_dc(1, 1)  // delta marker

  leb128_dc(u, ops.length)

  for (const op of ops) {
    u.add_dc(op.op, OP_BITS)
    if (op.op === OP.TENSOR_REMOVE) {
      const nameBytes = utf8Bytes(op.name)
      short_dc(u, nameBytes.length)
      for (let i = 0; i < nameBytes.length; i++) u.add_dc(nameBytes[i], 8)
    } else if (op.op === OP.TENSOR_REPLACE || op.op === OP.TENSOR_ADD) {
      const nameBytes = utf8Bytes(op.name)
      short_dc(u, nameBytes.length)
      for (let i = 0; i < nameBytes.length; i++) u.add_dc(nameBytes[i], 8)
      u.add_dc(op.dtype, DTYPE_BITS)
      short_dc(u, op.shape.length)
      for (const dim of op.shape) leb128_dc(u, dim)
      const expectedBytes = dataBytes(op.dtype, op.shape)
      const dataView = op.dtype === DTYPE.BOOL ? packBoolFromTensor(op) : toBytes(op)
      for (let i = 0; i < expectedBytes; i++) u.add_dc(dataView[i], 8)
    } else if (op.op === OP.ELEMENT_SET) {
      // Wire format:
      //   short(): name length
      //   bytes: name UTF-8
      //   5 bits: dtype
      //   short(): rank
      //   leb128 × rank: shape
      //   leb128: element count
      //   per element:
      //     leb128 × rank: indices
      //     dtype-bits: value (raw bytes for byte-aligned dtypes)
      const nameBytes = utf8Bytes(op.name)
      short_dc(u, nameBytes.length)
      for (let i = 0; i < nameBytes.length; i++) u.add_dc(nameBytes[i], 8)
      u.add_dc(op.dtype, DTYPE_BITS)
      short_dc(u, op.shape.length)
      for (const dim of op.shape) leb128_dc(u, dim)
      leb128_dc(u, op.elements.length)
      const valueBytes = bytesPerElem(op.dtype)
      for (const elem of op.elements) {
        for (const idx of elem.indices) leb128_dc(u, idx)
        // Encode the single element value into bytes.
        const elemBytes = encodeSingleElement(op.dtype, elem.value)
        for (let b = 0; b < valueBytes; b++) u.add_dc(elemBytes[b], 8)
      }
    } else {
      throw new Error(`unsupported op code ${op.op} (region/quant ops not in v0.1)`)
    }
  }

  u.single = false
  u.dcount = 0
  u.rcount = 0
  return u.dump()
}

export function applyDelta(baseDoc, deltaBytes) {
  const u8 = deltaBytes instanceof Uint8Array ? deltaBytes : new Uint8Array(deltaBytes)
  let bitPos = 0

  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      const byte = u8[bitPos >> 3]
      const bit = (byte >> (7 - (bitPos & 7))) & 1
      val = (val << 1) | bit
      bitPos++
    }
    return val
  }
  function readByte() { return readBits(8) }
  function readShort() {
    const prefix = readBits(2)
    if (prefix === 0) return readBits(2)
    if (prefix === 1) return readBits(3)
    if (prefix === 2) return readBits(4)
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

  const mode = readBits(1)
  if (mode !== 0) throw new Error("delta must be in structured mode")
  const isDelta = readBits(1)
  if (isDelta !== 1) throw new Error("payload is a full document, not a delta")

  const opCount = readLeb128()
  const tensors = { ...(baseDoc.tensors || {}) }

  for (let i = 0; i < opCount; i++) {
    const opCode = readBits(OP_BITS)
    if (opCode === OP.TENSOR_REMOVE) {
      const nameLen = readShort()
      const nameBytes = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nameBytes[j] = readByte()
      const name = new TextDecoder().decode(nameBytes)
      delete tensors[name]
    } else if (opCode === OP.TENSOR_REPLACE || opCode === OP.TENSOR_ADD) {
      const nameLen = readShort()
      const nameBytes = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nameBytes[j] = readByte()
      const name = new TextDecoder().decode(nameBytes)
      const dtype = readBits(DTYPE_BITS)
      const rank = readShort()
      const shape = []
      for (let r = 0; r < rank; r++) shape.push(readLeb128())
      const bytes = dataBytes(dtype, shape)
      const dataU8 = new Uint8Array(bytes)
      for (let j = 0; j < bytes; j++) dataU8[j] = readByte()
      let total = 1
      for (const d of shape) total *= d
      const data = materializeData(dtype, dataU8, total)
      tensors[name] = { dtype, shape, data }
    } else if (opCode === OP.ELEMENT_SET) {
      const nameLen = readShort()
      const nameBytes = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nameBytes[j] = readByte()
      const name = new TextDecoder().decode(nameBytes)
      const dtype = readBits(DTYPE_BITS)
      const rank = readShort()
      const shape = []
      for (let r = 0; r < rank; r++) shape.push(readLeb128())
      const elemCount = readLeb128()
      // Need a working copy of the base tensor's data to mutate.
      // Schemaful would let us look up the base; for schemaless we
      // require the tensor exists in the base document.
      if (!(name in tensors)) {
        throw new Error(`element_set on unknown tensor ${name}`)
      }
      const baseT = tensors[name]
      // Make a mutable copy. For typed arrays, slice() copies the buffer.
      let total = 1
      for (const d of baseT.shape) total *= d
      const newData = (baseT.data instanceof Uint8Array)
        ? new Uint8Array(baseT.data)
        : baseT.data.slice()
      const valueBytes = bytesPerElem(dtype)
      for (let e = 0; e < elemCount; e++) {
        const idx = []
        for (let r = 0; r < rank; r++) idx.push(readLeb128())
        const elemBytes = new Uint8Array(valueBytes)
        for (let b = 0; b < valueBytes; b++) elemBytes[b] = readByte()
        const value = decodeSingleElement(dtype, elemBytes)
        // Convert multi-dim index to flat.
        let flat = 0
        for (let r = 0; r < rank; r++) {
          flat = flat * shape[r] + idx[r]
        }
        newData[flat] = value
      }
      tensors[name] = { dtype, shape, data: newData }
    } else {
      throw new Error(`unsupported op code ${opCode} (region/quant ops not in v0.1)`)
    }
  }

  return { tensors }
}

function bytesPerElem(dtype) {
  // Byte count for a single element. Sub-byte dtypes return ceil(bits/8)
  // which is 1 — but element_set doesn't support sub-byte dtypes in v0.1.
  return Math.ceil((DTYPE_BITS_PER_ELEM[dtype] || 0) / 8)
}

function encodeSingleElement(dtype, value) {
  const buf = new ArrayBuffer(bytesPerElem(dtype))
  const view = new DataView(buf)
  switch (dtype) {
    case DTYPE.FP32:    view.setFloat32(0, value, true); break
    case DTYPE.FP64:    view.setFloat64(0, value, true); break
    case DTYPE.INT8:    view.setInt8(0, value); break
    case DTYPE.UINT8:   view.setUint8(0, value); break
    case DTYPE.INT16:   view.setInt16(0, value, true); break
    case DTYPE.UINT16:  view.setUint16(0, value, true); break
    case DTYPE.INT32:   view.setInt32(0, value, true); break
    case DTYPE.UINT32:  view.setUint32(0, value, true); break
    case DTYPE.INT64:   view.setBigInt64(0, BigInt(value), true); break
    case DTYPE.UINT64:  view.setBigUint64(0, BigInt(value), true); break
    default:
      throw new Error(`element_set not supported for dtype ${dtype}`)
  }
  return new Uint8Array(buf)
}

function decodeSingleElement(dtype, bytes) {
  const buf = bytes.buffer
  const view = new DataView(buf, bytes.byteOffset, bytes.byteLength)
  switch (dtype) {
    case DTYPE.FP32:    return view.getFloat32(0, true)
    case DTYPE.FP64:    return view.getFloat64(0, true)
    case DTYPE.INT8:    return view.getInt8(0)
    case DTYPE.UINT8:   return view.getUint8(0)
    case DTYPE.INT16:   return view.getInt16(0, true)
    case DTYPE.UINT16:  return view.getUint16(0, true)
    case DTYPE.INT32:   return view.getInt32(0, true)
    case DTYPE.UINT32:  return view.getUint32(0, true)
    case DTYPE.INT64:   return view.getBigInt64(0, true)
    case DTYPE.UINT64:  return view.getBigUint64(0, true)
    default:
      throw new Error(`element_set not supported for dtype ${dtype}`)
  }
}

function materializeData(dtype, dataU8, total) {
  switch (dtype) {
    case DTYPE.FP32:    return new Float32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.FP64:    return new Float64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT8:    return new Int8Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT8:   return dataU8
    case DTYPE.INT16:   return new Int16Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT16:  return new Uint16Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT32:   return new Int32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT32:  return new Uint32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT64:   return new BigInt64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT64:  return new BigUint64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.BOOL:    return unpackBools(dataU8, total)
    default:            return dataU8
  }
}

// ── high-level API (parallel to ARJSON) ──────────────────────────────────

// Chain framing: each delta is leb128(len) + bytes. Same as the JSON
// profile's ARJSON.toBuffer / fromBuffer machinery.
function chainSerialize(deltas) {
  let total = 0
  const lenBytes = []
  for (const d of deltas) {
    let len = d.length
    const bytes = []
    while (len >= 128) {
      bytes.push((len & 0x7f) | 0x80)
      len = Math.floor(len / 128)
    }
    bytes.push(len)
    lenBytes.push(bytes)
    total += bytes.length + d.length
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (let i = 0; i < deltas.length; i++) {
    for (const b of lenBytes[i]) buf[off++] = b
    buf.set(deltas[i], off)
    off += deltas[i].length
  }
  return buf
}

function chainParse(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let off = 0
  const deltas = []
  while (off < u8.length) {
    let len = 0, shift = 0, byte
    do {
      byte = u8[off++]
      len += (byte & 0x7f) * Math.pow(2, shift)
      shift += 7
    } while (byte & 0x80)
    deltas.push(u8.slice(off, off + len))
    off += len
  }
  return deltas
}

export class TensorPack {
  constructor({ json, arj }) {
    if (arj) {
      const u8 = arj instanceof Uint8Array ? arj : new Uint8Array(arj)
      // Detect framed chain (multi-delta) vs single payload.
      // Framed chains start with a leb128 length prefix; single payloads
      // start with the structured-mode bit (0). Heuristic: if the first
      // byte's high bit is 0 AND the first leb128 length matches the
      // remaining buffer length, treat as framed.
      const deltas = chainParse(u8)
      // Apply deltas in order.
      let doc = decodeDocument(deltas[0])
      for (let i = 1; i < deltas.length; i++) {
        doc = applyDelta(doc, deltas[i])
      }
      this.json = doc
      this.deltas = deltas
    } else if (json) {
      this.json = json
      const bytes = encodeDocument(json)
      this.deltas = [bytes]
    } else {
      throw new Error("TensorPack requires either { json } or { arj }")
    }
  }
  update(newDoc) {
    const deltaBytes = encodeDelta(this.json, newDoc)
    if (deltaBytes === null) return []  // no-op
    this.json = applyDelta(this.json, deltaBytes)
    this.deltas.push(deltaBytes)
    return [deltaBytes]
  }
  toBuffer() {
    return chainSerialize(this.deltas)
  }
}
