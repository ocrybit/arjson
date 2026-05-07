// Verify the weavepack-json and weavepack-tensor conformance test vector
// corpora against the JS reference implementation.
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

const __filename = fileURLToPath(import.meta.url)
const TOOLS_DIR  = dirname(__filename)
const JSON_ROOT   = join(TOOLS_DIR, "..", "profiles", "json",    "test-vectors")
const TENSOR_ROOT = join(TOOLS_DIR, "..", "profiles", "tensor",  "test-vectors")

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

  for (const v of vectors) {
    if (isDelta) {
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

  for (const v of vectors) {
    if (isStreaming) {
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
