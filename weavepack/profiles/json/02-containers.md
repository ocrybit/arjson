# weavepack-json — 02: Containers

**Status:** Draft. Retroactive spec of arjson v0.1.x as of 2026-05-03.

## Scope

This document specifies how the JSON profile of weavepack encodes the
two container shapes — **arrays** and **objects** — and how parent-child
relationships between containers and their members are represented.

The JSON value space (RFC 8259) defines two structural types:

```
array  = [ value, value, ... ]
object = { string-key: value, string-key: value, ... }
```

Both arrays and objects can nest arbitrarily deep and can contain any
JSON value as members.

## High-level model

weavepack-json uses a **flat columnar representation** for containers
rather than a recursive nested representation. The encoder walks the
JSON tree once and emits columns that, taken together, allow the decoder
to reconstruct the tree:

- Each leaf value contributes one entry to the **vrefs** column. The
  value's payload goes into the appropriate value column (`bools`,
  `nums`, `strs`/`vals`).
- Each "key step" in the tree (every container key or array index)
  contributes one entry to the **krefs** column.
- The `vrefs[i]` value is an integer index pointing at the kref slot
  that immediately encloses leaf `i`. The `krefs[k]` value is an
  integer index pointing at the kref slot that immediately encloses
  kref slot `k` (the parent step).

The result is a forest of paths from the root to each leaf, encoded as
two parallel arrays of integer pointers. The decoder rebuilds the JSON
tree by walking each leaf's chain of krefs back to the root, then
inserting the leaf at the corresponding position.

This representation is critical for the protocol's bit-level efficiency:
- Repeated keys (across siblings or across a column-of-objects pattern)
  share a single strmap entry
- Index-only arrays (no keys) collapse to ktype 0 with no per-index key
  data
- Delta updates can target a specific kref slot without reflowing
  surrounding structure

## Container key types (ktypes)

The `ktypes` column carries 2-bit values per kref slot, plus a
short-encoded length for string keys:

| `ktype[0]` | meaning | `ktype[1]` (if present) | key column |
|---|---|---|---|
| 0 | **array index** | — | `keys` carries a positional integer (auto-incremented per array, set during decode) |
| 1 | **object key (numeric placeholder)** | — | `keys` carries an integer that resolves to a string via the strmap (built during keymap pass) |
| 2 | **base64url string key** | string length + 1, or 0 for strmap reference | character bits in `kvals` (6 bits each) |
| 3 | **fallback string key** | string length + 1, or 2 for empty `""` key | UTF-16 code units in `kvals` (LEB128 each) |

A `ktype[0]` of 0 marks the slot as belonging to an array — the
"key" is the positional index assigned during decode (0, 1, 2, ...).
A `ktype[0]` of 1 marks the slot as belonging to an object whose key
is recovered via the strmap (used for repeated keys; the actual string
appears in the strmap once).

`ktype[0]` values 2 and 3 are reserved for **first-occurrence** string
keys whose characters are written literally into the `kvals` column.
The `ktype[1]` field is the encoded length:

- `0` (for ktype 2) — strmap reference: the next field in `keys` is
  the strmap index
- `1` (for ktype 3) — empty key `""`
- `n + 1` (for ktype 2 or 3 with n > 0) — literal string of length n
  follows in `kvals`

This encoding lets the encoder write each unique key exactly once.
Duplicate keys (e.g., the same property name appearing across many
sibling objects) are encoded as 1-bit strmap references on every
occurrence after the first.

## Empty containers

Empty arrays `[]` and empty objects `{}` have no member kref slots,
so they can't carry their identity via `krefs` alone. Their encoding
splits across the wire mode:

**Top-level (single-payload mode):**

| value | dc-tag (after `1` mode bit + `0` selector + 6 bits) |
|---|---|
| `[]` | 4 |
| `{}` | 5 |

(See `01-types.md` for the complete tag table.)

**Nested (inside a structured payload):**

A nested empty container is emitted as a vtype-6 value with a special
precision marker:

- precision `1` and positive sign → `[]`
- precision `1` and negative sign → `{}`

These are the only vtype-6 values that don't carry a mantissa. The
decoder, on seeing a precision-1 marker, materializes the empty array
or empty object directly without reading a mantissa from `nums`.

This odd-looking encoding is a deliberate piggyback on the float-type
machinery: empty containers are rare enough that giving them a dedicated
ctype tag would waste bits in the common case.

## Container parent-child linking

The kref tree is encoded via two columns:

- **`vrefs[i]`**: for leaf `i`, the index into `krefs` of the
  immediately-enclosing key step. Encoded as a delta-pack stream
  (`vlinks`) with run-length compression for repeated parents.
- **`krefs[k]`**: for kref slot `k`, the index into `krefs` of its
  parent kref slot (the next-level-up key step). Encoded as a
  delta-pack stream (`klinks`) with run-length compression for
  repeated parents.

A kref slot with `krefs[k] = 0` is at the root level (its parent is
the implicit document container).

The delta-pack encoding (`vlinks`/`klinks`) lets sibling leaves with the
same parent share an extremely short representation (1 bit for "same
as previous parent"). For arrays of N similar objects, the per-leaf
overhead drops to near zero.

## Container traversal during decode

On decode, after the column header sequence completes (`02-wire-format.md`),
the decoder walks each leaf in vrefs order:

1. For each `vrefs[i]`, walk back through `krefs[vrefs[i] - 2]`,
   `krefs[krefs[vrefs[i] - 2] - 2]`, ... until reaching root (parent = 0).
2. Each kref step contributes one path component (string key, integer
   index, or strmap-resolved key).
3. Insert the leaf value at the path. If the path crosses an object
   that doesn't yet exist, create it (as `{}`); same for arrays
   (created as `[]` and grown via successive index inserts).

The decoder MUST process leaves in vrefs order to ensure array indices
are inserted in ascending order. Out-of-order array inserts could
produce sparse arrays with `undefined` slots, which JSON does not
support.

## Top-level container detection

The top-level value is determined as follows:

- If the wire mode bit is `1` (single-payload), the top-level value
  is the single-payload tag's value (which may be a primitive or an
  empty container).
- If the wire mode bit is `0` (structured), the top-level container
  is determined by the first leaf's kref chain. If the chain's root
  kref has `ktype[0] = 0` (array index), the top level is an array;
  otherwise (`ktype[0]` ∈ {1, 2, 3}) it is an object.

A structured payload cannot represent a top-level primitive — single-
payload mode is used for that case.

## Mixed-type arrays

JSON arrays may contain mixed value types (some elements numbers,
others strings, etc.). weavepack-json handles this naturally because
each leaf carries its own vtype in the `vtypes` column. Mixed-type
arrays incur slightly higher per-element overhead than uniform-type
arrays because the run-length compression of `vtypes` is less
effective.

For arrays whose elements are all the same type — a common pattern
for e.g. arrays of numbers, arrays of strings — the run-length
encoding of `vtypes` collapses to two bits (the run header + the
type) regardless of array length, so the per-element vtype cost
amortizes to zero.

For arrays-of-objects with shared schema (e.g., a list of user records
with the same fields), the encoder achieves additional savings via
strmap dedup of repeated keys: every record after the first emits each
key as a 1-bit strmap reference. This is one of the workloads where
weavepack-json most outperforms self-describing alternatives like
JSON, CBOR, MessagePack.

## Object key ordering

JSON does not require key-order preservation. weavepack-json preserves
the insertion order of keys as they appear in the source object,
matching `Object.keys()` and `JSON.stringify()` behavior in JavaScript.
Implementations in other languages SHOULD preserve the order they
receive at encode time. This matters for:

- Signature schemes computed over the canonical encoding
- Debugging / human-readable output of decoded payloads
- Any consumer that depends on `Object.entries()` order

Two payloads encoding objects with different key insertion orders
produce different bytes, even though the decoded JSON values are
semantically equivalent under RFC 8259's "no order required" rule.

## Container size limits

There is no hard limit on:
- Array length (encoded as a delta-pack stream; large arrays compress
  well)
- Object key count (encoded similarly)
- Nesting depth

In practice, the JS reference implementation uses recursive descent
during encode, so very deeply nested containers (≥ several thousand
levels) may exhaust the stack. This is an implementation limit, not
a protocol limit. Implementations targeting deep nesting should use
iterative encoding (worklist-based) to avoid stack exhaustion.

## Test vector references

Conformance test vectors covering container encoding live in
`profiles/json/test-vectors/containers/`. Each vector is a tuple
`(input, expected-bytes, decoded-output)`.
