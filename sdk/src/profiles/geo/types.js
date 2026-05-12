// weavepack-geo — type constants.
//
// See weavepack/profiles/geo/01-types.md for the normative spec.
//
// Profile isolation: this file imports nothing from other profiles.

export const CTYPE = Object.freeze({
  BOOL:        0,
  INT8:        1,
  INT16:       2,
  INT32:       3,
  INT64:       4,
  UINT8:       5,
  UINT16:      6,
  UINT32:      7,
  UINT64:      8,
  FLOAT32:     9,
  FLOAT64:    10,
  STRING:     11,
  BYTES:      12,
  DATE32:     13,
  TIMESTAMP64: 14,
  // ctype 15 = FID (geo-profile internal; not allowed in user prop columns)
})

export const GEOM_TYPE = Object.freeze({
  POINT:               0,
  LINESTRING:          1,
  POLYGON:             2,
  MULTIPOINT:          3,
  MULTILINESTRING:     4,
  MULTIPOLYGON:        5,
  GEOMETRY_COLLECTION: 6,
  NULL_GEOMETRY:       7,
})

export const COORD_PRECISION = Object.freeze({
  FLOAT64: 0,
  FLOAT32: 1,
})

export const FID_KIND = Object.freeze({
  FID_ABSENT: 0,
  FID_STRING: 1,
  FID_UINT64: 2,
})

// Delta op codes — stored in bits 7–3 of the op-header byte.
// op_header byte = opCode << 3.  Bits 2–0 = reserved (zero on write).
export const OP = Object.freeze({
  FEATURE_INSERT:    0,
  FEATURE_DELETE:    1,
  GEOMETRY_REPLACE:  2,
  PROP_SET:          3,
  PROP_DELETE:       4,
  COLLECTION_REPLACE: 5,
})

// Wire path-kind discriminants (4-bit, packed in high nibble of path byte).
// path_header byte = pathKind << 4.  Bits 3–0 = reserved (zero on write).
export const PATH_KIND = Object.freeze({
  FEAT_BY_IDX:     0,  // payload: LEB128 index
  FEAT_BY_STR_FID: 1,  // payload: LEB128 len, UTF-8
  FEAT_BY_INT_FID: 2,  // payload: 8 bytes uint64 LE
  FEAT_GEOMETRY:   3,  // payload: inner path (0–2)
  FEAT_PROP_NAME:  4,  // payload: inner path (0–2), LEB128 name_len, UTF-8
  FEAT_PROP_IDX:   5,  // payload: inner path (0–2), LEB128 col_idx
  // 6–15 reserved
})

export const BLOCK_TYPE = Object.freeze({
  FEATURE:             0x00,
  GEOMETRY_COLLECTION: 0x01,
  DELTA:               0x02,
})

export const PROFILE_NUM = 8

export const MAX_STRING_BYTES = 1 * 1024 * 1024 * 1024

// Null bitmap — LSB-first per spec (01-types.md):
//   bit i is at byte[i>>3], bit position (i & 7).
export function nullBitmapBytes(n) { return Math.ceil(n / 8) }
export function getNullBit(bitmap, idx) { return (bitmap[idx >> 3] >> (idx & 7)) & 1 }
export function setNullBit(bitmap, idx) { bitmap[idx >> 3] |= (1 << (idx & 7)) }
