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
import { DTYPE, DTYPE_BITS, DTYPE_BITS_PER_ELEM, dataBytes, PROFILE_ID, PROFILE_VERSION } from "./types.js"

export { DTYPE, DTYPE_BITS, dataBytes, PROFILE_ID, PROFILE_VERSION }

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

// ── high-level API (parallel to ARJSON) ──────────────────────────────────

export class TensorPack {
  constructor({ json, arj }) {
    if (arj) {
      this.json = decodeDocument(arj)
      this.deltas = [arj]
    } else if (json) {
      this.json = json
      const bytes = encodeDocument(json)
      this.deltas = [bytes]
    } else {
      throw new Error("TensorPack requires either { json } or { arj }")
    }
  }
  toBuffer() {
    // Single delta; no length prefix.
    return this.deltas[0]
  }
}
