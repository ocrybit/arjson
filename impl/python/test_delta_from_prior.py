"""Unit tests for the tensor delta-from-prior (mode=1) decoder path.

The corpus already covers fp32 1D, int32 1D, and fp32 2D matrix
cases via test-vectors/deltas/delta_from_prior/fp32_and_int32.json.
This file adds direct unit tests for the apply_delta + the
internal _apply_arithmetic_delta helper, focused on the dtypes
and edge cases the corpus doesn't reach: fp64, int64 wrapping,
unknown-tensor error.

Run from impl/python:
    python3 test_delta_from_prior.py
"""

import struct
import unittest

from weavepack_tensor import DTYPE, apply_delta, encode_document
from weavepack_tensor.decoder import _apply_arithmetic_delta


class ArithmeticDeltaUnitTests(unittest.TestCase):
    """Direct unit tests for _apply_arithmetic_delta. Avoid the wire
    format here — those are covered via conformance corpus."""

    def test_fp64(self):
        result = _apply_arithmetic_delta(DTYPE.FP64, [10.0, 20.0], [0.5, -1.5])
        self.assertEqual(result, [10.5, 18.5])

    def test_int64_wraps(self):
        max_i64 = (1 << 63) - 1
        min_i64 = -(1 << 63)
        result = _apply_arithmetic_delta(DTYPE.INT64, [max_i64], [1])
        self.assertEqual(result[0], min_i64, "INT64_MAX + 1 should wrap to INT64_MIN")

    def test_uint8_wraps(self):
        result = _apply_arithmetic_delta(DTYPE.UINT8, [255, 0], [1, 255])
        self.assertEqual(result, [0, 255])

    def test_int8_wraps(self):
        result = _apply_arithmetic_delta(DTYPE.INT8, [127, -128], [1, -1])
        self.assertEqual(result, [-128, 127])

    def test_length_mismatch_errors(self):
        with self.assertRaises(ValueError):
            _apply_arithmetic_delta(DTYPE.FP32, [1.0, 2.0], [3.0])

    def test_unsupported_dtype_errors(self):
        # BOOL (dtype 0) is not in the arithmetic-delta match arms.
        with self.assertRaises(ValueError):
            _apply_arithmetic_delta(0, [1, 0], [0, 1])


def _make_mode1_delta_bytes(name, dtype, shape, data_bytes):
    """Hand-craft a tensor_replace mode=1 delta.

    Wire format (per spec/04-deltas.md):
        type bit 1
        leb128(op_count=1)
        op_code 3 bits = 000  (TENSOR_REPLACE)
        short(name_len) + name bytes
        5 bits dtype
        short(rank) + leb128(dim) per dim
        1 bit mode = 1
        data block (raw bytes)
    """
    bits = []
    def write_bits(value, n):
        for i in range(n - 1, -1, -1):
            bits.append((value >> i) & 1)
    def write_leb128(v):
        while v >= 128:
            write_bits(0x80 | (v & 0x7F), 8)
            v >>= 7
        write_bits(v & 0x7F, 8)
    def write_short(v):
        # short = 2-bit prefix + 2/3/4 bits of value, or prefix=3 + leb128 remainder.
        if v < 4: write_bits(0, 2); write_bits(v, 2)
        elif v < 12: write_bits(1, 2); write_bits(v - 4, 3)
        elif v < 28: write_bits(2, 2); write_bits(v - 12, 4)
        else: write_bits(3, 2); write_leb128(v - 28)

    write_bits(1, 1)         # type bit
    write_leb128(1)          # op_count
    write_bits(0, 3)         # op_code TENSOR_REPLACE
    name_bytes = name.encode("utf-8")
    write_short(len(name_bytes))
    for b in name_bytes:
        write_bits(b, 8)
    write_bits(dtype, 5)
    write_short(len(shape))
    for d in shape:
        write_leb128(d)
    write_bits(1, 1)         # mode = 1 (delta-from-prior)
    for b in data_bytes:
        write_bits(b, 8)
    # Pad to byte boundary.
    while len(bits) % 8 != 0:
        bits.append(0)
    out = bytearray()
    for i in range(0, len(bits), 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | bits[i + j]
        out.append(byte)
    return bytes(out)


class ApplyDeltaMode1Tests(unittest.TestCase):

    def test_fp64_through_apply_delta(self):
        base_doc = {"tensors": {"w": {"dtype": DTYPE.FP64, "shape": [2], "data": [1.0, 2.0]}}}
        delta_data = struct.pack("<2d", 0.25, -0.5)
        delta = _make_mode1_delta_bytes("w", DTYPE.FP64, [2], delta_data)
        result = apply_delta(base_doc, delta)
        self.assertEqual(result["tensors"]["w"]["data"], [1.25, 1.5])

    def test_unknown_tensor_errors(self):
        base_doc = {"tensors": {"x": {"dtype": DTYPE.FP32, "shape": [1], "data": [1.0]}}}
        delta_data = struct.pack("<1f", 0.5)
        # Reference a tensor not in base_doc.
        delta = _make_mode1_delta_bytes("nonexistent", DTYPE.FP32, [1], delta_data)
        with self.assertRaises((KeyError, Exception)):
            apply_delta(base_doc, delta)


if __name__ == "__main__":
    unittest.main()
