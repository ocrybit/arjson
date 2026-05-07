// JSON profile — diff algorithm.
//
// Extracted from sdk/src/arjson.js as part of Phase 3 of the weavepack
// roadmap. This module is JSON-specific because it dispatches on
// Array.isArray + Object.keys (JSON's container shapes), uses the JSON
// path grammar (see ./paths.js / utils.escapeKey), and assumes the
// JSON primitive type set (null, bool, number, string).
//
// The diff function takes two JSON values and returns an array of
// "ops" (replace, add, remove, diff). Each op has a `path`, an
// optional `op` discriminator, and a payload (`from`, `to`, `diffs`).
// The op set is defined in weavepack/profiles/json/04-deltas.md.
//
// Other profiles will define their own diff algorithms tailored to
// their data shapes (e.g., tensor profiles diff per-tensor or per-
// region; tabular profiles diff per-row).

import fastDiff from "fast-diff"
import { equals, isObject } from "../../utils.js"
import { escapeKey } from "./paths.js"

const uniq = arr => Array.from(new Set(arr))

const isPrimitive = v => !isObject(v) || v === null

const hasNonPrimitive = arr => arr.some(v => !isPrimitive(v))

// shouldUseDiff: decide whether a string change is worth encoding as a
// fast-diff op vs a full replace. Threshold: both sides must be ≥ 20
// chars and the change-size must be < 60% of `to` length.
function shouldUseDiff(from, to) {
  if (typeof from !== "string" || typeof to !== "string") return false
  if (from.length < 20 || to.length < 20) return false
  const diffs = fastDiff(from, to)
  let changeSize = 0
  for (const [op, text] of diffs) {
    if (op !== fastDiff.EQUAL) changeSize += text.length
  }
  return changeSize < to.length * 0.6
}

const replaceOp = (path, from, to) => [{ path, op: "replace", from, to }]

function primitiveChangeOp(path, from, to) {
  if (shouldUseDiff(from, to)) {
    return { path, op: "diff", from, to, diffs: fastDiff(from, to) }
  }
  return { path, op: "replace", from, to }
}

// diffArray: per-element diff for two same-shape arrays. See the
// commentary in arjson.js (pre-extraction) for the case analysis.
function diffArray(a, b, path = "") {
  if (a.length === 0 && b.length > 0) {
    if (hasNonPrimitive(b)) return replaceOp(path, a, b)
    return b.map((v, i) => ({ path: `${path}[${i}]`, to: v }))
  }
  if (b.length === 0 && a.length > 0) {
    const ops = []
    for (let i = a.length - 1; i >= 0; i--) {
      ops.push({ path: `${path}[${i}]`, op: "remove", from: a[i] })
    }
    return ops
  }

  const commonLen = Math.min(a.length, b.length)
  const modifications = []
  for (let i = 0; i < commonLen; i++) {
    if (!equals(a[i], b[i])) modifications.push(i)
  }

  // For object-to-object modifications, attempt sub-path replace ops.
  // ARTable supports replace-at-existing-path within array-element objects
  // but not add/remove of keys — so bail to full-array replace if any sub-op
  // would add or remove a key, or if a changed value is itself non-primitive.
  const objSubOps = new Map()
  for (const i of modifications) {
    if (!isPrimitive(b[i]) || !isPrimitive(a[i])) {
      if (
        isObject(a[i]) && !Array.isArray(a[i]) &&
        isObject(b[i]) && !Array.isArray(b[i])
      ) {
        const sub = diff(a[i], b[i], `${path}[${i}]`)
        if (
          sub.length > 0 &&
          sub.every(op =>
            isPrimitive(op.to) && (op.op === "replace" || op.op === "diff")
          )
        ) {
          objSubOps.set(i, sub)
        } else {
          return replaceOp(path, a, b)
        }
      } else {
        return replaceOp(path, a, b)
      }
    }
  }

  if (a.length !== b.length) {
    const overhang = a.length < b.length
      ? b.slice(a.length)
      : a.slice(b.length)
    if (hasNonPrimitive(overhang)) return replaceOp(path, a, b)
  }

  const ops = []

  if (a.length > b.length) {
    for (let i = a.length - 1; i >= b.length; i--) {
      ops.push({ path: `${path}[${i}]`, op: "remove", from: a[i] })
    }
  }

  for (let i = modifications.length - 1; i >= 0; i--) {
    const idx = modifications[i]
    if (objSubOps.has(idx)) {
      for (const op of objSubOps.get(idx)) ops.push(op)
    } else {
      ops.push({ path: `${path}[${idx}]`, ...primitiveChangeOp("", a[idx], b[idx]) })
    }
  }

  if (a.length < b.length) {
    for (let i = a.length; i < b.length; i++) {
      ops.push({ path: `${path}[${i}]`, to: b[i] })
    }
  }

  return ops
}

// Top-level recursive diff for two JSON values. Returns an array of
// op records.
export const diff = (a, b, path = "") => {
  if (equals(a, b)) return []

  if (isPrimitive(a) || isPrimitive(b)) {
    if (shouldUseDiff(a, b)) {
      return [{ path, op: "diff", from: a, to: b, diffs: fastDiff(a, b) }]
    }
    return replaceOp(path, a, b)
  }

  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b, path)
  if (Array.isArray(a) || Array.isArray(b)) return replaceOp(path, a, b)

  if (Object.keys(b).length === 0 && Object.keys(a).length > 0) {
    return replaceOp(path, a, b)
  }

  const allKeys = uniq([...Object.keys(a), ...Object.keys(b)])
  const ops = []
  for (const v of allKeys) {
    const _path = path === "" ? escapeKey(v) : `${path}.${escapeKey(v)}`
    if (typeof a[v] === "undefined") {
      ops.push({ path: _path, op: "add", to: b[v] })
    } else if (typeof b[v] === "undefined") {
      ops.push({ path: _path, op: "remove", from: a[v] })
    } else if (!equals(a[v], b[v])) {
      const sub = diff(a[v], b[v], _path)
      for (const op of sub) ops.push(op)
    }
  }
  return ops
}

// isNonStructural is consumed by ARJSON.update to decide whether to
// re-anchor on a primitive-to-primitive transition. It belongs to the
// JSON profile because the notion of "structural" (object/array vs
// primitive) is JSON-shaped.
export function isNonStructural(v) {
  if (v === null) return true
  if (typeof v !== "object") return true
  if (Array.isArray(v)) return v.length === 0
  return Object.keys(v).length === 0
}
