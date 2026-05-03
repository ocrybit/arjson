# weavepack-json — 04: Delta Operations

**Status:** Draft. Retroactive spec of arjson v0.1.x as of 2026-05-03.

## Scope

This document specifies how the JSON profile of weavepack encodes
incremental updates ("deltas") to a previously-encoded JSON document,
and how a chain of deltas composes to produce the current state.

The delta system is the core differentiator of weavepack vs.
self-describing alternatives like CBOR/JSON. A weavepack-json document
is naturally a **chain of payloads**: the first payload encodes the
initial JSON value, and each subsequent payload encodes one logical
update operation against the running state.

## Delta chain model

A weavepack-json document is a sequence of N ≥ 1 byte arrays
(`Delta_0, Delta_1, ..., Delta_{N-1}`). The initial state is recovered
by decoding `Delta_0` to obtain `JSON_0`; each subsequent state is
recovered by applying `Delta_i` to the running ARTable derived from
`Delta_0, ..., Delta_{i-1}`:

```
ARTable_0 = decode(Delta_0).table()
JSON_0    = build(ARTable_0)

ARTable_i = compact(ARTable_{i-1}, decode(Delta_i).table())
JSON_i    = build(ARTable_i)
```

**Append-only at the wire level.** Once a chain payload is serialized
out (i.e. its bytes have left the encoder), those bytes are immutable
— no consumer ever rewrites previously-emitted payload bytes. This
matches the permanent-storage use case where each update is a separate
transaction on an immutable ledger.

**Not append-only at the in-memory level.** A live encoder instance
(e.g. `ARJSON` in JS) may **re-anchor** in response to certain
updates (see Re-anchor section below), which replaces its in-memory
`deltas` array with a single fresh anchor and discards prior
payloads from its own view. Consumers that need durable history
across re-anchor boundaries must snapshot `toBuffer()` to external
storage between updates. The protocol's append-only guarantee
applies to bytes already emitted, not to the encoder's internal
buffer state.

### Chain serialization

Multiple deltas are concatenated into a single buffer with LEB128
length prefixes (lowest-order byte first; MSB continuation):

```
chain    = delta-frame*
delta-frame = leb128(len) byte_0 byte_1 ... byte_{len-1}
```

The functions that produce/consume this framing are
`ARJSON.toBuffer(deltas)` and `ARJSON.fromBuffer(buffer)`.

A chain of length 1 is byte-equivalent to a single delta with a leb128
length prefix. A consumer that knows it has a single payload (no
chain) can skip the prefix and decode directly.

## Logical operation types

The differ produces one of five logical operations per change. These
are not opcodes in the wire format — the wire format is structural —
but they are the semantic categories the differ uses to decide what
to emit.

| op | description | encoder behavior |
|---|---|---|
| `replace` | Change the value at an existing path | emit kref chain to path, vref + new value, push=1 |
| `add` | Add a new key or array slot at a path that didn't exist | emit kref chain to new path, vref + value, push=0 |
| `remove` | Delete a key or array slot | emit kref chain to path, vtype-0 standalone-delete escape |
| `diff` | String fast-diff (subcase of replace for big strings) | emit vtype-2 with vals-len=0, strdiff selector, patch in strdiffs column |
| `splice` | Array splice at index (insert/replace/delete N at position k) | emit vtype-0 escape with type2=1 carrying (index, remove_count, insert_type) |

Some compound updates may decompose into multiple delta payloads.
For example, a top-level reanchor (e.g., changing the root from a
primitive to an object) produces a fresh `Delta_0`-style payload that
restarts the chain.

## Wire encoding by operation

### `replace` operation

The encoder emits a delta payload in structured mode (bit 0 = `0`)
with a kref chain that resolves to the existing path, plus a new
value with `push = 1`. The compact step on the receiving side detects
that an existing kref slot is being overwritten and replaces the
prior value.

Path resolution against the prior ARTable: the encoder must locate
the kref index for the target path before encoding. For an existing
path, the kref already exists; the encoder uses its index. For a
brand-new path step (the last component), the encoder emits a fresh
kref slot.

For `replace` of a primitive at an existing key, only the leaf vref
+ value column entry changes; all enclosing krefs are reused.

### `add` operation

Same as `replace` but with `push = 0`. The compact step appends the
new entry instead of overwriting. Used when:

- A new property is added to an object that already has other
  properties
- A new element is appended to an array

For top-level additions to an empty document or for additions that
change the document shape (primitive → container), the encoder emits
a re-anchor (full new initial payload) instead of an `add`.

### `remove` operation

The encoder emits a kref chain to the target path. At the leaf, the
`vtypes` column carries the **standalone-delete escape**:

```
vtype-prefix : 3 bits = 000  (escape marker)
count        : short() = 0   (signals individual escape, not run)
type2        : 1 bit  = 0    (signals standalone delete)
```

The compact step propagates the deletion. If the deleted leaf is the
last child of an enclosing container, the deletion cascades up the
kref chain (the parent kref is dropped along with its now-empty
container).

### `diff` operation

A sub-case of `replace` for string values. The encoder emits:

- vtype = 2 (string-base64url; reused for diff signal)
- vals: `short(0)` then 1-bit selector = `1` (strdiff flag)
- strdiffs column: byte-aligned fast-diff patch payload

The fast-diff patch format (in `strdiffs`):

```
patch        = total-bits-leb128 op-count op[op-count]
total-bits   = leb128(byte-count * 8)
op-count     = uint8 (max 255 ops per patch)
op           = flags pos payload

flags        = (op-type << 7) | (has-ref << 6)
op-type      = 0 (delete) | 1 (insert)
has-ref      = 1 if insert references strmap entry, else 0

pos          = leb128(absolute-position-in-original)

payload (for delete):
  len        = leb128(deleted-length)

payload (for insert with has-ref=1):
  ref        = leb128(strmap-index)

payload (for insert with has-ref=0):
  len        = leb128(insert-length)
  bytes      = byte[len] (UTF-16 code units low-byte; high byte
                          assumed zero — patches are limited to BMP
                          characters with code unit < 256)
```

The `total-bits-leb128` prefix at the start tells the decoder how
many bits to consume for the entire patch, allowing it to skip ahead
without parsing the patch contents.

The encoder emits a diff only when the prior and new strings both
have length ≥ 20 AND the patch size is < 60% of the new string
length. Below this threshold, full replacement is smaller. Above it,
the patch wins.

### `splice` operation

Array splice is encoded with the **splice escape** in the vtypes column:

```
vtype-prefix : 3 bits = 000  (escape marker)
count        : short() = 0   (signals individual escape)
type2        : 1 bit  = 1    (signals splice/splice-delete)
index        : short()       (array position)
remove       : short()       (number of elements to remove)
type3        : 3 bits        (vtype of inserted element, or 0 for splice-delete)
```

If `type3 = 0`, the splice is a **splice-delete**: `remove` elements
at `index` are deleted with no insertion.

If `type3 != 0`, the splice inserts a new element of that vtype after
deleting `remove` existing elements. The inserted element's payload
follows in the appropriate column based on `type3`.

The differ produces splices for arrays of primitives where elements
have shifted (e.g., an insert at the head of a 1000-element array is
a single splice, not 1000 replaces). For arrays of objects, the
differ falls back to whole-array replace (`reanchor`) — partial
splices of nested objects within an array are too brittle.

## Re-anchor

A re-anchor is a special "delta" that is structurally a complete
fresh initial payload. The receiver replaces its entire ARTable with
the new one rather than applying a structural compact.

Re-anchors are emitted when:

1. The document transitions between a "non-structural" value
   (primitive, `null`, empty `[]`/`{}`) and a structural value, OR
   between two non-structural values that aren't equal. Non-structural
   states use single-payload mode and have no kref chain to attach
   updates to.

2. A `replace` operation targets the root path (`""`).

3. A `replace` operation replaces a primitive with an object or array
   value (the new subtree is too large to be efficiently expressed
   as add/replace/splice ops).

4. An empty-object → non-empty-object transition that would otherwise
   require synthesizing kref slots.

After a re-anchor, the chain restarts: the new fresh-anchor
payload becomes the entire `deltas` buffer. Prior payloads in
the in-memory chain are **discarded**, and `toBuffer()` after
re-anchor returns just the fresh single-payload bytes.

Discarding is required by the protocol (see core/05-deltas.md
"Encoder buffer policy on re-anchor"). A chain buffer must
contain exactly one initial anchor followed by deltas; multiple
standalone anchors in one buffer is malformed because receivers
have no signal to reset their ARTable mid-chain.

Consumers that need *durable* version history across re-anchor
boundaries should snapshot `arj.toBuffer()` at known-good points
before triggering re-anchor (e.g. after each `update()` whose
return value is `[fresh-anchor]`). The chain framing is then a
sequence of independent chain blobs, each restartable.

Verified by sdk regression tests and the property test
"any chain prefix is a valid parseable chain" in
`weavepack/properties/delta-correctness.test.js`.

## Compose / apply / chain laws

These algebraic properties are normative for any conforming
implementation. They are tested by the property suite in
`weavepack/properties/`.

### Round-trip

```
∀ json:  decode(encode(json))  ≡_JSON  json
```

For all JSON values in the supported value space (`01-types.md`),
the round-trip preserves the value at JSON-equality.

### Delta correctness

```
∀ a, b:  apply(delta(a, b), a)  ≡_JSON  b
```

For any two JSON values `a` and `b`, the delta produced by the differ,
when applied to the prior state `a`, produces `b`.

### Identity delta

```
∀ a:  delta(a, a) ≡ []   (empty delta list)
```

Encoding a no-op produces no delta payloads.

### Composition

```
∀ a, b, c:  apply(chain(delta(a, b), delta(b, c)), a)  ≡_JSON  c
```

The chain of two deltas, applied in order, produces the same result
as applying the second delta to the result of the first. This is the
foundation of incremental state recovery.

Note: `delta(a, b) ++ delta(b, c)` is NOT necessarily byte-equivalent
to `delta(a, c)`. The chain may have more bytes than a fresh diff
because it preserves intermediate states. The protocol guarantees
state equivalence, not byte minimality, across composition.

### Idempotence (replace)

```
∀ a, b:  apply(delta(a, b), apply(delta(a, b), a))  ≡_JSON  b
```

Applying the same replace delta twice (somehow — chains don't normally
allow this, but reasoners benefit from this property) produces the
same final state as applying it once. This holds for `replace`,
`remove`, and `add` ops; it does NOT hold for `splice` (splices are
position-sensitive).

## Strmap evolution across a chain

When a delta is applied, the receiving ARTable's strmap may grow:
new strings introduced by the delta are added to the strmap with
fresh indices. Strings that become unreferenced (e.g., after a
remove) are pruned during `compactStrMap()`.

The strmap indices themselves are NOT preserved across deltas. After
each compact, the strmap is renumbered to be densely packed starting
from 0. This means a strmap reference in `Delta_5` cannot be
interpreted in isolation — it must be resolved against the
post-compact ARTable from `Delta_0..Delta_4`.

This has an important consequence: **deltas are not independent**.
You cannot decode `Delta_5` alone and get the JSON value at position
5. You must replay the chain from the beginning. This is the cost
of the strmap-dedup design; it's the core reason the format is
small but state-recovery-non-random-access.

(See the `02-containers.md` discussion of fast-access caching: weavedb
caches the materialized ARTable in KV to avoid re-replaying chains.
This is a consumer-level optimization layered over the protocol.)

## String diff edge cases

The fast-diff encoding has these edge cases:

1. **Empty original or empty new**: the differ skips fast-diff entirely
   and emits a full replace. Diffs over empty strings have no benefit.

2. **Patches with > 255 ops**: the patch byte is `uint8`, so patches
   with more than 255 ops are not representable. The differ must fall
   back to full replace; the threshold is checked before emitting.

3. **Code units ≥ 256**: the insert payload uses 1 byte per character.
   Strings containing code units ≥ 256 (e.g., emoji, CJK) cannot be
   patched via this format. The differ falls back to full replace
   when any non-ASCII character is in the insert range. This is a
   limitation of the current fast-diff format that should be lifted
   in a future revision (it is not a fundamental constraint of the
   diff algorithm).

4. **Strmap dedup of insert text**: if the inserted text matches an
   existing strmap entry, the patch references the strmap by index
   instead of inlining the bytes. This trims patch size for repeated
   substrings.

## Known limitations

These are the gaps to address in v2 of the format:

1. **No move/copy ops**: the differ does not detect moves or copies
   across the tree. A move from `a.b` to `c.d` is encoded as
   `remove(a.b) + add(c.d, ...)`. This is sub-optimal for renames
   and tree shuffles but was rejected as a feature for v1 (see the
   "no conformance theater" design principle in the roadmap).

2. **Splice-only on primitive arrays**: splices for arrays of objects
   require the differ to fall back to whole-array replace. Per-element
   diffs of nested objects within an array are not produced.

3. **No range delete**: deleting a range of object keys is encoded
   as one remove op per key. Bulk-delete primitives don't exist
   (object keys have no positional ordering, so no equivalent to
   array splice exists for objects).

4. **Strdiff limited to ASCII inserts**: as noted above.

5. **No partial-decode**: applying delta `i` requires the ARTable
   from delta `i-1`. Random-access into a chain requires either
   replaying from start or caching ARTables externally.

## Test vector references

Conformance test vectors covering each delta operation type live in
`profiles/json/test-vectors/deltas/`. Each vector is a tuple
`(initial-json, update-json, expected-delta-bytes, expected-final-json)`
plus chain-composition vectors for multi-delta sequences.
