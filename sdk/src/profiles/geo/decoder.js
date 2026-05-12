// weavepack-geo — decoder (documents + delta frames).
//
// Mirrors the wire format produced by encoder.js exactly.
// Profile isolation: imports only from ./types.js.
//
// Returns the same document structure accepted by encodeDocument so that
//   encode(decode(bytes)) === bytes   (round-trip)

import {
  CTYPE, GEOM_TYPE, COORD_PRECISION, FID_KIND,
  OP, PATH_KIND, BLOCK_TYPE, PROFILE_NUM,
  nullBitmapBytes, getNullBit,
} from "./types.js"

const _dec = new TextDecoder()

// ── ByteReader ─────────────────────────────────────────────────────────────

class ByteReader {
  constructor(bytes) {
    this._buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    this._pos = 0
  }

  readByte() {
    if (this._pos >= this._buf.length) throw new Error("unexpected_end_of_input")
    return this._buf[this._pos++]
  }

  readBytes(n) {
    if (this._pos + n > this._buf.length) throw new Error("unexpected_end_of_input")
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
      if (shift >= 35) throw new Error("leb128_overflow")
    }
    return result >>> 0
  }

  readFloat32() {
    const b = this.readBytes(4)
    return new DataView(b.buffer, b.byteOffset).getFloat32(0, true)
  }

  readFloat64() {
    const b = this.readBytes(8)
    return new DataView(b.buffer, b.byteOffset).getFloat64(0, true)
  }
}

// ── String / array helpers ─────────────────────────────────────────────────

function readStr(r) {
  const len = r.readLEB128()
  return len === 0 ? "" : _dec.decode(r.readBytes(len))
}

function readCoordCol(r, n, cp) {
  const col = new Array(n)
  for (let i = 0; i < n; i++)
    col[i] = cp === COORD_PRECISION.FLOAT32 ? r.readFloat32() : r.readFloat64()
  return col
}

function readLEB128Array(r, n) {
  const arr = new Array(n)
  for (let i = 0; i < n; i++) arr[i] = r.readLEB128()
  return arr
}

function sum(arr) { return arr.reduce((s, v) => s + v, 0) }

// ── Uint64 LE helper ───────────────────────────────────────────────────────

function readUint64LE(r) {
  const b  = r.readBytes(8)
  const lo = BigInt(b[0]) | (BigInt(b[1]) << 8n) | (BigInt(b[2]) << 16n) | (BigInt(b[3]) << 24n)
  const hi = BigInt(b[4]) | (BigInt(b[5]) << 8n) | (BigInt(b[6]) << 16n) | (BigInt(b[7]) << 24n)
  return lo | (hi << 32n)
}

// ── Geometry section ───────────────────────────────────────────────────────
//
// numFeatures is the number of features in this section (1 for sub-geoms).

function readGeomSection(r, geomType, numFeatures, hasZ, cp) {
  switch (geomType) {
    case GEOM_TYPE.POINT: {
      const xCol = readCoordCol(r, numFeatures, cp)
      const yCol = readCoordCol(r, numFeatures, cp)
      const g = { xCol, yCol }
      if (hasZ) g.zCol = readCoordCol(r, numFeatures, cp)
      return g
    }
    case GEOM_TYPE.LINESTRING: {
      const coordCounts = readLEB128Array(r, numFeatures)
      const nv  = sum(coordCounts)
      const g   = { coordCounts, xCol: readCoordCol(r, nv, cp), yCol: readCoordCol(r, nv, cp) }
      if (hasZ) g.zCol = readCoordCol(r, nv, cp)
      return g
    }
    case GEOM_TYPE.POLYGON: {
      const ringsPerFeature = readLEB128Array(r, numFeatures)
      const ringCounts      = readLEB128Array(r, sum(ringsPerFeature))
      const nv = sum(ringCounts)
      const g  = { ringsPerFeature, ringCounts, xCol: readCoordCol(r, nv, cp), yCol: readCoordCol(r, nv, cp) }
      if (hasZ) g.zCol = readCoordCol(r, nv, cp)
      return g
    }
    case GEOM_TYPE.MULTIPOINT: {
      const partCounts = readLEB128Array(r, numFeatures)
      const nv = sum(partCounts)
      const g  = { partCounts, xCol: readCoordCol(r, nv, cp), yCol: readCoordCol(r, nv, cp) }
      if (hasZ) g.zCol = readCoordCol(r, nv, cp)
      return g
    }
    case GEOM_TYPE.MULTILINESTRING: {
      const partCounts  = readLEB128Array(r, numFeatures)
      const coordCounts = readLEB128Array(r, sum(partCounts))
      const nv = sum(coordCounts)
      const g  = { partCounts, coordCounts, xCol: readCoordCol(r, nv, cp), yCol: readCoordCol(r, nv, cp) }
      if (hasZ) g.zCol = readCoordCol(r, nv, cp)
      return g
    }
    case GEOM_TYPE.MULTIPOLYGON: {
      const partCounts   = readLEB128Array(r, numFeatures)
      const ringsPerPart = readLEB128Array(r, sum(partCounts))
      const ringCounts   = readLEB128Array(r, sum(ringsPerPart))
      const nv = sum(ringCounts)
      const g  = { partCounts, ringsPerPart, ringCounts, xCol: readCoordCol(r, nv, cp), yCol: readCoordCol(r, nv, cp) }
      if (hasZ) g.zCol = readCoordCol(r, nv, cp)
      return g
    }
    case GEOM_TYPE.NULL_GEOMETRY:
      return {}
    default:
      throw new Error(`unknown_geom_type: ${geomType}`)
  }
}

// ── Value decoding ─────────────────────────────────────────────────────────

function readValue(r, ctype) {
  switch (ctype) {
    case CTYPE.BOOL:  return r.readByte() !== 0
    case CTYPE.INT8:  { const b = r.readByte(); return b >= 128 ? b - 256 : b }
    case CTYPE.INT16: {
      const b = r.readBytes(2)
      const v = b[0] | (b[1] << 8)
      return v >= 32768 ? v - 65536 : v
    }
    case CTYPE.INT32: {
      const b = r.readBytes(4)
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) | 0
    }
    case CTYPE.INT64:
    case CTYPE.TIMESTAMP64: {
      const u = readUint64LE(r)
      return u >= 0x8000000000000000n ? u - 0x10000000000000000n : u
    }
    case CTYPE.UINT8:  return r.readByte()
    case CTYPE.UINT16: { const b = r.readBytes(2); return b[0] | (b[1] << 8) }
    case CTYPE.UINT32: {
      const b = r.readBytes(4)
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
    }
    case CTYPE.UINT64:    return readUint64LE(r)
    case CTYPE.FLOAT32:   return r.readFloat32()
    case CTYPE.FLOAT64:   return r.readFloat64()
    case CTYPE.STRING:    return readStr(r)
    case CTYPE.BYTES: {
      const len = r.readLEB128()
      return r.readBytes(len)
    }
    case CTYPE.DATE32: {
      const b = r.readBytes(4)
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) | 0
    }
    default:
      throw new Error(`unknown_ctype: ${ctype}`)
  }
}

// ── PropCols ───────────────────────────────────────────────────────────────

function readPropCols(r, numFeatures, numCols) {
  const propCols = []
  for (let c = 0; c < numCols; c++) {
    const name     = readStr(r)
    const ctype    = r.readByte()
    const nullable = r.readByte() !== 0

    let nullBits = null
    if (nullable) {
      nullBits = r.readBytes(nullBitmapBytes(numFeatures))
    }

    const values = new Array(numFeatures)
    const nnIdx  = []
    for (let i = 0; i < numFeatures; i++) {
      if (nullable && getNullBit(nullBits, i)) {
        values[i] = null
      } else {
        nnIdx.push(i)
      }
    }

    if (ctype === CTYPE.BOOL) {
      const bm = r.readBytes(Math.ceil(nnIdx.length / 8))
      for (let j = 0; j < nnIdx.length; j++)
        values[nnIdx[j]] = (bm[j >> 3] >> (j & 7)) & 1 ? true : false
    } else {
      for (const i of nnIdx) values[i] = readValue(r, ctype)
    }

    propCols.push({ name, ctype, nullable, values })
  }
  return propCols
}

// ── FID column ─────────────────────────────────────────────────────────────

function readFidColumn(r, fidKind, numFeatures) {
  if (fidKind === FID_KIND.FID_ABSENT) return null
  const fids = new Array(numFeatures)
  for (let i = 0; i < numFeatures; i++) {
    if (fidKind === FID_KIND.FID_STRING)     fids[i] = readStr(r)
    else if (fidKind === FID_KIND.FID_UINT64) fids[i] = readUint64LE(r)
    else throw new Error(`unknown_fid_kind: ${fidKind}`)
  }
  return fids
}

// ── Feature block ──────────────────────────────────────────────────────────

function readFeatureBlockPayload(r) {
  const geomType       = r.readByte()
  const coordPrecision = r.readByte()
  const hasZ           = r.readByte() !== 0
  const fidKind        = r.readByte()
  const numFeatures    = r.readLEB128()
  const numPropCols    = r.readLEB128()

  const fids     = readFidColumn(r, fidKind, numFeatures)
  const geom     = readGeomSection(r, geomType, numFeatures, hasZ, coordPrecision)
  const propCols = readPropCols(r, numFeatures, numPropCols)

  const blk = { type: 'feature', geomType, coordPrecision, hasZ, fidKind, numFeatures, geom, propCols }
  if (fids !== null) blk.fids = fids
  return blk
}

// ── Geometry-collection block ──────────────────────────────────────────────

function readGCBlockPayload(r) {
  const coordPrecision = r.readByte()
  const hasZ           = r.readByte() !== 0
  const fidKind        = r.readByte()
  const numFeatures    = r.readLEB128()
  const numPropCols    = r.readLEB128()
  const fids           = readFidColumn(r, fidKind, numFeatures)
  const totalSubGeoms  = r.readLEB128()
  const subGeomCounts  = readLEB128Array(r, numFeatures)

  const sgTypes = new Array(totalSubGeoms)
  for (let i = 0; i < totalSubGeoms; i++) sgTypes[i] = r.readByte()

  const subGeoms = new Array(totalSubGeoms)
  for (let i = 0; i < totalSubGeoms; i++)
    subGeoms[i] = { geomType: sgTypes[i], geom: readGeomSection(r, sgTypes[i], 1, hasZ, coordPrecision) }

  const propCols = readPropCols(r, numFeatures, numPropCols)
  const blk = { type: 'geometry_collection', coordPrecision, hasZ, fidKind, numFeatures, subGeomCounts, subGeoms, propCols }
  if (fids !== null) blk.fids = fids
  return blk
}

// ── Path decoding ──────────────────────────────────────────────────────────

function readInnerPath(r) {
  const kind = (r.readByte() >> 4) & 0xF
  if (kind === PATH_KIND.FEAT_BY_IDX)     return { kind, index: r.readLEB128() }
  if (kind === PATH_KIND.FEAT_BY_STR_FID) return { kind, fid: readStr(r) }
  if (kind === PATH_KIND.FEAT_BY_INT_FID) return { kind, fid: readUint64LE(r) }
  throw new Error(`invalid_inner_path_kind: ${kind}`)
}

function readPath(r) {
  const kind = (r.readByte() >> 4) & 0xF
  switch (kind) {
    case PATH_KIND.FEAT_BY_IDX:     return { kind, index: r.readLEB128() }
    case PATH_KIND.FEAT_BY_STR_FID: return { kind, fid: readStr(r) }
    case PATH_KIND.FEAT_BY_INT_FID: return { kind, fid: readUint64LE(r) }
    case PATH_KIND.FEAT_GEOMETRY:   return { kind, inner: readInnerPath(r) }
    case PATH_KIND.FEAT_PROP_NAME: {
      const inner = readInnerPath(r)
      return { kind, inner, name: readStr(r) }
    }
    case PATH_KIND.FEAT_PROP_IDX: {
      const inner  = readInnerPath(r)
      const colIdx = r.readLEB128()
      return { kind, inner, colIdx }
    }
    default: throw new Error(`unknown_path_kind: ${kind}`)
  }
}

// ── Op decoding ─────────────────────────────────────────────────────────────

function readBlock(r) {
  const bt = r.readByte()
  if (bt === BLOCK_TYPE.FEATURE)             return readFeatureBlockPayload(r)
  if (bt === BLOCK_TYPE.GEOMETRY_COLLECTION) return readGCBlockPayload(r)
  throw new Error(`unexpected_block_type_in_op: ${bt}`)
}

function readOp(r) {
  const code = r.readByte() >> 3
  switch (code) {
    case OP.FEATURE_INSERT:
      return { op: code, block: readBlock(r) }
    case OP.FEATURE_DELETE: {
      const mode = r.readByte()
      if (mode === 0) {
        const n = r.readLEB128()
        const paths = new Array(n)
        for (let i = 0; i < n; i++) paths[i] = readPath(r)
        return { op: code, mode, paths }
      }
      if (mode === 1) {
        return { op: code, mode, start: r.readLEB128(), count: r.readLEB128() }
      }
      throw new Error(`unknown_feature_delete_mode: ${mode}`)
    }
    case OP.GEOMETRY_REPLACE:
      return { op: code, path: readPath(r), block: readBlock(r) }
    case OP.PROP_SET: {
      const path  = readPath(r)
      const ctype = r.readByte()
      return { op: code, path, ctype, value: readValue(r, ctype) }
    }
    case OP.PROP_DELETE:
      return { op: code, path: readPath(r) }
    case OP.COLLECTION_REPLACE: {
      const n      = r.readLEB128()
      const blocks = new Array(n)
      for (let i = 0; i < n; i++) blocks[i] = readBlock(r)
      return { op: code, blocks }
    }
    default: throw new Error(`unknown_delta_op: ${code}`)
  }
}

// ── Delta frame ─────────────────────────────────────────────────────────────

function readDeltaFrame(r) {
  const name   = readStr(r)
  const numOps = r.readLEB128()
  const ops    = new Array(numOps)
  for (let i = 0; i < numOps; i++) ops[i] = readOp(r)
  return { type: 'delta', name, ops }
}

// ── Public: decodeDocument ─────────────────────────────────────────────────
//
// Accepts a Uint8Array (or anything with indexable bytes).
// Returns the document structure accepted by encodeDocument.

export function decodeDocument(bytes) {
  const r = new ByteReader(bytes)

  const profileId = r.readByte()
  if (profileId !== PROFILE_NUM)
    throw new Error(`wrong_profile: expected ${PROFILE_NUM}, got ${profileId}`)

  const name       = readStr(r)
  const blockCount = r.readLEB128()
  const blocks     = new Array(blockCount)

  for (let i = 0; i < blockCount; i++) {
    const bt = r.readByte()
    if (bt === BLOCK_TYPE.FEATURE)             { blocks[i] = readFeatureBlockPayload(r); continue }
    if (bt === BLOCK_TYPE.GEOMETRY_COLLECTION) { blocks[i] = readGCBlockPayload(r);      continue }
    if (bt === BLOCK_TYPE.DELTA)               { blocks[i] = readDeltaFrame(r);           continue }
    throw new Error(`unknown_block_type: ${bt}`)
  }

  return { name, blocks }
}
