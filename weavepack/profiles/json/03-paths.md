# weavepack-json — 03: Path Grammar

**Status:** Draft. Retroactive spec of arjson v0.1.x as of 2026-05-03.

## Scope

This document specifies the path grammar used by the JSON profile of
weavepack to identify locations within a JSON tree, used in delta
operations (`04-deltas.md`).

A weavepack-json **path** is a string that names a position in a JSON
tree relative to the root. Paths consist of dot-separated key steps and
bracketed array indices.

## Grammar

```
path        = path-step ( separator path-step )*
            | ε                                  ; empty path = root

path-step   = key | index

separator   = "." | bracket-prefix
            ; "." separates two consecutive key steps;
            ; "[" begins an index without a preceding "." separator

key         = ( key-char | escape-seq )+
            ; one or more characters, dot-terminated or bracket-terminated

key-char    = any character except "." | "[" | "]" | "\"

escape-seq  = "\\" "\\"                          ; literal backslash
            | "\\" "["                           ; literal "["
            | "\\" "]"                           ; literal "]"

index       = "[" digit+ "]"

digit       = "0".."9"

bracket-prefix = "[" digit+ "]"                  ; not preceded by "."
```

## Examples

| Path | Refers to |
|---|---|
| `""` | the root document |
| `name` | the value at root key `"name"` |
| `user.email` | `root["user"]["email"]` |
| `users[0]` | `root["users"][0]` |
| `users[0].name` | `root["users"][0]["name"]` |
| `data[2020]` | `root["data"][2020]` (the integer index 2020 in array `data`) |
| `\\[admin\\]` | `root["[admin]"]` (literal `[admin]` as object key) |
| `a\\\\b` | `root["a\\b"]` (literal `a\b` as object key) |
| `user[admin]` | `root["user[admin]"]` — the `[admin]` is treated as part of the key because it is not numeric |

## Disambiguation rules

These rules implement the parsing logic in `parsePath()`:

1. A `[` followed by digits and a closing `]` → array index. Both bracketed
   and the preceding key (if any) are recorded as separate path steps.

2. A `[` followed by anything that is NOT digits-then-`]` → literal `[`
   character belonging to the surrounding key. The `[`, contents, and `]`
   all become part of the key string.

3. A `\` followed by `[`, `]`, or `\` → escapes the following character
   into the current key.

4. A `\` followed by anything else → literal `\` belonging to the key
   (the backslash is preserved as itself; the following character is
   processed normally).

5. A `.` always terminates the current key and begins a new path step.
   Dots are never escaped — there is no representation for a key
   containing a literal `.` character (see Limitations).

## Empty path

The empty string `""` denotes the root document. This is used in delta
operations that replace the entire root value (e.g., changing the root
from a primitive to an object).

## Numeric keys vs array indices

A `[N]` form where `N` is digits-only is **always** an array index, not
an object key. To name a numeric-string key in an object, the encoder
must emit it as a dotted path step: `obj.42` refers to `obj["42"]` as an
object property, while `obj[42]` refers to `obj[42]` as an array index.

This distinction is enforced at the diff layer: when the differ produces
a path, it inspects the parent's container type and emits `[N]` for
arrays and `.N` for objects.

## Limitations

The following cases CANNOT be represented in the current path grammar:

1. **Object keys containing `.`**: there is no escape sequence for a
   literal `.` in a key. A key like `"a.b"` is indistinguishable from
   the path `a.b` (which means `root["a"]["b"]`). Encoders MUST avoid
   producing such keys, or the round-trip will lose fidelity at the
   path level even though the value column still round-trips correctly.

2. **Object keys consisting purely of digits and surrounded by brackets**:
   e.g., `"[42]"` literally as a key requires `\[42\]`, which works.
   But the original arjson behavior makes `[42]` standalone an array
   index regardless of context. So if an object has a key like `[42]`,
   it must always be referenced via the escaped form.

3. **Empty key in object**: a key of `""` is supported as a value (see
   `02-containers.md`), but the path grammar cannot reference it. A path
   of `""` means the root, not "the empty-string key of root". This is
   a known limitation; encoders accessing such keys must use alternative
   means (operating on the kref chain directly).

4. **Sparse arrays**: paths cannot describe sparse holes. JSON itself
   does not support sparse arrays, so this is not a practical limitation.

5. **Unicode in keys**: keys are UTF-16 strings; the path grammar treats
   any non-ASCII character outside the special set (`.`, `[`, `]`, `\`)
   as a regular key character. Path strings are themselves UTF-16, so
   no encoding-level issue arises, but consumers parsing paths from
   external systems should be aware that keys may contain arbitrary
   code units.

## Path equivalence

Two paths are equivalent if they describe the same position in the
document. Equivalence is defined by:

```
parsePath(p1) deep-equals parsePath(p2)
```

where `parsePath()` returns an array of path components (strings for
keys, numbers for array indices). Two distinct path strings can map
to the same parsed component array — e.g., `a[0]` and `a[0]` are
trivially equivalent, but `a.b\\.c` would parse to `["a", "b\\.c"]`
which is `["a", "b.c"]` after the escape, ambiguous with the
hypothetical "key with literal dot" case above. In practice, the
encoder produces canonical paths (no unnecessary escapes), and decoders
parse them deterministically.

## Path emission rules (encoder side)

When the differ produces a delta operation, it emits paths under these
rules:

1. The root path is `""` (empty string).
2. Object key transitions append `.<key>` if a previous step exists,
   else just `<key>`.
3. Array index transitions append `[<n>]` (no leading dot).
4. The `escapeKey()` function is applied to every object-key segment
   to escape `\`, `[`, `]` literals.

Implementations MUST produce paths byte-equivalent to the JS reference
implementation for the conformance corpus to pass. Path normalization
(e.g., adding redundant escapes) is forbidden.

## Path consumption rules (decoder / patcher side)

When applying a delta operation with a given path, the receiver parses
the path with `parsePath()` and walks the JSON tree:

```
let cursor = root
for each component in parsePath(path):
  cursor = cursor[component]
```

If any intermediate component is missing, behavior depends on the
operation:

- For `replace` / `add` / `remove` operations on a leaf, intermediate
  containers MUST exist or the operation is a protocol error.
- For `add` operations that create an entire subtree, the operation
  is encoded as a single replace at the parent path containing the
  new subtree, not as a sequence of nested adds.

This matches the encoder's behavior: it emits the smallest number of
delta ops needed to express the change, with each op atomic at its
target path.

## Test vector references

Conformance test vectors covering path parsing and emission live in
`profiles/json/test-vectors/paths/`. Each vector is a tuple
`(path-string, parsed-components)` plus round-trip emission tests
for each shape.
