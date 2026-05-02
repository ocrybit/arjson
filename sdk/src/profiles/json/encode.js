// JSON profile — encode entry points.
//
// Extracted from sdk/src/encoder.js as part of Phase 3 (stage 3.5).
// The Encoder class itself remains in encoder.js — it's profile-
// agnostic infrastructure (column buffers, bit packing, RLE, etc.).
// What lives here is the JSON-specific dispatch:
//
//   - `encode(v, encoder, query, strmap)`: top-level entry point.
//     Decides single-payload vs structured mode and emits the
//     appropriate JSON-shaped tags.
//   - `_encode(v, encoder, ...)`: recursive descent for structured
//     mode. Dispatches on `typeof v` and Array.isArray; emits vtype
//     values 0..7 from the JSON profile's vtype space.
//   - `pushPathStr` / `pushPathNum`: helpers for emitting object keys
//     and array indices into the kref column.
//
// Other profiles will define their own encode functions tailored to
// their value spaces. The Encoder class is the shared substrate they
// all build on.

import { getPrecision, strmap_byte, base64_byte } from "../../utils.js"

// Precomputed pow10 lookup; matches the decoder's table. Used for
// scaling numbers with decimal precision.
const POW10 = new Float64Array(310)
for (let i = 0; i < 310; i++) POW10[i] = Math.pow(10, i)

function pushPathStr(u, v2, prev = null, diff = null) {
  if (u.dcount > 0) u.push_klink(prev === null ? 0 : prev + 1)
  if (u.strMap.has(v2)) {
    u.add_keys(2, 2)
    u.push_keylen(0)
    u.short_kvals(u.strMap.get(v2))
  } else {
    u.strMap.set(v2, u.str_len++)
    const len = v2.length
    let is64 = len !== 0
    for (let i = 0; i < len; i++) {
      const c = v2.charCodeAt(i)
      if (c >= 128 || base64_byte[c] === 0xff) {
        is64 = false
        break
      }
    }
    const ktype = is64 ? 2 : 3
    u.add_keys(ktype, 2)
    u.push_keylen(len + 1)
    if (is64) {
      const need = ((len * 6 + 31) >> 5) + (u.kvals_len >> 5) + 1
      while (need >= u.kvals.length) u._grow()
      let kvlen = u.kvals_len
      const kvals = u.kvals
      for (let i = 0; i < len; i++) {
        const val = base64_byte[v2.charCodeAt(i)]
        const used = kvlen & 31
        const free = 32 - used
        const idx = kvlen >>> 5
        if (free >= 6) {
          if (used === 0) kvals[idx] = val
          else kvals[idx] = ((kvals[idx] << 6) | val) >>> 0
        } else {
          const high = val >>> (6 - free)
          if (used === 0) kvals[idx] = high
          else kvals[idx] = ((kvals[idx] << free) | high) >>> 0
          kvals[idx + 1] = val & ((1 << (6 - free)) - 1)
        }
        kvlen += 6
      }
      u.kvals_len = kvlen
    } else {
      for (let i = 0; i < len; i++) u.leb128_2_kvals(v2.charCodeAt(i))
    }
  }
  u.dcount++
}

function pushPathNum(u, prev = null, keylen, index = null) {
  if (u.dcount > 0) u.push_klink(prev === null ? 0 : prev + 1)
  u.add_keys(keylen, 2)
  u.dcount++
}

function encode(v, u, query, strmap) {
  if (typeof v === "number" && v - v !== 0) v = null
  strmap ??= {}
  u.reset(strmap)
  if (typeof v === "undefined") {
    u.single = false
    u.push_type(_encode(v, u))
  } else if (v === null) {
    u.add_dc(1, 1)
    u.add_dc(0, 7)
  } else if (typeof v !== "object") {
    u.add_dc(1, 1)
    if (v === true) u.add_dc(1, 7)
    else if (v === false) u.add_dc(2, 7)
    else if (v === "") u.add_dc(3, 7)
    else if (typeof v === "number") {
      const isInt = (v | 0) === v || Number.isInteger(v)
      const moved = isInt ? 0 : Math.min(getPrecision(v), 308)
      const type = moved === 0 ? (v < 0 ? 5 : 4) : v < 0 ? 7 : 6
      if (type === 4) {
        u.add_dc(1, 1)
        if (v < 63) u.add_dc(v, 6)
        else {
          u.add_dc(63, 6)
          u.leb128_2_dc(v - 63)
        }
      } else if (type === 5) {
        u.add_dc(0, 1)
        u.add_dc(type + 1, 6)
        u.uint_dc(-v)
      } else {
        u.add_dc(0, 1)
        u.add_dc(type + 1, 6)
        u.uint_dc(moved)
        u.uint_dc(Math.round((v < 0 ? -v : v) * (moved < 310 ? POW10[moved] : Math.pow(10, moved))))
      }
    } else if (typeof v === "string") {
      u.add_dc(0, 1)
      const len = v.length
      if (len === 1) {
        const charCode = v.charCodeAt(0)
        const mapValue = charCode < 128 ? strmap_byte[charCode] : 0xff
        if (mapValue !== 0xff) {
          u.add_dc(mapValue + 9, 6)
        } else {
          u.add_dc(61, 6)
          u.leb128_2_dc(charCode)
        }
      } else {
        let is64 = true
        for (let i = 0; i < len; i++) {
          const c = v.charCodeAt(i)
          if (c >= 128 || base64_byte[c] === 0xff) {
            is64 = false
            break
          }
        }
        if (is64) {
          u.add_dc(62, 6)
          u.short_dc(len)
          for (let i = 0; i < len; i++) u.add_dc(base64_byte[v.charCodeAt(i)], 6)
        } else {
          u.add_dc(63, 6)
          u.short_dc(len)
          for (let i = 0; i < len; i++) u.leb128_2_dc(v.charCodeAt(i))
        }
      }
    }
  } else if (Array.isArray(v) && v.length === 0) {
    u.add_dc(1, 1)
    u.add_dc(4, 7)
  } else if (Object.keys(v).length === 0) {
    u.add_dc(1, 1)
    u.add_dc(5, 7)
  } else {
    u.single = false
    u.push_type(_encode(v, u))
  }
  return u.dump(query)
}

function _encode(
  v,
  u,
  prev = null,
  prev_type = null,
  index = null,
  push = null,
  diff,
) {
  if (typeof v === "number" && v - v !== 0) v = null
  const _pt = u._pt
  if (typeof v === "number") {
    if (prev !== null) u.push_vlink(prev + 1)
    const isInt = (v | 0) === v || Number.isInteger(v)
    const moved = isInt ? 0 : Math.min(getPrecision(v), 308)
    const type = moved === 0 ? (v < 0 ? 5 : 4) : 6
    if (
      prev_type !== null &&
      (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== type)
    ) {
      u.push_type(prev_type)
    } else u.tcount++
    if (moved === 0) {
      u.push_int(v < 0 ? -v : v)
    } else {
      u.push_float(v < 0, moved + 1)
      if (moved > 2) u.push_int(moved + 1)
      u.push_int(Math.round((v < 0 ? -v : v) * (moved < 310 ? POW10[moved] : Math.pow(10, moved))))
    }
    _pt[0] = type; _pt[1] = index; _pt[2] = push
    return _pt
  } else if (typeof v === "undefined") {
    if (prev !== null) u.push_vlink(prev + 1)
    if (
      prev_type !== null &&
      (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== 1)
    )
      u.push_type(prev_type)
    else u.tcount++
    _pt[0] = 0; _pt[1] = index; _pt[2] = push
    return _pt
  } else if (typeof v === "boolean") {
    if (prev !== null) u.push_vlink(prev + 1)
    const type = 3
    if (
      prev_type !== null &&
      (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== type)
    )
      u.push_type(prev_type)
    else u.tcount++
    u.push_bool(v)
    _pt[0] = type; _pt[1] = index; _pt[2] = push
    return _pt
  } else if (v === null) {
    if (prev !== null) u.push_vlink(prev + 1)
    if (
      prev_type !== null &&
      (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== 1)
    )
      u.push_type(prev_type)
    else u.tcount++
    _pt[0] = 1; _pt[1] = index; _pt[2] = push
    return _pt
  } else if (typeof v === "string") {
    let ktype = 7
    if (prev !== null) u.push_vlink(prev + 1)
    if (diff) {
      ktype = 2
      u.short_vals(0)
      u.add_vals(1, 1)
      u.add_strdiffs_bytes(diff)
    } else if (u.strMap.has(v)) {
      ktype = 2
      u.short_vals(0)
      u.add_vals(0, 1)
      u.short_vals(u.strMap.get(v))
    } else {
      u.strMap.set(v, u.str_len++)
      const len = v.length
      u.short_vals(len)
      let is64 = len !== 0
      for (let i = 0; i < len; i++) {
        const c = v.charCodeAt(i)
        if (c >= 128 || base64_byte[c] === 0xff) {
          is64 = false
          break
        }
      }
      if (is64) {
        ktype = 2
        const need = ((len * 6 + 31) >> 5) + (u.vals_len >> 5) + 1
        while (need >= u.vals.length) u._grow()
        let vlen = u.vals_len
        const vals = u.vals
        for (let i = 0; i < len; i++) {
          const val = base64_byte[v.charCodeAt(i)]
          const used = vlen & 31
          const free = 32 - used
          const idx = vlen >>> 5
          if (free >= 6) {
            if (used === 0) vals[idx] = val
            else vals[idx] = ((vals[idx] << 6) | val) >>> 0
          } else {
            const high = val >>> (6 - free)
            if (used === 0) vals[idx] = high
            else vals[idx] = ((vals[idx] << free) | high) >>> 0
            vals[idx + 1] = val & ((1 << (6 - free)) - 1)
          }
          vlen += 6
        }
        u.vals_len = vlen
      } else {
        for (let i = 0; i < len; i++) u.leb128_2_vals(v.charCodeAt(i))
      }
    }
    if (
      prev_type !== null &&
      (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== ktype)
    ) {
      u.push_type(prev_type)
    } else u.tcount++

    _pt[0] = ktype; _pt[1] = index; _pt[2] = push
    return _pt
  } else if (Array.isArray(v)) {
    if (v.length === 0) {
      pushPathNum(u, prev, 0, index)
      prev = u.dcount
      if (prev !== null) u.push_vlink(prev)
      if (
        prev_type !== null &&
        (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== 6)
      ) {
        u.push_type(prev_type)
      } else u.tcount++
      u.push_float(false, 1)
      _pt[0] = 6; _pt[1] = index; _pt[2] = push
      return _pt
    } else {
      const _prev = u.dcount
      pushPathNum(u, prev, 0, index)
      const vlen = v.length
      for (let vi = 0; vi < vlen; vi++) {
        prev_type = _encode(v[vi], u, _prev, prev_type)
      }
    }
    return prev_type
  } else if (typeof v === "object") {
    if (Object.keys(v).length === 0) {
      pushPathNum(u, prev, 1, index)
      prev = u.dcount
      if (prev !== null) u.push_vlink(prev)
      if (
        prev_type !== null &&
        (prev_type[1] !== null || prev_type[2] !== null || prev_type[0] !== 6)
      ) {
        u.push_type(prev_type)
      } else u.tcount++
      u.push_float(true, 1)
      _pt[0] = 6; _pt[1] = index; _pt[2] = push
      return _pt
    } else {
      pushPathNum(u, prev, 1, index)
      const __prev = u.dcount
      const keys = Object.keys(v)
      const klen = keys.length
      for (let ki = 0; ki < klen; ki++) {
        const k = keys[ki]
        const _prev = u.dcount
        pushPathStr(u, k, __prev - 1)
        prev_type = _encode(v[k], u, _prev, prev_type)
      }
      return prev_type
    }
  }
}

export { encode, _encode, pushPathStr, pushPathNum }
