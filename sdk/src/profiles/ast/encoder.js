// weavepack-ast — encoder (AST documents + delta chains).
//
// Profile isolation: imports only from ./types.js. No JSON/tensor/wire/tabular/log/graph code.
//
// Binary layouts:
//   AST document (snapshot):
//     ast_version   : LEB128 uint32 = 1
//     profile_id    : LEB128 uint32 = 7
//     schema_hash   : 32 bytes
//     num_blocks    : LEB128 uint32
//     block[*]      : 1-byte block_type (0=node_block, 1=mixed_block) + payload
//
//   Delta chain:
//     ast_version   : LEB128 uint32 = 1
//     profile_id    : LEB128 uint32 = 7
//     schema_hash   : 32 bytes
//     num_ops       : LEB128 uint32
//     op[*]         : 1-byte op_code + op-specific payload
//
//   node_block payload:
//     kind_len      : LEB128 (block-level kind string length)
//     kind          : UTF-8 bytes
//     num_nodes     : LEB128
//     num_user_cols : LEB128 (col_id >= 4 only)
//     user_col[*]   : LEB128 col_id + 1-byte type_byte ((nullable<<4)|ctype)
//     nid col       : delta-packed LEB128Big (monotone uint64)
//     parent_nid col: null_bitmap + plain uint64 LE per non-null value
//     child_index col: LEB128 per value (uint32)
//     user col data[*]: [null_bitmap if nullable] + values
//
//   mixed_block payload: same as node_block but kind_len=0, plus per-row
//     kind col after child_index: LEB128-prefixed UTF-8 per row
//
// See weavepack/profiles/ast/02-containers.md and 04-deltas.md.

import {
  CTYPE, OP, PATH_KIND,
  BLOCK_TYPE_NODE, BLOCK_TYPE_MIXED,
  SCHEMA_HASH_BYTES, AST_VERSION, PROFILE_NUM,
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

function writeBoolColumn(w, values) {
  const n = values.length
  const bytes = new Uint8Array(Math.ceil(n / 8))
  for (let i = 0; i < n; i++) {
    if (values[i]) bytes[i >> 3] |= (1 << (i & 7))
  }
  w.writeBytes(bytes)
}

function writeNullBitmap(w, values, numElems) {
  const bytes = new Uint8Array(nullBitmapBytes(numElems))
  for (let i = 0; i < numElems; i++) {
    if (values[i] === null || values[i] === undefined) setNullBit(bytes, i)
  }
  w.writeBytes(bytes)
}

function writeValueColumn(w, ctype, values) {
  const nonNull = values.filter(v => v !== null && v !== undefined)
  if (ctype === CTYPE.BOOL) {
    writeBoolColumn(w, nonNull)
  } else {
    for (const v of nonNull) writeValue(w, ctype, v)
  }
}

// ── NID delta-pack column (monotone uint64) ────────────────────────────────

function writeNidDeltaColumn(w, ids) {
  if (ids.length === 0) return
  w.writeLEB128Big(BigInt(ids[0]))
  for (let i = 1; i < ids.length; i++) {
    const delta = BigInt(ids[i]) - BigInt(ids[i - 1])
    if (delta < 1n)
      throw new Error(`duplicate_element_id: nid delta must be ≥1; got ${delta} at index ${i}`)
    w.writeLEB128Big(delta)
  }
}

// ── parent_nid nullable column (plain uint64 LE, nullable) ────────────────

function writeParentNidColumn(w, parentNids, numNodes) {
  const bitmap = new Uint8Array(nullBitmapBytes(numNodes))
  for (let i = 0; i < numNodes; i++) {
    if (parentNids[i] === null || parentNids[i] === undefined) setNullBit(bitmap, i)
  }
  w.writeBytes(bitmap)
  for (let i = 0; i < numNodes; i++) {
    if (parentNids[i] !== null && parentNids[i] !== undefined) {
      const bv = BigInt(parentNids[i])
      const lo = Number(bv & 0xFFFFFFFFn)
      const hi = Number((bv >> 32n) & 0xFFFFFFFFn)
      w.writeByte(lo & 0xFF); w.writeByte((lo >> 8) & 0xFF)
      w.writeByte((lo >> 16) & 0xFF); w.writeByte((lo >> 24) & 0xFF)
      w.writeByte(hi & 0xFF); w.writeByte((hi >> 8) & 0xFF)
      w.writeByte((hi >> 16) & 0xFF); w.writeByte((hi >> 24) & 0xFF)
    }
  }
}

// ── child_index column (LEB128 per value) ─────────────────────────────────

function writeChildIndexColumn(w, childIndices) {
  for (const ci of childIndices) w.writeLEB128(ci >>> 0)
}

// ── per-row kind column (mixed_block only) ─────────────────────────────────

function writeKindColumn(w, kinds) {
  for (const k of kinds) {
    const utf8 = _enc.encode(String(k))
    w.writeLEB128(utf8.length)
    w.writeBytes(utf8)
  }
}

// ── User property columns (col_id >= 4) ───────────────────────────────────

function writeUserColSchema(w, col) {
  if (col.colId < 4)
    throw new Error(`reserved_col_id: col_id ${col.colId} is reserved (must be ≥ 4 for user columns)`)
  if (col.ctype > 15)
    throw new Error(`unknown_ctype: ctype ${col.ctype} ≥ 16 is reserved`)
  w.writeLEB128(col.colId >>> 0)
  w.writeByte(((col.nullable ? 1 : 0) << 4) | (col.ctype & 0xF))
}

function writeUserColData(w, col, numElems) {
  if (col.values.length !== numElems)
    throw new Error(`column ${col.colId} has ${col.values.length} values but block has ${numElems} elements`)
  if (col.nullable) writeNullBitmap(w, col.values, numElems)
  writeValueColumn(w, col.ctype, col.values)
}

// ── node_block / mixed_block encoding ─────────────────────────────────────
//
// node_block = {
//   kind:         string (block-level constant; omit for mixed_block),
//   nids:         BigInt[],
//   parentNids:   BigInt[]|null[] (null = root),
//   childIndices: number[],
//   kinds?:       string[] (per-row; mixed_block only),
//   columns:      [{ colId, ctype, nullable, values }] (col_id >= 4),
// }

function writeNodeBlockPayload(w, block, isMixed) {
  const nids         = block.nids ?? []
  const parentNids   = block.parentNids ?? new Array(nids.length).fill(null)
  const childIndices = block.childIndices ?? new Array(nids.length).fill(0)
  const cols         = block.columns ?? []
  const numNodes     = nids.length

  if (parentNids.length !== numNodes)
    throw new Error(`parentNids.length (${parentNids.length}) must equal nids.length (${numNodes})`)
  if (childIndices.length !== numNodes)
    throw new Error(`childIndices.length (${childIndices.length}) must equal nids.length (${numNodes})`)

  // Block-level kind (empty for mixed_block)
  const kindBytes = isMixed ? new Uint8Array(0) : _enc.encode(String(block.kind ?? ""))
  w.writeLEB128(kindBytes.length)
  if (kindBytes.length > 0) w.writeBytes(kindBytes)

  w.writeLEB128(numNodes)

  // User column schemas
  w.writeLEB128(cols.length)
  for (const col of cols) writeUserColSchema(w, col)

  // Mandatory columns: nid, parent_nid, child_index
  writeNidDeltaColumn(w, nids)
  writeParentNidColumn(w, parentNids, numNodes)
  writeChildIndexColumn(w, childIndices)

  // Per-row kind column (mixed_block only)
  if (isMixed) {
    const kinds = block.kinds ?? new Array(numNodes).fill("")
    if (kinds.length !== numNodes)
      throw new Error(`kinds.length (${kinds.length}) must equal nids.length (${numNodes})`)
    writeKindColumn(w, kinds)
  }

  // User prop columns
  for (const col of cols) writeUserColData(w, col, numNodes)
}

// ── AST document header ────────────────────────────────────────────────────

function writeDocHeader(w, schemaHash) {
  w.writeLEB128(AST_VERSION)
  w.writeLEB128(PROFILE_NUM)
  const hash = schemaHash instanceof Uint8Array ? schemaHash : new Uint8Array(SCHEMA_HASH_BYTES)
  if (hash.length !== SCHEMA_HASH_BYTES)
    throw new Error(`schema_hash must be exactly ${SCHEMA_HASH_BYTES} bytes`)
  w.writeBytes(hash)
}

// ── Public: AST document (snapshot) ───────────────────────────────────────
//
// tree = {
//   schemaHash?: Uint8Array (32 bytes; omit → all-zero),
//   blocks:      Array of { type: 'node'|'mixed', ...block-fields },
// }

export function encodeTree(tree) {
  const w = new ByteWriter()
  const { blocks = [] } = tree
  writeDocHeader(w, tree.schemaHash)
  w.writeLEB128(blocks.length)
  for (const blk of blocks) {
    if (blk.type === 'node') {
      w.writeByte(BLOCK_TYPE_NODE)
      writeNodeBlockPayload(w, blk, false)
    } else if (blk.type === 'mixed') {
      w.writeByte(BLOCK_TYPE_MIXED)
      writeNodeBlockPayload(w, blk, true)
    } else {
      throw new Error(`unknown block type: ${blk.type}`)
    }
  }
  return w.toBytes()
}

// ── Path encoding ──────────────────────────────────────────────────────────

function writePath(w, path) {
  const kind = path.kind
  if (kind >= 8)
    throw new Error(`unknown_path_kind: path kind ${kind} is reserved (must be 0–7)`)
  w.writeByte((kind & 0xF) << 4)
  switch (kind) {
    case PATH_KIND.NODE:
      w.writeLEB128Big(BigInt(path.nid))
      break
    case PATH_KIND.NODE_COL:
      w.writeLEB128Big(BigInt(path.nid))
      w.writeLEB128(path.colId >>> 0)
      break
    case PATH_KIND.NODE_KIND: {
      const kb = _enc.encode(String(path.nodeKind ?? ""))
      w.writeLEB128(kb.length)
      w.writeBytes(kb)
      break
    }
    case PATH_KIND.AT_NID:
    case PATH_KIND.AT_PARENT:
    case PATH_KIND.AT_CHILD_INDEX:
    case PATH_KIND.AT_KIND:
      break  // no payload
    case PATH_KIND.NODE_PROP: {
      const pb = _enc.encode(String(path.prop ?? ""))
      w.writeLEB128Big(BigInt(path.nid))
      w.writeLEB128(pb.length)
      w.writeBytes(pb)
      break
    }
    default:
      throw new Error(`unknown_path_kind: path kind ${kind}`)
  }
}

// ── Delta op encoding ──────────────────────────────────────────────────────

function writeNodeInsert(w, op) {
  const isMixed = op.mixed ?? false
  w.writeByte(isMixed ? BLOCK_TYPE_MIXED : BLOCK_TYPE_NODE)
  writeNodeBlockPayload(w, op.block, isMixed)
}

function writeNodeDelete(w, op) {
  const nids = op.nids ?? []
  w.writeLEB128Big(BigInt(nids.length))
  for (const nid of nids) w.writeLEB128Big(BigInt(nid))
}

function writeNodeMove(w, op) {
  w.writeLEB128Big(BigInt(op.nid))
  w.writeLEB128Big(BigInt(op.newParentNid ?? 0))
  w.writeLEB128(op.newChildIndex >>> 0)
}

function writePropSet(w, op) {
  writePath(w, op.path)
  w.writeByte(op.ctype & 0xF)
  const isNull = op.value === null || op.value === undefined
  const nullable = op.nullable ? 1 : 0
  const isNullBit = (nullable && isNull) ? 1 : 0
  w.writeByte((nullable & 1) | (isNullBit << 1))
  if (!isNullBit) writeValue(w, op.ctype, op.value)
}

function writeKindRename(w, op) {
  const oldBytes = _enc.encode(String(op.oldKind ?? ""))
  const newBytes = _enc.encode(String(op.newKind ?? ""))
  w.writeLEB128(oldBytes.length)
  w.writeBytes(oldBytes)
  w.writeLEB128(newBytes.length)
  w.writeBytes(newBytes)
}

function writeSubtreeReplace(w, op) {
  w.writeLEB128Big(BigInt(op.rootNid))
  const isMixed = op.mixed ?? false
  w.writeByte(isMixed ? BLOCK_TYPE_MIXED : BLOCK_TYPE_NODE)
  writeNodeBlockPayload(w, op.block, isMixed)
}

function writeOp(w, op) {
  const opCode = op.op
  if (opCode > 5)
    throw new Error(`unknown_delta_op: op code ${opCode} is reserved (must be 0–5)`)
  w.writeByte(opCode & 0x7)
  switch (opCode) {
    case OP.NODE_INSERT:     writeNodeInsert(w, op);     break
    case OP.NODE_DELETE:     writeNodeDelete(w, op);     break
    case OP.NODE_MOVE:       writeNodeMove(w, op);       break
    case OP.PROP_SET:        writePropSet(w, op);        break
    case OP.KIND_RENAME:     writeKindRename(w, op);     break
    case OP.SUBTREE_REPLACE: writeSubtreeReplace(w, op); break
    default:
      throw new Error(`unknown_delta_op: op code ${opCode}`)
  }
}

// ── Public: delta chain ────────────────────────────────────────────────────
//
// chain = { schemaHash?, ops: [...] }

export function encodeChain({ schemaHash, ops = [] }) {
  const w = new ByteWriter()
  writeDocHeader(w, schemaHash)
  w.writeLEB128(ops.length)
  for (const op of ops) writeOp(w, op)
  return w.toBytes()
}
