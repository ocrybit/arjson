// Null profile — the trivial second profile.
//
// Purpose: validate the protocol/profile boundary established in
// Phase 3. If the JSON-specific code in profiles/json/ has correctly
// localized JSON's assumptions, then implementing a profile that
// encodes only the value `null` should NOT require touching anything
// in profiles/json/ or in the top-level src/ files (other than
// generic infrastructure: Encoder class, utils helpers).
//
// Concretely, this profile imports ONLY from:
//   - ../../encoder.js (Encoder class — bit-pack accumulator, generic)
//   - ../../utils.js   (bit primitives — generic)
//
// It MUST NOT import from:
//   - ../../arjson.js, ../../builder.js, ../../decoder.js (now JSON profile)
//   - ../json/*        (JSON profile internals)
//
// If a future change to the JSON profile breaks this profile's
// imports or behavior, the boundary has leaked and Phase 3 has
// regressed.
//
// The profile encodes/decodes a single value: `null`. The wire
// format is a single byte 0x80 (single-payload mode bit + null
// tag). Updates always re-anchor; there are no incremental deltas
// because there's only one possible value.

import { Encoder } from "../../encoder.js"

// Profile identity
export const PROFILE_ID = "null"
export const PROFILE_VERSION = "0.1"

// Singleton encoder reused across encode calls.
const _enc = new Encoder()

// encode(value): MUST be exactly null. Returns the wire bytes.
export function encode(value) {
  if (value !== null) {
    throw new TypeError("null profile encodes only the value `null`")
  }
  _enc.reset({})
  _enc.add_dc(1, 1)  // single-payload mode bit
  _enc.add_dc(0, 7)  // null tag (matches JSON profile's tag space coincidentally)
  return _enc.dump()
}

// decode(bytes): expects the canonical 0x80 byte. Returns null.
export function decode(bytes) {
  if (bytes.length !== 1 || bytes[0] !== 0x80) {
    throw new Error(
      `null profile expects exactly 0x80; got ${
        Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
      }`
    )
  }
  return null
}

// NullARJSON: minimal high-level API in the same shape as ARJSON.
// Every value is null; every "update" re-anchors to null again.
export class NullARJSON {
  constructor() {
    this.json = null
    this.deltas = [encode(null)]
  }
  update(_value) {
    // No-op: the only legal value is null, and the JSON is already
    // null. Updates produce no new deltas. Returns empty list.
    return []
  }
  toBuffer() {
    // Single delta; no length prefix needed for a single payload.
    return this.deltas[0]
  }
  static fromBuffer(buffer) {
    decode(new Uint8Array(buffer))
    return new NullARJSON()
  }
}
