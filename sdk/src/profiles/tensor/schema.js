// weavepack-tensor — schema canonicalization and hash addressing.
//
// See weavepack/profiles/tensor/06-schemas.md for the normative spec.
//
// Schema language:
//   { "<name>": { "dtype": <code>, "shape": [<dims>...] }, ... }
//
// Canonical form: all keys sorted alphabetically at every level,
// no extra whitespace, UTF-8 encoded. Hash = SHA-256 of that form.

import { createHash } from "node:crypto"

// Recursively sort object keys (depth-first, handles nested objects).
function sortedObject(v) {
  if (Array.isArray(v)) return v.map(sortedObject)
  if (v !== null && typeof v === "object") {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortedObject(v[k])
    return out
  }
  return v
}

export function canonicalizeSchema(schema) {
  return JSON.stringify(sortedObject(schema))
}

export function schemaHash(schema) {
  const canonical = canonicalizeSchema(schema)
  const buf = createHash("sha256").update(canonical, "utf8").digest()
  return new Uint8Array(buf)
}

export function schemaHashHex(schema) {
  return Array.from(schemaHash(schema), b => b.toString(16).padStart(2, "0")).join("")
}
