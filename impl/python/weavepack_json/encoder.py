"""weavepack-json — encoder (single-payload + structured mode).

Implements both the single-payload wire format (mode-bit=1) for scalars
and empty containers, and the structured mode (mode-bit=0) for non-empty
arrays and objects.

The structured-mode encoder (_StructEnc) is a direct port of
impl/rust/weavepack-json/src/struct_encode.rs.  Column-buffer scheme:
each column is a list of (val, n_bits) pairs that are replayed into a
single _BitWriter at finalize time, so column boundaries carry no
byte-padding overhead.
"""

from typing import Any


# ── single-payload tags ───────────────────────────────────────────────────────

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


# ── shared bit primitives ─────────────────────────────────────────────────────

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


# ── single-payload helpers ────────────────────────────────────────────────────

def _encode_int(w: _BitWriter, v: int) -> None:
    if v >= 0:
        w.write_bits(1, 1)
        if v < 63:
            w.write_bits(v, 6)
        else:
            w.write_bits(63, 6)
            _leb128(w, v - 63)
    else:
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
            w.write_bits(0, 1)
            w.write_bits(_CHAR_NON_ALPHA, 6)
            _leb128(w, ord(c))
            return
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
        for i in range(0, len(utf16), 2):
            unit = utf16[i] | (utf16[i + 1] << 8)
            _leb128(w, unit)


# ── structured-mode encoder ───────────────────────────────────────────────────
# Port of impl/rust/weavepack-json/src/struct_encode.rs.

def _fast_bits(n: int) -> int:
    return 1 if n == 0 else n.bit_length()


class _ColBuf:
    """Column accumulator: list of (val, n_bits) pairs, replayed at finalize."""

    __slots__ = ("_ops", "_len")

    def __init__(self) -> None:
        self._ops: list = []
        self._len: int = 0

    def push(self, val: int, n: int) -> None:
        if n == 0:
            return
        val &= (1 << n) - 1
        self._ops.append((val, n))
        self._len += n

    def push_leb128(self, v: int) -> None:
        while v >= 128:
            self.push((v & 0x7F) | 0x80, 8)
            v >>= 7
        self.push(v, 8)

    def push_short(self, v: int) -> None:
        if v < 4:
            self.push(0, 2); self.push(v, 2)
        elif v < 8:
            self.push(1, 2); self.push(v, 3)
        elif v < 16:
            self.push(2, 2); self.push(v, 4)
        else:
            self.push(3, 2); self.push_leb128(v)

    @property
    def bit_len(self) -> int:
        return self._len

    def write_to(self, w: _BitWriter) -> None:
        for val, n in self._ops:
            w.write_bits(val, n)


class _StructEnc:
    """Structured-mode encoder — port of Rust StructEncoder."""

    def __init__(self) -> None:
        # Column buffers
        self.vlinks = _ColBuf()
        self.klinks = _ColBuf()
        self.keys   = _ColBuf()
        self.kvals  = _ColBuf()
        self.vtypes = _ColBuf()
        self.bools  = _ColBuf()
        self.nums   = _ColBuf()
        self.vals   = _ColBuf()

        # Flag columns (raw single-bit bodies; prefix written at finalize)
        self.vflags      = _ColBuf()
        self.vflags_zero = 0
        self.vflags_one  = 0
        self.kflags      = _ColBuf()
        self.kflags_zero = 0
        self.kflags_one  = 0
        self.bools_zero  = 0
        self.bools_one   = 0

        # Counters
        self.rcount = 0   # leaf value count
        self.dcount = 0   # path-node count

        # Link state
        self.prev_link:  int | None = None
        self.prev_klink: int | None = None

        # vlink RLE
        self.vc_v:      int | None = None
        self.vc_diffs:  list       = []
        self.vc_counts: list       = []
        self.vc_count:  int        = 0

        # klink RLE
        self.kc_v:      int | None = None
        self.kc_diffs:  list       = []
        self.kc_counts: list       = []
        self.kc_count:  int        = 0

        # Adaptive bit-width
        self.prev_bits  = 1
        self.prev_kbits = 1

        # Nums RLE
        self.prev_num: int       = 0
        self.nc_diff:  bool|None = None
        self.nc_v:     int       = 0
        self.nc_count: int       = 0

        # Vtypes RLE
        self.pt_type = 0
        self.tcount  = 0

        # Shared string intern map (keys + values share one map)
        self.str_len = 0
        self.strmap: dict = {}

    # ── link encoding ─────────────────────────────────────────────────────

    def _encode_link(self, v: int, prev: int | None) -> tuple:
        diff = v if prev is None else v - prev
        if diff < 0:
            d = -diff + 3
            return (d, True) if d < 7 else (v, False)
        else:
            return (diff, True) if diff < 4 else (v, False)

    # ── vlinks ────────────────────────────────────────────────────────────

    def push_vlink(self, v: int) -> None:
        v2, is_diff = self._encode_link(v, self.prev_link)
        self.prev_link = v

        self.vflags.push(1 if is_diff else 0, 1)
        if is_diff:
            self.vflags_one += 1
        else:
            self.vflags_zero += 1

        self._push_vlink_rle(v2, is_diff, self.dcount)
        self.rcount += 1

    def _push_vlink_rle(self, v: int, is_diff: bool, count: int) -> None:
        if self.vc_v is not None:
            if v == self.vc_v:
                self.vc_diffs.append(is_diff)
                self.vc_counts.append(count)
                self.vc_count += 1
                return
            self._flush_vlink()
        self.vc_v = v
        self.vc_diffs = [is_diff]
        self.vc_counts = [count]
        self.vc_count = 1

    def _flush_vlink(self) -> None:
        if self.vc_v is None:
            return
        v, count = self.vc_v, self.vc_count
        self.vc_v = None

        if count < 4:
            for i in range(count):
                self._flush_vlink_one(v, self.vc_diffs[i], self.vc_counts[i])
        else:
            if self.vc_diffs[0]:
                self.vlinks.push(0, 3)
                self.vlinks.push_short(count)
                self.vlinks.push((v + 1) & 0x7, 3)
            else:
                nb = self._set_newbits(self.vc_counts[0])
                self.vlinks.push(0, nb)
                self.vlinks.push_short(count)
                self.vlinks.push((v + 1) & ((1 << nb) - 1), nb)

    def _flush_vlink_one(self, v: int, is_diff: bool, count: int) -> None:
        if is_diff:
            self.vlinks.push((v + 1) & 0x7, 3)
        else:
            nb = self._set_newbits(count)
            self.vlinks.push((v + 1) & ((1 << nb) - 1), nb)

    def _set_newbits(self, count: int) -> int:
        new_bits = _fast_bits(count + 1)
        if new_bits > self.prev_bits:
            for i in range(new_bits - self.prev_bits):
                self.vlinks.push(0, self.prev_bits + i)
            self.prev_bits = new_bits
        return new_bits

    # ── klinks ────────────────────────────────────────────────────────────

    def push_klink(self, v: int) -> None:
        v2, is_diff = self._encode_link(v, self.prev_klink)
        self.prev_klink = v

        self.kflags.push(1 if is_diff else 0, 1)
        if is_diff:
            self.kflags_one += 1
        else:
            self.kflags_zero += 1

        self._push_klink_rle(v2, is_diff, self.dcount)

    def _push_klink_rle(self, v: int, is_diff: bool, count: int) -> None:
        if self.kc_v is not None:
            if v == self.kc_v:
                self.kc_diffs.append(is_diff)
                self.kc_counts.append(count)
                self.kc_count += 1
                return
            self._flush_klink()
        self.kc_v = v
        self.kc_diffs = [is_diff]
        self.kc_counts = [count]
        self.kc_count = 1

    def _flush_klink(self) -> None:
        if self.kc_v is None:
            return
        v, count = self.kc_v, self.kc_count
        self.kc_v = None

        if count < 4:
            for i in range(count):
                self._flush_klink_one(v, self.kc_diffs[i], self.kc_counts[i])
        else:
            if self.kc_diffs[0]:
                self.klinks.push(0, 3)
                self.klinks.push_short(count)
                self.klinks.push((v + 1) & 0x7, 3)
            else:
                nb = self._set_newbits_k(self.kc_counts[0])
                self.klinks.push(0, nb)
                self.klinks.push_short(count)
                self.klinks.push((v + 1) & ((1 << nb) - 1), nb)

    def _flush_klink_one(self, v: int, is_diff: bool, count: int) -> None:
        if is_diff:
            self.klinks.push((v + 1) & 0x7, 3)
        else:
            nb = self._set_newbits_k(count)
            self.klinks.push((v + 1) & ((1 << nb) - 1), nb)

    def _set_newbits_k(self, count: int) -> int:
        new_bits = _fast_bits(count + 1)
        if new_bits > self.prev_kbits:
            for i in range(new_bits - self.prev_kbits):
                self.klinks.push(0, self.prev_kbits + i)
            self.prev_kbits = new_bits
        return new_bits

    # ── vtypes ────────────────────────────────────────────────────────────

    def push_vtype(self, t: int) -> None:
        if self.tcount == 0:
            self.pt_type = t
            self.tcount = 1
        elif t == self.pt_type:
            self.tcount += 1
        else:
            self._maybe_flush_type(t)

    def _maybe_flush_type(self, new_type: int | None = None) -> None:
        if self.tcount == 0:
            return
        v = self.pt_type
        if self.tcount > 3:
            self.vtypes.push(0, 3)
            self.vtypes.push_short(self.tcount)
            self.vtypes.push(v, 3)
        else:
            for _ in range(self.tcount):
                self.vtypes.push(v, 3)
        self.tcount = 0
        if new_type is not None:
            self.pt_type = new_type
            self.tcount = 1

    # ── nums ──────────────────────────────────────────────────────────────

    def push_int(self, v: int) -> None:
        if v > 0xFFFF_FFFF or self.prev_num > 0xFFFF_FFFF:
            self.prev_num = v
            self._dint(v, False)
            return
        prev = self.prev_num
        diff = v - prev
        if diff < 0:
            d = -diff + 3
            v2, is_diff = (d, True) if d < 7 else (v, False)
        else:
            v2, is_diff = (diff, True) if diff < 4 else (v, False)
        self.prev_num = v
        self._dint_rle(v2, is_diff)

    def _dint_rle(self, v: int, is_diff: bool) -> None:
        if self.nc_diff is not None:
            if self.nc_diff == is_diff and self.nc_v == v:
                self.nc_count += 1
                return
            if self.nc_count == 1:
                self._dint(self.nc_v, self.nc_diff)
            else:
                self._flush_nums()
        self.nc_diff = is_diff
        self.nc_v = v
        self.nc_count = 1

    def _flush_nums(self) -> None:
        if self.nc_diff is None:
            return
        v, count, is_diff = self.nc_v, self.nc_count, self.nc_diff
        self.nc_diff = None

        if count < 3:
            for _ in range(count):
                self._dint(v, is_diff)
        else:
            # RLE: "00 111" + short(count) + encoded-value
            self.nums.push(0, 2)
            self.nums.push(7, 3)
            self.nums.push_short(count)
            if is_diff:
                self.nums.push(0, 2)
                self.nums.push(v & 0x7, 3)
            elif v < 16:
                self.nums.push(1, 2)
                self.nums.push(v & 0xF, 4)
            elif v < 64:
                self.nums.push(2, 2)
                self.nums.push(v & 0x3F, 6)
            else:
                self.nums.push(3, 2)
                self.nums.push_leb128(v)

    def _dint(self, v: int, is_diff: bool) -> None:
        if is_diff:
            self.nums.push(0, 2)
            self.nums.push(v & 0x7, 3)
        elif v < 16:
            self.nums.push(1, 2)
            self.nums.push(v & 0xF, 4)
        elif v < 64:
            self.nums.push(2, 2)
            self.nums.push(v & 0x3F, 6)
        else:
            self.nums.push(3, 2)
            self.nums.push_leb128(v)

    # ── bools ─────────────────────────────────────────────────────────────

    def push_bool(self, b: bool) -> None:
        self.bools.push(1 if b else 0, 1)
        if b:
            self.bools_one += 1
        else:
            self.bools_zero += 1

    # ── path nodes ────────────────────────────────────────────────────────

    def push_path_num(self, parent_vlink: int | None, keylen: int) -> None:
        if self.dcount > 0:
            klink_target = (parent_vlink + 1) if parent_vlink is not None else 0
            self.push_klink(klink_target)
        self.keys.push(keylen, 2)
        self.dcount += 1

    def push_path_str(self, key: str, parent_klink: int) -> None:
        if self.dcount > 0:
            self.push_klink(parent_klink + 1)

        if key in self.strmap:
            idx = self.strmap[key]
            self.keys.push(2, 2)
            self.keys.push_short(0)
            self.kvals.push_short(idx)
        else:
            self.strmap[key] = self.str_len
            self.str_len += 1
            utf16 = key.encode("utf-16-le")
            n_units = len(utf16) // 2
            is_b64 = n_units > 0 and all(c in _BASE64URL_INDEX for c in key)
            if is_b64:
                self.keys.push(2, 2)
                self.keys.push_short(n_units + 1)
                for c in key:
                    self.kvals.push(_BASE64URL_INDEX[c], 6)
            else:
                self.keys.push(3, 2)
                self.keys.push_short(n_units + 1)
                for i in range(0, len(utf16), 2):
                    unit = utf16[i] | (utf16[i + 1] << 8)
                    self.kvals.push_leb128(unit)
        self.dcount += 1

    # ── string values ─────────────────────────────────────────────────────

    def push_str_val(self, s: str) -> None:
        if s in self.strmap:
            idx = self.strmap[s]
            self.vals.push_short(0)
            self.vals.push(0, 1)   # flag=0 → strmap ref
            self.vals.push_short(idx)
        else:
            self.strmap[s] = self.str_len
            self.str_len += 1
            utf16 = s.encode("utf-16-le")
            n_units = len(utf16) // 2
            self.vals.push_short(n_units)
            is_b64 = n_units > 0 and all(c in _BASE64URL_INDEX for c in s)
            if is_b64:
                for c in s:
                    self.vals.push(_BASE64URL_INDEX[c], 6)
            else:
                for i in range(0, len(utf16), 2):
                    unit = utf16[i] | (utf16[i + 1] << 8)
                    self.vals.push_leb128(unit)

    # ── float helpers ─────────────────────────────────────────────────────

    def _push_float_enc(self, neg: bool, v: int) -> None:
        if v < 4:
            self.push_int((4 + v) if neg else v)
        else:
            self.push_int(4 if neg else 0)

    # ── number dispatch ───────────────────────────────────────────────────

    def _encode_number(self, n: int | float) -> None:
        if isinstance(n, int) and not isinstance(n, bool):
            if n >= 0:
                self.push_vtype(4)   # IntPos
                self.push_int(n)
            else:
                self.push_vtype(5)   # IntNeg
                self.push_int(-n)
            return
        # float
        if not (n == n) or n == float("inf") or n == float("-inf"):
            self.push_vtype(1)       # coerce non-finite to Null
            return
        limit = float(1 << 53)
        if n.is_integer() and -limit <= n <= limit:
            ni = int(n)
            if ni >= 0:
                self.push_vtype(4)
                self.push_int(ni)
            else:
                self.push_vtype(5)
                self.push_int(-ni)
            return
        self.push_vtype(6)           # Float
        neg = n < 0.0
        abs_n = -n if neg else n
        prec = min(_get_precision(abs_n), 308)
        mant = round(abs_n * (10 ** prec))
        self._push_float_enc(neg, prec + 1)
        if prec + 1 > 3:
            self.push_int(prec + 1)
        self.push_int(mant)

    # ── recursive value encoder ───────────────────────────────────────────

    def encode_value(self, v: Any, parent_vlink: int | None,
                     parent_klink: int | None) -> None:
        if v is None:
            vlink = (parent_vlink + 1) if parent_vlink is not None else 0
            self.push_vlink(vlink)
            self.push_vtype(1)           # Null

        elif isinstance(v, bool):
            vlink = (parent_vlink + 1) if parent_vlink is not None else 0
            self.push_vlink(vlink)
            self.push_vtype(3)           # Bool
            self.push_bool(v)

        elif isinstance(v, str):
            vlink = (parent_vlink + 1) if parent_vlink is not None else 0
            self.push_vlink(vlink)
            is_b64 = len(v) > 0 and all(c in _BASE64URL_INDEX for c in v)
            self.push_vtype(2 if is_b64 else 7)
            self.push_str_val(v)

        elif isinstance(v, (int, float)):
            vlink = (parent_vlink + 1) if parent_vlink is not None else 0
            self.push_vlink(vlink)
            self._encode_number(v)

        elif isinstance(v, list):
            if not v:
                # Empty array encoded as a Float leaf with value 1.
                self.push_path_num(parent_vlink, 0)
                vlink_self = self.dcount
                self.push_vlink(vlink_self)
                self.push_vtype(6)
                self._push_float_enc(False, 1)
            else:
                prev_dc = self.dcount
                self.push_path_num(parent_vlink, 0)
                for item in v:
                    self.encode_value(item, prev_dc, None)

        elif isinstance(v, dict):
            if not v:
                # Empty object encoded as a Float leaf with value 5.
                self.push_path_num(parent_vlink, 1)
                vlink_self = self.dcount
                self.push_vlink(vlink_self)
                self.push_vtype(6)
                self._push_float_enc(True, 1)
            else:
                prev_dc = self.dcount
                self.push_path_num(parent_vlink, 1)
                obj_dc = self.dcount
                for key, val in v.items():
                    self.push_path_str(key, obj_dc - 1)
                    key_dc_after = self.dcount - 1
                    self.encode_value(val, key_dc_after, key_dc_after)

    # ── finalize ──────────────────────────────────────────────────────────

    def finalize(self) -> bytes:
        # Flush RLE accumulators.
        self._flush_vlink()
        self._flush_klink()
        self._flush_nums()
        self._maybe_flush_type(None)

        # dc column: mode-bit=0 + short(rcount)
        dc = _ColBuf()
        dc.push(0, 1)
        dc.push_short(self.rcount)

        def _write_flag_col(w: _BitWriter, buf: _ColBuf,
                            zero: int, one: int) -> None:
            n = zero + one
            if n == 0:
                return
            if zero == n:
                w.write_bits(0, 2)
            elif one == n:
                w.write_bits(1, 2)
            else:
                w.write_bits(2, 2)
                buf.write_to(w)

        w = _BitWriter()
        dc.write_to(w)
        _write_flag_col(w, self.vflags, self.vflags_zero, self.vflags_one)
        self.vlinks.write_to(w)
        _write_flag_col(w, self.kflags, self.kflags_zero, self.kflags_one)
        self.klinks.write_to(w)
        self.keys.write_to(w)
        self.kvals.write_to(w)
        self.vtypes.write_to(w)
        _write_flag_col(w, self.bools, self.bools_zero, self.bools_one)
        self.nums.write_to(w)
        self.vals.write_to(w)
        # strdiffs column: empty for snapshots
        return w.finish()


def _encode_structured(v: Any) -> bytes:
    """Encode a non-empty JSON array or object in structured mode."""
    enc = _StructEnc()
    enc.encode_value(v, None, None)
    return enc.finalize()


# ── public entry point ────────────────────────────────────────────────────────

def encode(value: Any) -> bytes:
    """Encode a JSON value to its weavepack-json wire representation.

    Single-payload mode for scalars and empty containers.
    Structured mode for non-empty arrays and objects.
    """
    if isinstance(value, list) and value:
        return _encode_structured(value)
    if isinstance(value, dict) and value:
        return _encode_structured(value)

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
        # empty list
        w.write_bits(0, 1); w.write_bits(_EMPTY_ARRAY, 6)
    elif isinstance(value, dict):
        # empty dict
        w.write_bits(0, 1); w.write_bits(_EMPTY_OBJECT, 6)
    elif isinstance(value, int) and not isinstance(value, bool):
        _encode_int(w, value)
    elif isinstance(value, float):
        if value != value or value == float("inf") or value == float("-inf"):
            w.write_bits(0, 1); w.write_bits(_NULL, 6)
        elif value.is_integer():
            _encode_int(w, int(value))
        else:
            _encode_float(w, value)
    else:
        raise TypeError(f"unsupported type {type(value).__name__}")

    return w.finish()
