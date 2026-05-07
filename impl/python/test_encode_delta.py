"""Unit tests for weavepack-tensor Python delta encoder.

Tests compute_delta + encode_delta byte-exact against the JS reference.
Run from impl/python:
    python3 test_encode_delta.py
"""

import json
import struct
import unittest
from pathlib import Path

from weavepack_tensor import (
    DTYPE,
    OP,
    apply_delta,
    compute_delta,
    encode_delta,
    encode_document,
    parse_chain,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "weavepack" / "profiles" / "tensor" / "test-vectors" / "deltas"


def _parse_input(json_doc):
    out = {"tensors": {}}
    for name, t in json_doc["tensors"].items():
        data = list(t["data"])
        if t["dtype"] in (9, 10):  # INT64/UINT64
            data = [int(s) if isinstance(s, str) else s for s in data]
        out["tensors"][name] = {
            "dtype": t["dtype"],
            "shape": list(t["shape"]),
            "data": data,
        }
    return out


class CorpusEncodeTests(unittest.TestCase):
    """Byte-exact comparison against every delta corpus vector."""

    def _check_all(self, json_file: Path):
        with open(json_file) as f:
            vectors = json.load(f)
        for v in vectors:
            name = v.get("name", "(unnamed)")
            if v.get("delta_bytes_hex"):
                continue  # decode-only vectors; encoder parity not expected
            chain_hex = v.get("expected_chain_bytes_hex", "")
            if not chain_hex:
                continue
            chain_bytes = bytes.fromhex(chain_hex)
            frames = parse_chain(chain_bytes)

            initial = _parse_input(v["initial"])
            final = _parse_input(v["expected_final"])

            anchor = encode_document(initial)
            self.assertEqual(
                anchor.hex(), frames[0].hex(),
                f"{json_file.name} :: {name}: anchor mismatch",
            )

            if len(frames) < 2:
                delta = encode_delta(initial, final)
                self.assertIsNone(
                    delta,
                    f"{json_file.name} :: {name}: expected None for identity",
                )
                continue

            delta = encode_delta(initial, final)
            self.assertIsNotNone(delta, f"{json_file.name} :: {name}: delta is None")
            self.assertEqual(
                delta.hex(), frames[1].hex(),
                f"{json_file.name} :: {name}: delta mismatch",
            )

    def test_tensor_replace_corpus(self):
        self._check_all(VECTORS / "tensor_replace.json")

    def test_tensor_add_remove_corpus(self):
        self._check_all(VECTORS / "tensor_add_remove.json")

    def test_element_set_corpus(self):
        self._check_all(VECTORS / "element_set.json")

    def test_region_replace_corpus(self):
        self._check_all(VECTORS / "region_replace.json")

    def test_quant_change_corpus(self):
        self._check_all(VECTORS / "quant_change.json")


class UnitTests(unittest.TestCase):
    """Unit tests that don't depend on corpus file structure."""

    def test_identical_docs_returns_none(self):
        doc = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [2], "data": [1.0, 2.0]}}}
        self.assertIsNone(encode_delta(doc, doc))

    def test_tensor_remove_op(self):
        base = {"tensors": {"a": {"dtype": DTYPE.FP32, "shape": [1], "data": [1.0]},
                            "b": {"dtype": DTYPE.INT32, "shape": [1], "data": [0]}}}
        new = {"tensors": {"a": {"dtype": DTYPE.FP32, "shape": [1], "data": [1.0]}}}
        ops = compute_delta(base, new)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], OP.TENSOR_REMOVE)
        self.assertEqual(ops[0]["name"], "b")

    def test_tensor_add_op(self):
        base = {"tensors": {}}
        new = {"tensors": {"x": {"dtype": DTYPE.INT8, "shape": [3], "data": [1, 2, 3]}}}
        ops = compute_delta(base, new)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], OP.TENSOR_ADD)

    def test_tensor_replace_round_trip(self):
        base = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [3], "data": [1.0, 2.0, 3.0]}}}
        new  = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [3], "data": [4.0, 5.0, 6.0]}}}
        delta = encode_delta(base, new)
        self.assertIsNotNone(delta)
        result = apply_delta(base, delta)
        self.assertAlmostEqual(result["tensors"]["w"]["data"][0], 4.0, places=5)
        self.assertAlmostEqual(result["tensors"]["w"]["data"][2], 6.0, places=5)

    def test_element_set_sparse_round_trip(self):
        # Change elements 0 and 9 in a [10] tensor: bbox spans [0,10] (size=10)
        # but only 2/10 = 20% density → below REGION_DENSITY_THRESHOLD(50%) → element_set.
        base = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [10],
                                  "data": [float(i) for i in range(10)]}}}
        new_data = [float(i) for i in range(10)]
        new_data[0] = 99.0
        new_data[9] = 88.0
        new = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [10], "data": new_data}}}
        ops = compute_delta(base, new)
        self.assertEqual(ops[0]["op"], OP.ELEMENT_SET)
        delta = encode_delta(base, new)
        result = apply_delta(base, delta)
        self.assertAlmostEqual(result["tensors"]["w"]["data"][0], 99.0, places=5)
        self.assertAlmostEqual(result["tensors"]["w"]["data"][9], 88.0, places=5)

    def test_mode1_emitted_for_small_fp32_delta(self):
        base = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [4],
                                  "data": [1.0, 2.0, 3.0, 4.0]}}}
        new  = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [4],
                                  "data": [1.001, 2.002, 3.003, 4.004]}}}
        ops = compute_delta(base, new)
        self.assertEqual(ops[0]["op"], OP.TENSOR_REPLACE)
        self.assertEqual(ops[0].get("mode", 0), 1, "expected mode=1 for small delta")

    def test_mode0_emitted_for_large_fp32_delta(self):
        base = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [2], "data": [0.0, 0.0]}}}
        new  = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [2], "data": [1.0, 2.0]}}}
        ops = compute_delta(base, new)
        self.assertEqual(ops[0].get("mode", 0), 0, "expected mode=0 for large delta")

    def test_mode1_round_trip(self):
        base = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [4],
                                  "data": [1.0, 2.0, 3.0, 4.0]}}}
        new  = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [4],
                                  "data": [1.001, 2.002, 3.003, 4.004]}}}
        delta = encode_delta(base, new)
        result = apply_delta(base, delta)
        for i, want in enumerate([1.001, 2.002, 3.003, 4.004]):
            self.assertAlmostEqual(result["tensors"]["w"]["data"][i], want, delta=1e-3)

    def test_dtype_change_emits_remove_add(self):
        base = {"tensors": {"w": {"dtype": DTYPE.FP32, "shape": [2], "data": [1.0, 2.0]}}}
        new  = {"tensors": {"w": {"dtype": DTYPE.INT32, "shape": [2], "data": [1, 2]}}}
        ops = compute_delta(base, new)
        op_types = [o["op"] for o in ops]
        self.assertIn(OP.TENSOR_REMOVE, op_types)
        self.assertIn(OP.TENSOR_ADD, op_types)

    def test_region_replace_round_trip(self):
        data = list(range(16))
        base = {"tensors": {"m": {"dtype": DTYPE.INT32, "shape": [4, 4], "data": data}}}
        new_data = list(range(16))
        # Change a 2×2 block in the middle (dense enough for region_replace)
        new_data[5] = 50; new_data[6] = 60; new_data[9] = 70; new_data[10] = 80
        new = {"tensors": {"m": {"dtype": DTYPE.INT32, "shape": [4, 4], "data": new_data}}}
        delta = encode_delta(base, new)
        result = apply_delta(base, delta)
        self.assertEqual(result["tensors"]["m"]["data"][5], 50)
        self.assertEqual(result["tensors"]["m"]["data"][10], 80)


if __name__ == "__main__":
    unittest.main(verbosity=2)
