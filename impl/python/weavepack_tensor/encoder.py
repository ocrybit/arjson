"""weavepack-tensor — pure-Python encoder.

Counterpart to decoder.py. Implements schemaless + schemaful encoding
for the dtypes the decoder supports. Round-trips byte-exactly with
the JS reference for every supported dtype.

Scope: encode_document (schemaless), encode_document_schemaful,
compute_delta, encode_delta.
"""

import struct
from typing import Any

from .decoder import (
    DTYPE,
    _DTYPE_BITS,
    _data_bytes,
    schema_hash,
    OP,
)


class _BitWriter:
    """MSB-first bit writer."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.cur = 0
        self.bits_used = 0

    def write_bits(self, val: int, n: int) -> None:
        if n == 0:
            return
        val &= (1 << n) - 1
        remaining = n
        while remaining > 0:
            free = 8 - self.bits_used
            if remaining <= free:
                shift = free - remaining
                self.cur |= (val & ((1 << remaining) - 1)) << shift
                self.bits_used += remaining
                if self.bits_used == 8:
                    self.buf.append(self.cur)
                    self.cur = 0
                    self.bits_used = 0
                return
            shift = remaining - free
            part = (val >> shift) & ((1 << free) - 1)
            self.cur |= part
            self.buf.append(self.cur)
            self.cur = 0
            self.bits_used = 0
            remaining -= free

    def write_byte(self, b: int) -> None:
        self.write_bits(b & 0xFF, 8)

    def finish(self) -> bytes:
        if self.bits_used > 0:
            self.buf.append(self.cur)
        return bytes(self.buf)


def _f32_to_fp8e4m3(f: float) -> int:
    """f32 → fp8e4m3 bit pattern (RNE). Mirrors impl/rust/weavepack-tensor/src/fp8_dtype.rs."""
    if f != f:  # NaN
        return 0x7F
    bits = struct.unpack("<I", struct.pack("<f", float(f)))[0]
    sign = (bits >> 31) & 1
    sign_bit = sign << 7
    exp32 = (bits >> 23) & 0xFF
    mant32 = bits & 0x7FFFFF
    if exp32 == 0 and mant32 == 0:
        return sign_bit  # ±0
    if exp32 == 0xFF and mant32 == 0:
        return sign_bit | 0x7E  # ±Inf → max-finite
    e = exp32 - 127
    if e > 8:
        return sign_bit | 0x7E  # overflow
    if e >= -6:
        exp8 = e + 7
        m = mant32 >> 20
        lost = mant32 & 0xFFFFF
        if lost > 0x80000 or (lost == 0x80000 and (m & 1) != 0):
            m += 1
        if m >= 8:
            new_exp8 = exp8 + 1
            if new_exp8 > 15:
                return sign_bit | 0x7E
            return sign_bit | (new_exp8 << 3)
        if exp8 == 15 and m == 7:
            return sign_bit | 0x7E
        return sign_bit | (exp8 << 3) | m
    if e >= -10:
        mant24 = mant32 | 0x800000
        shift = 14 - e
        if shift >= 24:
            m, lost, halfway = 0, mant24, 0x800000
        else:
            m = (mant24 >> shift) & 0xFF
            lost = mant24 & ((1 << shift) - 1)
            halfway = 1 << (shift - 1)
        if lost > halfway or (lost == halfway and (m & 1) != 0):
            m += 1
        if m >= 8:
            return sign_bit | (1 << 3)
        return sign_bit | m
    return sign_bit  # underflow → ±0


def _leb128(w: _BitWriter, v: int) -> None:
    while v >= 128:
        w.write_byte((v & 0x7F) | 0x80)
        v >>= 7
    w.write_byte(v)


def _short(w: _BitWriter, v: int) -> None:
    if v < 4:
        w.write_bits(0, 2); w.write_bits(v, 2)
    elif v < 8:
        w.write_bits(1, 2); w.write_bits(v, 3)
    elif v < 16:
        w.write_bits(2, 2); w.write_bits(v, 4)
    else:
        w.write_bits(3, 2); _leb128(w, v)


def _serialize_data(dtype: int, data: list, total: int) -> bytes:
    """Pack a Python data list into raw little-endian bytes per dtype."""
    fmt_map = {
        DTYPE.FP32: f"<{total}f",
        DTYPE.FP64: f"<{total}d",
        DTYPE.INT8: f"<{total}b",
        DTYPE.UINT8: f"<{total}B",
        DTYPE.INT16: f"<{total}h",
        DTYPE.UINT16: f"<{total}H",
        DTYPE.INT32: f"<{total}i",
        DTYPE.UINT32: f"<{total}I",
        DTYPE.INT64: f"<{total}q",
        DTYPE.UINT64: f"<{total}Q",
    }
    if dtype in fmt_map:
        if total == 0:
            return b""
        return struct.pack(fmt_map[dtype], *data[:total])
    if dtype == DTYPE.BOOL:
        nbytes = (total + 7) // 8
        out = bytearray(nbytes)
        for i in range(total):
            if data[i]:
                out[i >> 3] |= 1 << (7 - (i & 7))
        return bytes(out)
    if dtype == DTYPE.INT4:
        out = bytearray((total + 1) // 2)
        for i in range(total):
            nibble = int(data[i]) & 0x0F
            if i % 2 == 0:
                out[i >> 1] |= nibble << 4
            else:
                out[i >> 1] |= nibble
        return bytes(out)
    if dtype == DTYPE.UINT4:
        out = bytearray((total + 1) // 2)
        for i in range(total):
            nibble = int(data[i]) & 0x0F
            if i % 2 == 0:
                out[i >> 1] |= nibble << 4
            else:
                out[i >> 1] |= nibble
        return bytes(out)
    if dtype in (DTYPE.FP16, DTYPE.BF16):
        # data is a list of raw u16 bit patterns
        return struct.pack(f"<{total}H", *data[:total])
    if dtype in (DTYPE.FP8E4M3, DTYPE.FP8E5M2):
        # data is a list of raw u8 bit patterns
        return struct.pack(f"<{total}B", *data[:total])
    if dtype == DTYPE.CFLOAT32:
        # Interleaved (real, imag) f32 pairs; 2*total float values.
        return struct.pack(f"<{2 * total}f", *data[:2 * total])
    if dtype == DTYPE.CFLOAT64:
        # Interleaved (real, imag) f64 pairs; 2*total double values.
        return struct.pack(f"<{2 * total}d", *data[:2 * total])
    if dtype == DTYPE.QINT8:
        if total == 0:
            return b""
        return struct.pack(f"<{total}b", *[int(v) for v in data[:total]])
    if dtype == DTYPE.QINT4:
        out = bytearray((total + 1) // 2)
        for i in range(total):
            nibble = int(data[i]) & 0x0F
            if i % 2 == 0:
                out[i >> 1] |= nibble << 4
            else:
                out[i >> 1] |= nibble
        return bytes(out)
    if dtype == DTYPE.QFP8:
        if total == 0:
            return b""
        return struct.pack(f"<{total}B", *[int(v) & 0xFF for v in data[:total]])
    raise ValueError(f"unsupported dtype {dtype} in encoder")


def _emit_data_block(w: _BitWriter, t: dict) -> None:
    total = 1
    for d in t["shape"]:
        total *= d
    raw = _serialize_data(t["dtype"], t["data"], total)
    expected = _data_bytes(t["dtype"], t["shape"])
    if len(raw) < expected:
        raise ValueError(f"data length {len(raw)} < expected {expected}")
    for i in range(expected):
        w.write_byte(raw[i])


def _emit_name(w: _BitWriter, name: str) -> None:
    name_bytes = name.encode("utf-8")
    _short(w, len(name_bytes))
    for b in name_bytes:
        w.write_byte(b)


def _emit_structured_trailer(w: _BitWriter) -> None:
    """JS Encoder.dump() emits this trailer when single=false:
        1 bit (0) + short(rcount=0).
    The tensor encoder uses single=false but pushes nothing to vlinks/
    klinks/nums, so rcount is 0 and the trailer is exactly 1 + 2 + 2 =
    5 bits."""
    w.write_bits(0, 1)
    _short(w, 0)


def encode_document(doc: dict) -> bytes:
    """Encode a schemaless tensor document."""
    w = _BitWriter()
    w.write_bits(0, 1)  # bit 0: document
    w.write_bits(0, 1)  # bit 1: no schema
    names = list(doc["tensors"].keys())
    _leb128(w, len(names))
    for name in names:
        t = doc["tensors"][name]
        _emit_name(w, name)
        w.write_bits(t["dtype"], 5)
        _short(w, len(t["shape"]))
        for dim in t["shape"]:
            _leb128(w, dim)
        _emit_data_block(w, t)
    _emit_structured_trailer(w)
    return w.finish()


def encode_document_schemaful(doc: dict, schema: dict) -> bytes:
    """Encode a schemaful tensor document. Tensors emitted in
    schema-canonical (sorted) name order; only data blocks on the
    wire."""
    sorted_names = sorted(schema.keys())
    h = schema_hash(schema)
    w = _BitWriter()
    w.write_bits(0, 1)  # bit 0: document
    w.write_bits(1, 1)  # bit 1: schema present
    for b in h:
        w.write_byte(b)
    for name in sorted_names:
        if name not in doc["tensors"]:
            raise ValueError(f"schema requires tensor {name!r} but document is missing it")
        t = doc["tensors"][name]
        sdef = schema[name]
        if t["dtype"] != sdef["dtype"]:
            raise ValueError(f"tensor {name!r}: dtype mismatch")
        if list(t["shape"]) != list(sdef["shape"]):
            raise ValueError(f"tensor {name!r}: shape mismatch")
        # Quantize qint dtypes using schema scale/zero_point before emission.
        if t["dtype"] == DTYPE.QINT8 and "scale" in sdef:
            scale, zp = sdef["scale"], sdef.get("zero_point", 0)
            q = [max(-128, min(127, round(v / scale + zp))) for v in t["data"]]
            _emit_data_block(w, {"dtype": DTYPE.QINT8, "shape": t["shape"], "data": q})
        elif t["dtype"] == DTYPE.QINT4 and "scale" in sdef:
            scale, zp = sdef["scale"], sdef.get("zero_point", 0)
            q = [max(-8, min(7, round(v / scale + zp))) for v in t["data"]]
            _emit_data_block(w, {"dtype": DTYPE.QINT4, "shape": t["shape"], "data": q})
        elif t["dtype"] == DTYPE.QFP8 and "scale" in sdef:
            scale = sdef["scale"]
            q = [_f32_to_fp8e4m3(v / scale) for v in t["data"]]
            _emit_data_block(w, {"dtype": DTYPE.QFP8, "shape": t["shape"], "data": q})
        else:
            _emit_data_block(w, t)
    _emit_structured_trailer(w)
    return w.finish()


# ── delta encoder (compute_delta + encode_delta) ──────────────────────────────

_OP_BITS = 3
_DENSITY_THRESHOLD = 0.3
_REGION_DENSITY_THRESHOLD = 0.5
_DELTA_FROM_PRIOR_THRESHOLD = 0.01


def _bytes_per_elem(dtype: int) -> int:
    """Bytes per element for the wire format (element_set uses 1 byte for sub-byte types)."""
    bits = _DTYPE_BITS.get(dtype, 0)
    return (bits + 7) // 8


def _encode_single_element(dtype: int, value) -> bytes:
    """Encode one element value as its element_set wire bytes."""
    if dtype in (DTYPE.INT4, DTYPE.UINT4):
        return bytes([int(value) & 0x0F])
    fmt_map = {
        DTYPE.FP32: ("<f", 4), DTYPE.FP64: ("<d", 8),
        DTYPE.INT8: ("<b", 1), DTYPE.UINT8: ("<B", 1),
        DTYPE.INT16: ("<h", 2), DTYPE.UINT16: ("<H", 2),
        DTYPE.INT32: ("<i", 4), DTYPE.UINT32: ("<I", 4),
        DTYPE.INT64: ("<q", 8), DTYPE.UINT64: ("<Q", 8),
    }
    if dtype in fmt_map:
        fmt, _ = fmt_map[dtype]
        return struct.pack(fmt, value)
    raise ValueError(f"element_set not supported for dtype {dtype}")


def _packed_wire_bytes(t: dict) -> bytes:
    """Get the full tensor as wire bytes for change comparison."""
    total = 1
    for d in t["shape"]:
        total *= d
    return _serialize_data(t["dtype"], t["data"], total)


def _flat_to_indices(flat: int, shape: list) -> list:
    indices = [0] * len(shape)
    for i in range(len(shape) - 1, -1, -1):
        indices[i] = flat % shape[i]
        flat //= shape[i]
    return indices


def _find_changed_elements(base_t: dict, new_t: dict):
    """Return list of {flat, indices} for changed elements, or None for unsupported dtypes."""
    dtype = base_t["dtype"]
    if dtype == DTYPE.BOOL:
        return None
    if dtype in (DTYPE.CFLOAT32, DTYPE.CFLOAT64):
        return None
    total = 1
    for d in base_t["shape"]:
        total *= d
    changed = []
    for i in range(total):
        if base_t["data"][i] != new_t["data"][i]:
            changed.append({"flat": i, "indices": _flat_to_indices(i, base_t["shape"])})
    return changed


def _bounding_box(changed: list, shape: list) -> list:
    """Compute per-dim [start, end) bounding box of changed elements."""
    rank = len(shape)
    mins = [float("inf")] * rank
    maxs = [float("-inf")] * rank
    for c in changed:
        for r in range(rank):
            if c["indices"][r] < mins[r]:
                mins[r] = c["indices"][r]
            if c["indices"][r] > maxs[r]:
                maxs[r] = c["indices"][r]
    return [[int(mins[r]), int(maxs[r]) + 1] for r in range(rank)]


def _bbox_element_count(bbox: list) -> int:
    n = 1
    for s, e in bbox:
        n *= (e - s)
    return n


def _extract_region(t: dict, bbox: list) -> list:
    """Extract elements within bbox in row-major order."""
    rank = len(t["shape"])
    result = []

    def recur(dim, idx):
        if dim == rank:
            flat = 0
            for r in range(rank):
                flat = flat * t["shape"][r] + idx[r]
            result.append(t["data"][flat])
            return
        s, e = bbox[dim]
        for i in range(s, e):
            idx[dim] = i
            recur(dim + 1, idx)

    recur(0, [0] * rank)
    return result


def _max_abs_delta(base_t: dict, new_t: dict) -> float:
    """Max absolute per-element delta for fp32/fp64; returns inf for other dtypes."""
    dtype = base_t["dtype"]
    if dtype not in (DTYPE.FP32, DTYPE.FP64):
        return float("inf")
    max_d = 0.0
    for b, n in zip(base_t["data"], new_t["data"]):
        d = abs(n - b)
        if d > max_d:
            max_d = d
    return max_d


def _compute_delta_bytes_fp(base_t: dict, new_t: dict) -> bytes:
    """Per-element arithmetic delta bytes (new - base) for fp32 or fp64."""
    dtype = base_t["dtype"]
    if dtype == DTYPE.FP32:
        deltas = [float(n) - float(b) for b, n in zip(base_t["data"], new_t["data"])]
        return struct.pack(f"<{len(deltas)}f", *deltas)
    else:  # FP64
        deltas = [float(n) - float(b) for b, n in zip(base_t["data"], new_t["data"])]
        return struct.pack(f"<{len(deltas)}d", *deltas)


def compute_delta(base_doc: dict, new_doc: dict) -> list:
    """Compute ops list between two tensor documents.

    Returns a list of op dicts, one per tensor operation.  Returns an
    empty list when the two documents are identical.
    """
    ops = []
    base_tensors = base_doc.get("tensors", {})
    new_tensors = new_doc.get("tensors", {})

    # Removals
    for name in base_tensors:
        if name not in new_tensors:
            ops.append({"op": OP.TENSOR_REMOVE, "name": name})

    # Additions
    for name in new_tensors:
        if name not in base_tensors:
            t = new_tensors[name]
            ops.append({"op": OP.TENSOR_ADD, "name": name, **t})

    # Changes
    for name in new_tensors:
        if name not in base_tensors:
            continue
        base_t = base_tensors[name]
        new_t = new_tensors[name]

        if base_t["dtype"] != new_t["dtype"] or list(base_t["shape"]) != list(new_t["shape"]):
            ops.append({"op": OP.TENSOR_REMOVE, "name": name})
            ops.append({"op": OP.TENSOR_ADD, "name": name, **new_t})
            continue

        dtype = base_t["dtype"]

        # quant_change: same dtype/shape, quantized dtype, scale or zero_point changed
        if dtype in (DTYPE.QINT8, DTYPE.QINT4, DTYPE.QFP8):
            scale_changed = base_t.get("scale", 0) != new_t.get("scale", 0)
            zp_changed = base_t.get("zero_point", 0) != new_t.get("zero_point", 0)
            if scale_changed or zp_changed:
                ops.append({
                    "op": OP.QUANT_CHANGE,
                    "name": name,
                    "dtype": new_t["dtype"],
                    "shape": new_t["shape"],
                    "data": new_t["data"],
                    "scale": new_t.get("scale", 0),
                    "zero_point": new_t.get("zero_point", 0),
                })
                continue

        base_bytes = _packed_wire_bytes(base_t)
        new_bytes = _packed_wire_bytes(new_t)
        expected = _data_bytes(dtype, base_t["shape"])
        if base_bytes[:expected] == new_bytes[:expected]:
            continue  # no change

        total = 1
        for d in base_t["shape"]:
            total *= d

        changed = _find_changed_elements(base_t, new_t)
        if changed is None:
            ops.append({"op": OP.TENSOR_REPLACE, "name": name, **new_t, "mode": 0})
            continue

        sparsity = len(changed) / total if total > 0 else 0.0

        if sparsity < _DENSITY_THRESHOLD:
            bbox = _bounding_box(changed, new_t["shape"])
            bbox_size = _bbox_element_count(bbox)
            if (bbox_size > 0 and bbox_size < total
                    and len(changed) / bbox_size > _REGION_DENSITY_THRESHOLD):
                region_data = _extract_region(new_t, bbox)
                ops.append({
                    "op": OP.REGION_REPLACE,
                    "name": name,
                    "dtype": new_t["dtype"],
                    "shape": new_t["shape"],
                    "bbox": bbox,
                    "region_data": region_data,
                })
            else:
                elements = [
                    {"indices": c["indices"], "value": new_t["data"][c["flat"]]}
                    for c in changed
                ]
                ops.append({
                    "op": OP.ELEMENT_SET,
                    "name": name,
                    "dtype": new_t["dtype"],
                    "shape": new_t["shape"],
                    "elements": elements,
                })
        else:
            max_d = _max_abs_delta(base_t, new_t)
            if 0 < max_d <= _DELTA_FROM_PRIOR_THRESHOLD:
                delta_bytes = _compute_delta_bytes_fp(base_t, new_t)
                ops.append({
                    "op": OP.TENSOR_REPLACE,
                    "name": name,
                    **new_t,
                    "mode": 1,
                    "delta_data": delta_bytes,
                })
            else:
                ops.append({"op": OP.TENSOR_REPLACE, "name": name, **new_t, "mode": 0})

    return ops


def _emit_quant_change(w: _BitWriter, op: dict) -> None:
    """Emit a quant_change op (op code 5)."""
    _emit_name(w, op["name"])
    # scale: fp32 little-endian
    scale_bytes = struct.pack("<f", float(op.get("scale", 0)))
    for b in scale_bytes:
        w.write_byte(b)
    # zero_point: dtype-dependent
    dtype = op["dtype"]
    if dtype == DTYPE.QINT8:
        w.write_byte(int(op.get("zero_point", 0)) & 0xFF)
    elif dtype == DTYPE.QINT4:
        w.write_byte(int(op.get("zero_point", 0)) & 0x0F)
    # QFP8: no zero_point field
    _emit_data_block(w, op)


def encode_delta(base_doc: dict, new_doc: dict):
    """Encode a delta between two tensor documents.

    Returns bytes if any tensor changed, or None if the documents are identical.
    Byte-exact with the JS ``encodeDelta`` and Rust ``encode_delta`` for all
    supported ops: tensor_replace (mode 0 and 1), tensor_add, tensor_remove,
    element_set, region_replace, quant_change.
    """
    ops = compute_delta(base_doc, new_doc)
    if not ops:
        return None

    w = _BitWriter()
    w.write_bits(1, 1)  # bit 0: delta
    _leb128(w, len(ops))

    for op in ops:
        op_code = op["op"]
        w.write_bits(op_code, _OP_BITS)

        if op_code == OP.TENSOR_REMOVE:
            _emit_name(w, op["name"])

        elif op_code in (OP.TENSOR_ADD, OP.TENSOR_REPLACE):
            _emit_name(w, op["name"])
            w.write_bits(op["dtype"], 5)
            _short(w, len(op["shape"]))
            for dim in op["shape"]:
                _leb128(w, dim)
            if op_code == OP.TENSOR_REPLACE:
                mode = op.get("mode", 0)
                w.write_bits(mode, 1)
                if mode == 1:
                    delta_data = op["delta_data"]
                    for b in delta_data:
                        w.write_byte(b)
                else:
                    _emit_data_block(w, op)
            else:
                _emit_data_block(w, op)

        elif op_code == OP.ELEMENT_SET:
            _emit_name(w, op["name"])
            w.write_bits(op["dtype"], 5)
            _short(w, len(op["shape"]))
            for dim in op["shape"]:
                _leb128(w, dim)
            elements = op["elements"]
            _leb128(w, len(elements))
            bpe = _bytes_per_elem(op["dtype"])
            for elem in elements:
                for idx in elem["indices"]:
                    _leb128(w, idx)
                eb = _encode_single_element(op["dtype"], elem["value"])
                for b in eb[:bpe]:
                    w.write_byte(b)

        elif op_code == OP.REGION_REPLACE:
            _emit_name(w, op["name"])
            w.write_bits(op["dtype"], 5)
            _short(w, len(op["shape"]))
            for dim in op["shape"]:
                _leb128(w, dim)
            bbox = op["bbox"]
            _short(w, len(bbox))
            for s, e in bbox:
                _leb128(w, s)
                _leb128(w, e)
            region_data = op["region_data"]
            total_region = 1
            for s, e in bbox:
                total_region *= (e - s)
            region_bytes = _serialize_data(op["dtype"], region_data, total_region)
            for b in region_bytes:
                w.write_byte(b)

        elif op_code == OP.QUANT_CHANGE:
            _emit_quant_change(w, op)

        else:
            raise ValueError(f"unsupported op code {op_code}")

    _emit_structured_trailer(w)
    return w.finish()
