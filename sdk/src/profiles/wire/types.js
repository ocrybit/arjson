// weavepack-wire — type constants.
// See weavepack/profiles/wire/01-types.md and 02-containers.md for the normative spec.
//
// Profile isolation: this file imports nothing from other profiles.

export const VTYPE = Object.freeze({
  BOOL:    0,
  INT32:   1,
  INT64:   2,
  UINT32:  3,
  UINT64:  4,
  SINT32:  5,
  SINT64:  6,
  FLOAT32: 7,
  FLOAT64: 8,
  STRING:  9,
  BYTES:   10,
  ENUM:    11,
})

export const CTYPE = Object.freeze({
  MESSAGE:  0,
  REPEATED: 1,
  MAP:      2,
  ONEOF:    3,
})

// Delta op codes (3 bits, 0..7). See weavepack/profiles/wire/04-deltas.md.
export const OP = Object.freeze({
  FIELD_SET:       0,
  FIELD_DELETE:    1,
  MESSAGE_REPLACE: 2,
  REPEATED_APPEND: 3,
  REPEATED_SPLICE: 4,
  MAP_SET:         5,
  MAP_DELETE:      6,
  ONEOF_SWITCH:    7,
})

// Path component types. See weavepack/profiles/wire/03-paths.md.
export const PC = Object.freeze({
  FIELD: 0,
  MAP:   1,
  INDEX: 2,
  END:   3,
})

// Document flags (byte 0).
export const FLAG_SCHEMALESS = 0x00
export const FLAG_DELTA      = 0x01
export const FLAG_SCHEMAFUL  = 0x02

export const PROFILE_ID      = "wire"
export const PROFILE_VERSION = "0.1"

// Type-tag byte encoding:
//   bits 0-3 = vtype (0..11) when bit 4 = 0
//   bit  4   = 1 → container; bits 0-1 = ctype (0..3)
export function scalarTag(vtype)    { return vtype & 0x0F }
export function containerTag(ctype) { return 0x10 | (ctype & 0x03) }
export function isContainer(tag)    { return (tag & 0x10) !== 0 }
export function getVtype(tag)       { return tag & 0x0F }
export function getCtype(tag)       { return tag & 0x03 }

// Convenience tags for containers.
export const TAG_MESSAGE  = containerTag(CTYPE.MESSAGE)
export const TAG_REPEATED = containerTag(CTYPE.REPEATED)
export const TAG_MAP      = containerTag(CTYPE.MAP)
export const TAG_ONEOF    = containerTag(CTYPE.ONEOF)

// Maximum string/bytes payload the decoder will accept (256 MiB).
export const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
