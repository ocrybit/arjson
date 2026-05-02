// Verify the weavepack-json conformance test vector corpus against the
// JS reference implementation. Re-encodes each input, compares to the
// stored expected_bytes_hex, then decodes and compares the result.
//
// Run from the repo root:
//   node weavepack/tools/verify-test-vectors.js
//
// Exit code 0 = all pass; exit code 1 = at least one failure.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ARJSON, enc, dec } from "../../sdk/src/arjson.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..", "profiles", "json", "test-vectors")

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

for (const path of walk(ROOT)) {
  const rel = path.slice(ROOT.length + 1)
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
          fail++
          failures.push({ path: rel, name: v.name, reason: "chain bytes mismatch", expected: v.expected_chain_bytes_hex, actual: chainHex })
          continue
        }
        if (!equals(arj.json, v.expected_final)) {
          fail++
          failures.push({ path: rel, name: v.name, reason: "final json mismatch", expected: v.expected_final, actual: arj.json })
          continue
        }
        const restored = new ARJSON({ arj: arj.toBuffer() })
        if (!equals(restored.json, v.expected_final)) {
          fail++
          failures.push({ path: rel, name: v.name, reason: "round-trip mismatch", expected: v.expected_final, actual: restored.json })
          continue
        }
        pass++
      } catch (e) {
        fail++
        failures.push({ path: rel, name: v.name, reason: "exception: " + e.message })
      }
    } else {
      try {
        const bytes = enc(v.input)
        const hex = toHex(bytes)
        if (hex !== v.expected_bytes_hex) {
          fail++
          failures.push({ path: rel, name: v.name, reason: "encode bytes mismatch", expected: v.expected_bytes_hex, actual: hex })
          continue
        }
        const decoded = dec(bytes)
        const target = v.expected_decoded !== undefined ? v.expected_decoded : v.input
        if (!equals(decoded, target)) {
          fail++
          failures.push({ path: rel, name: v.name, reason: "decode mismatch", expected: target, actual: decoded })
          continue
        }
        pass++
      } catch (e) {
        fail++
        failures.push({ path: rel, name: v.name, reason: "exception: " + e.message })
      }
    }
  }
}

console.log(`Pass: ${pass}`)
console.log(`Fail: ${fail}`)

if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) {
    console.log(`  ${f.path} :: ${f.name}`)
    console.log(`    reason: ${f.reason}`)
    if (f.expected !== undefined) console.log(`    expected: ${typeof f.expected === "string" ? f.expected : JSON.stringify(f.expected)}`)
    if (f.actual !== undefined) console.log(`    actual:   ${typeof f.actual === "string" ? f.actual : JSON.stringify(f.actual)}`)
  }
  process.exit(1)
}
