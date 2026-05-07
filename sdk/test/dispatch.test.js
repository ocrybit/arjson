// weavepack v1.2 dispatch module tests.
// Covers wrapPayload / peekHeader per RFC 0002.

import { describe, it } from "node:test"
import assert from "assert"
import { PID, VERSION_12, wrapPayload, peekHeader } from "../src/dispatch.js"

describe("wrapPayload", () => {
  it("prepends the 4-byte magic header", () => {
    const payload = new Uint8Array([0x80])  // null
    const wrapped = wrapPayload(payload, PID.JSON)
    assert.deepStrictEqual(Array.from(wrapped), [0x57, 0x50, 0x12, 0x00, 0x80])
  })

  it("uses correct profile-id for tensor", () => {
    const payload = new Uint8Array([0xAB, 0xCD])
    const wrapped = wrapPayload(payload, PID.TENSOR)
    assert.strictEqual(wrapped[3], 0x01)
  })

  it("produces a Uint8Array of length payload.length + 4", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const wrapped = wrapPayload(payload, PID.JSON)
    assert.strictEqual(wrapped.length, 9)
  })

  it("does not mutate the input bytes", () => {
    const payload = new Uint8Array([0x81])  // true
    const copy = new Uint8Array(payload)
    wrapPayload(payload, PID.JSON)
    assert.deepStrictEqual(Array.from(payload), Array.from(copy))
  })

  it("version byte is VERSION_12 (0x12)", () => {
    const wrapped = wrapPayload(new Uint8Array([0xFF]), PID.JSON)
    assert.strictEqual(wrapped[2], VERSION_12)
    assert.strictEqual(VERSION_12, 0x12)
  })
})

describe("peekHeader — v1.2 payload", () => {
  it("returns header fields for a valid v1.2 JSON payload", () => {
    const payload = new Uint8Array([0x80])
    const wrapped = wrapPayload(payload, PID.JSON)
    const h = peekHeader(wrapped)
    assert.notStrictEqual(h, null)
    assert.strictEqual(h.version,   0x12)
    assert.strictEqual(h.profileId, 0x00)
    assert.deepStrictEqual(Array.from(h.payload), [0x80])
  })

  it("returns header fields for a valid v1.2 tensor payload", () => {
    const payload = new Uint8Array([0xDE, 0xAD])
    const wrapped = wrapPayload(payload, PID.TENSOR)
    const h = peekHeader(wrapped)
    assert.notStrictEqual(h, null)
    assert.strictEqual(h.profileId, 0x01)
    assert.deepStrictEqual(Array.from(h.payload), [0xDE, 0xAD])
  })

  it("round-trips: peekHeader recovers the original payload bytes", () => {
    const original = new Uint8Array([0x57, 0x01, 0x02, 0x03, 0xFF])
    const wrapped  = wrapPayload(original, PID.JSON)
    const h = peekHeader(wrapped)
    assert.deepStrictEqual(Array.from(h.payload), Array.from(original))
  })
})

describe("peekHeader — v1.x payload (no header)", () => {
  it("returns null for a v1.x JSON payload (no magic)", () => {
    const payload = new Uint8Array([0x80])  // null: starts with 0x80, not 0x57
    assert.strictEqual(peekHeader(payload), null)
  })

  it("returns null for true (0x81)", () => {
    assert.strictEqual(peekHeader(new Uint8Array([0x81])), null)
  })

  it("returns null for an empty buffer", () => {
    assert.strictEqual(peekHeader(new Uint8Array([])), null)
  })

  it("returns null for a 3-byte buffer that starts with magic bytes", () => {
    // Not long enough to contain a full 4-byte header.
    assert.strictEqual(peekHeader(new Uint8Array([0x57, 0x50, 0x12])), null)
  })

  it("returns null when only byte[0] matches", () => {
    assert.strictEqual(peekHeader(new Uint8Array([0x57, 0x00, 0x12, 0x00])), null)
  })
})

describe("peekHeader — unsupported major version", () => {
  it("throws on major version 2", () => {
    // Build a header with version byte 0x20 (major=2, minor=0).
    const buf = new Uint8Array([0x57, 0x50, 0x20, 0x00, 0x80])
    assert.throws(() => peekHeader(buf), /unsupported weavepack major version 2/)
  })

  it("throws on major version 0", () => {
    const buf = new Uint8Array([0x57, 0x50, 0x00, 0x00, 0x80])
    assert.throws(() => peekHeader(buf), /unsupported weavepack major version 0/)
  })

  it("accepts minor versions within major 1 (e.g. v1.3 = 0x13)", () => {
    const buf = new Uint8Array([0x57, 0x50, 0x13, 0x00, 0x80])
    const h = peekHeader(buf)
    assert.notStrictEqual(h, null)
    assert.strictEqual(h.version,   0x13)
    assert.strictEqual(h.profileId, 0x00)
  })
})

describe("PID constants", () => {
  it("JSON profile-id is 0x00", () => assert.strictEqual(PID.JSON, 0x00))
  it("TENSOR profile-id is 0x01", () => assert.strictEqual(PID.TENSOR, 0x01))
  it("PID object is frozen", () => assert.throws(() => { PID.NEW = 99 }))
})
