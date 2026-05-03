"""Smoke tests for the chain helper (Python analogue of the Rust core unit tests)."""

import json
import os
import unittest
from weavepack_tensor import parse_chain, serialize_chain, validate_chain

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TENSOR_DELTAS_DIR = os.path.join(REPO_ROOT, "weavepack", "profiles", "tensor", "test-vectors", "deltas")


class ChainTests(unittest.TestCase):

    def test_round_trip_empty(self):
        self.assertEqual(serialize_chain([]), b"")
        self.assertEqual(parse_chain(b""), [])

    def test_round_trip_single_short(self):
        payloads = [b"\x01\x02\x03\x04"]
        self.assertEqual(parse_chain(serialize_chain(payloads)), payloads)

    def test_round_trip_multiple(self):
        payloads = [b"\x00" * 5, b"\xff" * 200, b"\x01\x02\x03", b"\x00" * 16384]
        self.assertEqual(parse_chain(serialize_chain(payloads)), payloads)

    def test_round_trip_empty_payload(self):
        """A 0-length payload encodes as a single 0x00 length-prefix byte."""
        self.assertEqual(serialize_chain([b""]), b"\x00")
        self.assertEqual(parse_chain(b"\x00"), [b""])

    def test_leb128_boundary_127_vs_128(self):
        """127 fits in one length byte; 128 requires two."""
        buf127 = serialize_chain([b"\x00" * 127])
        self.assertEqual(buf127[0], 0x7F)
        self.assertEqual(len(buf127), 1 + 127)

        buf128 = serialize_chain([b"\x00" * 128])
        self.assertEqual(buf128[0], 0x80)
        self.assertEqual(buf128[1], 0x01)
        self.assertEqual(len(buf128), 2 + 128)

        self.assertEqual(parse_chain(buf127), [b"\x00" * 127])
        self.assertEqual(parse_chain(buf128), [b"\x00" * 128])

    def test_prefix_is_a_valid_chain(self):
        """Per-payload addressability: any prefix re-emits to a valid chain."""
        payloads = [b"\x01\x02\x03", b"\x04\x05", b"\x06", b"\x07\x08\x09\x0a"]
        full = serialize_chain(payloads)
        parsed = parse_chain(full)
        self.assertEqual(parsed, payloads)
        for cut in range(1, len(payloads) + 1):
            prefix_buf = serialize_chain(parsed[:cut])
            self.assertEqual(parse_chain(prefix_buf), payloads[:cut])

    def test_validate_accepts_well_formed(self):
        # Single anchor (mode bit 1).
        self.assertIsNone(validate_chain(serialize_chain([b"\xea"])))
        # Structured anchor + structured deltas (mode bit 0).
        self.assertIsNone(validate_chain(serialize_chain([
            b"\x0a\xff", b"\x0a\x42", b"\x0a\x99",
        ])))

    def test_validate_rejects_anchor_past_position_zero(self):
        malformed = serialize_chain([b"\xea", b"\xeb"])
        with self.assertRaises(ValueError) as cm:
            validate_chain(malformed)
        self.assertIn("standalone anchor", str(cm.exception))
        self.assertIn("payload 1", str(cm.exception))

    def test_validate_rejects_zero_length_mid_chain(self):
        malformed = serialize_chain([b"\x0a\xff", b""])
        with self.assertRaises(ValueError) as cm:
            validate_chain(malformed)
        self.assertIn("zero-length", str(cm.exception))

    def test_real_fixture_chains_round_trip(self):
        """Cross-language equivalence: Python parses and re-serializes
        chain bytes produced by the JS reference encoder for every
        delta corpus vector that ships an `expected_chain_bytes_hex`."""
        if not os.path.isdir(TENSOR_DELTAS_DIR):
            self.skipTest(f"corpus not present at {TENSOR_DELTAS_DIR}")
        verified = 0
        for fname in sorted(os.listdir(TENSOR_DELTAS_DIR)):
            if not fname.endswith(".json"):
                continue
            with open(os.path.join(TENSOR_DELTAS_DIR, fname)) as f:
                vectors = json.load(f)
            for v in vectors:
                hexstr = v.get("expected_chain_bytes_hex")
                if not hexstr:
                    continue
                chain = bytes.fromhex(hexstr)
                payloads = parse_chain(chain)
                self.assertEqual(serialize_chain(payloads), chain,
                    f"round-trip mismatch for {fname}::{v.get('name', '?')}")
                self.assertGreaterEqual(len(payloads), 1)
                verified += 1
        self.assertGreater(verified, 0, "no fixture chains found to verify")


if __name__ == "__main__":
    unittest.main()
