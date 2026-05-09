// weavepack-graph — encoder (graph documents + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire/tabular/log code.
//
// Binary layouts:
//   Graph document (snapshot):
//     graph_version  : LEB128 uint32 = 1
//     profile_id     : LEB128 uint32 = 6
//     schema_hash    : 32 bytes
//     num_blocks     : LEB128 uint32
//     block[*]       : each prefixed by 1-byte block_type (0=node, 1=edge)
//
//   Delta chain:
//     graph_version  : LEB128 uint32 = 1
//     profile_id     : LEB128 uint32 = 6
//     schema_hash    : 32 bytes
//     num_ops        : LEB128 uint32
//     op[*]          : 1-byte op_code + op-specific payload
//
// See weavepack/profiles/graph/02-containers.md and 04-deltas.md.

import {
  CTYPE, OP, PATH_KIND,
  BLOCK_TYPE_NODE, BLOCK_TYPE_EDGE,
  SCHEMA_HASH_BYTES, GRAPH_VERSION, PROFILE_NUM,
  MAX_STRING_BYTES,
  nullBitmapBytes, setNullBit,
} from "./types.js"

const _enc = new TextEncoder()

// ── ByteWriter ─────────────────────────────────────────────────────────────

class ByteWriter {
  constructor() { this._buf = [] }

  writeByte(b) { this._buf.push(b & 0xFF) }

  writeBytes(src) {
    for (let i = 0; i < src.length; i++) this._buf.push(src[i] & 0xFF)
  }

  writeLEB128(v) {
    v = v >>> 0
    while (v >= 128) {
      this._buf.push((v & 0x7F) | 0x80)
      v >>>= 7
    }
    this._buf.push(v)
  }

  writeLEB128Big(v) {
    v = BigInt(v)
    while (v >= 128n) {
      this._buf.push(Number(v & 0x7Fn) | 0x80)
      v >>= 7n
    }
    this._buf.push(Number(v))
  }

  toBytes() { return new Uint8Array(this._buf) }
}

// ── Per-ctype single value encoding ──────────────────────────────────────

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
      const v = value | 0
      const u = v < 0 ? v + 0x100000000 : v
      w.writeByte(u & 0xFF); w.writeByte((u >> 8) & 0xFF)
      w.writeByte((u >> 16) & 0xFF); w.writeByte((u >> 24) & 0xFF)
      break
    }
    case CTYPE.INT64:
    case CTYPE.TIMESTAMP64: {
      const bv = BigInt(value)
      const lo = Number(bv & 0xFFFFFFFFn)
      const hi = Number((bv >> 32n) & 0xFFFFFFFFn)
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
    case CTYPE.UINT64:
    case CTYPE.NODE_ID: {
      const bv = BigInt(value)
      const lo = Number(bv & 0xFFFFFFFFn)
      const hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
      break
    }
    case CTYPE.FLOAT32: {
      const tmp = new ArrayBuffer(4)
      new DataView(tmp).setFloat32(0, value, true)
      w.writeBytes(new Uint8Array(tmp))
      break
    }
    case CTYPE.FLOAT64: {
      const tmp = new ArrayBuffer(8)
      new DataView(tmp).setFloat64(0, value, true)
      w.writeBytes(new Uint8Array(tmp))
      break
    }
    case CTYPE.STRING: {
      const utf8 = _enc.encode(String(value))
      if (utf8.length > MAX_STRING_BYTES) throw new Error("string_too_large: string exceeds 1 GiB limit")
      w.writeLEB128(utf8.length)
      w.writeBytes(utf8)
      break
    }
    case CTYPE.BYTES: {
      const src = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (src.length > MAX_STRING_BYTES) throw new Error("string_too_large: bytes exceeds 1 GiB limit")
      w.writeLEB128(src.length)
      w.writeBytes(src)
      break
    }
    case CTYPE.DATE32: {
      const v = value | 0
      const u = v < 0 ? v + 0x100000000 : v
      w.writeByte(u & 0xFF); w.writeByte((u >> 8) & 0xFF)
      w.writeByte((u >> 16) & 0xFF); w.writeByte((u >> 24) & 0xFF)
      break
    }
    default:
      throw new Error(`unknown_ctype: ctype ${ctype}`)
  }
}

// Bool value column: 1 bit per value, LSB-first within each byte (see 02-containers.md).
function writeBoolColumn(w, values) {
  const n = values.length
  const bytes = new Uint8Array(Math.ceil(n / 8))
  for (let i = 0; i < n; i++) {
    if (values[i]) bytes[i >> 3] |= (1 << (i & 7))
  }
  w.writeBytes(bytes)
}

// Write null bitmap for a nullable column (MSB-first: bit i set = NULL at index i).
function writeNullBitmap(w, values, numElems) {
  const bytes = new Uint8Array(nullBitmapBytes(numElems))
  for (let i = 0; i < numElems; i++) {
    if (values[i] === null || values[i] === undefined) setNullBit(bytes, i)
  }
  w.writeBytes(bytes)
}

// Write value column for a given ctype; nulls are skipped (caller wrote null bitmap).
function writeValueColumn(w, ctype, values) {
  const nonNull = values.filter(v => v !== null && v !== undefined)
  if (ctype === CTYPE.BOOL) {
    writeBoolColumn(w, nonNull)
  } else {
    for (const v of nonNull) writeValue(w, ctype, v)
  }
}

// ── NID / EID delta-pack column ────────────────────────────────────────────

function writeIdDeltaColumn(w, ids) {
  if (ids.length === 0) return
  w.writeLEB128Big(BigInt(ids[0]))
  for (let i = 1; i < ids.length; i++) {
    const delta = BigInt(ids[i]) - BigInt(ids[i - 1])
    if (delta < 1n)
      throw new Error(`duplicate_element_id: id delta must be ≥1; got ${delta} at index ${i}`)
    w.writeLEB128Big(delta)
  }
}

// ── SRC / DST plain uint64 column ─────────────────────────────────────────

function writePlainUint64Column(w, values) {
  for (const v of values) {
    const bv = BigInt(v)
    const lo = Number(bv & 0xFFFFFFFFn)
    const hi = Number((bv >> 32n) & 0xFFFFFFFFn)
    w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
    w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
    w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
    w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
  }
}

// ── Property column schema + data ─────────────────────────────────────────
//
// Schema entry: LEB128 col_id + 1-byte type_byte: (nullable << 4) | (ctype & 0xF)
// Data entry: [null_bitmap if nullable] + value column

function writePropColSchema(w, col) {
  if (col.colId < 2)
    throw new Error(`reserved_col_id: col_id ${col.colId} is reserved (node block: must be ≥ 2)`)
  if (col.ctype > 15)
    throw new Error(`unknown_ctype: ctype ${col.ctype} ≥ 16 is reserved`)
  w.writeLEB128(col.colId >>> 0)
  w.writeByte(((col.nullable ? 1 : 0) << 4) | (col.ctype & 0xF))
}

function writePropColData(w, col, numElems) {
  if (col.values.length !== numElems)
    throw new Error(`column ${col.colId} has ${col.values.length} values but block has ${numElems} elements`)
  if (col.nullable) writeNullBitmap(w, col.values, numElems)
  writeValueColumn(w, col.ctype, col.values)
}

// ── Node block ─────────────────────────────────────────────────────────────
//
// node_block = {
//   label?:   string (null or absent = no label),
//   nids:     BigInt[],
//   columns:  [{ colId, ctype, nullable, values }],  (col_id ≥ 2)
// }

function writeNodeBlock(w, block) {
  const nids    = block.nids ?? []
  const cols    = block.columns ?? []
  const numNodes = nids.length

  const labelBytes = block.label ? _enc.encode(block.label) : new Uint8Array(0)
  w.writeLEB128Big(BigInt(numNodes))
  w.writeLEB128(labelBytes.length)
  if (labelBytes.length > 0) w.writeBytes(labelBytes)

  w.writeLEB128(cols.length)
  for (const col of cols) {
    if (col.colId < 2)
      throw new Error(`reserved_col_id: col_id ${col.colId} is reserved (node block: col_id must be ≥ 2)`)
    writePropColSchema(w, col)
  }

  writeIdDeltaColumn(w, nids)

  for (const col of cols) writePropColData(w, col, numNodes)
}

// ── Edge block ─────────────────────────────────────────────────────────────
//
// edge_block = {
//   label?:   string,
//   eids:     BigInt[],
//   srcs:     BigInt[],  (node_id references)
//   dsts:     BigInt[],  (node_id references)
//   columns:  [{ colId, ctype, nullable, values }],  (col_id ≥ 4)
// }

function writeEdgeBlock(w, block) {
  const eids     = block.eids ?? []
  const srcs     = block.srcs ?? []
  const dsts     = block.dsts ?? []
  const cols     = block.columns ?? []
  const numEdges = eids.length

  if (srcs.length !== numEdges)
    throw new Error(`srcs.length (${srcs.length}) must equal eids.length (${numEdges})`)
  if (dsts.length !== numEdges)
    throw new Error(`dsts.length (${dsts.length}) must equal eids.length (${numEdges})`)

  const labelBytes = block.label ? _enc.encode(block.label) : new Uint8Array(0)
  w.writeLEB128Big(BigInt(numEdges))
  w.writeLEB128(labelBytes.length)
  if (labelBytes.length > 0) w.writeBytes(labelBytes)

  w.writeLEB128(cols.length)
  for (const col of cols) {
    if (col.colId < 4)
      throw new Error(`reserved_col_id: col_id ${col.colId} is reserved (edge block: col_id must be ≥ 4)`)
    writePropColSchema(w, col)
  }

  writeIdDeltaColumn(w, eids)
  writePlainUint64Column(w, srcs)
  writePlainUint64Column(w, dsts)

  for (const col of cols) writePropColData(w, col, numEdges)
}

// ── Graph document header ──────────────────────────────────────────────────

function writeDocHeader(w, schemaHash) {
  w.writeLEB128(GRAPH_VERSION)
  w.writeLEB128(PROFILE_NUM)
  const hash = schemaHash instanceof Uint8Array ? schemaHash : new Uint8Array(SCHEMA_HASH_BYTES)
  if (hash.length !== SCHEMA_HASH_BYTES)
    throw new Error(`schema_hash must be exactly ${SCHEMA_HASH_BYTES} bytes`)
  w.writeBytes(hash)
}

// ── Public: graph document (snapshot) ─────────────────────────────────────
//
// graph = {
//   schemaHash?: Uint8Array (32 bytes; omit → all-zero),
//   blocks:      Array of { type: 'node'|'edge', ...block-fields },
// }

export function encodeGraph(graph) {
  const w = new ByteWriter()
  const { blocks = [] } = graph
  writeDocHeader(w, graph.schemaHash)
  w.writeLEB128(blocks.length)
  for (const blk of blocks) {
    if (blk.type === 'node') {
      w.writeByte(BLOCK_TYPE_NODE)
      writeNodeBlock(w, blk)
    } else if (blk.type === 'edge') {
      w.writeByte(BLOCK_TYPE_EDGE)
      writeEdgeBlock(w, blk)
    } else {
      throw new Error(`unknown block type: ${blk.type}`)
    }
  }
  return w.toBytes()
}

// ── Path encoding (for prop_set) ───────────────────────────────────────────
//
// First byte: path_kind in high nibble (bits 7:4), zero low nibble.
// Payload bytes follow.

function writePath(w, path) {
  const kind = path.kind
  if (kind === 15)
    throw new Error("unknown_path_kind: path kind 15 is reserved")
  w.writeByte((kind & 0xF) << 4)
  switch (kind) {
    case PATH_KIND.NODE:           w.writeLEB128Big(BigInt(path.nid)); break
    case PATH_KIND.NODE_COL:       w.writeLEB128Big(BigInt(path.nid)); w.writeLEB128(path.colId >>> 0); break
    case PATH_KIND.EDGE:           w.writeLEB128Big(BigInt(path.eid)); break
    case PATH_KIND.EDGE_COL:       w.writeLEB128Big(BigInt(path.eid)); w.writeLEB128(path.colId >>> 0); break
    case PATH_KIND.NODE_LABEL: {
      const lb = _enc.encode(path.label ?? "")
      w.writeLEB128(lb.length); w.writeBytes(lb)
      break
    }
    case PATH_KIND.NODE_LABEL_COL: {
      const lb = _enc.encode(path.label ?? "")
      w.writeLEB128(lb.length); w.writeBytes(lb)
      w.writeLEB128(path.colId >>> 0)
      break
    }
    case PATH_KIND.EDGE_LABEL: {
      const lb = _enc.encode(path.label ?? "")
      w.writeLEB128(lb.length); w.writeBytes(lb)
      break
    }
    case PATH_KIND.EDGE_LABEL_COL: {
      const lb = _enc.encode(path.label ?? "")
      w.writeLEB128(lb.length); w.writeBytes(lb)
      w.writeLEB128(path.colId >>> 0)
      break
    }
    case PATH_KIND.AT_NID:
    case PATH_KIND.AT_EID:
    case PATH_KIND.AT_SRC:
    case PATH_KIND.AT_DST:
      break  // no payload
    case PATH_KIND.AT_LABEL: {
      const lb = _enc.encode(path.label ?? "")
      w.writeLEB128(lb.length); w.writeBytes(lb)
      break
    }
    case PATH_KIND.NODE_PROP: {
      const lb = _enc.encode(path.prop ?? "")
      w.writeLEB128Big(BigInt(path.nid))
      w.writeLEB128(lb.length); w.writeBytes(lb)
      break
    }
    case PATH_KIND.EDGE_PROP: {
      const lb = _enc.encode(path.prop ?? "")
      w.writeLEB128Big(BigInt(path.eid))
      w.writeLEB128(lb.length); w.writeBytes(lb)
      break
    }
    default:
      throw new Error(`unknown_path_kind: path kind ${kind}`)
  }
}

// ── Delta op encoding ──────────────────────────────────────────────────────

function writeNodeInsert(w, op) {
  writeNodeBlock(w, op.block)
}

function writeNodeDelete(w, op) {
  const nids = op.nids ?? []
  w.writeLEB128Big(BigInt(nids.length))
  for (const nid of nids) w.writeLEB128Big(BigInt(nid))
}

function writeEdgeInsert(w, op) {
  writeEdgeBlock(w, op.block)
}

function writeEdgeDelete(w, op) {
  const eids = op.eids ?? []
  w.writeLEB128Big(BigInt(eids.length))
  for (const eid of eids) w.writeLEB128Big(BigInt(eid))
}

function writePropSet(w, op) {
  writePath(w, op.path)
  // ctype: 4 bits in low nibble, 4 padding bits in high nibble
  w.writeByte(op.ctype & 0xF)
  // flags byte: bit 0 = nullable, bit 1 = is_null, bits 7:2 = padding
  const isNull = op.value === null || op.value === undefined
  const nullable = op.nullable ? 1 : 0
  const isNullBit = (nullable && isNull) ? 1 : 0
  w.writeByte((nullable & 1) | (isNullBit << 1))
  if (!isNullBit) writeValue(w, op.ctype, op.value)
}

function writeSubgraphReplace(w, op) {
  const hasNode = op.nodeBlock != null ? 1 : 0
  const hasEdge = op.edgeBlock != null ? 1 : 0
  w.writeByte((hasNode & 1) | ((hasEdge & 1) << 1))
  const labelBytes = op.label ? _enc.encode(op.label) : new Uint8Array(0)
  w.writeLEB128(labelBytes.length)
  if (labelBytes.length > 0) w.writeBytes(labelBytes)
  if (hasNode) writeNodeBlock(w, op.nodeBlock)
  if (hasEdge) writeEdgeBlock(w, op.edgeBlock)
}

function writeOp(w, op) {
  const opCode = op.op
  if (opCode > 5)
    throw new Error(`unknown_delta_op: op code ${opCode} is reserved (must be 0–5)`)
  // 3-bit op code in low bits of byte, 5 padding bits in high bits.
  w.writeByte(opCode & 0x7)
  switch (opCode) {
    case OP.NODE_INSERT:      writeNodeInsert(w, op);      break
    case OP.NODE_DELETE:      writeNodeDelete(w, op);      break
    case OP.EDGE_INSERT:      writeEdgeInsert(w, op);      break
    case OP.EDGE_DELETE:      writeEdgeDelete(w, op);      break
    case OP.PROP_SET:         writePropSet(w, op);         break
    case OP.SUBGRAPH_REPLACE: writeSubgraphReplace(w, op); break
    default:
      throw new Error(`unknown_delta_op: op code ${opCode}`)
  }
}

// ── Public: delta chain ────────────────────────────────────────────────────
//
// chain = { schemaHash?, ops: [...] }
//
// Wire: graph_version + profile_id + schema_hash + LEB128(num_ops) + op[*]

export function encodeChain({ schemaHash, ops = [] }) {
  const w = new ByteWriter()
  writeDocHeader(w, schemaHash)
  w.writeLEB128(ops.length)
  for (const op of ops) writeOp(w, op)
  return w.toBytes()
}
