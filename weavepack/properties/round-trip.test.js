// Property-based test: round-trip law.
//
//   ∀ json:  decode(encode(json))  ≡_JSON  json
//
// Phase 4 of the weavepack roadmap. See weavepack/core/05-deltas.md
// for the normative statement of this law.

import { describe, it } from "node:test"
import assert from "assert"
import { enc, dec } from "../../sdk/src/profiles/json/index.js"
import { sampleAny, sampleObject, sampleArray, samplePrimitive } from "./generators.js"

const ITERATIONS = 200

function jsonEqual(a, b) {
  // JSON-level equality: structural deep equal with NaN/Inf coerced
  // to null (matching the profile's documented behavior).
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
}

function canonicalize(v) {
  if (typeof v === "number") {
    if (!isFinite(v)) return null
    return v
  }
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map(canonicalize)
  const out = {}
  for (const k of Object.keys(v)) out[k] = canonicalize(v[k])
  return out
}

function checkRoundTrip(input) {
  const bytes = enc(input)
  const decoded = dec(bytes)
  return jsonEqual(canonicalize(input), decoded)
}

describe("property: round-trip on arbitrary JSON values", () => {
  it("holds for primitives across 200 seeds", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const input = samplePrimitive(seed)
      assert.ok(
        checkRoundTrip(input),
        `seed ${seed}: input ${JSON.stringify(input)} did not round-trip`
      )
    }
  })

  it("holds for objects across 200 seeds", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const input = sampleObject(seed)
      assert.ok(
        checkRoundTrip(input),
        `seed ${seed}: input ${JSON.stringify(input)} did not round-trip`
      )
    }
  })

  it("holds for arrays across 200 seeds", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const input = sampleArray(seed)
      assert.ok(
        checkRoundTrip(input),
        `seed ${seed}: input ${JSON.stringify(input)} did not round-trip`
      )
    }
  })

  it("holds for arbitrary nested values across 500 seeds", () => {
    for (let seed = 0; seed < 500; seed++) {
      const input = sampleAny(seed)
      assert.ok(
        checkRoundTrip(input),
        `seed ${seed}: input ${JSON.stringify(input).slice(0, 200)} did not round-trip`
      )
    }
  })

  it("holds for deeply nested structures across 100 seeds", () => {
    for (let seed = 0; seed < 100; seed++) {
      const input = sampleAny(seed, 8)
      assert.ok(
        checkRoundTrip(input),
        `seed ${seed}: deep nested input did not round-trip`
      )
    }
  })
})
