// Phase 3.8 boundary gate — validates that profiles/null/ can be
// implemented without touching profiles/json/ or any JSON-specific
// code at the top of src/.
//
// If this test passes, the protocol/profile boundary is real: a new
// profile can be added by writing a sibling profiles/<name>/ that
// uses only generic infrastructure (Encoder class, utils helpers).
//
// If the import line itself fails or any test below fails, the
// boundary has leaked — file as a Phase 3 regression and fix the
// leak.

import { describe, it } from "node:test"
import assert from "assert"
import {
  encode,
  decode,
  NullARJSON,
  PROFILE_ID,
  PROFILE_VERSION,
} from "../src/profiles/null/index.js"

describe("null profile (Phase 3 boundary gate)", () => {
  it("identifies as the null profile", () => {
    assert.equal(PROFILE_ID, "null")
    assert.equal(PROFILE_VERSION, "0.1")
  })

  it("encodes null to a single 0x80 byte", () => {
    const bytes = encode(null)
    assert.equal(bytes.length, 1)
    assert.equal(bytes[0], 0x80)
  })

  it("rejects non-null values", () => {
    assert.throws(() => encode(0), TypeError)
    assert.throws(() => encode(false), TypeError)
    assert.throws(() => encode(""), TypeError)
    assert.throws(() => encode({}), TypeError)
    assert.throws(() => encode([]), TypeError)
  })

  it("decodes 0x80 to null", () => {
    const bytes = new Uint8Array([0x80])
    assert.strictEqual(decode(bytes), null)
  })

  it("rejects malformed input", () => {
    assert.throws(() => decode(new Uint8Array([0x00])))
    assert.throws(() => decode(new Uint8Array([0x80, 0x80])))
    assert.throws(() => decode(new Uint8Array([])))
  })

  it("round-trips null", () => {
    assert.strictEqual(decode(encode(null)), null)
  })

  describe("NullARJSON high-level API", () => {
    it("constructs with null", () => {
      const a = new NullARJSON()
      assert.strictEqual(a.json, null)
      assert.equal(a.deltas.length, 1)
    })

    it("update is a no-op", () => {
      const a = new NullARJSON()
      const result = a.update(null)
      assert.deepEqual(result, [])
      assert.strictEqual(a.json, null)
    })

    it("toBuffer + fromBuffer round-trip", () => {
      const a = new NullARJSON()
      const buf = a.toBuffer()
      const restored = NullARJSON.fromBuffer(buf)
      assert.strictEqual(restored.json, null)
    })
  })

  describe("boundary verification", () => {
    it("does not import from profiles/json/", async () => {
      const { readFileSync } = await import("node:fs")
      const { fileURLToPath } = await import("node:url")
      const src = readFileSync(
        fileURLToPath(new URL("../src/profiles/null/index.js", import.meta.url)),
        "utf8"
      )
      // Only check actual import statements, not prose mentions.
      const importLines = src.split("\n").filter(line =>
        /^\s*import\b/.test(line) || /^\s*export\s+.*\bfrom\b/.test(line)
      )
      const offending = importLines.filter(line => line.includes("profiles/json"))
      assert.deepEqual(
        offending,
        [],
        "null profile must not import from profiles/json/"
      )
    })

    it("does not import the JSON profile's higher-level modules", async () => {
      const { readFileSync } = await import("node:fs")
      const { fileURLToPath } = await import("node:url")
      const src = readFileSync(
        fileURLToPath(new URL("../src/profiles/null/index.js", import.meta.url)),
        "utf8"
      )
      // arjson.js, builder.js, decoder.js — these are JSON profile
      // entry points (or shims to them). The null profile must not
      // depend on any.
      const forbiddenImports = [
        '"../../arjson.js"',
        '"../../builder.js"',
        '"../../decoder.js"',
      ]
      for (const fi of forbiddenImports) {
        assert.equal(
          src.includes(fi),
          false,
          `null profile must not import ${fi}`
        )
      }
    })
  })
})
