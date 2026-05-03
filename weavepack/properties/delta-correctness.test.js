// Property-based test: delta correctness law.
//
//   ∀ a, b:  apply(delta(a, b), a)  ≡_JSON  b
//
// Phase 4 of the weavepack roadmap. See weavepack/core/05-deltas.md
// for the normative statement of this law.

import { describe, it } from "node:test"
import assert from "assert"
import { ARJSON } from "../../sdk/src/profiles/json/index.js"
import { sampleAny, samplePair } from "./generators.js"

const ITERATIONS = 200

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

// checkDelta(a, b): construct an ARJSON from a, update to b, then
// verify the resulting state equals b. Also checks the chain bytes
// round-trip.
function checkDelta(a, b) {
  const arj = new ARJSON({ json: a })
  arj.update(b)
  if (!jsonEqual(arj.json, b)) {
    return { ok: false, reason: "in-memory state diverges from b after update", actual: arj.json }
  }
  const restored = new ARJSON({ arj: arj.toBuffer() })
  if (!jsonEqual(restored.json, b)) {
    return { ok: false, reason: "chain bytes did not round-trip to b", actual: restored.json }
  }
  return { ok: true }
}

describe("property: delta correctness — apply(delta(a, b), a) = b", () => {
  it("holds for random pairs across 200 seeds", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const [a, b] = samplePair(seed)
      const r = checkDelta(a, b)
      if (!r.ok) {
        const aStr = (JSON.stringify(a) ?? String(a)).slice(0, 100)
        const bStr = (JSON.stringify(b) ?? String(b)).slice(0, 100)
        const actStr = (JSON.stringify(r.actual) ?? String(r.actual)).slice(0, 100)
        assert.fail(`seed ${seed}: ${r.reason} (a=${aStr}, b=${bStr}, actual=${actStr})`)
      }
    }
  })

  it("holds for self-deltas (a → a) across 100 seeds", () => {
    // delta(a, a) should be a no-op.
    for (let seed = 0; seed < 100; seed++) {
      const a = sampleAny(seed)
      const arj = new ARJSON({ json: a })
      const lengthBefore = arj.deltas.length
      arj.update(a)
      const lengthAfter = arj.deltas.length
      assert.ok(
        jsonEqual(arj.json, a),
        `seed ${seed}: self-delta corrupted state`
      )
      assert.equal(
        lengthAfter,
        lengthBefore,
        `seed ${seed}: self-delta produced ${lengthAfter - lengthBefore} extra payloads (expected 0)`
      )
    }
  })

  it("holds for chained random updates (5 in a row) across 100 seeds", () => {
    for (let seed = 0; seed < 100; seed++) {
      const seq = []
      for (let i = 0; i < 5; i++) seq.push(sampleAny(seed * 13 + i))
      const arj = new ARJSON({ json: seq[0] })
      for (let i = 1; i < seq.length; i++) {
        arj.update(seq[i])
        assert.ok(
          jsonEqual(arj.json, seq[i]),
          `seed ${seed}, step ${i}: state diverged from expected`
        )
      }
      // Final chain bytes should restore to the last value.
      const restored = new ARJSON({ arj: arj.toBuffer() })
      assert.ok(
        jsonEqual(restored.json, seq[seq.length - 1]),
        `seed ${seed}: chain replay diverged from final value`
      )
    }
  })

  // Prefix-restore framing property: any byte-prefix of a chain that
  // contains a whole number of LEB128-framed payloads is itself a
  // valid chain (parses without error, decodes to *some* state).
  //
  // Note: ARJSON's update() re-anchors in some cases (non-structural
  // root replace, empty-path diff, object-replace), which collapses
  // earlier payloads. So we cannot assert "prefix N decodes to the
  // state after the Nth update". The actual framing-level guarantee
  // is structural: the chain bytes are losslessly splittable, every
  // prefix [0..k] is parseable, and decoding it succeeds. That's what
  // per-payload addressability rests on, regardless of any encoder-
  // side coalescing.
  it("any chain prefix is a valid parseable chain — 100 seeds", () => {
    for (let seed = 0; seed < 100; seed++) {
      const seq = []
      for (let i = 0; i < 4; i++) seq.push(sampleAny(seed * 17 + i))
      const arj = new ARJSON({ json: seq[0] })
      for (let i = 1; i < seq.length; i++) arj.update(seq[i])
      const fullBuf = arj.toBuffer()
      const allPayloads = ARJSON.fromBuffer(fullBuf)
      // Structural property #1: round-trip framing.
      const reEmitted = ARJSON.toBuffer(allPayloads)
      assert.deepEqual(
        Array.from(reEmitted), Array.from(fullBuf),
        `seed ${seed}: re-emit of parsed payloads should be byte-identical`
      )
      // Structural property #2: every prefix decodes without error.
      for (let cut = 1; cut <= allPayloads.length; cut++) {
        const prefixBuf = ARJSON.toBuffer(allPayloads.slice(0, cut))
        const restored = new ARJSON({ arj: prefixBuf })
        assert.ok(
          restored.deltas.length === cut,
          `seed ${seed}: prefix of ${cut} payloads should re-parse into ${cut} payloads`
        )
      }
    }
  })
})
