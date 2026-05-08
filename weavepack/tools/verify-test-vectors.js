// Verify the weavepack-json, weavepack-tensor, weavepack-wire, and
// weavepack-tabular conformance test vector corpora against the JS reference
// implementation.
//
// Run from the repo root:
//   node weavepack/tools/verify-test-vectors.js
//
// Exit code 0 = all pass; exit code 1 = at least one failure.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ARJSON, enc, dec } from "../../sdk/src/arjson.js"
import {
  encodeDocument as tensorEnc,
  decodeDocument as tensorDec,
  encodeDocumentSchemaful,
  decodeDocumentSchemaful,
  iterateTensorsSchemaful,
  TensorPack,
  DTYPE,
  schemaHashHex,
} from "../../sdk/src/profiles/tensor/index.js"
import {
  encodeDocument as wireEnc,
  decodeDocument as wireDec,
  encodeChain  as wireEncChain,
  decodeChain  as wireDecChain,
  applyChain   as wireApplyChain,
  VTYPE as WIRE_VTYPE,
} from "../../sdk/src/profiles/wire/index.js"
import {
  encodeFrame  as tabEncFrame,
  decodeFrame  as tabDecFrame,
  encodeChain  as tabEncChain,
  decodeChain  as tabDecChain,
  applyChain   as tabApplyChain,
  CTYPE as TAB_CTYPE,
  OP    as TAB_OP,
} from "../../sdk/src/profiles/tabular/index.js"
import { wrapPayload, peekHeader, PID } from "../../sdk/src/dispatch.js"

const __filename = fileURLToPath(import.meta.url)
const TOOLS_DIR   = dirname(__filename)
const JSON_ROOT   = join(TOOLS_DIR, "..", "profiles", "json",    "test-vectors")
const TENSOR_ROOT = join(TOOLS_DIR, "..", "profiles", "tensor",  "test-vectors")
const WIRE_ROOT     = join(TOOLS_DIR, "..", "profiles", "wire",    "test-vectors")
const TABULAR_ROOT  = join(TOOLS_DIR, "..", "profiles", "tabular", "test-vectors")
const CORE_ROOT     = join(TOOLS_DIR, "..", "core",     "test-vectors")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
const equals = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (path.endsWith(".json")) yield path
  }
}

let pass = 0, fail = 0
const failures = []

function record(path, name, reason, expected, actual) {
  fail++
  failures.push({ path, name, reason, expected, actual })
}

// ── weavepack-json vectors ────────────────────────────────────────────────

for (const path of walk(JSON_ROOT)) {
  const rel = path.slice(JSON_ROOT.length + 1)
  const vectors = JSON.parse(readFileSync(path, "utf8"))
  const isDelta = rel.startsWith("deltas/")
  const isV12   = rel.startsWith("v1.2/")

  for (const v of vectors) {
    if (isV12) {
      // v1.2 vector: encode with wrapPayload, compare bytes, decode via peekHeader + dec.
      try {
        const v1xBytes  = enc(v.input)
        const v12Bytes  = wrapPayload(v1xBytes, PID.JSON)
        const hex       = toHex(v12Bytes)
        if (hex !== v.expected_bytes_hex) {
          record(rel, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        const h = peekHeader(v12Bytes)
        if (h === null || h.profileId !== PID.JSON) {
          record(rel, v.name, "peekHeader failed to detect JSON v1.2 header"); continue
        }
        const decoded = dec(h.payload)
        const target  = v.expected_decoded !== undefined ? v.expected_decoded : v.input
        if (!equals(decoded, target)) {
          record(rel, v.name, "decode mismatch", target, decoded); continue
        }
        pass++
      } catch (e) {
        record(rel, v.name, "exception: " + e.message)
      }
    } else if (isDelta) {
      try {
        const arj = new ARJSON({ json: v.initial })
        if (v.updates) for (const u of v.updates) arj.update(u)
        else arj.update(v.update)
        const chainHex = toHex(arj.toBuffer())
        if (chainHex !== v.expected_chain_bytes_hex) {
          record(rel, v.name, "chain bytes mismatch", v.expected_chain_bytes_hex, chainHex); continue
        }
        if (!equals(arj.json, v.expected_final)) {
          record(rel, v.name, "final json mismatch", v.expected_final, arj.json); continue
        }
        const restored = new ARJSON({ arj: arj.toBuffer() })
        if (!equals(restored.json, v.expected_final)) {
          record(rel, v.name, "round-trip mismatch", v.expected_final, restored.json); continue
        }
        pass++
      } catch (e) {
        record(rel, v.name, "exception: " + e.message)
      }
    } else {
      try {
        const bytes = enc(v.input)
        const hex = toHex(bytes)
        if (hex !== v.expected_bytes_hex) {
          record(rel, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        const decoded = dec(bytes)
        const target = v.expected_decoded !== undefined ? v.expected_decoded : v.input
        if (!equals(decoded, target)) {
          record(rel, v.name, "decode mismatch", target, decoded); continue
        }
        pass++
      } catch (e) {
        record(rel, v.name, "exception: " + e.message)
      }
    }
  }
}

// ── weavepack-tensor helpers ──────────────────────────────────────────────

// Materialise typed array from a plain JSON data array and dtype code.
// fp16/bf16 inputs come in as plain f32 numbers; the encoder converts
// them to raw 16-bit bits per RFC 0001.
function jsonToTyped(dtype, arr) {
  switch (dtype) {
    case DTYPE.FP32:  return new Float32Array(arr)
    case DTYPE.FP64:  return new Float64Array(arr)
    case DTYPE.INT8:  return new Int8Array(arr)
    case DTYPE.UINT8: return new Uint8Array(arr)
    case DTYPE.INT16: return new Int16Array(arr)
    case DTYPE.UINT16:return new Uint16Array(arr)
    case DTYPE.INT32: return new Int32Array(arr)
    case DTYPE.UINT32:return new Uint32Array(arr)
    case DTYPE.INT64: return new BigInt64Array(arr.map(v => BigInt(v)))
    case DTYPE.UINT64:return new BigUint64Array(arr.map(v => BigInt(v)))
    case DTYPE.INT4:  return new Int8Array(arr)
    case DTYPE.UINT4: return new Uint8Array(arr)
    case DTYPE.BOOL:  return arr
    case 13:           return new Float32Array(arr)  // FP16 — encoder converts
    case 14:           return new Float32Array(arr)  // BF16 — encoder converts
    case DTYPE.FP8E4M3: return new Float32Array(arr)  // fp8 — encoder converts
    case DTYPE.FP8E5M2: return new Float32Array(arr)  // fp8 — encoder converts
    case DTYPE.CFLOAT32: return new Float32Array(arr) // interleaved real,imag as f32
    case DTYPE.CFLOAT64: return new Float64Array(arr) // interleaved real,imag as f64
    case DTYPE.QINT8:  return new Float32Array(arr) // qint8 input is f32; encoder quantizes
    case DTYPE.QINT4:  return new Float32Array(arr) // qint4 input is f32; encoder quantizes
    case DTYPE.QFP8:   return new Float32Array(arr) // qfp8 input is f32; encoder quantizes
    default: throw new Error(`unsupported dtype ${dtype} in jsonToTyped`)
  }
}

// Build a live tensor document from a JSON-vector tensor map.
// Tensors may carry a `data_raw_bits` field (Uint16 bit patterns) instead of
// `data` (f32 values) when the test value isn't representable in JSON as a
// finite float (e.g. fp16 ±Infinity, NaN).  raw_bits are fed directly to the
// Uint16Array path in emitDataBlock, bypassing f32→fp16 conversion.
function parseTensorDoc(jsonDoc) {
  const tensors = {}
  for (const [name, t] of Object.entries(jsonDoc.tensors)) {
    let data
    if (t.data_raw_bits !== undefined && (t.dtype === DTYPE.FP16 || t.dtype === DTYPE.BF16)) {
      data = new Uint16Array(t.data_raw_bits)
    } else if (t.data_raw_bits !== undefined && (t.dtype === DTYPE.FP8E4M3 || t.dtype === DTYPE.FP8E5M2)) {
      data = new Uint8Array(t.data_raw_bits)
    } else {
      data = jsonToTyped(t.dtype, t.data)
    }
    const entry = { dtype: t.dtype, shape: t.shape, data }
    if (t.scale !== undefined) entry.scale = t.scale
    if (t.zero_point !== undefined) entry.zero_point = t.zero_point
    tensors[name] = entry
  }
  return { tensors }
}

// Normalise a decoded tensor's data to a plain comparable array.
function normaliseData(dtype, data) {
  if (dtype === DTYPE.INT64 || dtype === DTYPE.UINT64) {
    // Convert BigInt array to string array for JSON.stringify comparison.
    return Array.from(data, v => v.toString())
  }
  return Array.from(data)
}

// Compare two tensor documents structurally.
function tensorDocsEqual(a, b) {
  const ak = Object.keys(a.tensors).sort()
  const bk = Object.keys(b.tensors).sort()
  if (!equals(ak, bk)) return false
  for (const name of ak) {
    const ta = a.tensors[name], tb = b.tensors[name]
    if (ta.dtype !== tb.dtype) return false
    if (!equals(ta.shape, tb.shape)) return false
    if (!equals(normaliseData(ta.dtype, ta.data), normaliseData(tb.dtype, tb.data))) return false
  }
  return true
}

// ── weavepack-tensor vectors ──────────────────────────────────────────────

for (const path of walk(TENSOR_ROOT)) {
  const rel    = path.slice(TENSOR_ROOT.length + 1)
  const prefix = "tensor:" + rel
  const vectors = JSON.parse(readFileSync(path, "utf8"))
  const isSchema    = rel.startsWith("schemas/")
  const isDelta     = rel.startsWith("deltas/")
  const isStreaming = rel.startsWith("streaming/")
  const isV12       = rel.startsWith("v1.2/")
  const isSecurity  = rel.startsWith("security/")

  for (const v of vectors) {
    if (isSecurity) continue  // handled by the tensor security loop below
    if (isV12) {
      // v1.2 tensor vector: encode with wrapPayload, compare bytes, decode via peekHeader.
      try {
        const doc      = parseTensorDoc(v.input)
        const v1xBytes = tensorEnc(doc)
        const v12Bytes = wrapPayload(v1xBytes, PID.TENSOR)
        const hex      = toHex(v12Bytes)
        if (hex !== v.expected_bytes_hex) {
          record(prefix, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        const h = peekHeader(v12Bytes)
        if (h === null || h.profileId !== PID.TENSOR) {
          record(prefix, v.name, "peekHeader failed to detect tensor v1.2 header"); continue
        }
        const decoded = tensorDec(h.payload)
        if (!tensorDocsEqual(decoded, doc)) {
          record(prefix, v.name, "round-trip mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else if (isStreaming) {
      // Streaming vector: call iterateTensorsSchemaful, compare yielded tensors.
      try {
        const bytes    = new Uint8Array(v.bytes_hex.match(/.{2}/g).map(h => parseInt(h, 16)))
        const registry = new Map([[v.schema_hash_hex, v.schema]])
        const yielded  = []
        for (const t of iterateTensorsSchemaful(bytes, registry)) {
          yielded.push({ name: t.name, dtype: t.dtype, shape: t.shape, data: Array.from(t.data) })
        }
        if (yielded.length !== v.expected_tensors.length) {
          record(prefix, v.name, "tensor count mismatch", v.expected_tensors.length, yielded.length); continue
        }
        let ok = true
        for (let i = 0; i < yielded.length; i++) {
          const got = yielded[i], exp = v.expected_tensors[i]
          if (got.name !== exp.name || got.dtype !== exp.dtype ||
              !equals(got.shape, exp.shape) || !equals(got.data, exp.data)) {
            record(prefix, v.name, `tensor[${i}] mismatch`, JSON.stringify(exp), JSON.stringify(got))
            ok = false; break
          }
        }
        if (ok) pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else if (isSchema) {
      // Schema vector: encode schemaful, compare bytes, decode, compare tensors.
      try {
        const doc    = parseTensorDoc(v.input)
        const bytes  = encodeDocumentSchemaful(doc, v.schema)
        const hex    = toHex(bytes)
        if (hex !== v.expected_bytes_hex) {
          record(prefix, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        // Verify schema_hash_hex matches.
        const computedHash = schemaHashHex(v.schema)
        if (computedHash !== v.schema_hash_hex) {
          record(prefix, v.name, "schema hash mismatch", v.schema_hash_hex, computedHash); continue
        }
        // Round-trip: decode schemaful.
        const registry = new Map([[v.schema_hash_hex, v.schema]])
        const decoded  = decodeDocumentSchemaful(bytes, registry)
        // Use expected_decoded if present (e.g. when quantization is lossy/clamping).
        const expectedDoc = v.expected_decoded ? parseTensorDoc(v.expected_decoded) : doc
        if (!tensorDocsEqual(decoded, expectedDoc)) {
          record(prefix, v.name, "schemaful round-trip mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else if (isDelta && v.delta_bytes_hex) {
      // Raw-delta vector: apply a manually crafted delta (e.g. mode=1) directly
      // to the initial doc, without going through the encoder.  Tests the decoder
      // only.  Used for delta-from-prior (mode=1) vectors where the v0.1 encoder
      // always emits mode=0.
      try {
        const initDoc      = parseTensorDoc(v.initial)
        const deltaBytes   = new Uint8Array(v.delta_bytes_hex.match(/.{2}/g).map(h => parseInt(h, 16)))
        const { applyDelta } = await import("../../sdk/src/profiles/tensor/index.js")
        const result       = applyDelta(initDoc, deltaBytes)
        const expectedFinal = parseTensorDoc(v.expected_final)
        if (!tensorDocsEqual(result, expectedFinal)) {
          record(prefix, v.name, "raw-delta decode mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else if (isDelta) {
      // Delta vector: build TensorPack chain, compare chain bytes, compare final state.
      try {
        const initDoc = parseTensorDoc(v.initial)
        const updDoc  = parseTensorDoc(v.update)
        const pack    = new TensorPack({ json: initDoc })
        pack.update(updDoc)
        const chainHex = toHex(pack.toBuffer())
        if (chainHex !== v.expected_chain_bytes_hex) {
          record(prefix, v.name, "chain bytes mismatch", v.expected_chain_bytes_hex, chainHex); continue
        }
        const expectedFinal = parseTensorDoc(v.expected_final)
        if (!tensorDocsEqual(pack.json, expectedFinal)) {
          record(prefix, v.name, "final state mismatch"); continue
        }
        // Round-trip: restore from chain.
        const restored = new TensorPack({ arj: pack.toBuffer() })
        if (!tensorDocsEqual(restored.json, expectedFinal)) {
          record(prefix, v.name, "round-trip mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else {
      // Document vector: encode, compare bytes hex, decode, compare.
      try {
        const doc  = parseTensorDoc(v.input)
        const bytes = tensorEnc(doc)
        const hex   = toHex(bytes)
        if (hex !== v.expected_bytes_hex) {
          record(prefix, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        const decoded = tensorDec(bytes)
        // Vectors for fp8/fp16/bf16 dtypes use expected_bits (raw byte/word patterns)
        // instead of doc-level equality because the decoded data is a typed-array
        // of raw bits rather than f32 values. Compare against expected_bits.
        if (v.expected_bits) {
          const tname = Object.keys(decoded.tensors)[0]
          const decodedBits = Array.from(decoded.tensors[tname].data)
          if (!equals(decodedBits, v.expected_bits)) {
            record(prefix, v.name, "raw bits mismatch", v.expected_bits, decodedBits); continue
          }
        } else if (!tensorDocsEqual(decoded, doc)) {
          record(prefix, v.name, "decode mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    }
  }
}

// ── weavepack-core security vectors ──────────────────────────────────────
//
// Each vector has:
//   input_bytes_hex      — adversarial input to pass to dec()
//   expected_behavior    — "refusal" (must throw) or "clean-decode" (must not throw)
//   expected_error_class — semantic category matched against the JS error message

const SECURITY_CLASS_PATTERNS = {
  read_past_end:   ["read past end of buffer"],
  invalid_mode:    ["invalid vflags mode", "invalid kflags mode", "invalid bools mode"],
  runlength_bomb:  ["run-length exceeds", "run-length exceeds"],
  column_overflow: ["length exceeds", "exceeds buffer", "exceeds remaining"],
}

const fromHex = h => new Uint8Array((h.match(/.{2}/g) || []).map(s => parseInt(s, 16)))

const SECURITY_ROOT = join(CORE_ROOT, "security")

for (const path of walk(SECURITY_ROOT)) {
  const rel = "core/security/" + path.slice(SECURITY_ROOT.length + 1)
  const vectors = JSON.parse(readFileSync(path, "utf8"))

  for (const v of vectors) {
    const bytes = fromHex(v.input_bytes_hex)
    try {
      const result = dec(bytes)
      if (v.expected_behavior === "refusal") {
        record(rel, v.name, `expected refusal but decoded to ${JSON.stringify(result)}`)
      } else {
        pass++
      }
    } catch (e) {
      if (v.expected_behavior === "refusal") {
        const pats = SECURITY_CLASS_PATTERNS[v.expected_error_class] || []
        const matched = pats.length === 0 || pats.some(p => e.message.toLowerCase().includes(p.toLowerCase()))
        if (matched) {
          pass++
        } else {
          record(rel, v.name, `wrong error class (got "${e.message}", expected class ${v.expected_error_class})`)
        }
      } else {
        record(rel, v.name, `unexpected exception: ${e.message}`)
      }
    }
  }
}

// ── weavepack-tensor security vectors ────────────────────────────────────
//
// Each vector has:
//   input_bytes_hex      — adversarial input to pass to tensorDec()
//   expected_behavior    — "refusal" (must throw) or "clean-decode" (must not throw)
//   expected_error_class — semantic category matched against the JS error message

const TENSOR_SECURITY_CLASS_PATTERNS = {
  unknown_dtype:   ["unknown dtype"],
  tensor_too_large: ["exceeds 256 mib", "exceeds maximum"],
}

const TENSOR_SECURITY_ROOT = join(TENSOR_ROOT, "security")

for (const path of walk(TENSOR_SECURITY_ROOT)) {
  const rel = "tensor:security/" + path.slice(TENSOR_SECURITY_ROOT.length + 1)
  const vectors = JSON.parse(readFileSync(path, "utf8"))

  for (const v of vectors) {
    const bytes = fromHex(v.input_bytes_hex)
    try {
      const result = tensorDec(bytes)
      if (v.expected_behavior === "refusal") {
        record(rel, v.name, `expected refusal but decoded to ${JSON.stringify(Object.keys(result.tensors))}`)
      } else {
        pass++
      }
    } catch (e) {
      if (v.expected_behavior === "refusal") {
        const pats = TENSOR_SECURITY_CLASS_PATTERNS[v.expected_error_class] || []
        const matched = pats.length === 0 || pats.some(p => e.message.toLowerCase().includes(p.toLowerCase()))
        if (matched) {
          pass++
        } else {
          record(rel, v.name, `wrong error class (got "${e.message}", expected class ${v.expected_error_class})`)
        }
      } else {
        record(rel, v.name, `unexpected exception: ${e.message}`)
      }
    }
  }
}

// ── weavepack-wire vectors ────────────────────────────────────────────────
//
// Snapshot vector fields:
//   input              — field array (BigInt values as strings, Uint8Array as {_bytes:[...]})
//   expected_bytes_hex — hex of wireEnc(input)
//
// Delta vector fields:
//   initial                  — field array
//   ops                      — op array
//   expected_chain_bytes_hex — hex of wireEncChain(ops)
//   expected_final           — field array after applying ops

const BIGINT_VTYPES_WIRE = new Set([
  WIRE_VTYPE.INT64,
  WIRE_VTYPE.UINT64,
  WIRE_VTYPE.SINT64,
])

// Recursively restore BigInt and Uint8Array values from their JSON representations.
function normalizeWireFields(fields) {
  if (!Array.isArray(fields)) return fields
  return fields.map(f => {
    const out = Object.assign({}, f)
    // Scalar BigInt
    if (BIGINT_VTYPES_WIRE.has(f.vtype) && typeof f.value === "string") {
      out.value = BigInt(f.value)
    }
    // Scalar Bytes
    if (f.vtype === WIRE_VTYPE.BYTES && f.value && f.value._bytes !== undefined) {
      out.value = new Uint8Array(f.value._bytes)
    }
    // Nested message
    if (f.message !== undefined) out.message = normalizeWireFields(f.message)
    // Repeated
    if (f.repeated !== undefined) {
      const { elemType, values } = f.repeated
      out.repeated = {
        elemType,
        values: BIGINT_VTYPES_WIRE.has(elemType)
          ? values.map(v => BigInt(v))
          : elemType === WIRE_VTYPE.BYTES
            ? values.map(v => v && v._bytes ? new Uint8Array(v._bytes) : v)
            : values,
      }
    }
    // Map entries
    if (f.map !== undefined) {
      const { keyType, valueType, entries } = f.map
      out.map = {
        keyType, valueType,
        entries: entries.map(([k, v]) => [
          k,
          BIGINT_VTYPES_WIRE.has(valueType) ? BigInt(v)
            : valueType === WIRE_VTYPE.BYTES && v && v._bytes ? new Uint8Array(v._bytes)
            : v,
        ]),
      }
    }
    // Oneof
    if (f.oneof !== undefined) {
      const { activeField, valueType, value } = f.oneof
      out.oneof = {
        activeField, valueType,
        value: BIGINT_VTYPES_WIRE.has(valueType) && typeof value === "string"
          ? BigInt(value)
          : valueType === WIRE_VTYPE.BYTES && value && value._bytes
            ? new Uint8Array(value._bytes)
            : value,
      }
    }
    return out
  })
}

// Normalize ops array (field_set/oneof_switch values may hold BigInt-as-string).
function normalizeWireOps(ops) {
  return ops.map(op => {
    const out = Object.assign({}, op)
    if (out.path) out.path = out.path.map(c => Object.assign({}, c))
    if (op.value !== undefined) {
      if (BIGINT_VTYPES_WIRE.has(op.value.vtype) && typeof op.value.value === "string") {
        out.value = { ...op.value, value: BigInt(op.value.value) }
      }
      if (op.value.vtype === WIRE_VTYPE.BYTES && op.value.value && op.value.value._bytes) {
        out.value = { ...op.value, value: new Uint8Array(op.value.value._bytes) }
      }
      if (op.value.message !== undefined) {
        out.value = { ...op.value, message: normalizeWireFields(op.value.message) }
      }
    }
    if (op.message !== undefined) out.message = normalizeWireFields(op.message)
    if (op.elements !== undefined && BIGINT_VTYPES_WIRE.has(op.elements.elemType)) {
      out.elements = { ...op.elements, values: op.elements.values.map(v => BigInt(v)) }
    }
    if (op.insertValues !== undefined && BIGINT_VTYPES_WIRE.has(op.elemType)) {
      out.insertValues = op.insertValues.map(v => BigInt(v))
    }
    if (op.value !== undefined && BIGINT_VTYPES_WIRE.has(op.valueType) && typeof op.value === "string") {
      out.value = BigInt(op.value)
    }
    return out
  })
}

// Custom serializer for comparing decoded wire fields.
// Handles BigInt (→ string) and Uint8Array (→ hex).
function wireSerial(v) {
  return JSON.stringify(v, (_k, val) => {
    if (typeof val === "bigint") return `__BigInt__${val}`
    if (val instanceof Uint8Array) return `__Bytes__${toHex(val)}`
    return val
  })
}

function wireEquals(a, b) { return wireSerial(a) === wireSerial(b) }

for (const path of walk(WIRE_ROOT)) {
  const rel    = path.slice(WIRE_ROOT.length + 1)
  const prefix = "wire:" + rel
  const vectors = JSON.parse(readFileSync(path, "utf8"))
  const isDelta  = rel.startsWith("deltas/")
  const isSchema = rel.startsWith("schemas/")

  for (const v of vectors) {
    // Pending placeholder vectors are skipped.
    if (v.status === "pending") continue

    if (isSchema) {
      // Schema vectors placeholder — skip (schemaful encoding deferred to later revision).
      continue
    } else if (isDelta) {
      // Delta chain vector: encode ops, compare hex, apply to initial, compare final.
      try {
        const initial = normalizeWireFields(v.initial)
        const ops     = normalizeWireOps(v.ops)
        const chainBytes = wireEncChain(ops)
        const chainHex   = toHex(chainBytes)
        if (chainHex !== v.expected_chain_bytes_hex) {
          record(prefix, v.name, "chain bytes mismatch", v.expected_chain_bytes_hex, chainHex); continue
        }
        // Decode chain and verify round-trip.
        const decodedOps = wireDecChain(chainBytes)
        if (!wireEquals(decodedOps, ops)) {
          record(prefix, v.name, "ops round-trip mismatch"); continue
        }
        // Apply chain to initial state, compare final.
        const final    = wireApplyChain(initial, ops)
        const expected = normalizeWireFields(v.expected_final)
        if (!wireEquals(final, expected)) {
          record(prefix, v.name, "final state mismatch", wireSerial(expected), wireSerial(final)); continue
        }
        // Snapshot round-trip: encode final state, decode, compare.
        const snapBytes   = wireEnc(final)
        const snapDecoded = wireDec(snapBytes)
        if (!wireEquals(snapDecoded, final)) {
          record(prefix, v.name, "snapshot round-trip mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else {
      // Snapshot vector: encode, compare hex, decode, compare.
      // If expected_decoded is present, compare against it (e.g. for canonicalization tests).
      try {
        const input = normalizeWireFields(v.input)
        const bytes  = wireEnc(input)
        const hex    = toHex(bytes)
        if (hex !== v.expected_bytes_hex) {
          record(prefix, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        const decoded  = wireDec(bytes)
        const expected = v.expected_decoded !== undefined
          ? normalizeWireFields(v.expected_decoded)
          : input
        if (!wireEquals(decoded, expected)) {
          record(prefix, v.name, "decode round-trip mismatch", wireSerial(expected), wireSerial(decoded)); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    }
  }
}

// ── weavepack-tabular vectors ─────────────────────────────────────────────
//
// Snapshot vector fields:
//   input              — { rowIds: string[], columns: [...] }
//   expected_bytes_hex — hex of tabEncFrame(input)
//
// Delta vector fields:
//   initial                  — frame spec
//   ops                      — op array (rowIds as string[], BigInt ctypes as string values)
//   expected_chain_bytes_hex — hex of tabEncChain(ops)
//   expected_final           — frame spec after applying ops

const BIGINT_CTYPES_TAB = new Set([TAB_CTYPE.INT64, TAB_CTYPE.UINT64, TAB_CTYPE.TIMESTAMP64])

function tabSpecValToJs(ctype, v) {
  if (v === null || v === undefined) return null
  if (typeof v === "object" && v._bytes !== undefined) return new Uint8Array(v._bytes)
  if (BIGINT_CTYPES_TAB.has(ctype) && typeof v === "string") return BigInt(v)
  return v
}

function tabSpecToFrame(spec) {
  return {
    rowIds: (spec.rowIds || []).map(r => BigInt(r)),
    columns: (spec.columns || []).map(col => ({
      colId: col.colId,
      ctype: col.ctype,
      nullable: col.nullable,
      values: col.values.map(v => tabSpecValToJs(col.ctype, v)),
      ...(col.name ? { name: col.name } : {}),
    })),
  }
}

function tabSpecToOps(ops) {
  return ops.map(op => {
    const o = { ...op }
    if (o.rowIds) o.rowIds = o.rowIds.map(r => BigInt(r))
    if (o.columns) o.columns = o.columns.map(col => ({
      ...col,
      values: col.values.map(v => tabSpecValToJs(col.ctype, v)),
    }))
    if (o.defaultValue !== undefined && o.hasDefault) {
      o.defaultValue = tabSpecValToJs(o.ctype, o.defaultValue)
    }
    return o
  })
}

function tabJsValToSpec(ctype, v) {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) return { _bytes: Array.from(v) }
  if (typeof v === "bigint") return String(v)
  return v
}

function tabFrameToSpec(frame) {
  return {
    rowIds: frame.rowIds.map(r => String(r)),
    columns: frame.columns.map(col => ({
      colId: col.colId,
      ctype: col.ctype,
      nullable: col.nullable,
      values: col.values.map(v => tabJsValToSpec(col.ctype, v)),
      ...(col.name ? { name: col.name } : {}),
    })),
  }
}

function tabEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

for (const path of walk(TABULAR_ROOT)) {
  const rel     = path.slice(TABULAR_ROOT.length + 1)
  const prefix  = "tabular:" + rel
  const vectors = JSON.parse(readFileSync(path, "utf8"))
  const isDelta = rel.startsWith("deltas/")

  for (const v of vectors) {
    if (v.status === "pending") continue

    if (isDelta) {
      try {
        const initialJs = tabSpecToFrame(v.initial)
        const opsJs     = tabSpecToOps(v.ops)

        // Encode chain, compare hex.
        const chainBytes = tabEncChain({ ops: opsJs })
        const chainHex   = toHex(chainBytes)
        if (chainHex !== v.expected_chain_bytes_hex) {
          record(prefix, v.name, "chain bytes mismatch", v.expected_chain_bytes_hex, chainHex); continue
        }

        // Decode chain, verify op round-trip (re-encode).
        const { ops: decodedOps } = tabDecChain(chainBytes)
        const reencBytes = tabEncChain({ ops: decodedOps })
        if (toHex(reencBytes) !== chainHex) {
          record(prefix, v.name, "chain decode+re-encode mismatch"); continue
        }

        // Apply chain to initial state; compare final.
        const initial     = tabDecFrame(tabEncFrame(initialJs))
        const finalState  = tabApplyChain(initial, opsJs)
        const finalSpec   = tabFrameToSpec(finalState)
        if (!tabEquals(finalSpec, v.expected_final)) {
          record(prefix, v.name, "final state mismatch",
            JSON.stringify(v.expected_final), JSON.stringify(finalSpec)); continue
        }

        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    } else {
      // Snapshot vector: encode, compare hex, decode, re-encode (round-trip).
      try {
        const inputJs = tabSpecToFrame(v.input)
        const bytes   = tabEncFrame(inputJs)
        const hex     = toHex(bytes)
        if (hex !== v.expected_bytes_hex) {
          record(prefix, v.name, "encode bytes mismatch", v.expected_bytes_hex, hex); continue
        }
        const decoded  = tabDecFrame(bytes)
        const reencHex = toHex(tabEncFrame(decoded))
        if (reencHex !== hex) {
          record(prefix, v.name, "decode+re-encode round-trip mismatch"); continue
        }
        pass++
      } catch (e) {
        record(prefix, v.name, "exception: " + e.message)
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────

console.log(`Pass: ${pass}`)
console.log(`Fail: ${fail}`)

if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) {
    console.log(`  ${f.path} :: ${f.name}`)
    console.log(`    reason: ${f.reason}`)
    if (f.expected !== undefined) console.log(`    expected: ${typeof f.expected === "string" ? f.expected : JSON.stringify(f.expected)}`)
    if (f.actual   !== undefined) console.log(`    actual:   ${typeof f.actual   === "string" ? f.actual   : JSON.stringify(f.actual)}`)
  }
  process.exit(1)
}
