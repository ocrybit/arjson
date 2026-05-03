"""weavepack-tensor — pure-Python schemaless + schemaful decoder.

Implements the wire format from
weavepack/profiles/tensor/{02-containers,01-types}.md.
Pure Python 3.10+; no external dependencies (numpy / ml_dtypes are
used only by callers, never by this module).

Returns tensor data as Python lists of native-typed values, except
for fp16/bf16 which return raw u16 bits (consumers convert via the
provided helpers or external libs).
"""

import hashlib
import json
import struct
from typing import Any


# ── dtype registry (mirrors weavepack/profiles/tensor/01-types.md) ──

class DTYPE:
    BOOL = 0
    INT4 = 1
    UINT4 = 2
    INT8 = 3
    UINT8 = 4
    INT16 = 5
    UINT16 = 6
    INT32 = 7
    UINT32 = 8
    INT64 = 9
    UINT64 = 10
    FP8E4M3 = 11
    FP8E5M2 = 12
    FP16 = 13
    BF16 = 14
    FP32 = 15
    FP64 = 16
    CFLOAT32 = 17
    CFLOAT64 = 18
    QINT4 = 28
    QINT8 = 29
    QFP8 = 30


_DTYPE_BITS = {
    DTYPE.BOOL: 1, DTYPE.INT4: 4, DTYPE.UINT4: 4,
    DTYPE.INT8: 8, DTYPE.UINT8: 8,
    DTYPE.INT16: 16, DTYPE.UINT16: 16,
    DTYPE.INT32: 32, DTYPE.UINT32: 32,
    DTYPE.INT64: 64, DTYPE.UINT64: 64,
    DTYPE.FP8E4M3: 8, DTYPE.FP8E5M2: 8,
    DTYPE.FP16: 16, DTYPE.BF16: 16,
    DTYPE.FP32: 32, DTYPE.FP64: 64,
    DTYPE.CFLOAT32: 64, DTYPE.CFLOAT64: 128,
}


def _data_bytes(dtype: int, shape: list[int]) -> int:
    """Total bytes for a tensor of given shape and dtype."""
    bpe = _DTYPE_BITS.get(dtype)
    if bpe is None:
        raise ValueError(f"unknown dtype {dtype}")
    total_elements = 1
    for d in shape:
        total_elements *= d
    if total_elements == 0:
        return 0
    return (total_elements * bpe + 7) // 8


# ── bit reader ──────────────────────────────────────────────────────

class _BitReader:
    """MSB-first bit reader."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_pos = 0

    def read_bits(self, n: int) -> int:
        val = 0
        for _ in range(n):
            byte_idx = self.bit_pos >> 3
            bit_off = self.bit_pos & 7
            bit = (self.data[byte_idx] >> (7 - bit_off)) & 1
            val = (val << 1) | bit
            self.bit_pos += 1
        return val

    def read_byte(self) -> int:
        return self.read_bits(8)

    def read_leb128(self) -> int:
        result = 0
        shift = 0
        while True:
            b = self.read_bits(8)
            result |= (b & 0x7F) << shift
            if not (b & 0x80):
                return result
            shift += 7

    def read_short(self) -> int:
        prefix = self.read_bits(2)
        if prefix == 0: return self.read_bits(2)
        if prefix == 1: return self.read_bits(3)
        if prefix == 2: return self.read_bits(4)
        return self.read_leb128()


# ── element materialization ─────────────────────────────────────────

def _materialize(dtype: int, raw_bytes: bytes, total: int) -> list:
    """Parse raw little-endian bytes into a list of typed values."""
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
            return []
        return list(struct.unpack(fmt_map[dtype], raw_bytes[:struct.calcsize(fmt_map[dtype])]))
    if dtype == DTYPE.BOOL:
        return [(raw_bytes[i >> 3] >> (7 - (i & 7))) & 1 for i in range(total)]
    if dtype == DTYPE.FP16 or dtype == DTYPE.BF16:
        # Return raw u16 bits; caller converts to f32 if desired.
        return list(struct.unpack(f"<{total}H", raw_bytes[:2 * total]))
    raise ValueError(f"unsupported dtype {dtype}; pure-Python decoder is partial")


# ── document decoder (schemaless) ───────────────────────────────────

def decode_document(data: bytes) -> dict:
    """Decode a schemaless tensor document. Returns
    {'tensors': {name: {'dtype': int, 'shape': [int...], 'data': list}}}."""
    r = _BitReader(data)
    type_bit = r.read_bits(1)
    if type_bit != 0:
        raise ValueError("payload is a delta, not a document")
    has_schema = r.read_bits(1)
    if has_schema != 0:
        raise NotImplementedError(
            "schemaful payload — use decode_document_schemaful() with a schema registry"
        )
    n = r.read_leb128()
    tensors = {}
    for _ in range(n):
        name_len = r.read_short()
        name = bytes(r.read_byte() for _ in range(name_len)).decode("utf-8")
        dtype = r.read_bits(5)
        rank = r.read_short()
        shape = [r.read_leb128() for _ in range(rank)]
        nbytes = _data_bytes(dtype, shape)
        raw = bytes(r.read_byte() for _ in range(nbytes))
        total = 1
        for d in shape:
            total *= d
        data_list = _materialize(dtype, raw, total)
        tensors[name] = {"dtype": dtype, "shape": shape, "data": data_list}
    return {"tensors": tensors}


# ── schemaful decoder ────────────────────────────────────────────────

def _canonicalize_schema(schema: dict) -> str:
    """Stable JSON form of a schema (for hashing). Mirrors the JS
    canonicalizeSchema in profiles/tensor/schema.js."""
    sorted_names = sorted(schema.keys())
    canonical = {name: schema[name] for name in sorted_names}
    return json.dumps(canonical, separators=(",", ":"))


def schema_hash(schema: dict) -> bytes:
    """SHA-256 of the canonical schema form."""
    return hashlib.sha256(_canonicalize_schema(schema).encode("utf-8")).digest()


def schema_hash_hex(schema: dict) -> str:
    return schema_hash(schema).hex()


def decode_document_schemaful(data: bytes, schemas: dict) -> dict:
    """Decode a schemaful payload using a hex-keyed schema registry."""
    r = _BitReader(data)
    type_bit = r.read_bits(1)
    if type_bit != 0:
        raise ValueError("payload is a delta, not a document")
    has_schema = r.read_bits(1)
    if has_schema != 1:
        raise ValueError("payload is schemaless; use decode_document()")
    # 32 bytes hash.
    hash_bytes = bytes(r.read_byte() for _ in range(32))
    hash_hex = hash_bytes.hex()
    if hash_hex not in schemas:
        raise KeyError(f"schema {hash_hex} not in registry")
    schema = schemas[hash_hex]
    sorted_names = sorted(schema.keys())
    tensors = {}
    for name in sorted_names:
        sdef = schema[name]
        dtype = sdef["dtype"]
        shape = sdef["shape"]
        nbytes = _data_bytes(dtype, shape)
        raw = bytes(r.read_byte() for _ in range(nbytes))
        total = 1
        for d in shape:
            total *= d
        data_list = _materialize(dtype, raw, total)
        tensors[name] = {"dtype": dtype, "shape": shape, "data": data_list}
    return {"tensors": tensors}


# ── fp16/bf16 helpers (no numpy required) ───────────────────────────

# ── delta application ────────────────────────────────────────────────

class OP:
    TENSOR_REPLACE = 0
    TENSOR_ADD = 1
    TENSOR_REMOVE = 2
    REGION_REPLACE = 3
    ELEMENT_SET = 4
    QUANT_CHANGE = 5


def apply_delta(base_doc: dict, delta_bytes: bytes) -> dict:
    """Apply a tensor delta payload to a base document.

    Implements the wire format from
    weavepack/profiles/tensor/04-deltas.md. v0.0.1 supports
    TENSOR_REPLACE, TENSOR_ADD, TENSOR_REMOVE, ELEMENT_SET.
    REGION_REPLACE and QUANT_CHANGE raise NotImplementedError.
    """
    r = _BitReader(delta_bytes)
    type_bit = r.read_bits(1)
    if type_bit != 1:
        raise ValueError("not a delta payload (type bit = 0)")
    op_count = r.read_leb128()
    tensors = dict(base_doc.get("tensors", {}))

    for _ in range(op_count):
        op_code = r.read_bits(3)

        if op_code == OP.TENSOR_REMOVE:
            name_len = r.read_short()
            name = bytes(r.read_byte() for _ in range(name_len)).decode("utf-8")
            tensors.pop(name, None)

        elif op_code in (OP.TENSOR_REPLACE, OP.TENSOR_ADD):
            name_len = r.read_short()
            name = bytes(r.read_byte() for _ in range(name_len)).decode("utf-8")
            dtype = r.read_bits(5)
            rank = r.read_short()
            shape = [r.read_leb128() for _ in range(rank)]
            nbytes = _data_bytes(dtype, shape)
            raw = bytes(r.read_byte() for _ in range(nbytes))
            total = 1
            for d in shape:
                total *= d
            tensors[name] = {
                "dtype": dtype, "shape": shape,
                "data": _materialize(dtype, raw, total),
            }

        elif op_code == OP.ELEMENT_SET:
            name_len = r.read_short()
            name = bytes(r.read_byte() for _ in range(name_len)).decode("utf-8")
            dtype = r.read_bits(5)
            rank = r.read_short()
            shape = [r.read_leb128() for _ in range(rank)]
            elem_count = r.read_leb128()
            if name not in tensors:
                raise KeyError(f"element_set on unknown tensor {name}")
            base_data = list(tensors[name]["data"])
            value_bytes = (_DTYPE_BITS[dtype] + 7) // 8
            for _ in range(elem_count):
                idx = [r.read_leb128() for _ in range(rank)]
                eb = bytes(r.read_byte() for _ in range(value_bytes))
                value = _materialize(dtype, eb, 1)[0]
                # Convert multi-dim index to flat (row-major).
                flat = 0
                for r2 in range(rank):
                    flat = flat * shape[r2] + idx[r2]
                base_data[flat] = value
            tensors[name] = {"dtype": dtype, "shape": shape, "data": base_data}

        elif op_code == OP.REGION_REPLACE:
            # Wire format per JS reference (sdk/src/profiles/tensor/index.js):
            #   name + dtype + full shape + bbox-rank + (start, end) per dim
            #   + region data block (row-major).
            name_len = r.read_short()
            name = bytes(r.read_byte() for _ in range(name_len)).decode("utf-8")
            dtype = r.read_bits(5)
            rank = r.read_short()
            shape = [r.read_leb128() for _ in range(rank)]
            bbox_rank = r.read_short()
            bbox = []
            for _ in range(bbox_rank):
                s = r.read_leb128()
                e = r.read_leb128()
                bbox.append((s, e))
            region_elements = 1
            for s, e in bbox:
                region_elements *= (e - s)
            value_bytes = (_DTYPE_BITS[dtype] + 7) // 8
            region_raw = bytes(
                r.read_byte() for _ in range(value_bytes * region_elements)
            )
            region_data = _materialize(dtype, region_raw, region_elements)
            if name not in tensors:
                raise KeyError(f"region_replace on unknown tensor {name}")
            base_data = list(tensors[name]["data"])
            # Iterate bbox in row-major order, copy region into base_data.
            idx = [0] * rank
            ptr = [0]  # mutable counter for region_data index

            def recur(dim):
                if dim == rank:
                    flat = 0
                    for d in range(rank):
                        flat = flat * shape[d] + idx[d]
                    base_data[flat] = region_data[ptr[0]]
                    ptr[0] += 1
                    return
                s, e = bbox[dim]
                for i in range(s, e):
                    idx[dim] = i
                    recur(dim + 1)

            recur(0)
            tensors[name] = {"dtype": dtype, "shape": shape, "data": base_data}

        else:
            raise NotImplementedError(f"op {op_code} not in v0.0.1")

    return {"tensors": tensors}


def fp16_bits_to_f32(raw: int) -> float:
    """IEEE 754 binary16 → f32. RFC 0001 reference algorithm."""
    raw &= 0xFFFF
    sign = (raw >> 15) & 1
    exp = (raw >> 10) & 0x1F
    mantissa = raw & 0x3FF
    if exp == 0:
        if mantissa == 0:
            return -0.0 if sign else 0.0
        v = (mantissa / 1024.0) * (2.0 ** -14)
        return -v if sign else v
    if exp == 0x1F:
        if mantissa == 0:
            return float("-inf") if sign else float("inf")
        return float("nan")
    v = (1 + mantissa / 1024.0) * (2.0 ** (exp - 15))
    return -v if sign else v


def bf16_bits_to_f32(raw: int) -> float:
    """bfloat16 → f32. bf16 is the upper 16 bits of f32."""
    raw &= 0xFFFF
    full = raw << 16
    return struct.unpack("<f", struct.pack("<I", full))[0]
