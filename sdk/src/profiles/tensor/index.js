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
import {
  fp8e4m3ToF32, f32ToFp8e4m3, f32ArrayToFp8e4m3Bits,
  fp8e5m2ToF32, f32ToFp8e5m2, f32ArrayToFp8e5m2Bits,
} from "./fp8.js"

export { DTYPE, DTYPE_BITS, OP, dataBytes, PROFILE_ID, PROFILE_VERSION }
export { schemaHash, schemaHashHex, canonicalizeSchema }
export {
  fp16BitsToF32, f32ToFp16Bits, bf16BitsToF32, f32ToBf16Bits,
  f32ArrayToFp16Bits, fp16BitsToF32Array,
  f32ArrayToBf16Bits, bf16BitsToF32Array,
}
export {
  fp8e4m3ToF32, f32ToFp8e4m3, f32ArrayToFp8e4m3Bits,
  fp8e5m2ToF32, f32ToFp8e5m2, f32ArrayToFp8e5m2Bits,
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

// ── nibble (int4 / uint4) packing ────────────────────────────────────────
//
// Wire format: 2 elements per byte; high nibble = lower-indexed element,
// low nibble = higher-indexed element. Odd count: last byte has value in
// high nibble, low nibble = 0.
//
// int4: two's-complement in 4 bits, range -8..7.  value & 0xF = wire nibble.
// uint4: unsigned, range 0..15.

function packNibbles(arr, count) {
  const out = new Uint8Array(Math.ceil(count / 2))
  for (let i = 0; i < count; i++) {
    const nibble = arr[i] & 0xF
    if (i % 2 === 0) out[i >> 1]  = nibble << 4
    else             out[i >> 1] |= nibble
  }
  return out
}

function unpackInt4(bytes, count) {
  const out = new Int8Array(count)
  for (let i = 0; i < count; i++) {
    const nibble = (i % 2 === 0) ? (bytes[i >> 1] >> 4) & 0xF : bytes[i >> 1] & 0xF
    out[i] = nibble >= 8 ? nibble - 16 : nibble
  }
  return out
}

function unpackUint4(bytes, count) {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = (i % 2 === 0) ? (bytes[i >> 1] >> 4) & 0xF : bytes[i >> 1] & 0xF
  }
  return out
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
  } else if (t.dtype === DTYPE.INT4 || t.dtype === DTYPE.UINT4 || t.dtype === DTYPE.QINT4) {
    let total = 1
    for (const d of t.shape) total *= d
    dataView = packNibbles(t.data, total)
  } else if (t.dtype === DTYPE.QFP8) {
    // Accept Float32Array (raw already-encoded fp8e4m3 bits stored as floats
    // is not sensible; callers pass Uint8Array of fp8 bits) or Uint8Array.
    if (t.data instanceof Uint8Array) {
      dataView = t.data
    } else {
      dataView = toBytes(t)
    }
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
  } else if (t.dtype === DTYPE.FP8E4M3 || t.dtype === DTYPE.FP8E5M2) {
    // Accept either Float32Array (convert) or Uint8Array (raw fp8 bits).
    if (t.data instanceof Uint8Array) {
      dataView = t.data
    } else if (t.data instanceof Float32Array) {
      dataView = t.dtype === DTYPE.FP8E4M3
        ? f32ArrayToFp8e4m3Bits(t.data)
        : f32ArrayToFp8e5m2Bits(t.data)
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
    if (t.dtype === DTYPE.QINT8 && sDef.scale !== undefined) {
      // Quantize Float32Array input → Int8Array using schema scale + zero_point.
      // q = clamp(round(f32 / scale + zero_point), -128, 127)
      const scale = sDef.scale, zp = sDef.zero_point || 0
      let total = 1
      for (const d of t.shape) total *= d
      const q = new Int8Array(total)
      const f32 = t.data instanceof Float32Array ? t.data : new Float32Array(Array.from(t.data))
      for (let i = 0; i < total; i++) {
        const qval = Math.round(f32[i] / scale + zp)
        q[i] = Math.max(-128, Math.min(127, qval))
      }
      emitDataBlock(u, { dtype: DTYPE.QINT8, shape: t.shape, data: q })
    } else if (t.dtype === DTYPE.QINT4 && sDef.scale !== undefined) {
      // Quantize Float32Array → 4-bit signed nibbles via schema scale + zero_point.
      // q = clamp(round(f32 / scale + zero_point), -8, 7)
      const scale = sDef.scale, zp = sDef.zero_point || 0
      let total = 1
      for (const d of t.shape) total *= d
      const q = new Int8Array(total)
      const f32 = t.data instanceof Float32Array ? t.data : new Float32Array(Array.from(t.data))
      for (let i = 0; i < total; i++) {
        const qval = Math.round(f32[i] / scale + zp)
        q[i] = Math.max(-8, Math.min(7, qval))
      }
      emitDataBlock(u, { dtype: DTYPE.QINT4, shape: t.shape, data: q })
    } else if (t.dtype === DTYPE.QFP8 && sDef.scale !== undefined) {
      // Quantize Float32Array → fp8e4m3 bits scaled by schema scale.
      // q_fp8 = fp8e4m3_encode(f32 / scale); dequant: f32 = fp8e4m3_decode(q) * scale
      const scale = sDef.scale
      let total = 1
      for (const d of t.shape) total *= d
      const f32 = t.data instanceof Float32Array ? t.data : new Float32Array(Array.from(t.data))
      const scaled = new Float32Array(total)
      for (let i = 0; i < total; i++) scaled[i] = f32[i] / scale
      const fp8bits = f32ArrayToFp8e4m3Bits(scaled)
      emitDataBlock(u, { dtype: DTYPE.QFP8, shape: t.shape, data: fp8bits })
    } else {
      emitDataBlock(u, t)
    }
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
    let data = materializeData(sDef.dtype, dataU8, total)
    if (sDef.dtype === DTYPE.QINT8 && sDef.scale !== undefined) {
      // Dequantize Int8Array → Float32Array: f32 = (q - zero_point) * scale
      const scale = sDef.scale, zp = sDef.zero_point || 0
      const f32 = new Float32Array(total)
      for (let i = 0; i < total; i++) f32[i] = (data[i] - zp) * scale
      data = f32
    } else if (sDef.dtype === DTYPE.QINT4 && sDef.scale !== undefined) {
      // Dequantize 4-bit signed nibbles → Float32Array: f32 = (q - zero_point) * scale
      const scale = sDef.scale, zp = sDef.zero_point || 0
      const f32 = new Float32Array(total)
      for (let i = 0; i < total; i++) f32[i] = (data[i] - zp) * scale
      data = f32
    } else if (sDef.dtype === DTYPE.QFP8 && sDef.scale !== undefined) {
      // Dequantize fp8e4m3 bits → Float32Array: f32 = fp8e4m3_decode(q) * scale
      const scale = sDef.scale
      const f32 = new Float32Array(total)
      for (let i = 0; i < total; i++) f32[i] = fp8e4m3ToF32(data[i]) * scale
      data = f32
    }
    tensors[name] = { dtype: sDef.dtype, shape: sDef.shape, data }
  }

  return { tensors }
}

// ── schemaful sub-tensor random access (A.4) ──────────────────────────────
//
// The schema gives us each tensor's exact byte count (dataBytes(dtype, shape)),
// so we can compute bit-offsets arithmetically and skip directly to tensor N
// without parsing tensors 0..N-1.
//
// Wire layout for schemaful documents (bit positions):
//   0       : doc flag (0)
//   1       : schema present (1)
//   2–257   : 256-bit schema hash
//   258+    : tensor data blocks in canonical name order, each
//             dataBytes(dtype, shape) * 8 bits with no padding between tensors.
//
// Since dataBytes always returns whole bytes, each data block consumes
// a whole number of bits; bit position stays consistent across tensors.

// Shared: reads the 2-bit doc discriminant + 256-bit schema hash,
// resolves the schema from the registry, returns state for callers.
function parseSchemafulHeader(u8, registry) {
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
  if (hasSchema !== 1) throw new Error("payload is schemaless; use decodeDocument() instead")
  const hashBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) hashBytes[i] = readBits(8)
  const hex = Array.from(hashBytes, b => b.toString(16).padStart(2, "0")).join("")
  const schema = registry.get(hex)
  if (!schema) throw new Error(`unknown schema-id ${hex}; register the schema before decoding`)
  const actualHex = schemaHashHex(schema)
  if (actualHex !== hex) throw new Error(`schema registry entry for ${hex} hashes to ${actualHex}; registry is corrupt`)
  return { bitPos, schema, sortedNames: Object.keys(schema).sort() }
}

// listTensorsSchemaful(bytes, registry) → string[]
// Returns tensor names in canonical (sorted) order without decoding any data.
export function listTensorsSchemaful(bytes, registry) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const { sortedNames } = parseSchemafulHeader(u8, registry)
  return sortedNames
}

// decodeTensorSchemaful(bytes, name, registry) → { dtype, shape, data }
// Decodes exactly one named tensor from a schemaful document.
// Seeks past preceding tensors using the schema's byte-count arithmetic;
// no tensor data before the target is read from the buffer.
export function decodeTensorSchemaful(bytes, name, registry) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const { bitPos: headerEnd, schema, sortedNames } = parseSchemafulHeader(u8, registry)

  const targetIdx = sortedNames.indexOf(name)
  if (targetIdx < 0) {
    throw new Error(`tensor "${name}" not found in schema; available: ${sortedNames.join(", ")}`)
  }

  // Compute bit position of the target tensor's data block.
  let bitPos = headerEnd
  for (let i = 0; i < targetIdx; i++) {
    const sDef = schema[sortedNames[i]]
    bitPos += dataBytes(sDef.dtype, sDef.shape) * 8
  }

  // Read target tensor data block.
  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      val = (val << 1) | ((u8[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return val
  }

  const sDef = schema[name]
  const byteCount = dataBytes(sDef.dtype, sDef.shape)
  const dataU8 = new Uint8Array(byteCount)
  for (let i = 0; i < byteCount; i++) dataU8[i] = readBits(8)

  let total = 1
  for (const d of sDef.shape) total *= d
  let data = materializeData(sDef.dtype, dataU8, total)

  if (sDef.dtype === DTYPE.QINT8 && sDef.scale !== undefined) {
    const scale = sDef.scale, zp = sDef.zero_point || 0
    const f32 = new Float32Array(total)
    for (let i = 0; i < total; i++) f32[i] = (data[i] - zp) * scale
    data = f32
  } else if (sDef.dtype === DTYPE.QINT4 && sDef.scale !== undefined) {
    const scale = sDef.scale, zp = sDef.zero_point || 0
    const f32 = new Float32Array(total)
    for (let i = 0; i < total; i++) f32[i] = (data[i] - zp) * scale
    data = f32
  } else if (sDef.dtype === DTYPE.QFP8 && sDef.scale !== undefined) {
    const scale = sDef.scale
    const f32 = new Float32Array(total)
    for (let i = 0; i < total; i++) f32[i] = fp8e4m3ToF32(data[i]) * scale
    data = f32
  }

  return { dtype: sDef.dtype, shape: sDef.shape, data }
}

// ── schemaful streaming iterator (A.5) ───────────────────────────────────
//
// iterateTensorsSchemaful(bytes, registry) → Generator<{ name, dtype, shape, data }>
//
// Yields one { name, dtype, shape, data } per tensor in canonical (sorted)
// order. Advances a single bit-position cursor sequentially — no offset
// arithmetic per tensor, no seeking backwards, no full-document buffer.
//
// Invariant: the yielded data values are identical to those returned by
// decodeDocumentSchemaful (same materializeData + dequantization logic).
// Use this when consuming all tensors in order; prefer decodeTensorSchemaful
// for random access to a specific named tensor.

export function* iterateTensorsSchemaful(bytes, registry) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let { bitPos, schema, sortedNames } = parseSchemafulHeader(u8, registry)

  function readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      val = (val << 1) | ((u8[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
      bitPos++
    }
    return val
  }

  for (const name of sortedNames) {
    const sDef = schema[name]
    const byteCount = dataBytes(sDef.dtype, sDef.shape)
    const dataU8 = new Uint8Array(byteCount)
    for (let i = 0; i < byteCount; i++) dataU8[i] = readBits(8)

    let total = 1
    for (const d of sDef.shape) total *= d
    let data = materializeData(sDef.dtype, dataU8, total)

    if (sDef.dtype === DTYPE.QINT8 && sDef.scale !== undefined) {
      const scale = sDef.scale, zp = sDef.zero_point || 0
      const f32 = new Float32Array(total)
      for (let i = 0; i < total; i++) f32[i] = (data[i] - zp) * scale
      data = f32
    } else if (sDef.dtype === DTYPE.QINT4 && sDef.scale !== undefined) {
      const scale = sDef.scale, zp = sDef.zero_point || 0
      const f32 = new Float32Array(total)
      for (let i = 0; i < total; i++) f32[i] = (data[i] - zp) * scale
      data = f32
    } else if (sDef.dtype === DTYPE.QFP8 && sDef.scale !== undefined) {
      const scale = sDef.scale
      const f32 = new Float32Array(total)
      for (let i = 0; i < total; i++) f32[i] = fp8e4m3ToF32(data[i]) * scale
      data = f32
    }

    yield { name, dtype: sDef.dtype, shape: sDef.shape, data }
  }
}

// ── delta encoding ────────────────────────────────────────────────────────
//
// Wire: [1][leb128-op-count][ops...]
// Updated from pre-5.5 format ([0][1][leb128...]) to use bit 0 = 1 (delta).

const ELEMENT_SET_DENSITY_THRESHOLD = 0.3
// V0.2 A.3 — emit tensor_replace mode=1 (delta-from-prior) when the
// max absolute per-element delta is below this threshold. Empirically
// (see examples/delta-from-prior-mode-bit.js) mode=1 + brotli is 1.6×
// smaller than mode=0 + brotli at ±0.0001 noise, 1.36× at ±0.001,
// 1.13× at ±0.01, ~1.0× above. Below the threshold the win is
// material; above it, mode=0 is fine and avoids encoder overhead.
// fp32/fp64 only; integer dtypes always use mode=0.
const DELTA_FROM_PRIOR_MAX_DELTA = 0.01

function maxAbsDelta(baseT, newT) {
  if (baseT.dtype !== DTYPE.FP32 && baseT.dtype !== DTYPE.FP64) return Infinity
  let max = 0
  const bd = baseT.data, nd = newT.data
  for (let i = 0; i < bd.length; i++) {
    const d = Math.abs(nd[i] - bd[i])
    if (d > max) max = d
  }
  return max
}

function shapesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Returns the wire-format packed byte view of tensor data (for diff comparison).
function packedWireBytes(t) {
  if (t.dtype === DTYPE.BOOL) return packBoolFromTensor(t)
  if (t.dtype === DTYPE.INT4 || t.dtype === DTYPE.UINT4) {
    let n = 1
    for (const d of t.shape) n *= d
    return packNibbles(t.data, n)
  }
  return toBytes(t)
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
  // Dtypes whose data arrays are not indexed by element count (bool, complex)
  // fall back to full tensor_replace in the delta path.
  if (baseT.dtype === DTYPE.BOOL) return null
  if (baseT.dtype === DTYPE.CFLOAT32 || baseT.dtype === DTYPE.CFLOAT64) return null
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
    // quant_change: same dtype/shape, quantized dtype, different scale or zero_point.
    if (baseT.dtype === DTYPE.QINT8 || baseT.dtype === DTYPE.QINT4 || baseT.dtype === DTYPE.QFP8) {
      const scaleChanged = (baseT.scale || 0) !== (newT.scale || 0)
      const zpChanged    = (baseT.zero_point || 0) !== (newT.zero_point || 0)
      if (scaleChanged || zpChanged) {
        ops.push({
          op: OP.QUANT_CHANGE, name, dtype: newT.dtype, shape: newT.shape, data: newT.data,
          scale: newT.scale || 0, zero_point: newT.zero_point || 0,
        })
        continue
      }
    }
    const baseBytes = packedWireBytes(baseT)
    const newBytes  = packedWireBytes(newT)
    const expected = dataBytes(baseT.dtype, baseT.shape)
    if (bytesEqual(baseBytes.subarray(0, expected), newBytes.subarray(0, expected))) continue

    let total = 1
    for (const d of baseT.shape) total *= d
    const changed = findChangedElements(baseT, newT)
    if (!changed) {
      // Sub-byte dtype (bool); fall back to full replace.
      ops.push({ op: OP.TENSOR_REPLACE, name, ...newT })
      continue
    }
    const sparsity = changed.length / total

    if (sparsity < ELEMENT_SET_DENSITY_THRESHOLD) {
      // Compute bounding box. If most of the bbox is touched, region_replace
      // wins (per 04-deltas.md heuristic: > 50% density inside bbox).
      const bbox = boundingBox(changed, baseT.shape)
      const bboxSize = bboxElementCount(bbox)
      if (bboxSize > 0 && changed.length / bboxSize > REGION_REPLACE_DENSITY_THRESHOLD
          && bboxSize < total) {
        // region_replace beats element_set for this dense bounding box.
        ops.push({
          op: OP.REGION_REPLACE, name,
          dtype: newT.dtype, shape: newT.shape, bbox,
          regionData: extractRegion(newT, bbox),
        })
      } else {
        ops.push({
          op: OP.ELEMENT_SET, name, dtype: newT.dtype, shape: newT.shape,
          elements: changed.map(c => ({ indices: c.indices, value: newT.data[c.flat] })),
        })
      }
    } else {
      // Dense update: TENSOR_REPLACE. Choose mode=1 (delta-from-prior)
      // if the max abs delta is small enough that brotli will exploit
      // the leading-zero structure of the deltas.
      const maxD = maxAbsDelta(baseT, newT)
      if (maxD <= DELTA_FROM_PRIOR_MAX_DELTA && maxD > 0) {
        const Ctor = baseT.data.constructor
        const deltaData = new Ctor(baseT.data.length)
        for (let i = 0; i < baseT.data.length; i++) deltaData[i] = newT.data[i] - baseT.data[i]
        ops.push({ op: OP.TENSOR_REPLACE, name, ...newT, mode: 1, deltaData })
      } else {
        ops.push({ op: OP.TENSOR_REPLACE, name, ...newT })
      }
    }
  }

  return ops
}

const REGION_REPLACE_DENSITY_THRESHOLD = 0.5

/// boundingBox(changed, shape) → array of [start, end] (end-exclusive) per dim.
function boundingBox(changed, shape) {
  const rank = shape.length
  const mins = new Array(rank).fill(Infinity)
  const maxs = new Array(rank).fill(-Infinity)
  for (const c of changed) {
    for (let r = 0; r < rank; r++) {
      if (c.indices[r] < mins[r]) mins[r] = c.indices[r]
      if (c.indices[r] > maxs[r]) maxs[r] = c.indices[r]
    }
  }
  return mins.map((m, r) => [m, maxs[r] + 1])  // end-exclusive
}

function bboxElementCount(bbox) {
  let n = 1
  for (const [s, e] of bbox) n *= (e - s)
  return n
}

/// Extract a contiguous region from tensor t into a typed array.
function extractRegion(t, bbox) {
  const rank = t.shape.length
  const elementCount = bboxElementCount(bbox)
  // Iterate the bbox in row-major order, copy elements into a new array
  // matching t.data's typed-array kind.
  const data = t.data
  const Ctor = data.constructor
  const out = new Ctor(elementCount)
  let outIdx = 0
  // Recursive iteration over dims.
  const idx = new Array(rank)
  function recur(dim) {
    if (dim === rank) {
      // Convert idx to flat offset in the source tensor.
      let flat = 0
      for (let r = 0; r < rank; r++) flat = flat * t.shape[r] + idx[r]
      out[outIdx++] = data[flat]
      return
    }
    const [s, e] = bbox[dim]
    for (let i = s; i < e; i++) {
      idx[dim] = i
      recur(dim + 1)
    }
  }
  recur(0)
  return out
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
      if (op.op === OP.TENSOR_REPLACE) {
        // mode bit: 0 = absolute values, 1 = per-element delta-from-prior.
        u.add_dc(op.mode || 0, 1)
        emitDataBlock(u, op.mode === 1 ? { ...op, data: op.deltaData } : op)
      } else {
        emitDataBlock(u, op)
      }
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
    } else if (op.op === OP.REGION_REPLACE) {
      // Wire format: name + dtype + full shape + rank + per-dim ranges
      // (start, end) + region data block in row-major order. Carrying
      // the full shape (not just the rank) lets the decoder validate
      // against the base tensor; carrying the dtype is for parity with
      // tensor_replace's robust form.
      emitName(u, op.name)
      u.add_dc(op.dtype, DTYPE_BITS)
      short_dc(u, op.shape.length)
      for (const dim of op.shape) leb128_dc(u, dim)
      // Range list: rank ranges, each (start, end-exclusive).
      short_dc(u, op.bbox.length)
      for (const [s, e] of op.bbox) {
        leb128_dc(u, s)
        leb128_dc(u, e)
      }
      // Region data block. Element count = product(end-start) for each dim.
      const regionElements = bboxElementCount(op.bbox)
      let regionU8
      if (op.dtype === DTYPE.INT4 || op.dtype === DTYPE.UINT4) {
        regionU8 = packNibbles(op.regionData, regionElements)
      } else {
        const vb = bytesPerElem(op.dtype)
        regionU8 = new Uint8Array(op.regionData.buffer, op.regionData.byteOffset, vb * regionElements)
      }
      for (let i = 0; i < regionU8.length; i++) u.add_dc(regionU8[i], 8)
    } else if (op.op === OP.QUANT_CHANGE) {
      emitName(u, op.name)
      // new scale: fp32 little-endian (4 bytes).
      const scaleBuf = new ArrayBuffer(4)
      new DataView(scaleBuf).setFloat32(0, op.scale, true)
      const scaleU8 = new Uint8Array(scaleBuf)
      for (let i = 0; i < 4; i++) u.add_dc(scaleU8[i], 8)
      // new zero_point: dtype-dependent.
      if (op.dtype === DTYPE.QINT8) {
        u.add_dc(op.zero_point & 0xFF, 8)  // signed int8 stored as unsigned byte
      } else if (op.dtype === DTYPE.QINT4) {
        u.add_dc(op.zero_point & 0xF, 8)   // signed int4 in low nibble of one byte
      }
      // QFP8: no zero_point field.
      emitDataBlock(u, op)
    } else {
      throw new Error(`unsupported op code ${op.op}`)
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
      // tensor_replace carries a mode bit; tensor_add does not (it has no base to diff against).
      const modeBit = opCode === OP.TENSOR_REPLACE ? readBits(1) : 0
      const bc = dataBytes(dtype, shape)
      const dataU8 = new Uint8Array(bc)
      for (let j = 0; j < bc; j++) dataU8[j] = readBits(8)
      let total = 1
      for (const d of shape) total *= d
      if (modeBit === 0) {
        tensors[name] = { dtype, shape, data: materializeData(dtype, dataU8, total) }
      } else {
        // mode=1: per-element arithmetic delta (new = base + delta)
        if (!(name in tensors)) throw new Error(`tensor_replace mode=1 on unknown tensor '${name}'`)
        const baseT = tensors[name]
        const deltaData = materializeData(dtype, dataU8, total)
        tensors[name] = { dtype, shape, data: addDeltaFromPrior(dtype, baseT.data, deltaData) }
      }

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

    } else if (opCode === OP.REGION_REPLACE) {
      const nameLen = readShort()
      const nb = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nb[j] = readBits(8)
      const name = new TextDecoder().decode(nb)
      const dtype = readBits(DTYPE_BITS)
      const rank = readShort()
      const shape = []
      for (let r = 0; r < rank; r++) shape.push(readLeb128())
      const bboxRank = readShort()
      const bbox = []
      for (let r = 0; r < bboxRank; r++) {
        const s = readLeb128()
        const e = readLeb128()
        bbox.push([s, e])
      }
      let regionElements = 1
      for (const [s, e] of bbox) regionElements *= (e - s)
      const regionBytes = Math.ceil(regionElements * (DTYPE_BITS_PER_ELEM[dtype] || 8) / 8)
      const regionU8 = new Uint8Array(regionBytes)
      for (let j = 0; j < regionBytes; j++) regionU8[j] = readBits(8)

      // Apply: copy region into existing tensor data.
      if (!(name in tensors)) throw new Error(`region_replace on unknown tensor ${name}`)
      const baseT = tensors[name]
      const newData = (baseT.data instanceof Uint8Array) ? new Uint8Array(baseT.data) : baseT.data.slice()
      const regionData = materializeData(dtype, regionU8, regionElements)
      // Iterate the bbox in row-major order, copy into newData.
      const idx = new Array(rank)
      let regionIdx = 0
      function recur(dim) {
        if (dim === rank) {
          let flat = 0
          for (let r = 0; r < rank; r++) flat = flat * shape[r] + idx[r]
          newData[flat] = regionData[regionIdx++]
          return
        }
        const [s, e] = bbox[dim]
        for (let i = s; i < e; i++) {
          idx[dim] = i
          recur(dim + 1)
        }
      }
      recur(0)
      tensors[name] = { dtype, shape, data: newData }

    } else if (opCode === OP.QUANT_CHANGE) {
      const nameLen = readShort()
      const nb = new Uint8Array(nameLen)
      for (let j = 0; j < nameLen; j++) nb[j] = readBits(8)
      const name = new TextDecoder().decode(nb)
      if (!(name in tensors)) throw new Error(`quant_change on unknown tensor '${name}'`)
      const baseT = tensors[name]
      // Read new scale (fp32 LE, 4 bytes).
      const scaleBytes = new Uint8Array(4)
      for (let i = 0; i < 4; i++) scaleBytes[i] = readBits(8)
      const newScale = new DataView(scaleBytes.buffer).getFloat32(0, true)
      // Read new zero_point (dtype-dependent).
      let newZeroPoint = 0
      if (baseT.dtype === DTYPE.QINT8) {
        const zpByte = readBits(8)
        newZeroPoint = zpByte >= 128 ? zpByte - 256 : zpByte  // sign-extend int8
      } else if (baseT.dtype === DTYPE.QINT4) {
        const zpNibble = readBits(8) & 0xF
        newZeroPoint = zpNibble >= 8 ? zpNibble - 16 : zpNibble  // sign-extend int4
      }
      // QFP8: zero_point is always 0 (no field on wire).
      // Read new data block.
      const bc = dataBytes(baseT.dtype, baseT.shape)
      const dataU8 = new Uint8Array(bc)
      for (let j = 0; j < bc; j++) dataU8[j] = readBits(8)
      let total = 1
      for (const d of baseT.shape) total *= d
      tensors[name] = {
        dtype: baseT.dtype, shape: baseT.shape,
        data: materializeData(baseT.dtype, dataU8, total),
        scale: newScale, zero_point: newZeroPoint,
      }

    } else {
      throw new Error(`unsupported op code ${opCode}`)
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
    // Sub-byte types: value stored in low nibble of a single byte.
    case DTYPE.INT4:
    case DTYPE.UINT4:  view.setUint8(0, value & 0xF); break
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
    case DTYPE.INT4: {
      const nibble = view.getUint8(0) & 0xF
      return nibble >= 8 ? nibble - 16 : nibble
    }
    case DTYPE.UINT4:  return view.getUint8(0) & 0xF
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
    case DTYPE.INT8:
    case DTYPE.QINT8:  return new Int8Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.QINT4:  return unpackInt4(dataU8, total)
    case DTYPE.UINT8:  return dataU8
    case DTYPE.INT16:  return new Int16Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT16: return new Uint16Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT32:  return new Int32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT32: return new Uint32Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT64:  return new BigInt64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.UINT64: return new BigUint64Array(dataU8.buffer, dataU8.byteOffset, total)
    case DTYPE.INT4:   return unpackInt4(dataU8, total)
    case DTYPE.UINT4:  return unpackUint4(dataU8, total)
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
    case DTYPE.QFP8:
    case DTYPE.FP8E4M3:
    case DTYPE.FP8E5M2: {
      // Return raw Uint8Array of fp8 bits; 1 byte per element.
      // Callers wanting f32 values use fp8e4m3ToF32 / fp8e5m2ToF32.
      const copy = new Uint8Array(dataU8.buffer.slice(dataU8.byteOffset, dataU8.byteOffset + total))
      return copy
    }
    case DTYPE.CFLOAT32: {
      // Each complex element is (real f32, imag f32) = 8 bytes.
      // Represent as Float32Array of length 2*total (interleaved real, imag).
      const copy = new Uint8Array(dataU8.buffer.slice(dataU8.byteOffset, dataU8.byteOffset + total * 8))
      return new Float32Array(copy.buffer, 0, total * 2)
    }
    case DTYPE.CFLOAT64: {
      // Each complex element is (real f64, imag f64) = 16 bytes.
      // Represent as Float64Array of length 2*total (interleaved real, imag).
      const copy = new Uint8Array(dataU8.buffer.slice(dataU8.byteOffset, dataU8.byteOffset + total * 16))
      return new Float64Array(copy.buffer, 0, total * 2)
    }
    default:           return dataU8
  }
}

// ── delta-from-prior arithmetic ──────────────────────────────────────────────
//
// Applies a per-element arithmetic delta: result[i] = base[i] + delta[i].
// Both base and deltaData must be typed arrays of the same dtype.
// For fp16/bf16, both carry raw Uint16 bits; the arithmetic is done in f32.
// For integer types, JS typed array assignment wraps correctly.
// Bool tensors never use delta-from-prior (encoder always emits mode=0 for bool).
function addDeltaFromPrior(dtype, base, deltaData) {
  if (dtype === DTYPE.FP16) {
    const baseF32  = fp16BitsToF32Array(base)
    const deltaF32 = fp16BitsToF32Array(deltaData)
    const result   = new Float32Array(base.length)
    for (let i = 0; i < result.length; i++) result[i] = baseF32[i] + deltaF32[i]
    return f32ArrayToFp16Bits(result)
  }
  if (dtype === DTYPE.BF16) {
    const baseF32  = bf16BitsToF32Array(base)
    const deltaF32 = bf16BitsToF32Array(deltaData)
    const result   = new Float32Array(base.length)
    for (let i = 0; i < result.length; i++) result[i] = baseF32[i] + deltaF32[i]
    return f32ArrayToBf16Bits(result)
  }
  // All other typed arrays (fp32, fp64, int8/16/32, uint8/16/32, int64, uint64):
  // slice() preserves the typed-array kind; assignment wraps at the correct width.
  const result = base.slice()
  for (let i = 0; i < result.length; i++) result[i] = base[i] + deltaData[i]
  return result
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
