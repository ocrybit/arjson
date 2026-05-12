// weavepack-ast — type constants.
//
// See weavepack/profiles/ast/01-types.md for the normative spec.
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
  NODE_ID:    15,
})

// Delta op codes (3 bits, 0..5; codes 6–7 reserved). See 04-deltas.md.
export const OP = Object.freeze({
  NODE_INSERT:      0,
  NODE_DELETE:      1,
  NODE_MOVE:        2,
  PROP_SET:         3,
  KIND_RENAME:      4,
  SUBTREE_REPLACE:  5,
})

// Wire path_kind discriminants (4-bit, packed in high nibble of path byte).
// Codes 8–15 reserved; decoder must refuse with unknown_path_kind.
export const PATH_KIND = Object.freeze({
  NODE:           0,  // node/N
  NODE_COL:       1,  // node/N[col_id]
  NODE_KIND:      2,  // kind:K (all nodes with a given kind string)
  AT_NID:         3,  // @nid
  AT_PARENT:      4,  // @parent
  AT_CHILD_INDEX: 5,  // @child_index
  AT_KIND:        6,  // @kind
  NODE_PROP:      7,  // node/N.prop_name
  // 8–15 = reserved; decoder must refuse with unknown_path_kind
})

export const BLOCK_TYPE_NODE  = 0x00
export const BLOCK_TYPE_MIXED = 0x01

export const FRAME_SNAPSHOT = 0x00
export const FRAME_DELTA    = 0x01

export const PROFILE_ID      = "ast"
export const PROFILE_VERSION = "0.1"
export const PROFILE_NUM     = 7   // numeric profile id in ast_document header
export const AST_VERSION     = 1   // wire format version

// Schema hash is always 32 bytes (all-zero = no schema attached).
export const SCHEMA_HASH_BYTES = 32

// Safety limits.
export const MAX_STRING_BYTES = 1 * 1024 * 1024 * 1024

// Null bitmap helpers (MSB-first per spec; bit=1 means NULL).
export function nullBitmapBytes(n) {
  return Math.ceil(n / 8)
}

export function getNullBit(bitmap, idx) {
  return (bitmap[idx >> 3] >> (7 - (idx & 7))) & 1
}

export function setNullBit(bitmap, idx) {
  bitmap[idx >> 3] |= (1 << (7 - (idx & 7)))
}
