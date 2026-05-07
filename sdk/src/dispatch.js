// weavepack v1.2 wire envelope dispatch.
// See weavepack/rfcs/0002-explicit-profile-id.md
//
// The 4-byte v1.2 magic header (prepended to every v1.2 payload):
//   [0] 0x57 'W'
//   [1] 0x50 'P'
//   [2] 0x12  (version byte: high nibble = major 1, low nibble = minor 2)
//   [3] <profile-id>  (0x00 = JSON, 0x01 = tensor)
//
// v1.x payloads (no header) remain valid — the fallback path treats them
// as implicit JSON profile (profile-id 0x00).

// Numeric profile-ids assigned by the profile registry.
export const PID = Object.freeze({
  JSON:   0x00,
  TENSOR: 0x01,
})

const MAGIC_0 = 0x57  // 'W'
const MAGIC_1 = 0x50  // 'P'

// The version byte for weavepack v1.2: major nibble 1, minor nibble 2.
export const VERSION_12 = 0x12

// Prepend the 4-byte v1.2 header to a profile-specific payload.
// Returns a new Uint8Array; the original bytes are not modified.
export function wrapPayload(bytes, profileId) {
  const out = new Uint8Array(4 + bytes.length)
  out[0] = MAGIC_0; out[1] = MAGIC_1; out[2] = VERSION_12; out[3] = profileId
  out.set(bytes, 4)
  return out
}

// Inspect raw bytes for a v1.2 magic header.
//
// Returns { version, profileId, payload } when the header is present, where
//   version   = the raw version byte (e.g. 0x12 for v1.2)
//   profileId = the profile-id byte (e.g. 0x00 = JSON, 0x01 = tensor)
//   payload   = bytes.slice(4) — the profile-specific bitstream
//
// Returns null when there is no magic header (v1.x payload — caller should
// treat it as an implicit JSON payload per the RFC 0002 fallback rule).
//
// Throws an Error when the magic bytes are present but the major version is
// unrecognised (anything other than 1 in the high nibble of byte 2).
export function peekHeader(bytes) {
  if (bytes.length < 4 || bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) {
    return null  // v1.x payload — no header
  }
  const version = bytes[2]
  const major   = version >> 4
  if (major !== 1) throw new Error(`unsupported weavepack major version ${major}`)
  const profileId = bytes[3]
  return { version, profileId, payload: bytes.slice(4) }
}
