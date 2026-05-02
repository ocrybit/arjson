// Property-based test: composition and idempotence laws.
//
// composition:  apply(chain(delta(a, b), delta(b, c)), a)  ≡_JSON  c
// idempotence:  delta(b, b) is empty
//               delta(a, b) applied to apply(delta(a, b), a) is empty
//
// Phase 4 of the weavepack roadmap. See weavepack/core/05-deltas.md.

import { describe, it } from "node:test"
import assert from "assert"
import { ARJSON } from "../../sdk/src/profiles/json/index.js"
import { sampleAny } from "./generators.js"

const ITERATIONS = 100

function jsonEqual(a, b) {
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

describe("property: composition — chained deltas reach the final state", () => {
  it("chain of (a, b, c) replays to c — 100 seeds", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const a = sampleAny(seed * 3 + 0)
      const b = sampleAny(seed * 3 + 1)
      const c = sampleAny(seed * 3 + 2)
      const arj = new ARJSON({ json: a })
      arj.update(b)
      arj.update(c)
      assert.ok(
        jsonEqual(arj.json, c),
        `seed ${seed}: in-memory state diverged from c`
      )
      const restored = new ARJSON({ arj: arj.toBuffer() })
      assert.ok(
        jsonEqual(restored.json, c),
        `seed ${seed}: chain replay diverged from c`
      )
    }
  })

  it("incremental and direct paths to c agree — 100 seeds", () => {
    // Two paths from a:
    //   incremental: a → b → c  (two update steps)
    //   direct:      a → c      (one update step)
    // Both must yield c at JSON-equality.
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const a = sampleAny(seed * 3 + 0)
      const b = sampleAny(seed * 3 + 1)
      const c = sampleAny(seed * 3 + 2)
      const incremental = new ARJSON({ json: a })
      incremental.update(b)
      incremental.update(c)
      const direct = new ARJSON({ json: a })
      direct.update(c)
      assert.ok(
        jsonEqual(incremental.json, direct.json),
        `seed ${seed}: incremental path differs from direct path`
      )
    }
  })
})

describe("property: idempotence — repeated identity updates are no-ops", () => {
  it("delta(b, b) emits zero deltas across 100 seeds", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const v = sampleAny(seed)
      const arj = new ARJSON({ json: v })
      const before = arj.deltas.length
      arj.update(v)
      const after = arj.deltas.length
      assert.equal(
        after,
        before,
        `seed ${seed}: identity update produced ${after - before} extra payloads`
      )
    }
  })

  it("re-applying same target after first update is a no-op — 100 seeds", () => {
    // Update from a to b. Then update from b to b. Second update
    // should add nothing.
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const a = sampleAny(seed * 2)
      const b = sampleAny(seed * 2 + 1)
      const arj = new ARJSON({ json: a })
      arj.update(b)
      const lengthAfterFirst = arj.deltas.length
      arj.update(b)  // re-apply same target
      const lengthAfterSecond = arj.deltas.length
      assert.equal(
        lengthAfterSecond,
        lengthAfterFirst,
        `seed ${seed}: re-applying same target produced ${lengthAfterSecond - lengthAfterFirst} extra payloads`
      )
      assert.ok(
        jsonEqual(arj.json, b),
        `seed ${seed}: state diverged after second update`
      )
    }
  })
})
