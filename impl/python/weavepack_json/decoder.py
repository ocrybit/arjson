"""weavepack-json — single-payload + structured-mode decoder.

Implements the wire format from weavepack/profiles/json/01-types.md and
weavepack/profiles/json/02-containers.md.  Bit ordering is MSB-first
within each byte (matches the JS reference and Rust impl).

Scope:
  - Single-payload mode (mode bit = 1): all 64 tags
  - Structured mode (mode bit = 0): snapshot decode (containers +
    strmap-dedup).  Delta payloads are decoded structurally but
    delta application (the chain step) is not performed; callers
    that need the post-delta value should use the JS or Rust impl.
"""

from __future__ import annotations
from typing import Any


# ── constants ──────────────────────────────────────────────────────────

_STRMAP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_BASE64URL_REV = {c: i for i, c in enumerate(_BASE64URL)}

_POW10 = []
for _i in range(311):
    try:
        _POW10.append(10.0 ** _i)
    except OverflowError:
        _POW10.append(float("inf"))


def _pow10(n: int) -> float:
    if 0 <= n <= 310:
        return _POW10[n]
    try:
        return 10.0 ** n
    except OverflowError:
        return float("inf")


# ── bit reader ─────────────────────────────────────────────────────────

class _BitReader:
    """MSB-first bit reader over a bytes object."""

    __slots__ = ("data", "bit_pos")

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_pos = 0

    def read_bits(self, n: int) -> int:
        val = 0
        data = self.data
        pos = self.bit_pos
        for _ in range(n):
            byte_idx = pos >> 3
            bit = (data[byte_idx] >> (7 - (pos & 7))) & 1
            val = (val << 1) | bit
            pos += 1
        self.bit_pos = pos
        return val

    def leb128(self) -> int:
        result = 0
        shift = 0
        while True:
            byte = self.read_bits(8)
            result |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                return result
            shift += 7

    def short(self) -> int:
        """short() per weavepack-core/03-bit-encoding.md."""
        p = self.read_bits(2)
        if p == 0: return self.read_bits(2)
        if p == 1: return self.read_bits(3)
        if p == 2: return self.read_bits(4)
        return self.leb128()

    def uint(self) -> int:
        """uint() per weavepack-core/03-bit-encoding.md."""
        p = self.read_bits(2)
        if p == 0: return self.read_bits(3)
        if p == 1: return self.read_bits(4)
        if p == 2: return self.read_bits(6)
        return self.leb128()


# ── column type tags ───────────────────────────────────────────────────

# vtypes:
_VT_UNDEF    = 0  # also used for delete delta / undefined
_VT_NULL     = 1
_VT_STR_B64  = 2
_VT_BOOL     = 3
_VT_INT_POS  = 4
_VT_INT_NEG  = 5
_VT_FLOAT    = 6
_VT_STR_FALL = 7

# Special vtype variants (stored as tuples):
#   ("del",)                   — delete delta
#   ("splice_del", idx, rem)   — splice delete
#   ("splice_rep", idx, rem, typ) — splice replace

# ktypes (2 bits):
_KT_ARR  = 0
_KT_OBJ  = 1
_KT_B64  = 2
_KT_FALL = 3


# ── single-payload decoder ─────────────────────────────────────────────

def _decode_single(r: _BitReader) -> Any:
    sel = r.read_bits(1)
    tag = r.read_bits(6)
    if sel == 1:
        return tag if tag < 63 else 63 + r.leb128()

    if tag == 0: return None
    if tag == 1: return True
    if tag == 2: return False
    if tag == 3: return ""
    if tag == 4: return []
    if tag == 5: return {}
    if tag == 6: return -r.uint()
    if tag == 7:
        moved = r.uint(); mant = r.uint()
        return mant / _pow10(moved)
    if tag == 8:
        moved = r.uint(); mant = r.uint()
        return -(mant / _pow10(moved))
    if 9 <= tag <= 60:
        return _STRMAP_ALPHABET[tag - 9]
    if tag == 61:
        return chr(r.leb128())
    if tag == 62:
        n = r.short()
        return "".join(_BASE64URL[r.read_bits(6)] for _ in range(n))
    if tag == 63:
        n = r.short()
        units = [r.leb128() for _ in range(n)]
        raw = b"".join(u.to_bytes(2, "little") for u in units)
        return raw.decode("utf-16-le")
    raise ValueError(f"unknown single-payload tag {tag}")


# ── structured-mode helpers ────────────────────────────────────────────

def _read_flag_col(r: _BitReader, length: int) -> list[int]:
    if length == 0:
        return []
    mode = r.read_bits(2)
    if mode == 0: return [0] * length
    if mode == 1: return [1] * length
    if mode == 2: return [r.read_bits(1) for _ in range(length)]
    raise ValueError(f"invalid flag mode {mode}")


def _apply_link(diff: bool, raw: int, prev: int) -> tuple[int, int]:
    """Convert a raw link value + diff flag to an absolute reference."""
    val = (raw - 1) & 0xFFFFFFFFFFFFFFFF  # wrapping sub
    if diff:
        if val > 3:
            v = (prev - (val - 3)) & 0xFFFFFFFFFFFFFFFF
        else:
            v = (prev + val) & 0xFFFFFFFFFFFFFFFF
    else:
        v = val
    return v, v


def _read_vrefs(r: _BitReader, vflags: list[int]) -> tuple[list[int], int]:
    vrefs: list[int] = []
    key_len = 0
    prev = 0
    cbits = 1
    i = 0
    while i < len(vflags):
        diff = vflags[i] == 1
        if diff:
            raw = r.read_bits(3)
            if raw == 0:
                run = r.short()
                rv = r.read_bits(3)
                run_start = i
                for j in range(run):
                    d = vflags[run_start + j] == 1
                    v, prev = _apply_link(d, rv, prev)
                    vrefs.append(v)
                    if v > key_len: key_len = v
                    i += 1
            else:
                v, prev = _apply_link(True, raw, prev)
                vrefs.append(v)
                if v > key_len: key_len = v
                i += 1
        else:
            raw = 0
            while True:
                raw = r.read_bits(cbits)
                if raw != 0: break
                cbits += 1
            v, prev = _apply_link(False, raw, prev)
            vrefs.append(v)
            if v > key_len: key_len = v
            i += 1
    return vrefs, key_len


def _read_krefs(r: _BitReader, kflags: list[int]) -> list[int]:
    krefs: list[int] = []
    prev = 0
    cbits = 1
    i = 0
    while i < len(kflags):
        diff = kflags[i] == 1
        if diff:
            raw = r.read_bits(3)
            if raw == 0:
                run = r.short()
                rv = r.read_bits(3)
                run_start = i
                for j in range(run):
                    d = kflags[run_start + j] == 1
                    v, prev = _apply_link(d, rv, prev)
                    krefs.append(v)
                    i += 1
            else:
                v, prev = _apply_link(True, raw, prev)
                krefs.append(v)
                i += 1
        else:
            raw = 0
            while True:
                raw = r.read_bits(cbits)
                if raw != 0: break
                cbits += 1
            v, prev = _apply_link(False, raw, prev)
            krefs.append(v)
            i += 1
    return krefs


def _read_ktypes(r: _BitReader, count: int) -> list[tuple]:
    out = []
    for _ in range(count):
        t = r.read_bits(2)
        length = 0 if t < 2 else r.short()
        out.append((t, length))
    return out


def _read_keys(r: _BitReader, ktypes: list[tuple]) -> list:
    """Returns a list of key descriptors:
      ('arr', idx), ('obj', idx), ('str', s), ('smref', n)
    """
    keys = []
    arr_idx = 0
    obj_idx = 0
    for (t, length) in ktypes:
        if t == _KT_ARR:
            keys.append(('arr', arr_idx)); arr_idx += 1
        elif t == _KT_OBJ:
            keys.append(('obj', obj_idx)); obj_idx += 1
        elif t == _KT_B64:
            if length == 0:
                keys.append(('smref', r.short()))
            else:
                s = "".join(_BASE64URL[r.read_bits(6)] for _ in range(length - 1))
                keys.append(('str', s))
        elif t == _KT_FALL:
            if length <= 1:
                keys.append(('str', ""))
            else:
                units = [r.leb128() for _ in range(length - 1)]
                raw = b"".join(u.to_bytes(2, "little") for u in units)
                keys.append(('str', raw.decode("utf-16-le")))
    return keys


def _read_vtypes(r: _BitReader, count: int) -> list:
    vtypes = []
    i = 0
    while i < count:
        raw = r.read_bits(3)
        if raw == 0:
            cnt = r.short()
            if cnt == 0:
                sel = r.read_bits(1)
                if sel == 1:
                    index  = r.short()
                    remove = r.short()
                    typ    = r.read_bits(3)
                    if typ == 0:
                        vtypes.append(("splice_del", index, remove))
                    else:
                        vtypes.append(("splice_rep", index, remove, typ))
                else:
                    vtypes.append(("del",))
                i += 1
            else:
                vt = cnt  # cnt here is actually the next 3-bit vtype... wait
                # The Rust decoder: cnt = r.short(), then if cnt==0 that's the
                # escape path; otherwise cnt is the run-length and we read the vtype.
                # But we already read cnt = r.short(). The vtype comes after.
                vt = r.read_bits(3)
                for _ in range(cnt):
                    vtypes.append(vt)
                if cnt > count - i:
                    raise ValueError("vtype run overflow")
                i += cnt
        else:
            vtypes.append(raw)
            i += 1
    return vtypes


def _read_bools(r: _BitReader, vtypes: list) -> list[bool]:
    count = sum(1 for v in vtypes if v == _VT_BOOL)
    if count == 0: return []
    mode = r.read_bits(2)
    if mode == 0: return [False] * count
    if mode == 1: return [True] * count
    if mode == 2: return [r.read_bits(1) == 1 for _ in range(count)]
    raise ValueError(f"invalid bools mode {mode}")


def _vt_num_tag(vt) -> int:
    if vt == _VT_INT_POS: return 4
    if vt == _VT_INT_NEG: return 5
    if vt == _VT_FLOAT:   return 6
    return 0


def _read_dint(r: _BitReader, prev: int, cache: list) -> int:
    """Read one dint value; cache is a mutable list [rem, delta, is_diff] or []."""
    if cache:
        rem, delta, is_diff = cache
        val = (prev + delta) if is_diff else delta
        cache[0] -= 1
        if cache[0] == 0:
            cache.clear()
        return val

    x = r.read_bits(2)
    diff = (x == 0)
    if x == 3:
        n = r.leb128()
    elif x == 2:
        n = r.read_bits(6)
    elif x == 1:
        n = r.read_bits(4)
    else:
        n = r.read_bits(3)

    # RLE trigger: diff=True AND n=7
    if diff and n == 7:
        count = r.short()
        x2 = r.read_bits(2)
        diff2 = (x2 == 0)
        if x2 == 3:
            base = r.leb128()
        elif x2 == 0:
            base = r.read_bits(3)
        elif x2 == 1:
            base = r.read_bits(4)
        else:
            base = r.read_bits(6)
        if diff2:
            delta = -(base - 3) if base > 3 else base
            first = prev + delta
        else:
            delta = base
            first = base
        if count > 1:
            cache.extend([count - 1, delta, diff2])
        return first

    if diff:
        d = -(n - 3) if n > 3 else n
        return prev + d
    return n


def _read_nums(r: _BitReader, vtypes: list) -> list:
    nums = []
    prev = 0
    cache: list = []
    for vt in vtypes:
        tag = _vt_num_tag(vt)
        if tag == 0: continue
        n = _read_dint(r, prev, cache)
        prev = n
        if tag == 4:
            nums.append(n)
        elif tag == 5:
            nums.append(-n)
        elif tag == 6:
            if n == 0 or n == 4:
                moved = _read_dint(r, prev, cache); prev = moved
                mant  = _read_dint(r, prev, cache); prev = mant
                sign = -1.0 if n == 4 else 1.0
                nums.append(sign * mant / _pow10(moved - 1))
            else:
                moved = n - 4 if n > 4 else n
                sign  = -1.0 if n > 4 else 1.0
                if moved == 1:
                    nums.append({} if sign < 0 else [])
                else:
                    mant = _read_dint(r, prev, cache); prev = mant
                    nums.append(sign * mant / _pow10(moved - 1))
    return nums


def _vt_str_type(vt) -> int:
    if vt == _VT_STR_B64: return 2
    if vt == _VT_STR_FALL: return 7
    if isinstance(vt, tuple) and vt[0] == "splice_rep": return vt[3]
    return 0


def _read_strs(r: _BitReader, vtypes: list) -> list:
    """Returns list of ('lit', s) | ('smref', idx) | ('diffref', dc)."""
    strs = []
    dc = 0
    for vt in vtypes:
        t = _vt_str_type(vt)
        if t == 0: continue
        length = r.short()
        if t == 2 and length == 0:
            if r.read_bits(1) == 0:
                strs.append(('smref', r.short()))
            else:
                strs.append(('diffref', dc)); dc += 1
        else:
            n = length
            if t == 7:
                units = [r.leb128() for _ in range(n)]
                raw = b"".join(u.to_bytes(2, "little") for u in units)
                strs.append(('lit', raw.decode("utf-16-le")))
            else:
                s = "".join(_BASE64URL[r.read_bits(6)] for _ in range(n))
                strs.append(('lit', s))
    return strs


def _build_strmap(vrefs, krefs, ktypes_raw, keys, vtypes, strs) -> dict[int, str]:
    """Build the strmap by walking vref kref chains root-to-leaf."""
    strmap: dict[int, str] = {}
    str_rev: dict[str, int] = {}
    next_idx = 0
    seen = [False] * len(krefs)
    trav: list[tuple[bool, int]] = []  # (is_kref, index)

    for vi in range(len(vrefs)):
        v = vrefs[vi]
        # kref index = node_value - 2
        kid = v - 2
        stack: list[int] = []
        while 0 <= kid < len(krefs) and not seen[kid]:
            seen[kid] = True
            stack.append(kid)
            parent_val = krefs[kid]
            kid = parent_val - 2
        for k in reversed(stack):
            trav.append((True, k))
        trav.append((False, vi))

    sc = 0

    def to_map(s: str) -> None:
        nonlocal next_idx
        if s not in str_rev:
            str_rev[s] = next_idx
            strmap[next_idx] = s
            next_idx += 1

    for is_kref, idx in trav:
        if is_kref:
            # keys[kref_node_value - 1] = keys[(idx+2) - 1] = keys[idx+1]
            k = keys[idx + 1] if idx + 1 < len(keys) else None
            if k and k[0] == 'str':
                to_map(k[1])
        else:
            t = _vt_str_type(vtypes[idx]) if idx < len(vtypes) else 0
            if t in (2, 7):
                if sc < len(strs) and strs[sc][0] == 'lit':
                    to_map(strs[sc][1])
                sc += 1

    return strmap


def _resolve_str(entry, strmap: dict) -> str:
    kind = entry[0]
    if kind == 'lit':    return entry[1]
    if kind == 'smref':  return strmap.get(entry[1], "")
    return ""  # diffref — not resolved in snapshot mode


def _get_primitive(vi: int, vtypes, bools, nums, strs, strmap,
                   cursors: list) -> Any:
    """Extract primitive value at vtypes index vi; cursors=[nc, bc, sc]."""
    vt = vtypes[vi] if vi < len(vtypes) else _VT_UNDEF

    if isinstance(vt, tuple):
        kind = vt[0]
        if kind == "del":           return None
        if kind == "splice_del":    return None
        if kind == "splice_rep":
            t = vt[3]
            return _get_primitive_by_tag(t, bools, nums, strs, strmap, cursors)

    if vt in (_VT_UNDEF, _VT_NULL): return None
    if vt == _VT_BOOL:
        b = bools[cursors[1]]; cursors[1] += 1; return b
    if vt in (_VT_INT_POS, _VT_INT_NEG, _VT_FLOAT):
        v = nums[cursors[0]]; cursors[0] += 1; return v
    if vt in (_VT_STR_B64, _VT_STR_FALL):
        s = strs[cursors[2]]; cursors[2] += 1
        return _resolve_str(s, strmap)
    return None


def _get_primitive_by_tag(t: int, bools, nums, strs, strmap, cursors) -> Any:
    if t == 1: return None
    if t == 3: b = bools[cursors[1]]; cursors[1] += 1; return b
    if t in (4, 5, 6): v = nums[cursors[0]]; cursors[0] += 1; return v
    if t in (2, 7):
        s = strs[cursors[2]]; cursors[2] += 1
        return _resolve_str(s, strmap)
    return None


def _resolve_path(vref_val: int, krefs, keys) -> list:
    """Walk kref chain root-to-leaf; return list of Step tuples."""
    chain: list[int] = []
    cur = vref_val
    while True:
        chain.append(cur)
        if cur > 1:
            kid = cur - 2
            if 0 <= kid < len(krefs):
                p = krefs[kid]
                if p > 0:
                    cur = p
                    continue
        break

    steps = []
    for ci in reversed(chain):
        key_idx = ci - 1
        k = keys[key_idx] if 0 <= key_idx < len(keys) else None
        if k is None:
            steps.append(('root',))
        elif k[0] == 'arr':
            steps.append(('arr', ci))
        elif k[0] == 'obj':
            steps.append(('obj', ci))
        elif k[0] == 'str':
            steps.append(('key', ci, k[1]))
        elif k[0] == 'smref':
            steps.append(('key', ci, ""))  # resolved later via strmap
    return steps


def _nav(node: Any, path: list, depth: int, val: Any,
         arr_init: set, obj_init: set) -> Any:
    """Recursively navigate/mutate node; return the (possibly new) node."""
    total = len(path)
    if depth >= total:
        return val

    step = path[depth]
    is_last = (depth == total - 1)

    if step[0] == 'root':
        return val

    elif step[0] == 'arr':
        ci = step[1]
        if not isinstance(node, list):
            node = []
            arr_init.add(ci)
        if is_last:
            # Don't push container placeholders — they were added by parent step.
            if not isinstance(val, (list, dict)):
                node.append(val)
            return node
        next_step = path[depth + 1]
        if next_step[0] == 'arr':
            child_ci = next_step[1]
            if child_ci not in arr_init:
                arr_init.add(child_ci)
                node.append([])
            new_child = _nav(node[-1], path, depth + 1, val, arr_init, obj_init)
            node[-1] = new_child
        elif next_step[0] == 'obj':
            child_ci = next_step[1]
            if child_ci not in obj_init:
                obj_init.add(child_ci)
                node.append({})
            new_child = _nav(node[-1], path, depth + 1, val, arr_init, obj_init)
            node[-1] = new_child
        elif next_step[0] == 'key':
            if not node:
                return node
            new_child = _nav(node[-1], path, depth + 1, val, arr_init, obj_init)
            node[-1] = new_child
        else:
            node.append(val)
        return node

    elif step[0] == 'obj':
        ci = step[1]
        if not isinstance(node, dict):
            node = {}
            obj_init.add(ci)
        if is_last:
            # Container placeholder: return the value (caller sets it).
            return val
        return _nav(node, path, depth + 1, val, arr_init, obj_init)

    elif step[0] == 'key':
        ci, key = step[1], step[2]
        if not isinstance(node, dict):
            node = {}
        if is_last:
            node[key] = val
            return node
        next_step = path[depth + 1]
        if key not in node:
            if next_step[0] == 'arr':
                node[key] = []
                arr_init.add(next_step[1])
            else:
                node[key] = {}
                if next_step[0] == 'obj':
                    obj_init.add(next_step[1])
        new_child = _nav(node[key], path, depth + 1, val, arr_init, obj_init)
        node[key] = new_child
        return node

    return node


def _build_tree(vrefs, krefs, ktypes_raw, keys, vtypes, bools, nums, strs,
                strmap: dict) -> Any:
    if not vrefs:
        cursors = [0, 0, 0]
        return _get_primitive(0, vtypes, bools, nums, strs, strmap, cursors)

    root: Any = None
    arr_init: set = set()
    obj_init: set = set()
    nc, bc, sc = 0, 0, 0

    for vi in range(len(vrefs)):
        v = vrefs[vi]
        cursors = [nc, bc, sc]
        val = _get_primitive(vi, vtypes, bools, nums, strs, strmap, cursors)
        nc, bc, sc = cursors

        path = _resolve_path_with_strmap(v, krefs, keys, strmap)
        root = _nav(root, path, 0, val, arr_init, obj_init)

    return root


def _resolve_path_with_strmap(vref_val: int, krefs, keys, strmap: dict) -> list:
    """Walk kref chain root-to-leaf; resolve smref keys via strmap."""
    chain: list[int] = []
    cur = vref_val
    while True:
        chain.append(cur)
        if cur > 1:
            kid = cur - 2
            if 0 <= kid < len(krefs):
                p = krefs[kid]
                if p > 0:
                    cur = p
                    continue
        break

    steps = []
    for ci in reversed(chain):
        key_idx = ci - 1
        k = keys[key_idx] if 0 <= key_idx < len(keys) else None
        if k is None:
            steps.append(('root',))
        elif k[0] == 'arr':
            steps.append(('arr', ci))
        elif k[0] == 'obj':
            steps.append(('obj', ci))
        elif k[0] == 'str':
            steps.append(('key', ci, k[1]))
        elif k[0] == 'smref':
            resolved = strmap.get(k[1], "")
            steps.append(('key', ci, resolved))
    return steps


# ── structured-mode entry point ────────────────────────────────────────

def _decode_structured(r: _BitReader) -> Any:
    rcount = r.short()

    vflags = _read_flag_col(r, rcount)
    vrefs, klen = _read_vrefs(r, vflags)

    kflag_n = max(0, klen - 1)
    kflags = _read_flag_col(r, kflag_n)
    krefs  = _read_krefs(r, kflags)

    ktype_n = 0 if (not krefs and rcount == 0) else (len(krefs) + 1)
    ktypes_raw = _read_ktypes(r, ktype_n)
    keys = _read_keys(r, ktypes_raw)

    vtype_n = max(1, len(vrefs))
    vtypes = _read_vtypes(r, vtype_n)

    bools = _read_bools(r, vtypes)
    nums  = _read_nums(r, vtypes)
    strs  = _read_strs(r, vtypes)

    # Skip strdiff payloads (present in delta payloads)
    diff_count = sum(1 for s in strs if s[0] == 'diffref')
    for _ in range(diff_count):
        bits = r.leb128()
        # advance past the strdiff bytes
        r.bit_pos += ((bits + 7) // 8) * 8

    strmap = _build_strmap(vrefs, krefs, ktypes_raw, keys, vtypes, strs)
    return _build_tree(vrefs, krefs, ktypes_raw, keys, vtypes, bools, nums, strs, strmap)


# ── public entry point ─────────────────────────────────────────────────

def decode(data: bytes) -> Any:
    """Decode a weavepack-json payload (single-payload or structured snapshot).

    Returns the decoded JSON value (None / bool / int / float / str /
    list / dict).
    """
    r = _BitReader(data)
    if r.read_bits(1) == 1:
        return _decode_single(r)
    return _decode_structured(r)
