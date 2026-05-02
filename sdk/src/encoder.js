import { bits } from "./utils.js"

// The Encoder class is profile-agnostic: it provides column buffers,
// bit-pack primitives, run-length aware delta encoding for the link
// columns, and the final dump() that flattens the columns into bytes.
//
// JSON-specific encode/`_encode` entry points live in
// `./profiles/json/encode.js`. Other profiles will define their own
// entry points using this same Encoder class as the substrate.

class Encoder {
  constructor(n = 1) {
    this._initArrays(n)
    this.strMap = new Map()
    this.bitsLookup = new Uint8Array(17)
    for (let i = 0; i < 17; i++) {
      this.bitsLookup[i] = i === 0 ? 1 : 32 - Math.clz32(i)
    }
  }

  _initArrays(n) {
    this.kc_counts = new Uint32Array(32 * n)
    this.vc_counts = new Uint32Array(32 * n)
    this.kc_diffs = new Uint32Array(4 * n)
    this.vc_diffs = new Uint32Array(4 * n)
    this.vlinks = new Uint32Array(32 * n)
    this.klinks = new Uint32Array(32 * n)
    this.vflags = new Uint32Array(16 * n)
    this.kflags = new Uint32Array(16 * n)
    this.bools = new Uint32Array(16 * n)
    this.keys = new Uint32Array(32 * n)
    this.types = new Uint32Array(32 * n)
    this.nums = new Uint32Array(32 * n)
    this.dc = new Uint32Array(32 * n)
    this.kvals = new Uint32Array(64 * n)
    this.vals = new Uint32Array(64 * n)
    this.strdiffs = new Uint32Array(64 * n)
    this.capacity = n
  }

  _grow() {
    const newCapacity = this.capacity * 2
    const old_kc_counts = this.kc_counts
    const old_vc_counts = this.vc_counts
    const old_kc_diffs = this.kc_diffs
    const old_vc_diffs = this.vc_diffs
    const old_vlinks = this.vlinks
    const old_klinks = this.klinks
    const old_vflags = this.vflags
    const old_kflags = this.kflags
    const old_bools = this.bools
    const old_keys = this.keys
    const old_types = this.types
    const old_nums = this.nums
    const old_dc = this.dc
    const old_kvals = this.kvals
    const old_vals = this.vals
    const old_strdiffs = this.strdiffs

    this.kc_counts = new Uint32Array(32 * newCapacity)
    this.vc_counts = new Uint32Array(32 * newCapacity)
    this.kc_diffs = new Uint32Array(4 * newCapacity)
    this.vc_diffs = new Uint32Array(4 * newCapacity)
    this.vlinks = new Uint32Array(32 * newCapacity)
    this.klinks = new Uint32Array(32 * newCapacity)
    this.vflags = new Uint32Array(16 * newCapacity)
    this.kflags = new Uint32Array(16 * newCapacity)
    this.bools = new Uint32Array(16 * newCapacity)
    this.keys = new Uint32Array(32 * newCapacity)
    this.types = new Uint32Array(32 * newCapacity)
    this.nums = new Uint32Array(32 * newCapacity)
    this.dc = new Uint32Array(32 * newCapacity)
    this.kvals = new Uint32Array(64 * newCapacity)
    this.vals = new Uint32Array(64 * newCapacity)
    this.strdiffs = new Uint32Array(64 * newCapacity)

    this.kc_counts.set(old_kc_counts)
    this.vc_counts.set(old_vc_counts)
    this.kc_diffs.set(old_kc_diffs)
    this.vc_diffs.set(old_vc_diffs)
    this.vlinks.set(old_vlinks)
    this.klinks.set(old_klinks)
    this.vflags.set(old_vflags)
    this.kflags.set(old_kflags)
    this.bools.set(old_bools)
    this.keys.set(old_keys)
    this.types.set(old_types)
    this.nums.set(old_nums)
    this.dc.set(old_dc)
    this.kvals.set(old_kvals)
    this.vals.set(old_vals)
    this.strdiffs.set(old_strdiffs)

    this.capacity = newCapacity
  }

  fastBits(n) {
    return n < 17 ? this.bitsLookup[n] : bits(n)
  }

  vc_diffs_set(index, value) {
    const wordIndex = index >>> 5
    const bitOffset = index & 31
    if (wordIndex >= this.vc_diffs.length) this._grow()
    if (value) {
      this.vc_diffs[wordIndex] |= 1 << bitOffset
    } else {
      this.vc_diffs[wordIndex] &= ~(1 << bitOffset)
    }
  }
  vc_diffs_get(index) {
    const wordIndex = index >>> 5
    const bitOffset = index & 31
    return (this.vc_diffs[wordIndex] >>> bitOffset) & 1
  }
  kc_diffs_set(index, value) {
    const wordIndex = index >>> 5
    const bitOffset = index & 31
    if (wordIndex >= this.kc_diffs.length) this._grow()
    if (value) {
      this.kc_diffs[wordIndex] |= 1 << bitOffset
    } else {
      this.kc_diffs[wordIndex] &= ~(1 << bitOffset)
    }
  }
  kc_diffs_get(index) {
    const wordIndex = index >>> 5
    const bitOffset = index & 31
    return (this.kc_diffs[wordIndex] >>> bitOffset) & 1
  }

  add_vlinks(val, vlen) {
    const maxIdx = (this.vlinks_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.vlinks.length) this._grow()
    this.vlinks_len = this._add(this.vlinks, this.vlinks_len, val, vlen)
  }
  add_klinks(val, vlen) {
    const maxIdx = (this.klinks_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.klinks.length) this._grow()
    this.klinks_len = this._add(this.klinks, this.klinks_len, val, vlen)
  }
  add_vflags(val, vlen) {
    const maxIdx = (this.vflags_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.vflags.length) this._grow()
    this.vflags_len = this._add(this.vflags, this.vflags_len, val, vlen)
  }
  add_kflags(val, vlen) {
    const maxIdx = (this.kflags_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.kflags.length) this._grow()
    this.kflags_len = this._add(this.kflags, this.kflags_len, val, vlen)
  }
  add_bools(val, vlen) {
    const maxIdx = (this.bools_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.bools.length) this._grow()
    this.bools_len = this._add(this.bools, this.bools_len, val, vlen)
  }
  add_keys(val, vlen) {
    const maxIdx = (this.keys_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.keys.length) this._grow()
    this.keys_len = this._add(this.keys, this.keys_len, val, vlen)
  }
  add_types(val, vlen) {
    const maxIdx = (this.types_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.types.length) this._grow()
    this.types_len = this._add(this.types, this.types_len, val, vlen)
  }
  add_nums(val, vlen) {
    const maxIdx = (this.nums_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.nums.length) this._grow()
    this.nums_len = this._add(this.nums, this.nums_len, val, vlen)
  }
  add_dc(val, vlen) {
    const maxIdx = (this.dc_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.dc.length) this._grow()
    this.dc_len = this._add(this.dc, this.dc_len, val, vlen)
  }
  add_kvals(val, vlen) {
    const maxIdx = (this.kvals_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.kvals.length) this._grow()
    this.kvals_len = this._add(this.kvals, this.kvals_len, val, vlen)
  }
  add_vals(val, vlen) {
    const maxIdx = (this.vals_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.vals.length) this._grow()
    this.vals_len = this._add(this.vals, this.vals_len, val, vlen)
  }

  add_strdiffs(val, vlen) {
    const maxIdx = (this.strdiffs_len >> 5) + ((vlen + 31) >> 5) + 1
    if (maxIdx >= this.strdiffs.length) this._grow()
    this.strdiffs_len = this._add(this.strdiffs, this.strdiffs_len, val, vlen)
  }

  add_strdiffs_bytes(uint8array) {
    for (let i = 0; i < uint8array.length; i++) {
      this.add_strdiffs(uint8array[i], 8)
    }
  }

  _add(tar, len, val, vlen) {
    // Caller (add_vflags etc.) is responsible for ensuring tar is large
    // enough by calling _grow when needed. The previous in-loop grow +
    // polymorphic re-bind chain was redundant overhead.
    if (vlen >= 32) val = val >>> 0
    else val &= (1 << vlen) - 1
    const used = len & 31
    const free = used === 0 ? 32 : 32 - used
    const idx = len >> 5

    if (vlen <= free) {
      if (used === 0) tar[idx] = val
      else tar[idx] = (tar[idx] << vlen) | val
      len += vlen
      return len
    }

    const high = val >>> (vlen - free)
    if (used === 0) tar[idx] = high
    else tar[idx] = (tar[idx] << free) | high
    len += free

    let rest = vlen - free
    if (rest <= 32) {
      tar[idx + 1] = val & ((1 << rest) - 1)
      len += rest
      return len
    }

    let writeIdx = idx + 1
    while (rest > 32) {
      tar[writeIdx++] = (val >>> (rest - 32)) & 0xffffffff
      len += 32
      rest -= 32
    }

    if (rest > 0) {
      tar[writeIdx] = val & ((1 << rest) - 1)
      len += rest
    }
    return len
  }

  push_vflag(flag) {
    this.add_vflags(flag, 1)
    if (flag) this.vflags_one++; else this.vflags_zero++
  }

  push_bool(bool) {
    const v = bool ? 1 : 0
    this.add_bools(v, 1)
    if (v) this.bools_one++; else this.bools_zero++
  }

  push_kflag(flag) {
    this.add_kflags(flag, 1)
    if (flag) this.kflags_one++; else this.kflags_zero++
  }

  get_diff(v, prev) {
    let diff = prev === -1 ? v : v - prev
    let isDiff = false
    if (diff < 0) {
      diff = Math.abs(diff) + 3
      isDiff = diff < 7
    } else isDiff = diff < 4
    const v2 = isDiff ? diff : v
    return v2 * 2 + (isDiff ? 1 : 0)
  }

  push_vlink(v) {
    // Inline get_diff: avoids method call + pack/unpack of result.
    const prev = this.prev_link
    let diff = prev === -1 ? v : v - prev
    let isDiff
    if (diff < 0) {
      diff = -diff + 3
      isDiff = diff < 7
    } else isDiff = diff < 4
    const v2 = isDiff ? diff : v
    this.prev_link = v
    // Inline push_vflag → add_vflags → _add for single-bit write.
    // Single bit always fits in current word (free >= 1) so no grow
    // path needed beyond a one-time capacity check.
    const flag = isDiff ? 1 : 0
    const vflen = this.vflags_len
    const vfidx = vflen >>> 5
    if (vfidx + 1 >= this.vflags.length) this._grow()
    const vfused = vflen & 31
    if (vfused === 0) this.vflags[vfidx] = flag
    else this.vflags[vfidx] = (this.vflags[vfidx] << 1) | flag
    this.vflags_len = vflen + 1
    if (flag) this.vflags_one++; else this.vflags_zero++
    this._push_vlink(v2, isDiff, this.dcount)
    this.rcount++
  }

  push_klink(v) {
    const prev = this.prev_klink
    let diff = prev === -1 ? v : v - prev
    let isDiff
    if (diff < 0) {
      diff = -diff + 3
      isDiff = diff < 7
    } else isDiff = diff < 4
    const v2 = isDiff ? diff : v
    this.prev_klink = v
    // Inline single-bit kflag write — same pattern as push_vlink.
    const flag = isDiff ? 1 : 0
    const kflen = this.kflags_len
    const kfidx = kflen >>> 5
    if (kfidx + 1 >= this.kflags.length) this._grow()
    const kfused = kflen & 31
    if (kfused === 0) this.kflags[kfidx] = flag
    else this.kflags[kfidx] = (this.kflags[kfidx] << 1) | flag
    this.kflags_len = kflen + 1
    if (flag) this.kflags_one++; else this.kflags_zero++
    this._push_klink(v2, isDiff, this.dcount)
  }

  set_newbits(count) {
    const new_bits = this.fastBits(count + 1)
    if (new_bits > this.prev_bits) {
      const diff = new_bits - this.prev_bits
      for (let i = 0; i < diff; i++) this.add_vlinks(0, this.prev_bits + i)
      this.prev_bits = new_bits
    }
    return new_bits
  }

  set_newbits_k(count) {
    const new_bits = this.fastBits(count + 1)
    if (new_bits > this.prev_kbits) {
      const diff = new_bits - this.prev_kbits
      for (let i = 0; i < diff; i++) this.add_klinks(0, this.prev_kbits + i)
      this.prev_kbits = new_bits
    }
    return new_bits
  }

  _flush_vlink(v, diff, count) {
    if (diff) {
      this.add_vlinks(v + 1, 3)
    } else {
      const nb = this.set_newbits(count)
      this.add_vlinks(v + 1, nb)
    }
  }

  flush_vlink() {
    if (this.vc_v === null) return
    if (this.vc_count < 4) {
      for (let i = 0; i < this.vc_count; i++)
        this._flush_vlink(
          this.vc_v,
          this.vc_diffs_get(i) === 1,
          this.vc_counts[i],
        )
    } else {
      if (this.vc_diffs_get(0) === 1) {
        this.add_vlinks(0, 3)
        this.short_vlinks(this.vc_count)
        this.add_vlinks(this.vc_v + 1, 3)
      } else {
        const nb = this.set_newbits(this.vc_counts[0])
        this.add_vlinks(0, nb)
        this.short_vlinks(this.vc_count)
        this.add_vlinks(this.vc_v + 1, nb)
      }
    }
  }

  _push_vlink(v, diff, count) {
    if (this.vc_count >= this.vc_counts.length) this._grow()
    if (this.vc_v === null) {
      this.vc_v = v
      this.vc_diffs_set(0, diff ? 1 : 0)
      this.vc_counts[0] = count
      this.vc_count = 1
    } else if (v === this.vc_v) {
      this.vc_diffs_set(this.vc_count, diff ? 1 : 0)
      this.vc_counts[this.vc_count] = count
      this.vc_count++
    } else {
      this.flush_vlink()
      this.vc_v = v
      this.vc_diffs_set(0, diff ? 1 : 0)
      this.vc_counts[0] = count
      this.vc_count = 1
    }
  }

  flush_klink() {
    if (this.kc_v === null) return
    if (this.kc_count < 4) {
      for (let i = 0; i < this.kc_count; i++) {
        this._flush_klink(
          this.kc_v,
          this.kc_diffs_get(i) === 1,
          this.kc_counts[i],
        )
      }
    } else {
      if (this.kc_diffs_get(0) === 1) {
        this.add_klinks(0, 3)
        this.short_klinks(this.kc_count)
        this.add_klinks(this.kc_v + 1, 3)
      } else {
        const nb = this.set_newbits_k(this.kc_counts[0])
        this.add_klinks(0, nb)
        this.short_klinks(this.kc_count)
        this.add_klinks(this.kc_v + 1, nb)
      }
    }
  }

  _flush_klink(v, diff, count) {
    if (diff) {
      this.add_klinks(v + 1, 3)
    } else {
      const nb = this.set_newbits_k(count)
      this.add_klinks(v + 1, nb)
    }
  }

  _push_klink(v, diff, count) {
    if (this.kc_count >= this.kc_counts.length) this._grow()
    if (this.kc_v === null) {
      this.kc_v = v
      this.kc_diffs_set(0, diff ? 1 : 0)
      this.kc_counts[0] = count
      this.kc_count = 1
    } else if (v === this.kc_v) {
      this.kc_diffs_set(this.kc_count, diff ? 1 : 0)
      this.kc_counts[this.kc_count] = count
      this.kc_count++
    } else {
      this.flush_klink()
      this.kc_v = v
      this.kc_diffs_set(0, diff ? 1 : 0)
      this.kc_counts[0] = count
      this.kc_count = 1
    }
  }
  push_type(obj) {
    if (obj === null) return
    let v = null
    let index = null
    let push = null
    if (obj !== null) [v, index, push] = obj
    if (index !== null) {
      this.add_types(0, 3)
      this.short_types(0)
      this.add_types(1, 1)
      this.short_types(index)
      this.short_types(push ?? 0)
      this.add_types(v, 3)
    } else if (this.tcount > 3) {
      this.add_types(0, 3)
      this.short_types(this.tcount)
      this.add_types(v, 3)
    } else for (let i = 0; i < this.tcount; i++) this.add_types(v, 3)
    this.tcount = 1
  }

  push_keylen(v) {
    this.short_keys(v)
  }

  push_int(v) {
    if (v > 0xffffffff || this.prev_num > 0xffffffff) {
      this.prev_num = v
      this.dint(v, false)
      return
    }
    // Inline get_diff: avoids method call + pack/unpack.
    // Note: prev_num is initialized to 0 (not null), so the null check
    // from get_diff is unnecessary here.
    const prev = this.prev_num
    let diff = v - prev
    let isDiff
    if (diff < 0) {
      diff = -diff + 3
      isDiff = diff < 7
    } else isDiff = diff < 4
    const v2 = isDiff ? diff : v
    this.prev_num = v
    this.dint(v2, isDiff)
  }

  push_float(neg, v) {
    if (v < 4) this.push_int(neg ? 4 + v : v)
    else this.push_int(neg ? 4 : 0)
  }

  flush_nums() {
    if (this.nc_diff !== null) {
      if (this.nc_count < 3) {
        for (let i = 0; i < this.nc_count; i++)
          this._dint(this.nc_v, this.nc_diff)
      } else {
        this.add_nums(0, 2)
        this.add_nums(7, 3)
        this.short_nums(this.nc_count)
        if (this.nc_diff) {
          this.add_nums(0, 2)
          this.add_nums(this.nc_v, 3)
        } else if (this.nc_v < 64) {
          const d = this.nc_v < 16 ? 4 : 6
          const flag = this.nc_v < 16 ? 1 : 2
          this.add_nums(flag, 2)
          this.add_nums(this.nc_v, d)
        } else this.leb128_nums(this.nc_v)
      }
    }
  }

  dint(v, diff = false) {
    if (this.nc_diff === null) {
      this.nc_diff = diff
      this.nc_v = v
      this.nc_count = 1
    } else if (this.nc_diff === diff && this.nc_v === v) {
      this.nc_count += 1
    } else {
      if (this.nc_count === 1) this._dint(this.nc_v, this.nc_diff)
      else this.flush_nums()
      this.nc_diff = diff
      this.nc_v = v
      this.nc_count = 1
    }
  }

  _dint(v, diff) {
    if (diff) {
      this.add_nums(0, 2)
      this.add_nums(v, 3)
    } else if (v < 64) {
      const d = v < 16 ? 4 : 6
      const flag = v < 16 ? 1 : 2
      this.add_nums(flag, 2)
      this.add_nums(v, d)
    } else this.leb128_nums(v)
  }

  leb128_2_kvals(v) {
    while (v >= 128) {
      this.add_kvals((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_kvals(v, 8)
  }
  leb128_2_dc(v) {
    while (v >= 128) {
      this.add_dc((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_dc(v, 8)
  }

  leb128_2_vals(v) {
    while (v >= 128) {
      this.add_vals((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_vals(v, 8)
  }

  leb128_dc(v) {
    this.add_dc(3, 2)
    while (v >= 128) {
      this.add_dc((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_dc(v, 8)
  }

  leb128_keys(v) {
    this.add_keys(3, 2)
    while (v >= 128) {
      this.add_keys((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_keys(v, 8)
  }

  leb128_klinks(v) {
    this.add_klinks(3, 2)
    while (v >= 128) {
      this.add_klinks((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_klinks(v, 8)
  }

  leb128_vals(v) {
    this.add_vals(3, 2)
    while (v >= 128) {
      this.add_vals((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_vals(v, 8)
  }

  leb128_kvals(v) {
    this.add_kvals(3, 2)
    while (v >= 128) {
      this.add_kvals((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_kvals(v, 8)
  }

  leb128_nums(v) {
    this.add_nums(3, 2)
    while (v >= 128) {
      this.add_nums((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_nums(v, 8)
  }

  leb128_types(v) {
    this.add_types(3, 2)
    while (v >= 128) {
      this.add_types((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_types(v, 8)
  }

  leb128_vlinks(v) {
    this.add_vlinks(3, 2)
    while (v >= 128) {
      this.add_vlinks((v & 0x7f) | 0x80, 8)
      v = Math.floor(v / 128)
    }
    this.add_vlinks(v, 8)
  }

  uint_dc(v) {
    if (v < 64) {
      const d = v < 8 ? 3 : v < 16 ? 4 : 6
      const flag = v < 8 ? 0 : v < 16 ? 1 : 2
      this.add_dc(flag, 2)
      this.add_dc(v, d)
    } else this.leb128_dc(v)
  }

  short_types(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_types(d - 2, 2)
      this.add_types(v, d)
    } else this.leb128_types(v)
  }

  short_dc(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_dc(d - 2, 2)
      this.add_dc(v, d)
    } else this.leb128_dc(v)
  }

  short_vals(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_vals(d - 2, 2)
      this.add_vals(v, d)
    } else this.leb128_vals(v)
  }

  short_nums(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_nums(d - 2, 2)
      this.add_nums(v, d)
    } else this.leb128_nums(v)
  }

  short_kvals(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_kvals(d - 2, 2)
      this.add_kvals(v, d)
    } else this.leb128_kvals(v)
  }

  short_keys(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_keys(d - 2, 2)
      this.add_keys(v, d)
    } else this.leb128_keys(v)
  }

  short_klinks(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_klinks(d - 2, 2)
      this.add_klinks(v, d)
    } else this.leb128_klinks(v)
  }

  short_vlinks(v) {
    if (v < 16) {
      const d = v < 4 ? 2 : this.fastBits(v)
      this.add_vlinks(d - 2, 2)
      this.add_vlinks(v, d)
    } else this.leb128_vlinks(v)
  }

  reset(strmap) {
    this.strMap.clear()
    this.str_len = 0
    if (strmap) {
      for (const k in strmap) {
        this.strMap.set(strmap[k], +k)
        this.str_len++
      }
    }
    this.prev_bits = 1
    this.prev_kbits = 1
    this.prev_num = 0
    this.nums_count = 0
    this.prev_link = -1
    this.prev_klink = -1
    this.single = true
    this.len = 0
    this.dlen = 0
    this.jlen = 0
    this.dcount = 0
    this.rcount = 0
    this.tcount = 0
    this.oid = 0
    this.iid = 0

    // Reused [type, index, push] tuple. _encode mutates this in place
    // and returns it; saves a fresh 3-element array allocation per
    // recursive call (one per leaf value). All callers stash the returned
    // reference into prev_type which always points to this same array.
    if (!this._pt) this._pt = [0, null, null]
    else {
      this._pt[0] = 0
      this._pt[1] = null
      this._pt[2] = null
    }

    this.vc_v = null
    this.vc_count = null
    this.kc_v = null
    this.kc_count = null
    this.nc_diff = null
    this.nc_v = null
    this.nc_count = null

    this.vlinks_len = 0
    this.klinks_len = 0
    this.vflags_len = 0
    this.kflags_len = 0
    this.bools_len = 0
    // Counters for v1.1 RLE-flag column encoding. We track zeros/ones
    // as columns are populated so dump() can emit a 2-bit prefix:
    //   00 = all zeros (no body)
    //   01 = all ones (no body)
    //   10 = mixed (followed by raw body bits)
    this.vflags_zero = 0; this.vflags_one = 0
    this.kflags_zero = 0; this.kflags_one = 0
    this.bools_zero = 0; this.bools_one = 0
    this.keys_len = 0
    this.types_len = 0
    this.nums_len = 0
    this.dc_len = 0
    this.kvals_len = 0
    this.vals_len = 0
    this.strdiffs_len = 0
  }
  todump() {
    let dumps = []
    for (let v of [
      "dc",
      "vflags",
      "vlinks",
      "kflags",
      "klinks",
      "keys",
      "kvals",
      "types",
      "bools",
      "nums",
      "vals",
    ]) {
      dumps.push({ len: this[`${v}_len`], bits: this[v] })
    }
    return dumps
  }
  _query(query) {
    this.dc_len = 0
    if (query) {
      this.add_dc(query.op, 2)
      this.short_dc(query.col)
      this.leb128_2_dc(query.doc)
      if (query.op === 2 && typeof query.len === "number") {
        this.short_dc(query.len)
      }
    }
    return { len: this.dc_len, bits: this.dc }
  }
  _dump(bits, query) {
    this._query(query)
    let totalBits = this.dc_len
    for (let v of bits) for (let v2 of v) totalBits += v2.len
    const padBits = (8 - (totalBits % 8)) % 8
    const finalBits = totalBits + padBits
    const outLength = finalBits / 8
    const out = new Uint8Array(outLength)
    let outIndex = 0
    let accumulator = 0
    let accBits = 0
    const writeBits = (num, numBits) => {
      while (numBits > 0) {
        const free = 8 - accBits
        if (numBits <= free) {
          accumulator = (accumulator << numBits) | (num & ((1 << numBits) - 1))
          accBits += numBits
          numBits = 0
          if (accBits === 8) {
            out[outIndex++] = accumulator
            accumulator = 0
            accBits = 0
          }
        } else {
          const shift = numBits - free
          const part = num >>> shift
          accumulator = (accumulator << free) | (part & ((1 << free) - 1))
          out[outIndex++] = accumulator
          num = num & ((1 << shift) - 1)
          numBits -= free
          accumulator = 0
          accBits = 0
        }
      }
    }
    const writeBuffer = (buffer, bitLen) => {
      let remaining = bitLen
      let i = 0
      while (remaining > 0 && i < buffer.length) {
        const bitsThis = Math.min(32, remaining)
        writeBits(buffer[i] >>> 0, bitsThis)
        remaining -= bitsThis
        i++
      }
    }
    if (query) writeBuffer(this.dc, this.dc_len)
    for (let v of bits) for (let v2 of v) writeBuffer(v2.bits, v2.len)
    if (padBits > 0) writeBits(0, padBits)
    return out
  }
  dump(query) {
    if (query) {
      this.add_dc(query.op, 2)
      this.short_dc(query.col)
      this.leb128_2_dc(query.doc)
      if (query.op === 2 && typeof query.len === "number") {
        this.short_dc(query.len)
      }
    }
    if (!this.single) {
      this.flush_vlink()
      this.flush_klink()
      this.flush_nums()
      this.add_dc(0, 1)
      this.short_dc(this.rcount)
    }
    // v1.1 RLE-flag encoding: prefix vflags, kflags, bools columns with
    // a 2-bit mode selector when the column is non-empty:
    //   00 = all zeros (no body)
    //   01 = all ones  (no body)
    //   10 = mixed     (followed by raw len bits)
    //   11 = reserved
    // Empty columns (len=0) emit nothing. Structurally vflags_len > 0
    // in structured mode, but kflags_len and bools_len can be 0.
    const vfMode = this.vflags_len === 0 ? -1
      : this.vflags_zero === this.vflags_len ? 0
      : this.vflags_one === this.vflags_len ? 1 : 2
    const kfMode = this.kflags_len === 0 ? -1
      : this.kflags_zero === this.kflags_len ? 0
      : this.kflags_one === this.kflags_len ? 1 : 2
    const bMode = this.bools_len === 0 ? -1
      : this.bools_zero === this.bools_len ? 0
      : this.bools_one === this.bools_len ? 1 : 2
    const vfHeader = vfMode === -1 ? 0 : 2
    const kfHeader = kfMode === -1 ? 0 : 2
    const bHeader = bMode === -1 ? 0 : 2
    const vfBody = vfMode === 2 ? this.vflags_len : 0
    const kfBody = kfMode === 2 ? this.kflags_len : 0
    const bBody = bMode === 2 ? this.bools_len : 0

    const totalBits =
      this.dc_len +
      vfHeader + vfBody +
      this.vlinks_len +
      kfHeader + kfBody +
      this.klinks_len +
      this.keys_len +
      this.types_len +
      this.nums_len +
      bHeader + bBody +
      this.kvals_len +
      this.vals_len +
      this.strdiffs_len
    const padBits = (8 - (totalBits % 8)) % 8
    const finalBits = totalBits + padBits
    const outLength = finalBits / 8
    const out = new Uint8Array(outLength)

    // Pack columns. For vflags/kflags/bools, write the 2-bit prefix first
    // (when len > 0) then the body only if mode is mixed.
    let outIndex = 0
    let accumulator = 0
    let accBits = 0
    // Per-column entries are { buf, len, prefix, prefixBits }.
    // prefixBits is 0 for columns without prefix and 2 for prefixed.
    // For prefixed mode 0 or 1, the body length is 0.
    const _cols = [
      { buf: this.dc,        len: this.dc_len,        prefix: 0, prefixBits: 0 },
      { buf: this.vflags,    len: vfBody,             prefix: vfMode | 0, prefixBits: vfHeader },
      { buf: this.vlinks,    len: this.vlinks_len,    prefix: 0, prefixBits: 0 },
      { buf: this.kflags,    len: kfBody,             prefix: kfMode | 0, prefixBits: kfHeader },
      { buf: this.klinks,    len: this.klinks_len,    prefix: 0, prefixBits: 0 },
      { buf: this.keys,      len: this.keys_len,      prefix: 0, prefixBits: 0 },
      { buf: this.kvals,     len: this.kvals_len,     prefix: 0, prefixBits: 0 },
      { buf: this.types,     len: this.types_len,     prefix: 0, prefixBits: 0 },
      { buf: this.bools,     len: bBody,              prefix: bMode | 0, prefixBits: bHeader },
      { buf: this.nums,      len: this.nums_len,      prefix: 0, prefixBits: 0 },
      { buf: this.vals,      len: this.vals_len,      prefix: 0, prefixBits: 0 },
      { buf: this.strdiffs,  len: this.strdiffs_len,  prefix: 0, prefixBits: 0 },
    ]
    for (let ci = 0; ci < 12; ci++) {
      const col = _cols[ci]
      // Write prefix bits if any.
      if (col.prefixBits > 0) {
        let num = col.prefix
        let numBits = col.prefixBits
        while (numBits > 0) {
          const free = 8 - accBits
          if (numBits <= free) {
            accumulator = (accumulator << numBits) | (num & ((1 << numBits) - 1))
            accBits += numBits
            numBits = 0
            if (accBits === 8) {
              out[outIndex++] = accumulator
              accumulator = 0
              accBits = 0
            }
          } else {
            const shift = numBits - free
            const part = num >>> shift
            accumulator = (accumulator << free) | (part & ((1 << free) - 1))
            out[outIndex++] = accumulator
            num = num & ((1 << shift) - 1)
            numBits -= free
            accumulator = 0
            accBits = 0
          }
        }
      }
      const buffer = col.buf
      let remaining = col.len
      const buflen = buffer.length
      let bi = 0
      while (remaining > 0 && bi < buflen) {
        const bitsThis = remaining < 32 ? remaining : 32
        let num = buffer[bi] >>> 0
        let numBits = bitsThis
        while (numBits > 0) {
          const free = 8 - accBits
          if (numBits <= free) {
            accumulator = (accumulator << numBits) | (num & ((1 << numBits) - 1))
            accBits += numBits
            numBits = 0
            if (accBits === 8) {
              out[outIndex++] = accumulator
              accumulator = 0
              accBits = 0
            }
          } else {
            const shift = numBits - free
            const part = num >>> shift
            accumulator = (accumulator << free) | (part & ((1 << free) - 1))
            out[outIndex++] = accumulator
            num = num & ((1 << shift) - 1)
            numBits -= free
            accumulator = 0
            accBits = 0
          }
        }
        remaining -= bitsThis
        bi++
      }
    }
    // Inline final pad bits (was writeBits(0, padBits) closure).
    if (padBits > 0) {
      let numBits = padBits
      let num = 0
      while (numBits > 0) {
        const free = 8 - accBits
        if (numBits <= free) {
          accumulator = (accumulator << numBits) | (num & ((1 << numBits) - 1))
          accBits += numBits
          numBits = 0
          if (accBits === 8) {
            out[outIndex++] = accumulator
            accumulator = 0
            accBits = 0
          }
        } else {
          const shift = numBits - free
          const part = num >>> shift
          accumulator = (accumulator << free) | (part & ((1 << free) - 1))
          out[outIndex++] = accumulator
          num = num & ((1 << shift) - 1)
          numBits -= free
          accumulator = 0
          accBits = 0
        }
      }
    }
    return out
  }
}

// JSON-specific encode entry points (encode, _encode, pushPathStr,
// pushPathNum) live in ./profiles/json/encode.js. Re-export them here
// for backwards compatibility with consumers that import from
// "./encoder.js" directly.
export { Encoder }
export { encode, _encode, pushPathStr } from "./profiles/json/encode.js"
