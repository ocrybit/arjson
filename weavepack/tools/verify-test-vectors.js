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
    // BigInt stored as decimal strings
    case DTYPE.INT64: return new BigInt64Array(arr.map(v => BigInt(v)))
    case DTYPE.UINT64:return new BigUint64Array(arr.map(v => BigInt(v)))
    case DTYPE.BOOL:  return arr  // plain array of 0/1, as expected by encoder
    default: throw new Error(`unsupported dtype ${dtype} in jsonToTyped`)
  }
}

// Build a live tensor document from a JSON-vector tensor map.
function parseTensorDoc(jsonDoc) {
  const tensors = {}
  for (const [name, t] of Object.entries(jsonDoc.tensors)) {
    tensors[name] = { dtype: t.dtype, shape: t.shape, data: jsonToTyped(t.dtype, t.data) }
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
  const isSchema = rel.startsWith("schemas/")
  const isDelta  = rel.startsWith("deltas/")

  for (const v of vectors) {
    if (isSchema) {
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
        if (!tensorDocsEqual(decoded, doc)) {
          record(prefix, v.name, "schemaful round-trip mismatch"); continue
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
        if (!tensorDocsEqual(decoded, doc)) {
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
