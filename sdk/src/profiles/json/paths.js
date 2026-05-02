// JSON profile — path grammar.
//
// Extracted from sdk/src/utils.js as part of Phase 3 of the weavepack
// roadmap. The .[] grammar is JSON-specific (other profiles will define
// their own navigation grammars). See weavepack/profiles/json/03-paths.md
// for the normative spec.

// escapeKey: escape `\`, `[`, `]` literals so the key survives parsePath.
// Note that `.` is NOT escaped — keys containing literal dots cannot
// be round-tripped through this grammar (a known limitation; see
// 03-paths.md).
export function escapeKey(k) {
  return String(k).replace(/[\\\[\]]/g, "\\$&")
}

// parsePath: split a path string into an array of components. Numeric
// brackets `[N]` become numbers; everything else becomes a string.
//
// The parser tolerates ambiguous input gracefully: `[non-numeric]` is
// treated as a literal part of the surrounding key rather than failing.
// See 03-paths.md for the disambiguation rules.
export function parsePath(path) {
  if (!path) return []

  const result = []
  let currentKey = ""
  let i = 0

  while (i < path.length) {
    const char = path[i]

    if (char === "\\" && i + 1 < path.length) {
      const next = path[i + 1]
      if (next === "[" || next === "]" || next === "\\") {
        currentKey += next
        i += 2
        continue
      }
    }

    if (char === ".") {
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      continue
    }

    if (char === "[") {
      let j = i + 1
      let content = ""
      while (j < path.length && path[j] !== "]") {
        content += path[j]
        j++
      }

      if (j < path.length && path[j] === "]" && /^\d+$/.test(content)) {
        if (currentKey) {
          result.push(currentKey)
          currentKey = ""
        }
        result.push(parseInt(content, 10))
        i = j + 1
        continue
      }

      currentKey += char
      i++
      continue
    }

    currentKey += char
    i++
  }

  if (currentKey) result.push(currentKey)
  return result
}

// parsePathStrict: stricter variant that always escapes via `\` and
// always treats `[<digits>]` as an array index when preceded by a
// complete key. Currently exported for completeness but not used by
// any code in src/. Kept for backwards compatibility with prior API
// surface.
export function parsePathStrict(path) {
  if (!path) return []

  const result = []
  let currentKey = ""
  let i = 0
  let escaped = false

  while (i < path.length) {
    const char = path[i]

    if (escaped) {
      currentKey += char
      escaped = false
      i++
      continue
    }

    if (char === "\\") {
      escaped = true
      i++
      continue
    }

    if (char === ".") {
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      continue
    }

    if (char === "[") {
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }

      let j = i + 1
      let indexStr = ""

      while (j < path.length && path[j] !== "]") {
        indexStr += path[j]
        j++
      }

      if (j >= path.length) {
        currentKey += char
        i++
        continue
      }

      if (/^\d+$/.test(indexStr)) {
        result.push(parseInt(indexStr, 10))
        i = j + 1
      } else {
        currentKey += path.substring(i, j + 1)
        i = j + 1
      }
      continue
    }

    currentKey += char
    i++
  }

  if (currentKey) result.push(currentKey)
  return result
}
