// weavepack-graph — type constants.
//
// See weavepack/profiles/graph/01-types.md for the normative spec.
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
  EDGE_INSERT:      2,
  EDGE_DELETE:      3,
  PROP_SET:         4,
  SUBGRAPH_REPLACE: 5,
})

// Wire path_kind discriminants (4-bit, packed in high nibble of path byte).
export const PATH_KIND = Object.freeze({
  NODE:           0,  // node/N
  NODE_COL:       1,  // node/N[col_id]
  EDGE:           2,  // edge/E
  EDGE_COL:       3,  // edge/E[col_id]
  NODE_LABEL:     4,  // .NodeLabel
  NODE_LABEL_COL: 5,  // .NodeLabel[col_id]
  EDGE_LABEL:     6,  // -EdgeLabel
  EDGE_LABEL_COL: 7,  // -EdgeLabel[col_id]
  AT_NID:         8,  // @nid
  AT_EID:         9,  // @eid
  AT_SRC:        10,  // @src
  AT_DST:        11,  // @dst
  AT_LABEL:      12,  // @label.<label>
  NODE_PROP:     13,  // node/N.prop_name
  EDGE_PROP:     14,  // edge/E.prop_name
  // 15 = reserved; decoder must refuse with unknown_path_kind
})

export const BLOCK_TYPE_NODE = 0
export const BLOCK_TYPE_EDGE = 1

export const FRAME_SNAPSHOT = 0x00
export const FRAME_DELTA    = 0x01

export const PROFILE_ID      = "graph"
export const PROFILE_VERSION = "0.1"
export const PROFILE_NUM     = 6   // numeric profile id in graph_document header
export const GRAPH_VERSION   = 1   // wire format version

// Schema hash is always 32 bytes (all-zero = no schema attached).
export const SCHEMA_HASH_BYTES = 32

// Safety limits (denial-of-service guards). See 01-types.md §Capacity limits.
// Max string/bytes property value: 1 GiB (spec says 2^30 bytes).
export const MAX_STRING_BYTES = 1 * 1024 * 1024 * 1024

// Null bitmap helpers (MSB-first, per 02-containers.md §Null bitmap details).
// bit=1 means NULL for that element.
export function nullBitmapBytes(n) {
  return Math.ceil(n / 8)
}

export function getNullBit(bitmap, idx) {
  return (bitmap[idx >> 3] >> (7 - (idx & 7))) & 1
}

export function setNullBit(bitmap, idx) {
  bitmap[idx >> 3] |= (1 << (7 - (idx & 7)))
}
