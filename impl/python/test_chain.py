"""Smoke tests for the chain helper (Python analogue of the Rust core unit tests)."""

import unittest
from weavepack_tensor import parse_chain, serialize_chain


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

    def test_prefix_is_a_valid_chain(self):
        """Per-payload addressability: any prefix re-emits to a valid chain."""
        payloads = [b"\x01\x02\x03", b"\x04\x05", b"\x06", b"\x07\x08\x09\x0a"]
        full = serialize_chain(payloads)
        parsed = parse_chain(full)
        self.assertEqual(parsed, payloads)
        for cut in range(1, len(payloads) + 1):
            prefix_buf = serialize_chain(parsed[:cut])
            self.assertEqual(parse_chain(prefix_buf), payloads[:cut])


if __name__ == "__main__":
    unittest.main()
