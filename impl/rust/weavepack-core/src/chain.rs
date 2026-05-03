// Chain serialization: LEB128-length-prefixed concatenation of payloads.
//
// A weavepack chain buffer is the on-wire form of a sequence of
// independently-encoded payloads (one anchor + zero or more deltas).
// Each payload is preceded by a varint length, so consumers can split
// a chain into its constituent payloads without decoding any of them
// — and that, in turn, gives the per-payload addressability property
// the protocol advertises.
//
// Mirrors the JS reference's chainSerialize/chainParse in
// sdk/src/profiles/tensor/index.js.

/// Split a chain buffer into individual payload byte-slices.
///
/// Each returned `Vec<u8>` is one independently-decodable payload.
/// The returned vector's length equals the number of payloads in the
/// chain. Errors (currently a panic on malformed length prefix) are
/// best-effort; this is not a parser meant to handle adversarial input.
pub fn chain_parse(buf: &[u8]) -> Vec<Vec<u8>> {
    let mut off = 0;
    let mut segments = Vec::new();
    while off < buf.len() {
        let mut len: usize = 0;
        let mut shift = 0;
        loop {
            let byte = buf[off];
            off += 1;
            len |= ((byte & 0x7f) as usize) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                break;
            }
        }
        segments.push(buf[off..off + len].to_vec());
        off += len;
    }
    segments
}

/// Serialize a sequence of payloads into a single chain buffer.
///
/// The output is `chain_parse`'s inverse: parsing the result returns
/// the input segments in order.
pub fn chain_serialize(segments: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for seg in segments {
        let mut len = seg.len();
        loop {
            if len < 128 {
                out.push(len as u8);
                break;
            }
            out.push(((len & 0x7f) | 0x80) as u8);
            len >>= 7;
        }
        out.extend_from_slice(seg);
    }
    out
}

/// Validate that a chain conforms to the protocol's
/// "single anchor + deltas" structural rule.
///
/// The first payload may be in any mode (single-payload primitive
/// or structured); subsequent payloads MUST be structured (mode
/// bit = 0). A standalone anchor (single-payload mode) past
/// position 0 indicates the chain was constructed by concatenating
/// independent encoder outputs, which is malformed: receivers will
/// either crash or silently corrupt the result.
///
/// See `weavepack/core/05-deltas.md` §"Encoder buffer policy on
/// re-anchor" and `weavepack/TROUBLESHOOTING.md` "Decoded JSON
/// doesn't match either input state".
///
/// Returns `Ok(())` if the chain is structurally valid, or an
/// `Err` with a diagnostic message identifying the offending
/// payload index.
pub fn chain_validate(buf: &[u8]) -> Result<(), String> {
    let segments = chain_parse(buf);
    for (i, seg) in segments.iter().enumerate().skip(1) {
        if seg.is_empty() {
            return Err(format!("payload {i}: zero-length payload mid-chain"));
        }
        // Mode bit is the MSB of the first byte (MSB-first bit packing).
        let mode_bit = (seg[0] >> 7) & 1;
        if mode_bit == 1 {
            return Err(format!(
                "payload {i}: standalone anchor (mode bit = 1) past position 0; \
                 chain is malformed (multiple anchors). \
                 See weavepack/core/05-deltas.md §\"Encoder buffer policy on re-anchor\"."
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_empty() {
        let segments: Vec<Vec<u8>> = vec![];
        let buf = chain_serialize(&segments);
        assert_eq!(buf.len(), 0);
        assert_eq!(chain_parse(&buf), segments);
    }

    #[test]
    fn round_trip_single_short() {
        let segments = vec![vec![1u8, 2, 3, 4]];
        let buf = chain_serialize(&segments);
        assert_eq!(chain_parse(&buf), segments);
    }

    #[test]
    fn round_trip_multiple() {
        let segments = vec![
            vec![0u8; 5],
            vec![0xffu8; 200],
            vec![1u8, 2, 3],
            vec![0u8; 16384],
        ];
        let buf = chain_serialize(&segments);
        assert_eq!(chain_parse(&buf), segments);
    }

    #[test]
    fn round_trip_empty_payload() {
        // A 0-length payload encodes as a single 0x00 length-prefix byte.
        let segments = vec![vec![]];
        let buf = chain_serialize(&segments);
        assert_eq!(buf, vec![0x00]);
        assert_eq!(chain_parse(&buf), segments);
    }

    #[test]
    fn leb128_boundary_127_vs_128() {
        // 127 fits in one length byte; 128 requires two.
        let buf127 = chain_serialize(&vec![vec![0u8; 127]]);
        assert_eq!(buf127[0], 0x7f);
        assert_eq!(buf127.len(), 1 + 127);

        let buf128 = chain_serialize(&vec![vec![0u8; 128]]);
        assert_eq!(buf128[0], 0x80);
        assert_eq!(buf128[1], 0x01);
        assert_eq!(buf128.len(), 2 + 128);

        // Both round-trip.
        assert_eq!(chain_parse(&buf127), vec![vec![0u8; 127]]);
        assert_eq!(chain_parse(&buf128), vec![vec![0u8; 128]]);
    }

    #[test]
    fn validate_accepts_well_formed_chains() {
        // Single-payload anchor only.
        let single = chain_serialize(&vec![vec![0xeau8]]); // mode bit 1
        assert!(chain_validate(&single).is_ok());
        // Structured anchor + structured deltas.
        let multi = chain_serialize(&vec![
            vec![0x0au8, 0xff],   // mode bit 0
            vec![0x0au8, 0x42],
            vec![0x0au8, 0x99],
        ]);
        assert!(chain_validate(&multi).is_ok());
    }

    #[test]
    fn validate_rejects_anchor_past_position_zero() {
        // Two single-payload anchors concatenated.
        let malformed = chain_serialize(&vec![vec![0xeau8], vec![0xebu8]]);
        let err = chain_validate(&malformed).unwrap_err();
        assert!(err.contains("standalone anchor"), "got: {err}");
        assert!(err.contains("payload 1"), "got: {err}");
    }

    #[test]
    fn validate_rejects_zero_length_payload_mid_chain() {
        let malformed = chain_serialize(&vec![vec![0x0au8, 0xff], vec![]]);
        let err = chain_validate(&malformed).unwrap_err();
        assert!(err.contains("zero-length"), "got: {err}");
    }

    #[test]
    fn prefix_is_a_valid_chain() {
        // Per-payload addressability: any prefix of a chain can be
        // re-emitted on its own and parses back to its constituents.
        let segments = vec![vec![1u8, 2, 3], vec![4u8, 5], vec![6u8], vec![7u8, 8, 9, 10]];
        let full = chain_serialize(&segments);
        let parsed = chain_parse(&full);
        for cut in 1..=segments.len() {
            let prefix = chain_serialize(&parsed[..cut].to_vec());
            assert_eq!(chain_parse(&prefix), segments[..cut].to_vec(),
                "prefix of {cut} payloads should round-trip");
        }
    }
}
