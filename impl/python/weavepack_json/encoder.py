"""weavepack-json — single-payload encoder.

Counterpart to decoder.py. Implements the wire format from
weavepack/profiles/json/01-types.md (Single-payload mode section)
in pure Python.

Scope: same as decoder — null / bool / int / float / string / empty
container. Structured mode (objects, arrays, deltas) deferred.

Round-trip: this encoder produces byte sequences that decode.decode()
returns to the original value, achieving Level 2 conformance for the
single-payload subset.
"""

import struct
from typing import Any


# Tag table (mirrors decoder)
_NULL          = 0
_TRUE          = 1
_FALSE         = 2
_EMPTY_STRING  = 3
_EMPTY_ARRAY   = 4
_EMPTY_OBJECT  = 5
_INT_NEGATIVE  = 6
_FLOAT_POS     = 7
_FLOAT_NEG     = 8
_CHAR_RANGE_LO = 9
_CHAR_NON_ALPHA = 61
_STR_BASE64URL = 62
_STR_FALLBACK  = 63

_STRMAP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_STRMAP_INDEX = {c: i for i, c in enumerate(_STRMAP_ALPHABET)}
_BASE64URL_INDEX = {c: i for i, c in enumerate(_BASE64URL)}


class _BitWriter:
    """MSB-first bit writer. Output zero-padded to byte boundary."""

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

    def finish(self) -> bytes:
        if self.bits_used > 0:
            self.buf.append(self.cur)
        return bytes(self.buf)


def _leb128(w: _BitWriter, v: int) -> None:
    while v >= 128:
        w.write_bits((v & 0x7F) | 0x80, 8)
        v >>= 7
    w.write_bits(v, 8)


def _short(w: _BitWriter, v: int) -> None:
    if v < 4:
        w.write_bits(0, 2); w.write_bits(v, 2)
    elif v < 8:
        w.write_bits(1, 2); w.write_bits(v, 3)
    elif v < 16:
        w.write_bits(2, 2); w.write_bits(v, 4)
    else:
        w.write_bits(3, 2); _leb128(w, v)


def _uint(w: _BitWriter, v: int) -> None:
    if v < 8:
        w.write_bits(0, 2); w.write_bits(v, 3)
    elif v < 16:
        w.write_bits(1, 2); w.write_bits(v, 4)
    elif v < 64:
        w.write_bits(2, 2); w.write_bits(v, 6)
    else:
        w.write_bits(3, 2); _leb128(w, v)


def _get_precision(v: float) -> int:
    """Number of significant fractional digits, capped at 308."""
    if v == 0.0:
        return 0
    s = repr(v)
    if "e" in s or "E" in s:
        sep = "e" if "e" in s else "E"
        mantissa, exp_s = s.split(sep, 1)
        exp = int(exp_s)
        if "." in mantissa:
            frac = mantissa.split(".", 1)[1]
            mantissa_prec = len(frac)
        else:
            mantissa_prec = 0
        return min(max(0, mantissa_prec - exp), 308)
    if "." in s:
        frac = s.split(".", 1)[1].rstrip("0")
        return min(len(frac), 308)
    return 0


def _encode_int(w: _BitWriter, v: int) -> None:
    if v >= 0:
        # Selector = 1 (positive int fast path).
        w.write_bits(1, 1)
        if v < 63:
            w.write_bits(v, 6)
        else:
            w.write_bits(63, 6)
            _leb128(w, v - 63)
    else:
        # Selector = 0, tag = INT_NEGATIVE.
        w.write_bits(0, 1)
        w.write_bits(_INT_NEGATIVE, 6)
        _uint(w, -v)


def _encode_float(w: _BitWriter, v: float) -> None:
    neg = v < 0
    abs_v = -v if neg else v
    prec = min(_get_precision(abs_v), 308)
    mantissa = round(abs_v * (10 ** prec))
    w.write_bits(0, 1)
    w.write_bits(_FLOAT_NEG if neg else _FLOAT_POS, 6)
    _uint(w, prec)
    _uint(w, mantissa)


def _encode_string(w: _BitWriter, s: str) -> None:
    if s == "":
        w.write_bits(0, 1)
        w.write_bits(_EMPTY_STRING, 6)
        return
    # Length is UTF-16 code units (matches JS string.length).
    utf16 = s.encode("utf-16-le")
    n_units = len(utf16) // 2
    if n_units == 1:
        c = s[0] if len(s) == 1 else None
        if c is not None and c in _STRMAP_INDEX:
            idx = _STRMAP_INDEX[c]
            w.write_bits(0, 1)
            w.write_bits(_CHAR_RANGE_LO + idx, 6)
            return
        if c is not None and ord(c) < 0x10000:
            # Single-char outside [A-Za-z]
            w.write_bits(0, 1)
            w.write_bits(_CHAR_NON_ALPHA, 6)
            _leb128(w, ord(c))
            return
    # Multi-char.
    is_b64 = all(ch in _BASE64URL_INDEX for ch in s) and len(s) > 0
    if is_b64:
        w.write_bits(0, 1)
        w.write_bits(_STR_BASE64URL, 6)
        _short(w, n_units)
        for ch in s:
            w.write_bits(_BASE64URL_INDEX[ch], 6)
    else:
        w.write_bits(0, 1)
        w.write_bits(_STR_FALLBACK, 6)
        _short(w, n_units)
        # Emit per UTF-16 code unit.
        for i in range(0, len(utf16), 2):
            unit = utf16[i] | (utf16[i + 1] << 8)
            _leb128(w, unit)


def encode(value: Any) -> bytes:
    """Encode a single-payload-eligible JSON value.

    Raises NotImplementedError for non-empty arrays / objects (those
    require structured mode, which this v0.0.1 doesn't implement).
    """
    w = _BitWriter()
    w.write_bits(1, 1)  # mode bit = single

    if value is None:
        w.write_bits(0, 1); w.write_bits(_NULL, 6)
    elif value is True:
        w.write_bits(0, 1); w.write_bits(_TRUE, 6)
    elif value is False:
        w.write_bits(0, 1); w.write_bits(_FALSE, 6)
    elif isinstance(value, str):
        _encode_string(w, value)
    elif isinstance(value, list):
        if len(value) == 0:
            w.write_bits(0, 1); w.write_bits(_EMPTY_ARRAY, 6)
        else:
            raise NotImplementedError("non-empty arrays require structured mode")
    elif isinstance(value, dict):
        if len(value) == 0:
            w.write_bits(0, 1); w.write_bits(_EMPTY_OBJECT, 6)
        else:
            raise NotImplementedError("non-empty objects require structured mode")
    elif isinstance(value, int) and not isinstance(value, bool):
        _encode_int(w, value)
    elif isinstance(value, float):
        if value != value:  # NaN
            w.write_bits(0, 1); w.write_bits(_NULL, 6)
        elif value == float("inf") or value == float("-inf"):
            w.write_bits(0, 1); w.write_bits(_NULL, 6)
        elif value.is_integer():
            _encode_int(w, int(value))
        else:
            _encode_float(w, value)
    else:
        raise TypeError(f"unsupported type {type(value).__name__}")

    return w.finish()
