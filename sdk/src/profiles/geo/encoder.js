// weavepack-geo — encoder (documents + delta chains).
//
// Profile isolation: imports only from ./types.js.
// No JSON / tensor / wire / tabular / log / graph / ast code.
//
// Data model accepted by encodeDocument:
//   doc = {
//     name?: string,          // collection name (default "")
//     blocks: Block[],        // feature_block | geometry_collection_block | delta_frame
//   }
//
//   feature_block (type = 'feature'):
//     geomType: GEOM_TYPE constant
//     coordPrecision: COORD_PRECISION constant (default FLOAT64)
//     hasZ: boolean (default false)
//     fidKind: FID_KIND constant (default FID_ABSENT)
//     numFeatures: number
//     fids?: (string|BigInt)[]  required if fidKind != FID_ABSENT
//     geom: geometry-section object (see writeGeomSection)
//     propCols: [{ name, ctype, nullable, values[] }]
//
//   geometry_collection_block (type = 'geometry_collection'):
//     coordPrecision, hasZ, fidKind, numFeatures, fids?, propCols (same as above)
//     subGeomCounts: number[]  sub-geometry count per feature
//     subGeoms: [{ geomType, geom }]  one per sub-geometry
//
//   delta_frame (type = 'delta'):
//     name?: string  collection name targeted
//     ops: Op[]  (see writeOp)
//
// See weavepack/profiles/geo/02-containers.md and 04-deltas.md.

import {
  CTYPE, GEOM_TYPE, COORD_PRECISION, FID_KIND,
  OP, PATH_KIND, BLOCK_TYPE,
  PROFILE_NUM, MAX_STRING_BYTES,
  nullBitmapBytes, setNullBit,
} from "./types.js"

const _enc = new TextEncoder()

// ── ByteWriter ─────────────────────────────────────────────────────────────

class ByteWriter {
  constructor() { this._buf = [] }

  writeByte(b)   { this._buf.push(b & 0xFF) }
  writeBytes(src) { for (let i = 0; i < src.length; i++) this._buf.push(src[i] & 0xFF) }

  writeLEB128(v) {
    v = v >>> 0
    while (v >= 128) { this._buf.push((v & 0x7F) | 0x80); v >>>= 7 }
    this._buf.push(v)
  }

  writeLEB128Big(v) {
    v = BigInt(v)
    while (v >= 128n) { this._buf.push(Number(v & 0x7Fn) | 0x80); v >>= 7n }
    this._buf.push(Number(v))
  }

  writeFloat32(f) {
    const tmp = new ArrayBuffer(4)
    new DataView(tmp).setFloat32(0, f, true)
    this.writeBytes(new Uint8Array(tmp))
  }

  writeFloat64(f) {
    const tmp = new ArrayBuffer(8)
    new DataView(tmp).setFloat64(0, f, true)
    this.writeBytes(new Uint8Array(tmp))
  }

  toBytes() { return new Uint8Array(this._buf) }
}

// ── Per-ctype value encoding (ctypes 0–14) ─────────────────────────────────

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
      const u = (value | 0) < 0 ? (value | 0) + 0x100000000 : (value | 0)
      w.writeByte(u & 0xFF); w.writeByte((u >> 8) & 0xFF)
      w.writeByte((u >> 16) & 0xFF); w.writeByte((u >> 24) & 0xFF)
      break
    }
    case CTYPE.INT64:
    case CTYPE.TIMESTAMP64: {
      const bv = BigInt(value)
      const lo = Number(bv & 0xFFFFFFFFn), hi = Number((bv >> 32n) & 0xFFFFFFFFn)
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
      const lo = Number(bv & 0xFFFFFFFFn), hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
      break
    }
    case CTYPE.FLOAT32:
      w.writeFloat32(value)
      break
    case CTYPE.FLOAT64:
      w.writeFloat64(value)
      break
    case CTYPE.STRING: {
      const utf8 = _enc.encode(String(value))
      if (utf8.length > MAX_STRING_BYTES) throw new Error("string_too_large")
      w.writeLEB128(utf8.length); w.writeBytes(utf8)
      break
    }
    case CTYPE.BYTES: {
      const src = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (src.length > MAX_STRING_BYTES) throw new Error("bytes_too_large")
      w.writeLEB128(src.length); w.writeBytes(src)
      break
    }
    case CTYPE.DATE32: {
      const u = (value | 0) < 0 ? (value | 0) + 0x100000000 : (value | 0)
      w.writeByte(u & 0xFF); w.writeByte((u >> 8) & 0xFF)
      w.writeByte((u >> 16) & 0xFF); w.writeByte((u >> 24) & 0xFF)
      break
    }
    default:
      throw new Error(`unknown_ctype: ${ctype}`)
  }
}

function writeNullBitmap(w, values, n) {
  const bm = new Uint8Array(nullBitmapBytes(n))
  for (let i = 0; i < n; i++) {
    if (values[i] === null || values[i] === undefined) setNullBit(bm, i)
  }
  w.writeBytes(bm)
}

function writeBoolColumn(w, values) {
  const bm = new Uint8Array(Math.ceil(values.length / 8))
  for (let i = 0; i < values.length; i++) {
    if (values[i]) bm[i >> 3] |= (1 << (i & 7))
  }
  w.writeBytes(bm)
}

function writeValueColumn(w, ctype, values) {
  const nonNull = values.filter(v => v !== null && v !== undefined)
  if (ctype === CTYPE.BOOL) writeBoolColumn(w, nonNull)
  else for (const v of nonNull) writeValue(w, ctype, v)
}

// ── Coordinate column helpers ──────────────────────────────────────────────

function writeCoordCol(w, vals, coordPrecision) {
  for (const v of vals) {
    if (coordPrecision === COORD_PRECISION.FLOAT32) w.writeFloat32(v)
    else w.writeFloat64(v)
  }
}

function writeLEB128Array(w, arr) {
  for (const v of arr) w.writeLEB128(v >>> 0)
}

// ── Feature ID column ──────────────────────────────────────────────────────

function writeFidColumn(w, fidKind, fids, numFeatures) {
  if (fidKind === FID_KIND.FID_ABSENT) return
  if (!fids || fids.length !== numFeatures)
    throw new Error(`fids.length must equal numFeatures (${numFeatures})`)
  if (fidKind === FID_KIND.FID_STRING) {
    for (const fid of fids) {
      const utf8 = _enc.encode(String(fid))
      w.writeLEB128(utf8.length); w.writeBytes(utf8)
    }
  } else if (fidKind === FID_KIND.FID_UINT64) {
    for (const fid of fids) {
      const bv = BigInt(fid)
      const lo = Number(bv & 0xFFFFFFFFn), hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
    }
  } else {
    throw new Error(`unknown_fid_kind: ${fidKind}`)
  }
}

// ── Geometry section encoding ──────────────────────────────────────────────
//
// geom object shape per GEOM_TYPE:
//   POINT:           { xCol, yCol, zCol? }
//   LINESTRING:      { coordCounts, xCol, yCol, zCol? }
//   POLYGON:         { ringsPerFeature, ringCounts, xCol, yCol, zCol? }
//   MULTIPOINT:      { partCounts, xCol, yCol, zCol? }
//   MULTILINESTRING: { partCounts, coordCounts, xCol, yCol, zCol? }
//   MULTIPOLYGON:    { partCounts, ringsPerPart, ringCounts, xCol, yCol, zCol? }
//   NULL_GEOMETRY:   {} (no coordinate data)
//
// Wire order for POLYGON:  ringsPerFeature → ringCounts → x → y → [z]
// (decodable order: outer count array comes first so decoder knows the inner array length)

function writeGeomSection(w, geomType, geom, hasZ, coordPrecision) {
  switch (geomType) {
    case GEOM_TYPE.POINT: {
      writeCoordCol(w, geom.xCol, coordPrecision)
      writeCoordCol(w, geom.yCol, coordPrecision)
      if (hasZ) writeCoordCol(w, geom.zCol, coordPrecision)
      break
    }
    case GEOM_TYPE.LINESTRING: {
      writeLEB128Array(w, geom.coordCounts)
      writeCoordCol(w, geom.xCol, coordPrecision)
      writeCoordCol(w, geom.yCol, coordPrecision)
      if (hasZ) writeCoordCol(w, geom.zCol, coordPrecision)
      break
    }
    case GEOM_TYPE.POLYGON: {
      // ringsPerFeature first (outer), then ringCounts (inner) — decodable order
      writeLEB128Array(w, geom.ringsPerFeature)
      writeLEB128Array(w, geom.ringCounts)
      writeCoordCol(w, geom.xCol, coordPrecision)
      writeCoordCol(w, geom.yCol, coordPrecision)
      if (hasZ) writeCoordCol(w, geom.zCol, coordPrecision)
      break
    }
    case GEOM_TYPE.MULTIPOINT: {
      writeLEB128Array(w, geom.partCounts)
      writeCoordCol(w, geom.xCol, coordPrecision)
      writeCoordCol(w, geom.yCol, coordPrecision)
      if (hasZ) writeCoordCol(w, geom.zCol, coordPrecision)
      break
    }
    case GEOM_TYPE.MULTILINESTRING: {
      writeLEB128Array(w, geom.partCounts)
      writeLEB128Array(w, geom.coordCounts)
      writeCoordCol(w, geom.xCol, coordPrecision)
      writeCoordCol(w, geom.yCol, coordPrecision)
      if (hasZ) writeCoordCol(w, geom.zCol, coordPrecision)
      break
    }
    case GEOM_TYPE.MULTIPOLYGON: {
      writeLEB128Array(w, geom.partCounts)
      writeLEB128Array(w, geom.ringsPerPart)
      writeLEB128Array(w, geom.ringCounts)
      writeCoordCol(w, geom.xCol, coordPrecision)
      writeCoordCol(w, geom.yCol, coordPrecision)
      if (hasZ) writeCoordCol(w, geom.zCol, coordPrecision)
      break
    }
    case GEOM_TYPE.NULL_GEOMETRY:
      break  // no coordinate data
    default:
      throw new Error(`unknown_geom_type: ${geomType}`)
  }
}

// ── Property columns ───────────────────────────────────────────────────────

function writePropCols(w, propCols, numFeatures) {
  for (const col of propCols) {
    if (col.ctype === 15) throw new Error("fid_in_property_col")
    if (col.ctype > 14) throw new Error(`unknown_ctype: ${col.ctype}`)
    const nameBytes = _enc.encode(String(col.name))
    w.writeLEB128(nameBytes.length); w.writeBytes(nameBytes)
    w.writeByte(col.ctype & 0xFF)
    w.writeByte(col.nullable ? 0x01 : 0x00)
    if (col.nullable) writeNullBitmap(w, col.values, numFeatures)
    writeValueColumn(w, col.ctype, col.values)
  }
}

// ── feature_block payload ──────────────────────────────────────────────────

function writeFeatureBlockPayload(w, blk) {
  const geomType       = blk.geomType       ?? GEOM_TYPE.POINT
  const coordPrecision = blk.coordPrecision ?? COORD_PRECISION.FLOAT64
  const hasZ           = blk.hasZ           ?? false
  const fidKind        = blk.fidKind        ?? FID_KIND.FID_ABSENT
  const numFeatures    = blk.numFeatures
  const propCols       = blk.propCols       ?? []

  if (!numFeatures || numFeatures < 1) throw new Error("empty_feature_block")
  if (geomType > 7) throw new Error(`unknown_geom_type: ${geomType}`)
  if (coordPrecision > 1) throw new Error(`unknown_coord_precision: ${coordPrecision}`)
  if (hasZ !== false && hasZ !== true && hasZ !== 0 && hasZ !== 1)
    throw new Error(`unknown_has_z: ${hasZ}`)
  if (fidKind > 2) throw new Error(`unknown_fid_kind: ${fidKind}`)

  w.writeByte(geomType)
  w.writeByte(coordPrecision)
  w.writeByte(hasZ ? 1 : 0)
  w.writeByte(fidKind)
  w.writeLEB128(numFeatures)
  w.writeLEB128(propCols.length)

  writeFidColumn(w, fidKind, blk.fids, numFeatures)
  writeGeomSection(w, geomType, blk.geom ?? {}, hasZ ? true : false, coordPrecision)
  writePropCols(w, propCols, numFeatures)
}

// ── geometry_collection_block payload ─────────────────────────────────────

function writeGCBlockPayload(w, blk) {
  const coordPrecision = blk.coordPrecision ?? COORD_PRECISION.FLOAT64
  const hasZ           = blk.hasZ           ?? false
  const fidKind        = blk.fidKind        ?? FID_KIND.FID_ABSENT
  const numFeatures    = blk.numFeatures
  const subGeomCounts  = blk.subGeomCounts  ?? []
  const subGeoms       = blk.subGeoms       ?? []
  const propCols       = blk.propCols       ?? []

  if (!numFeatures || numFeatures < 1) throw new Error("empty_feature_block")

  const totalSubGeoms = subGeoms.length
  w.writeByte(coordPrecision)
  w.writeByte(hasZ ? 1 : 0)
  w.writeByte(fidKind)
  w.writeLEB128(numFeatures)
  w.writeLEB128(propCols.length)

  writeFidColumn(w, fidKind, blk.fids, numFeatures)

  w.writeLEB128(totalSubGeoms)
  writeLEB128Array(w, subGeomCounts)

  // sub-geometry types
  for (const sg of subGeoms) {
    if (sg.geomType === GEOM_TYPE.GEOMETRY_COLLECTION)
      throw new Error("nested_geometry_collection")
    w.writeByte(sg.geomType)
  }

  // sub-geometry payloads (each as single-feature geometry section)
  for (const sg of subGeoms) {
    writeGeomSection(w, sg.geomType, sg.geom ?? {}, hasZ ? true : false, coordPrecision)
  }

  writePropCols(w, propCols, numFeatures)
}

// ── Path encoding ──────────────────────────────────────────────────────────

function writeInnerPath(w, path) {
  // Inner path must be FEAT_BY_IDX, FEAT_BY_STR_FID, or FEAT_BY_INT_FID
  const kind = path.kind
  if (kind > 2) throw new Error(`invalid inner path kind: ${kind}`)
  w.writeByte((kind & 0xF) << 4)
  if (kind === PATH_KIND.FEAT_BY_IDX) {
    w.writeLEB128(path.index >>> 0)
  } else if (kind === PATH_KIND.FEAT_BY_STR_FID) {
    const utf8 = _enc.encode(String(path.fid))
    w.writeLEB128(utf8.length); w.writeBytes(utf8)
  } else if (kind === PATH_KIND.FEAT_BY_INT_FID) {
    const bv = BigInt(path.fid)
    const lo = Number(bv & 0xFFFFFFFFn), hi = Number((bv >> 32n) & 0xFFFFFFFFn)
    w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
    w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
    w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
    w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
  }
}

function writePath(w, path) {
  const kind = path.kind
  if (kind > 5) throw new Error(`unknown_path_kind: ${kind}`)
  w.writeByte((kind & 0xF) << 4)
  switch (kind) {
    case PATH_KIND.FEAT_BY_IDX:
      w.writeLEB128(path.index >>> 0)
      break
    case PATH_KIND.FEAT_BY_STR_FID: {
      const utf8 = _enc.encode(String(path.fid))
      w.writeLEB128(utf8.length); w.writeBytes(utf8)
      break
    }
    case PATH_KIND.FEAT_BY_INT_FID: {
      const bv = BigInt(path.fid)
      const lo = Number(bv & 0xFFFFFFFFn), hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
      break
    }
    case PATH_KIND.FEAT_GEOMETRY:
      writeInnerPath(w, path.inner)
      break
    case PATH_KIND.FEAT_PROP_NAME: {
      writeInnerPath(w, path.inner)
      const utf8 = _enc.encode(String(path.name))
      w.writeLEB128(utf8.length); w.writeBytes(utf8)
      break
    }
    case PATH_KIND.FEAT_PROP_IDX:
      writeInnerPath(w, path.inner)
      w.writeLEB128(path.colIdx >>> 0)
      break
  }
}

// ── Delta op encoding ──────────────────────────────────────────────────────

function writeOp(w, op) {
  const code = op.op
  if (code > 5) throw new Error(`unknown_delta_op: ${code}`)
  w.writeByte(code << 3)

  switch (code) {
    case OP.FEATURE_INSERT: {
      const blk = op.block
      if (blk.type === 'feature') {
        w.writeByte(BLOCK_TYPE.FEATURE)
        writeFeatureBlockPayload(w, blk)
      } else if (blk.type === 'geometry_collection') {
        w.writeByte(BLOCK_TYPE.GEOMETRY_COLLECTION)
        writeGCBlockPayload(w, blk)
      } else {
        throw new Error(`feature_insert: unknown block type ${blk.type}`)
      }
      break
    }

    case OP.FEATURE_DELETE: {
      const mode = op.mode ?? 0
      w.writeByte(mode)
      if (mode === 0) {
        // path_list
        const paths = op.paths ?? []
        w.writeLEB128(paths.length)
        for (const p of paths) writePath(w, p)
      } else if (mode === 1) {
        // index_range
        w.writeLEB128(op.start >>> 0)
        w.writeLEB128(op.count >>> 0)
      } else {
        throw new Error(`feature_delete: unknown mode ${mode}`)
      }
      break
    }

    case OP.GEOMETRY_REPLACE: {
      writePath(w, op.path)
      // embedded single-feature block (no outer block-type needed; encoded inline)
      const blk = op.block
      w.writeByte(BLOCK_TYPE.FEATURE)
      writeFeatureBlockPayload(w, blk)
      break
    }

    case OP.PROP_SET: {
      writePath(w, op.path)
      const ctype = op.ctype
      if (ctype > 14) throw new Error(`unknown_ctype: ${ctype}`)
      w.writeByte(ctype)
      writeValue(w, ctype, op.value)
      break
    }

    case OP.PROP_DELETE:
      writePath(w, op.path)
      break

    case OP.COLLECTION_REPLACE: {
      const blocks = op.blocks ?? []
      w.writeLEB128(blocks.length)
      for (const blk of blocks) {
        if (blk.type === 'delta') throw new Error("delta_inside_replace")
        if (blk.type === 'feature') {
          w.writeByte(BLOCK_TYPE.FEATURE)
          writeFeatureBlockPayload(w, blk)
        } else if (blk.type === 'geometry_collection') {
          w.writeByte(BLOCK_TYPE.GEOMETRY_COLLECTION)
          writeGCBlockPayload(w, blk)
        } else {
          throw new Error(`collection_replace: unknown block type ${blk.type}`)
        }
      }
      break
    }
  }
}

// ── delta_frame block ──────────────────────────────────────────────────────

function writeDeltaFrame(w, blk) {
  const nameBytes = _enc.encode(String(blk.name ?? ""))
  w.writeLEB128(nameBytes.length)
  if (nameBytes.length) w.writeBytes(nameBytes)
  const ops = blk.ops ?? []
  w.writeLEB128(ops.length)
  for (const op of ops) writeOp(w, op)
}

// ── Public: encodeDocument ─────────────────────────────────────────────────
//
// doc = { name?: string, blocks: Block[] }
// Returns Uint8Array.

export function encodeDocument(doc) {
  const w = new ByteWriter()
  const nameBytes = _enc.encode(String(doc.name ?? ""))
  w.writeByte(PROFILE_NUM)      // profile id = 8
  w.writeLEB128(nameBytes.length)
  if (nameBytes.length) w.writeBytes(nameBytes)
  const blocks = doc.blocks ?? []
  w.writeLEB128(blocks.length)
  for (const blk of blocks) {
    if (blk.type === 'feature') {
      w.writeByte(BLOCK_TYPE.FEATURE)
      writeFeatureBlockPayload(w, blk)
    } else if (blk.type === 'geometry_collection') {
      w.writeByte(BLOCK_TYPE.GEOMETRY_COLLECTION)
      writeGCBlockPayload(w, blk)
    } else if (blk.type === 'delta') {
      w.writeByte(BLOCK_TYPE.DELTA)
      writeDeltaFrame(w, blk)
    } else {
      throw new Error(`unknown block type: ${blk.type}`)
    }
  }
  return w.toBytes()
}
