// weavepack v1.2 wire envelope dispatch.
// See weavepack/rfcs/0002-explicit-profile-id.md
//
// The 4-byte v1.2 magic header (prepended to every v1.2 payload):
//   [0] 0x57  'W'
//   [1] 0x50  'P'
//   [2] 0x12   version byte: high nibble = major 1, low nibble = minor 2
//   [3] <pid>  profile-id (PID::JSON = 0x00, PID::TENSOR = 0x01)
//
// v1.x payloads (no header) remain valid — peek_header returns None for
// them; callers treat absent headers as implicit JSON (RFC 0002 fallback).

/// Numeric profile-ids assigned by the weavepack profile registry.
pub mod PID {
    pub const JSON:   u8 = 0x00;
    pub const TENSOR: u8 = 0x01;
}

pub const VERSION_12: u8 = 0x12;

const MAGIC_0: u8 = 0x57; // 'W'
const MAGIC_1: u8 = 0x50; // 'P'

/// Result returned by `peek_header` when a v1.2 header is present.
#[derive(Debug, PartialEq, Clone)]
pub struct PeekResult {
    /// Raw version byte (e.g. 0x12 for v1.2).
    pub version: u8,
    /// Profile-id byte (e.g. PID::JSON or PID::TENSOR).
    pub profile_id: u8,
    /// Profile-specific payload (bytes after the 4-byte header).
    pub payload: Vec<u8>,
}

/// Prepend the 4-byte v1.2 header to a profile-specific payload.
/// Returns a new Vec<u8>; the original bytes are not modified.
pub fn wrap_payload(bytes: &[u8], profile_id: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.push(MAGIC_0);
    out.push(MAGIC_1);
    out.push(VERSION_12);
    out.push(profile_id);
    out.extend_from_slice(bytes);
    out
}

/// Inspect raw bytes for a v1.2 magic header.
///
/// Returns `Some(PeekResult)` when the header is present.
/// Returns `None` when there is no magic header (v1.x payload — caller
/// should treat it as an implicit JSON payload per RFC 0002 fallback).
/// Returns `Err(String)` when the magic bytes are present but the major
/// version is unrecognised (anything other than 1 in the high nibble).
pub fn peek_header(bytes: &[u8]) -> Result<Option<PeekResult>, String> {
    if bytes.len() < 4 || bytes[0] != MAGIC_0 || bytes[1] != MAGIC_1 {
        return Ok(None); // v1.x payload — no header
    }
    let version = bytes[2];
    let major = version >> 4;
    if major != 1 {
        return Err(format!("unsupported weavepack major version {major}"));
    }
    let profile_id = bytes[3];
    Ok(Some(PeekResult {
        version,
        profile_id,
        payload: bytes[4..].to_vec(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_json_round_trip() {
        let payload = vec![0x80u8]; // null in JSON single-payload encoding
        let wrapped = wrap_payload(&payload, PID::JSON);
        assert_eq!(&wrapped[..4], &[0x57, 0x50, 0x12, 0x00]);
        let result = peek_header(&wrapped).unwrap().unwrap();
        assert_eq!(result.version, VERSION_12);
        assert_eq!(result.profile_id, PID::JSON);
        assert_eq!(result.payload, payload);
    }

    #[test]
    fn wrap_tensor_round_trip() {
        let payload = vec![0x01u8, 0x02, 0x03];
        let wrapped = wrap_payload(&payload, PID::TENSOR);
        assert_eq!(wrapped[3], PID::TENSOR);
        let result = peek_header(&wrapped).unwrap().unwrap();
        assert_eq!(result.profile_id, PID::TENSOR);
        assert_eq!(result.payload, payload);
    }

    #[test]
    fn v1x_payload_returns_none() {
        // A v1.x payload doesn't start with WP magic — peek returns None.
        let v1x = vec![0xeau8]; // integer 42 in JSON single-payload
        assert_eq!(peek_header(&v1x).unwrap(), None);
    }

    #[test]
    fn unknown_major_version_returns_err() {
        // Construct a payload with major version 2.
        let bad = vec![0x57u8, 0x50, 0x22, 0x00, 0x80];
        assert!(peek_header(&bad).is_err());
    }

    #[test]
    fn too_short_returns_none() {
        assert_eq!(peek_header(&[]).unwrap(), None);
        assert_eq!(peek_header(&[0x57, 0x50, 0x12]).unwrap(), None);
    }

    // Known byte vectors from the conformance corpus.

    #[test]
    fn corpus_json_null() {
        // v1.2 null: 5750120080
        let bytes = [0x57u8, 0x50, 0x12, 0x00, 0x80];
        let r = peek_header(&bytes).unwrap().unwrap();
        assert_eq!(r.profile_id, PID::JSON);
        assert_eq!(r.payload, vec![0x80]);
    }

    #[test]
    fn corpus_json_true() {
        // v1.2 true: 5750120081
        let bytes = [0x57u8, 0x50, 0x12, 0x00, 0x81];
        let r = peek_header(&bytes).unwrap().unwrap();
        assert_eq!(r.profile_id, PID::JSON);
        assert_eq!(r.payload, vec![0x81]);
    }
}
