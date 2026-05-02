// Deterministic random JSON value generators for property-based tests.
//
// Phase 4 of the weavepack roadmap calls for property-based testing.
// Rather than pull in fast-check as a dependency, this module
// implements a minimal seed-driven generator framework. Tests iterate
// over seeds 0..N-1; each seed deterministically produces a JSON
// value to test against an algebraic law.
//
// The seed is a simple linear-congruential PRNG state. Identical seeds
// produce identical values across runs, enabling deterministic
// regression on a failing seed.

// ── PRNG ─────────────────────────────────────────────────────────────────

// LCG with the same constants as Numerical Recipes. Gives a uniform
// distribution over [0, 2^32) for any seed in the same range. Returns
// the next state plus a normalized float in [0, 1).
function lcg(state) {
  const next = (state * 1664525 + 1013904223) >>> 0
  return { state: next, value: next / 0x100000000 }
}

class Rng {
  constructor(seed) {
    this.state = seed >>> 0
  }
  next() {
    const r = lcg(this.state)
    this.state = r.state
    return r.value
  }
  int(min, max) {
    // Inclusive range. Caller ensures max < 2^32.
    return min + Math.floor(this.next() * (max - min + 1))
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)]
  }
  bool() {
    return this.next() < 0.5
  }
}

// ── JSON value generators ────────────────────────────────────────────────
//
// Each `gen<X>(rng, depth)` returns a JSON-shaped value. `depth` is
// the recursion budget — when it reaches 0, only primitives are
// generated to bound tree size.

function genNull() { return null }

function genBool(rng) { return rng.bool() }

function genInt(rng) {
  // Uniform mix of small and large integers.
  const r = rng.next()
  if (r < 0.4) return rng.int(-10, 10)
  if (r < 0.7) return rng.int(-1000, 1000)
  if (r < 0.9) return rng.int(-1000000, 1000000)
  // Avoid > 2^31 since LCG is 32-bit; use safe-ish range.
  return rng.int(-1e9, 1e9)
}

function genFloat(rng) {
  // Floats with controlled decimal precision.
  const sign = rng.bool() ? 1 : -1
  const mantissa = rng.int(0, 100000)
  const exp = rng.int(0, 6)  // up to 6 decimal places
  return sign * mantissa / Math.pow(10, exp)
}

function genNumber(rng) {
  return rng.bool() ? genInt(rng) : genFloat(rng)
}

const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
const ASCII_DIGITS = "0123456789"
const SAFE_PUNCT = " -_."

function genString(rng) {
  const len = rng.int(0, 20)
  let s = ""
  for (let i = 0; i < len; i++) {
    const r = rng.next()
    if (r < 0.6) s += ASCII_LOWER[rng.int(0, 25)]
    else if (r < 0.8) s += ASCII_DIGITS[rng.int(0, 9)]
    else s += SAFE_PUNCT[rng.int(0, SAFE_PUNCT.length - 1)]
  }
  return s
}

function genKey(rng) {
  // Object keys: short identifier-like strings, biased toward small
  // pools so the strmap dedup actually fires.
  const pools = ["a", "b", "c", "name", "id", "type", "value", "count", "k1", "k2"]
  return rng.pick(pools)
}

function genArray(rng, depth) {
  const len = rng.int(0, depth > 1 ? 6 : 3)
  const arr = []
  for (let i = 0; i < len; i++) arr.push(genAny(rng, depth - 1))
  return arr
}

function genObject(rng, depth) {
  const keyCount = rng.int(0, depth > 1 ? 5 : 2)
  const obj = {}
  for (let i = 0; i < keyCount; i++) {
    obj[genKey(rng) + i] = genAny(rng, depth - 1)
  }
  return obj
}

function genAny(rng, depth = 4) {
  if (depth <= 0) return genPrimitive(rng)
  const r = rng.next()
  if (r < 0.15) return genNull()
  if (r < 0.25) return genBool(rng)
  if (r < 0.45) return genInt(rng)
  if (r < 0.55) return genFloat(rng)
  if (r < 0.7) return genString(rng)
  if (r < 0.85) return genArray(rng, depth)
  return genObject(rng, depth)
}

function genPrimitive(rng) {
  const r = rng.next()
  if (r < 0.2) return genNull()
  if (r < 0.4) return genBool(rng)
  if (r < 0.65) return genInt(rng)
  if (r < 0.8) return genFloat(rng)
  return genString(rng)
}

// ── Sample factories — produce a value from a seed integer ───────────────

export function sampleAny(seed, depth = 4) {
  return genAny(new Rng(seed), depth)
}
export function sampleObject(seed, depth = 4) {
  return genObject(new Rng(seed), depth)
}
export function sampleArray(seed, depth = 4) {
  return genArray(new Rng(seed), depth)
}
export function samplePrimitive(seed) {
  return genPrimitive(new Rng(seed))
}
export function sampleString(seed) {
  return genString(new Rng(seed))
}
export function sampleNumber(seed) {
  return genNumber(new Rng(seed))
}

// genPair(seed): returns two distinct JSON values, useful for delta
// tests. The two share the same seed-derived RNG state but consume
// different prefixes, so they're correlated but not identical.
export function samplePair(seed, depth = 4) {
  const rng1 = new Rng(seed)
  const a = genAny(rng1, depth)
  const rng2 = new Rng(seed ^ 0xdeadbeef)
  const b = genAny(rng2, depth)
  return [a, b]
}
