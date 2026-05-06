"""Unit tests for A.4 skip-load and A.5 streaming iterator in the
pure-Python tensor decoder.

Tests:
  list_tensors_schemaful  — sorted names without decoding data
  decode_tensor_schemaful — first / middle / last tensor, qint8, unknown-name error
  iterate_tensors_schemaful — canonical order, full-doc parity, early stop

Run from impl/python:
    python3 test_skip_load.py
"""

import struct
import unittest

from weavepack_tensor import (
    DTYPE,
    decode_document_schemaful,
    decode_tensor_schemaful,
    encode_document_schemaful,
    iterate_tensors_schemaful,
    list_tensors_schemaful,
    schema_hash_hex,
)


def _registry(schema):
    return {schema_hash_hex(schema): schema}


def _fp32_tensor(values):
    return {"dtype": DTYPE.FP32, "shape": [len(values)], "data": values}


def _make_three_tensors():
    """Build a 3-tensor schemaful doc: alpha, beta, gamma (sorted order)."""
    doc = {"tensors": {
        "alpha": _fp32_tensor([1.0, 2.0, 3.0]),
        "gamma": _fp32_tensor([7.0, 8.0]),
        "beta": {"dtype": DTYPE.INT32, "shape": [4], "data": [10, 20, 30, 40]},
    }}
    schema = {
        "alpha": {"dtype": DTYPE.FP32, "shape": [3]},
        "beta": {"dtype": DTYPE.INT32, "shape": [4]},
        "gamma": {"dtype": DTYPE.FP32, "shape": [2]},
    }
    encoded = encode_document_schemaful(doc, schema)
    return encoded, schema


class ListTensorsSchemafulTest(unittest.TestCase):

    def test_sorted_names_returned(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        names = list_tensors_schemaful(encoded, reg)
        self.assertEqual(names, ["alpha", "beta", "gamma"])

    def test_single_tensor_doc(self):
        schema = {"w": {"dtype": DTYPE.FP32, "shape": [2]}}
        doc = {"tensors": {"w": _fp32_tensor([0.5, -0.5])}}
        encoded = encode_document_schemaful(doc, schema)
        reg = _registry(schema)
        names = list_tensors_schemaful(encoded, reg)
        self.assertEqual(names, ["w"])

    def test_does_not_raise_on_large_doc(self):
        schema = {f"t{i:02d}": {"dtype": DTYPE.FP32, "shape": [10]} for i in range(5)}
        doc = {"tensors": {n: {"dtype": DTYPE.FP32, "shape": [10], "data": [float(i)] * 10}
                           for i, n in enumerate(sorted(schema.keys()))}}
        encoded = encode_document_schemaful(doc, schema)
        reg = _registry(schema)
        names = list_tensors_schemaful(encoded, reg)
        self.assertEqual(names, sorted(schema.keys()))

    def test_unknown_schema_raises(self):
        encoded, schema = _make_three_tensors()
        with self.assertRaises(KeyError):
            list_tensors_schemaful(encoded, {})

    def test_schemaless_raises(self):
        from weavepack_tensor import encode_document
        doc = {"tensors": {"x": _fp32_tensor([1.0])}}
        encoded = encode_document(doc)
        schema = {"x": {"dtype": DTYPE.FP32, "shape": [1]}}
        reg = _registry(schema)
        with self.assertRaises(ValueError):
            list_tensors_schemaful(encoded, reg)


class DecodeTensorSchemafulTest(unittest.TestCase):

    def test_first_tensor(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        result = decode_tensor_schemaful(encoded, "alpha", reg)
        self.assertEqual(result["dtype"], DTYPE.FP32)
        self.assertEqual(result["shape"], [3])
        self.assertAlmostEqual(result["data"][0], 1.0)
        self.assertAlmostEqual(result["data"][2], 3.0)

    def test_middle_tensor(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        result = decode_tensor_schemaful(encoded, "beta", reg)
        self.assertEqual(result["dtype"], DTYPE.INT32)
        self.assertEqual(result["data"], [10, 20, 30, 40])

    def test_last_tensor(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        result = decode_tensor_schemaful(encoded, "gamma", reg)
        self.assertEqual(result["shape"], [2])
        self.assertAlmostEqual(result["data"][0], 7.0)
        self.assertAlmostEqual(result["data"][1], 8.0)

    def test_parity_with_full_decode(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        full = decode_document_schemaful(encoded, reg)
        for name in ["alpha", "beta", "gamma"]:
            single = decode_tensor_schemaful(encoded, name, reg)
            self.assertEqual(single["dtype"], full["tensors"][name]["dtype"])
            self.assertEqual(single["shape"], full["tensors"][name]["shape"])
            for a, b in zip(single["data"], full["tensors"][name]["data"]):
                self.assertAlmostEqual(a, b, places=5)

    def test_unknown_name_raises(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        with self.assertRaises(KeyError):
            decode_tensor_schemaful(encoded, "delta", reg)

    def test_qint8_dequantized(self):
        # scale=0.25, zp=0: float inputs are exact multiples of scale so round-trip is lossless.
        scale, zp = 0.25, 0
        float_vals = [0.5, 1.0, -0.5, -1.0, 0.0]
        schema = {"q": {"dtype": DTYPE.QINT8, "shape": [5], "scale": scale, "zero_point": zp}}
        doc = {"tensors": {"q": {"dtype": DTYPE.QINT8, "shape": [5], "data": float_vals}}}
        encoded = encode_document_schemaful(doc, schema)
        reg = _registry(schema)
        result = decode_tensor_schemaful(encoded, "q", reg)
        for a, b in zip(result["data"], float_vals):
            self.assertAlmostEqual(a, b, places=5)

    def test_byte_offset_cross_check(self):
        """Verify skip-load reaches the same byte position as full sequential decode."""
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        # All three tensors via skip-load must agree with full decode.
        full = decode_document_schemaful(encoded, reg)
        for name in sorted(schema.keys()):
            t = decode_tensor_schemaful(encoded, name, reg)
            f = full["tensors"][name]
            self.assertEqual(t["data"], f["data"])


class IterateTensorsSchemafulTest(unittest.TestCase):

    def test_canonical_order(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        names = [item["name"] for item in iterate_tensors_schemaful(encoded, reg)]
        self.assertEqual(names, ["alpha", "beta", "gamma"])

    def test_full_decode_parity(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        full = decode_document_schemaful(encoded, reg)
        for item in iterate_tensors_schemaful(encoded, reg):
            name = item["name"]
            f = full["tensors"][name]
            self.assertEqual(item["dtype"], f["dtype"])
            self.assertEqual(item["shape"], f["shape"])
            for a, b in zip(item["data"], f["data"]):
                self.assertAlmostEqual(a, b, places=5)

    def test_single_tensor_doc(self):
        schema = {"w": {"dtype": DTYPE.FP32, "shape": [3]}}
        doc = {"tensors": {"w": _fp32_tensor([1.0, 2.0, 3.0])}}
        encoded = encode_document_schemaful(doc, schema)
        reg = _registry(schema)
        items = list(iterate_tensors_schemaful(encoded, reg))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["name"], "w")
        self.assertAlmostEqual(items[0]["data"][1], 2.0)

    def test_mixed_dtypes(self):
        schema = {
            "fp": {"dtype": DTYPE.FP32, "shape": [2]},
            "ii": {"dtype": DTYPE.INT32, "shape": [3]},
        }
        doc = {"tensors": {
            "fp": _fp32_tensor([0.1, -0.1]),
            "ii": {"dtype": DTYPE.INT32, "shape": [3], "data": [1, 2, 3]},
        }}
        encoded = encode_document_schemaful(doc, schema)
        reg = _registry(schema)
        items = {it["name"]: it for it in iterate_tensors_schemaful(encoded, reg)}
        self.assertAlmostEqual(items["fp"]["data"][0], 0.1, places=5)
        self.assertEqual(items["ii"]["data"], [1, 2, 3])

    def test_early_stop_does_not_raise(self):
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        gen = iterate_tensors_schemaful(encoded, reg)
        first = next(gen)
        self.assertEqual(first["name"], "alpha")
        # Close the generator early — must not raise.
        gen.close()

    def test_a4_cross_check(self):
        """iterate_tensors_schemaful and decode_tensor_schemaful must agree."""
        encoded, schema = _make_three_tensors()
        reg = _registry(schema)
        for item in iterate_tensors_schemaful(encoded, reg):
            single = decode_tensor_schemaful(encoded, item["name"], reg)
            self.assertEqual(item["data"], single["data"])

    def test_qint8_dequantized(self):
        # scale=0.25, zp=0: float inputs are exact multiples of scale so round-trip is lossless.
        scale, zp = 0.25, 0
        float_vals = [0.25, 0.5, -0.25]
        schema = {"q": {"dtype": DTYPE.QINT8, "shape": [3], "scale": scale, "zero_point": zp}}
        doc = {"tensors": {"q": {"dtype": DTYPE.QINT8, "shape": [3], "data": float_vals}}}
        encoded = encode_document_schemaful(doc, schema)
        reg = _registry(schema)
        items = list(iterate_tensors_schemaful(encoded, reg))
        for a, b in zip(items[0]["data"], float_vals):
            self.assertAlmostEqual(a, b, places=5)

    def test_schemaless_raises(self):
        from weavepack_tensor import encode_document
        doc = {"tensors": {"x": _fp32_tensor([1.0])}}
        encoded = encode_document(doc)
        schema = {"x": {"dtype": DTYPE.FP32, "shape": [1]}}
        reg = _registry(schema)
        gen = iterate_tensors_schemaful(encoded, reg)
        with self.assertRaises(ValueError):
            next(gen)


if __name__ == "__main__":
    unittest.main()
