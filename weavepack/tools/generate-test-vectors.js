// Generate the weavepack-json conformance test vector corpus.
//
// Reads a hand-curated list of (input, description) tuples per category,
// runs the JS reference encoder, and emits JSON files in the structure
// described in profiles/json/05-conformance.md.
//
// Run from the repo root:
//   node weavepack/tools/generate-test-vectors.js
//
// Re-running overwrites the existing vectors. The intended workflow is
// to commit the generated vectors so other implementations can target
// them without depending on the JS encoder being present.
//
// Vector shape:
//   round-trip:  { name, description, input, expected_bytes_hex }
//   delta:       { name, description, initial, update,
//                  expected_delta_bytes_hex, expected_chain_bytes_hex,
//                  expected_final }

import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ARJSON, enc } from "../../sdk/src/arjson.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..", "profiles", "json", "test-vectors")

const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")

// ── round-trip categories ────────────────────────────────────────────────

const roundTripCategories = {
  "types/primitives/null.json": [
    { name: "null literal", input: null },
  ],
  "types/primitives/booleans.json": [
    { name: "true", input: true },
    { name: "false", input: false },
  ],
  "types/primitives/integers.json": [
    { name: "zero", input: 0 },
    { name: "one", input: 1 },
    { name: "small positive", input: 42 },
    { name: "max-fast-path", input: 62 },
    { name: "first leb128", input: 63 },
    { name: "small negative", input: -1 },
    { name: "negative", input: -42 },
    { name: "large positive", input: 1000000 },
    { name: "large negative", input: -1000000 },
    { name: "max safe integer", input: 9007199254740991 },
  ],
  "types/primitives/floats.json": [
    { name: "simple positive", input: 0.5 },
    { name: "simple negative", input: -0.5 },
    { name: "two-digit precision", input: 1.25 },
    { name: "large precision", input: 0.123456789 },
    { name: "negative with precision", input: -3.14159 },
    { name: "scientific notation small", input: 1e-10 },
    { name: "scientific notation large", input: 1e10 },
  ],
  "types/primitives/strings.json": [
    { name: "empty string", input: "" },
    { name: "single uppercase", input: "A" },
    { name: "single lowercase", input: "z" },
    { name: "short base64url", input: "Hello" },
    { name: "with digit", input: "abc123" },
    { name: "with hyphen", input: "abc-123" },
    { name: "with underscore", input: "abc_123" },
    { name: "non-base64url", input: "hello, world!" },
    { name: "control chars", input: "line1\nline2\ttab" },
    { name: "unicode CJK", input: "中文测试" },
    { name: "emoji", input: "😀" },
  ],
  "types/primitives/empty-collections.json": [
    { name: "empty array", input: [] },
    { name: "empty object", input: {} },
  ],
  "types/numbers/max-safe.json": [
    { name: "max safe minus one", input: 9007199254740990 },
    { name: "max safe", input: 9007199254740991 },
    { name: "negative max safe", input: -9007199254740991 },
  ],
  "types/numbers/non-finite.json": [
    { name: "NaN coerces to null", input: { v: NaN }, expected_decoded: { v: null } },
    { name: "Infinity coerces to null", input: { v: Infinity }, expected_decoded: { v: null } },
    { name: "negative Infinity coerces to null", input: { v: -Infinity }, expected_decoded: { v: null } },
  ],
  "types/strings/strmap-dedup.json": [
    { name: "two identical strings in array", input: ["hello", "hello"] },
    { name: "repeated key, repeated string value", input: [{ k: "v" }, { k: "v" }, { k: "v" }] },
    { name: "many repeats", input: Array(10).fill("repeated") },
  ],
  "containers/arrays/empty.json": [
    { name: "empty top-level", input: [] },
    { name: "nested empty", input: { a: [] } },
    { name: "array of empties", input: [[], [], []] },
  ],
  "containers/arrays/homogeneous-primitives.json": [
    { name: "ints", input: [1, 2, 3, 4, 5] },
    { name: "strings", input: ["a", "b", "c"] },
    { name: "bools", input: [true, false, true] },
    { name: "nulls", input: [null, null, null] },
  ],
  "containers/arrays/nested.json": [
    { name: "two levels", input: [[1, 2], [3, 4]] },
    { name: "three levels", input: [[[1]]] },
    { name: "mixed depth", input: [1, [2, [3, [4]]]] },
  ],
  "containers/arrays/mixed-types.json": [
    { name: "all four primitives", input: [null, true, 42, "str"] },
    { name: "primitives and containers", input: [1, "a", [], {}] },
  ],
  "containers/objects/single-key.json": [
    { name: "string value", input: { name: "weavepack" } },
    { name: "int value", input: { count: 42 } },
    { name: "bool value", input: { active: true } },
    { name: "array value", input: { items: [1, 2, 3] } },
    { name: "nested object", input: { user: { id: 1 } } },
  ],
  "containers/objects/nested.json": [
    { name: "two levels", input: { a: { b: 1 } } },
    { name: "three levels", input: { a: { b: { c: 1 } } } },
    { name: "siblings at depth", input: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } },
  ],
  "containers/objects/repeated-keys.json": [
    { name: "two records", input: [{ id: 1, name: "a" }, { id: 2, name: "b" }] },
    { name: "five records (strmap dedup wins)", input: [
      { id: 1, name: "a", role: "admin" },
      { id: 2, name: "b", role: "admin" },
      { id: 3, name: "c", role: "user" },
      { id: 4, name: "d", role: "user" },
      { id: 5, name: "e", role: "guest" },
    ] },
  ],
  "containers/objects/special-char-keys.json": [
    { name: "empty key", input: { "": 1 } },
    { name: "key with bracket", input: { "user[admin]": true } },
    { name: "key with backslash", input: { "a\\b": 1 } },
    { name: "key with space", input: { "key with spaces": 1 } },
  ],
}

// ── delta categories ─────────────────────────────────────────────────────

const deltaCategories = {
  "deltas/replace/primitive-replace.json": [
    { name: "int to int", initial: { n: 1 }, update: { n: 2 } },
    { name: "string to string short", initial: { s: "old" }, update: { s: "new" } },
    { name: "bool to bool", initial: { b: false }, update: { b: true } },
    { name: "int to string", initial: { v: 42 }, update: { v: "hello" } },
  ],
  "deltas/replace/string-replace.json": [
    { name: "short string", initial: { msg: "hi" }, update: { msg: "hello" } },
    { name: "long string falls back to replace", initial: { msg: "x".repeat(20) }, update: { msg: "y".repeat(20) } },
  ],
  "deltas/replace/nested-replace.json": [
    { name: "deep replace", initial: { a: { b: { c: 1 } } }, update: { a: { b: { c: 99 } } } },
    { name: "array element", initial: { arr: [1, 2, 3] }, update: { arr: [1, 99, 3] } },
  ],
  "deltas/add/new-key.json": [
    { name: "add to single-key object", initial: { a: 1 }, update: { a: 1, b: 2 } },
    { name: "add multiple keys", initial: { a: 1 }, update: { a: 1, b: 2, c: 3 } },
  ],
  "deltas/add/new-array-element.json": [
    { name: "append one", initial: [1, 2], update: [1, 2, 3] },
    { name: "append multiple", initial: [1], update: [1, 2, 3, 4] },
  ],
  "deltas/add/new-nested-key.json": [
    { name: "add to nested object", initial: { user: { name: "a" } }, update: { user: { name: "a", age: 30 } } },
  ],
  "deltas/remove/leaf-key.json": [
    { name: "remove one key", initial: { a: 1, b: 2 }, update: { a: 1 } },
    { name: "remove last key cascades to empty", initial: { a: 1 }, update: {} },
  ],
  "deltas/remove/nested-key.json": [
    { name: "remove from nested", initial: { user: { name: "a", age: 30 } }, update: { user: { name: "a" } } },
  ],
  "deltas/diff/long-string-with-diff.json": [
    { name: "edit middle of long string",
      initial: { msg: "the quick brown fox jumps over the lazy dog" },
      update: { msg: "the quick brown CAT jumps over the lazy dog" } },
  ],
  "deltas/splice/insert-at-tail.json": [
    { name: "append primitive", initial: [1, 2, 3], update: [1, 2, 3, 4] },
  ],
  "deltas/splice/delete-range.json": [
    { name: "delete one from middle", initial: [1, 2, 3, 4, 5], update: [1, 2, 4, 5] },
  ],
  "deltas/reanchor/primitive-to-object.json": [
    { name: "primitive to object reanchors", initial: 42, update: { a: 1 } },
  ],
  "deltas/reanchor/object-to-primitive.json": [
    { name: "object to primitive reanchors", initial: { a: 1 }, update: 42 },
  ],
  "deltas/reanchor/empty-to-populated.json": [
    { name: "empty object to populated", initial: {}, update: { a: 1 } },
    { name: "empty array to populated", initial: [], update: [1, 2, 3] },
  ],
  "deltas/chains/short-chain.json": [
    { name: "three updates", initial: { a: 1 }, updates: [{ a: 2 }, { a: 3 }, { a: 4 }] },
    { name: "grow object", initial: {}, updates: [{ a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }] },
  ],
}

// ── generation ───────────────────────────────────────────────────────────

function writeJson(path, data) {
  const fullPath = join(ROOT, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, JSON.stringify(data, null, 2) + "\n")
}

function generateRoundTrip() {
  let total = 0
  for (const [path, vectors] of Object.entries(roundTripCategories)) {
    const out = vectors.map(v => {
      const bytes = enc(v.input)
      const vector = {
        name: v.name,
        description: v.description ?? v.name,
        input: v.input,
        expected_bytes_hex: toHex(bytes),
      }
      if (v.expected_decoded !== undefined) vector.expected_decoded = v.expected_decoded
      return vector
    })
    writeJson(path, out)
    total += out.length
  }
  return total
}

function generateDeltas() {
  let total = 0
  for (const [path, vectors] of Object.entries(deltaCategories)) {
    const out = vectors.map(v => {
      const arj = new ARJSON({ json: v.initial })
      const initialBytes = arj.deltas[0]
      const vector = {
        name: v.name,
        description: v.description ?? v.name,
        initial: v.initial,
      }
      if (v.updates) {
        const chainDeltas = []
        for (const u of v.updates) {
          const ds = arj.update(u)
          for (const d of ds) chainDeltas.push(toHex(d))
        }
        vector.updates = v.updates
        vector.initial_delta_hex = toHex(initialBytes)
        vector.update_deltas_hex = chainDeltas
        vector.expected_chain_bytes_hex = toHex(arj.toBuffer())
        vector.expected_final = arj.json
      } else {
        const ds = arj.update(v.update)
        vector.update = v.update
        vector.initial_delta_hex = toHex(initialBytes)
        vector.expected_delta_bytes_hex = ds.map(d => toHex(d)).join("")
        vector.expected_chain_bytes_hex = toHex(arj.toBuffer())
        vector.expected_final = arj.json
      }
      return vector
    })
    writeJson(path, out)
    total += out.length
  }
  return total
}

const rtCount = generateRoundTrip()
const deltaCount = generateDeltas()

console.log(`Generated ${rtCount} round-trip vectors and ${deltaCount} delta vectors.`)
