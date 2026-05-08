// weavepack-tabular — type constants.
//
// See weavepack/profiles/tabular/01-types.md for the normative spec.
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
  EXT:        15,
})

// Delta op codes (3 bits, 0..6; 7 reserved). See weavepack/profiles/tabular/04-deltas.md.
export const OP = Object.freeze({
  ROW_INSERT:    0,
  ROW_UPDATE:    1,
  ROW_DELETE:    2,
  COLUMN_ADD:    3,
  COLUMN_DROP:   4,
  COLUMN_RENAME: 5,
  BATCH_UPSERT:  6,
})

export const FRAME_SNAPSHOT = 0x00
export const FRAME_DELTA    = 0x01

export const PROFILE_ID      = "tabular"
export const PROFILE_VERSION = "0.1"

// Schema hash is always 32 bytes (all-zero = no schema attached).
export const SCHEMA_HASH_BYTES = 32

// Safety limits (denial-of-service guards). See 01-types.md §Size limits.
export const MAX_STRING_BYTES  = 256 * 1024 * 1024
export const MAX_FRAME_BYTES   = 2  * 1024 * 1024 * 1024

// Null bitmap layout: bit[row_i] = (byte[row_i>>3] >> (7 - (row_i & 7))) & 1.
// A bit of 1 means NULL for that row (per 02-containers.md §Null bitmap details).
export function nullBitmapBytes(numRows) {
  return Math.ceil(numRows / 8)
}

export function getNullBit(bitmap, rowIdx) {
  return (bitmap[rowIdx >> 3] >> (7 - (rowIdx & 7))) & 1
}

export function setNullBit(bitmap, rowIdx) {
  bitmap[rowIdx >> 3] |= (1 << (7 - (rowIdx & 7)))
}
