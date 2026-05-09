// weavepack-log — type constants.
//
// See weavepack/profiles/log/01-types.md for the normative spec.
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
  LEVEL:      16,
})

// Severity levels for the LEVEL ctype. Values 6-7 are reserved.
export const LEVEL = Object.freeze({
  TRACE: 0,
  DEBUG: 1,
  INFO:  2,
  WARN:  3,
  ERROR: 4,
  FATAL: 5,
})

// Delta op codes (0..4; 5-7 reserved). See weavepack/profiles/log/04-deltas.md.
export const OP = Object.freeze({
  EVENT_APPEND:      0,
  FIELD_UPDATE:      1,
  EVENT_EXPIRE:      2,
  SCHEMA_EVOLVE:     3,
  CURSOR_CHECKPOINT: 4,
})

// Sub-op codes for SCHEMA_EVOLVE; code 3 is reserved.
export const SCHEMA_SUB_OP = Object.freeze({
  COLUMN_ADD:    0,
  COLUMN_DROP:   1,
  COLUMN_RENAME: 2,
})

export const FRAME_SNAPSHOT      = 0x00
export const FRAME_DELTA         = 0x01
export const FRAME_STREAM_HEADER = 0x02

export const PROFILE_ID      = "log"
export const PROFILE_VERSION = "0.1"

// Schema hash is always 32 bytes (all-zero = no schema attached).
export const SCHEMA_HASH_BYTES = 32
// Stream ID is a 16-byte UUID.
export const STREAM_ID_BYTES   = 16

// Safety limits (denial-of-service guards). See 01-types.md §Size limits.
export const MAX_STRING_BYTES  = 256 * 1024 * 1024
export const MAX_FRAME_BYTES   = 2   * 1024 * 1024 * 1024

// Null bitmap helpers (MSB-first, per 02-containers.md §Null bitmap details).
// bit=1 means NULL for that event.
export function nullBitmapBytes(numEvents) {
  return Math.ceil(numEvents / 8)
}

export function getNullBit(bitmap, eventIdx) {
  return (bitmap[eventIdx >> 3] >> (7 - (eventIdx & 7))) & 1
}

export function setNullBit(bitmap, eventIdx) {
  bitmap[eventIdx >> 3] |= (1 << (7 - (eventIdx & 7)))
}
