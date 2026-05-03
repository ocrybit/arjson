"""weavepack-json — single-payload decoder.

Implements the wire format from weavepack/profiles/json/01-types.md
Single-payload mode section. Bit ordering is MSB-first within each
byte (matches the JS reference and Rust impl).
"""

from typing import Any


# ── Single-payload tag table (selector = 0 branch) ──────────────────
# See weavepack/profiles/json/01-types.md, Single-payload mode section.

_NULL          = 0
_TRUE          = 1
_FALSE         = 2
_EMPTY_STRING  = 3
_EMPTY_ARRAY   = 4
_EMPTY_OBJECT  = 5
_INT_NEGATIVE  = 6
_FLOAT_POS     = 7
_FLOAT_NEG     = 8
# 9..60: single character A..Z, a..z (52 chars)
_CHAR_RANGE_LO = 9
_CHAR_RANGE_HI = 60
_CHAR_NON_ALPHA = 61
_STR_BASE64URL = 62
_STR_FALLBACK  = 63

_STRMAP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


class _BitReader:
    """MSB-first bit reader over a bytes object."""

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

    def read_leb128(self) -> int:
        """LEB128 (byte-aligned; 7 bits payload + 1 continuation bit)."""
        result = 0
        shift = 0
        while True:
            byte = self.read_bits(8)
            result |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                return result
            shift += 7

    def read_short(self) -> int:
        """short() per weavepack-core/03-bit-encoding.md."""
        prefix = self.read_bits(2)
        if prefix == 0: return self.read_bits(2)
        if prefix == 1: return self.read_bits(3)
        if prefix == 2: return self.read_bits(4)
        return self.read_leb128()

    def read_uint(self) -> int:
        """uint() per weavepack-core/03-bit-encoding.md."""
        prefix = self.read_bits(2)
        if prefix == 0: return self.read_bits(3)
        if prefix == 1: return self.read_bits(4)
        if prefix == 2: return self.read_bits(6)
        return self.read_leb128()


def decode(data: bytes) -> Any:
    """Decode a weavepack-json single-payload payload.

    Returns the decoded JSON value (None / bool / int / float / str /
    [] / {}).

    Raises NotImplementedError if the payload is structured-mode
    (containers / deltas) — this v0.0.1 supports only single-payload.
    """
    r = _BitReader(data)
    mode = r.read_bits(1)
    if mode != 1:
        raise NotImplementedError(
            "structured-mode decoding not supported in this proof-of-concept"
        )
    selector = r.read_bits(1)
    tag = r.read_bits(6)

    if selector == 1:
        # Positive integer fast path.
        if tag < 63:
            return tag
        return 63 + r.read_leb128()

    # selector = 0: tag table.
    if tag == _NULL:          return None
    if tag == _TRUE:          return True
    if tag == _FALSE:         return False
    if tag == _EMPTY_STRING:  return ""
    if tag == _EMPTY_ARRAY:   return []
    if tag == _EMPTY_OBJECT:  return {}
    if tag == _INT_NEGATIVE:
        return -r.read_uint()
    if tag in (_FLOAT_POS, _FLOAT_NEG):
        prec = r.read_uint()
        mantissa = r.read_uint()
        f = mantissa / (10 ** prec)
        return -f if tag == _FLOAT_NEG else f
    if _CHAR_RANGE_LO <= tag <= _CHAR_RANGE_HI:
        idx = tag - _CHAR_RANGE_LO
        return _STRMAP_ALPHABET[idx]
    if tag == _CHAR_NON_ALPHA:
        return chr(r.read_leb128())
    if tag == _STR_BASE64URL:
        n = r.read_short()
        return "".join(_BASE64URL[r.read_bits(6)] for _ in range(n))
    if tag == _STR_FALLBACK:
        # Length is in UTF-16 code units (matches JS string.length).
        n = r.read_short()
        units = [r.read_leb128() for _ in range(n)]
        # Reassemble surrogate pairs into Unicode code points.
        # Encode as UTF-16-LE bytes, then decode via Python's UTF-16 decoder.
        utf16_bytes = b"".join(u.to_bytes(2, "little") for u in units)
        return utf16_bytes.decode("utf-16-le")
    raise ValueError(f"unknown single-payload tag {tag}")
