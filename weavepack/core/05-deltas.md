# weavepack-core — 05: Delta Chain Semantics

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the **delta chain semantics** at the core
level: how a sequence of payloads composes to recover state, what
algebraic laws hold, and what re-anchoring means. The specific
delta operation vocabulary (replace, add, remove, splice, ...) is
profile-specific (see `profiles/<name>/04-deltas.md`).

## Chain model

A weavepack document is a sequence of N ≥ 1 payloads:

```
Document = ⟨Delta_0, Delta_1, ..., Delta_{N-1}⟩
```

where:

- `Delta_0` is the **anchor**: a complete encoding of the initial
  state, decodable on its own.
- `Delta_i` for `i > 0` is an **incremental update**: it specifies
  changes against the ARTable derived from `Delta_0..Delta_{i-1}`.

The current state at index `i` is recovered by:

```
ARTable_0 = decode(Delta_0).table()

ARTable_i = compact(ARTable_{i-1}, decode(Delta_i).table())
```

where `compact` is the core-defined operation that merges a delta's
column updates into a base table, applying additions, replacements,
and deletions per the structural metadata in the delta.

## The compact operation

`compact(base, delta)` MUST satisfy:

1. **Additions**: leaves in `delta` whose ref chain doesn't intersect
   any in `base` are appended to `base`.
2. **Replacements**: leaves in `delta` whose ref chain matches an
   existing leaf in `base` AND whose vtype is non-zero replace the
   prior leaf's value.
3. **Deletions**: leaves in `delta` whose vtype is zero AND whose
   ref chain matches an existing leaf in `base` are removed from
   `base`. If the parent kref's children become empty, the parent
   is also removed (cascading).
4. **Splices**: the splice escape in `delta`'s vtypes column MUST
   be honored: the specified array slot range is replaced/deleted
   per the splice metadata.
5. **Strmap merge**: strings introduced by `delta` are merged into
   the strmap, with renumbering as needed.
6. **Compact step**: after the merge, unreferenced strmap entries
   are removed, and indices are renumbered to be densely packed.

The exact compact algorithm is detailed in the JS reference's
`ARTable.compact()` method (`sdk/src/artable.js`); a normative
prose specification is deferred to a future revision of this doc.

## Re-anchoring

A **re-anchor** is a "delta" that is structurally a complete fresh
anchor — it replaces the entire ARTable rather than merging
incrementally. Re-anchors are emitted by profile-level encoders
when:

1. The transition from the prior state to the new state is too
   structural to express as adds/replaces/removes (e.g., changing
   the root from a primitive to a container).
2. The diff would be larger than a fresh anchor.
3. The prior state was a "non-structural" value (single primitive
   or empty container) that has no ref structure to attach updates
   to.

A re-anchor in the chain restarts the conceptual chain from that
point. Subsequent deltas refer to the re-anchored state, not the
pre-re-anchor state. The recovery algorithm starts from the
most-recent re-anchor.

**Encoder buffer policy on re-anchor: discard.** When the encoder
re-anchors, it replaces its in-memory chain with a single fresh
anchor payload. `toBuffer()` after re-anchor returns just those
bytes; prior payloads are dropped from the live encoder's view.
This is what the JS reference does, and it's the conforming
behavior.

The reason this is the conforming behavior: a single chain buffer
contains exactly one initial anchor (the first payload) followed
by zero or more deltas relative to the running state. Receivers
process payload `i+1` against the ARTable produced by payloads
`0..i`. Inserting a second standalone anchor mid-chain would
break this — the receiver has no signal to reset its ARTable, and
the second anchor would be (mis-)processed as a delta against the
first state, almost certainly producing decode errors.

Encoders MUST NOT emit a re-anchor as an additional payload in
the same chain buffer. To represent durable history across
re-anchor boundaries, the producer should snapshot `toBuffer()`
between updates and store each chain blob independently. Each
snapshot is a self-contained chain that can be decoded on its
own.

Receivers MAY assume that any chain buffer they're handed
contains exactly one initial anchor followed only by deltas. If a
payload past position 0 in the same chain is a fresh anchor
(structurally a single-payload mode payload encoding a complete
new state), the chain is malformed.

Detection of re-anchors: any payload whose first bit is `1`
(single-payload mode) is a re-anchor in the structural sense — it
encodes a stand-alone primitive or empty container. Payloads with
first bit `0` (structured mode) are incremental updates against
the running ARTable.

NOTE: an implementation may also choose to emit a structured-mode
re-anchor (e.g., a fresh-from-scratch payload with a complete tree
encoded structurally). The core spec doesn't distinguish these
from regular structured-mode deltas; the only signal is the
profile-level encoder's intent. Receivers SHOULD treat any payload
that requires the empty-state base ARTable as a re-anchor.

## Chain serialization

Chains are concatenated with LEB128 length prefixes:

```
chain        = delta-frame*
delta-frame  = leb128(len) byte_0 byte_1 ... byte_{len-1}
```

A chain of length 1 is byte-equivalent to a single delta with a
length prefix. Consumers that know they have N=1 MAY skip the
prefix; doing so is non-portable but allowed.

## Algebraic laws

These laws are **normative** for any conforming implementation.
They are tested by the property suite in
`weavepack/properties/` (Phase 4 deliverable).

### Round-trip

```
∀ json:  decode(encode(json)) ≡ json
```

For all values in the supported value space of the profile,
encode-then-decode preserves the value at profile-level equality.

Where ≡ is profile-defined equality (e.g., for JSON: deep-equality
ignoring object key order; for tensors: element-wise equality).

### Delta correctness

```
∀ a, b:  apply(delta(a, b), a) ≡ b
```

For any two values `a` and `b` in the profile's value space, the
delta produced by the differ, when applied to the prior state `a`,
produces `b`.

### Identity delta

```
∀ a:  delta(a, a) is empty
```

Encoding a no-op produces no delta payloads.

### Composition

```
∀ a, b, c:  apply(chain(delta(a, b), delta(b, c)), a) ≡ c
```

The chain of two deltas, applied in order, produces the same result
as applying the second delta to the result of the first. This is
the foundation of incremental state recovery.

NOTE: `chain(delta(a, b), delta(b, c))` is NOT necessarily byte-
equivalent to `delta(a, c)`. The chain may have more bytes than a
fresh diff because it preserves intermediate states. The protocol
guarantees state equivalence, not byte minimality, across composition.

### Replay determinism

```
∀ chain: decode(chain) ≡ replay(chain)
```

where `replay` is the explicit recovery algorithm:

```
replay(chain):
  ARTable = decode(chain[0]).table()
  for i in 1..len(chain):
    ARTable = compact(ARTable, decode(chain[i]).table())
  return build(ARTable)
```

Two implementations that conform MUST agree on the result of
`replay(chain)` for any conformance-corpus chain. Byte-level
agreement on intermediate ARTables is NOT required (Level 2);
only the final value must agree.

### Cascading delete

```
∀ leaf l in container c:
  if delete(l) leaves c empty,
  then delete(l) implies delete(c) recursively up the ref chain
```

This propagates deletions up the kref chain, removing now-empty
parent containers along with their ref structure.

### Strmap renumbering invariance

```
∀ chain, ∀ ARTable_i:
  reference_resolution(strmap_index, ARTable_i) only valid using
  the strmap at index i; not at any other index
```

Strmap indices are NOT stable across deltas. References must be
resolved within the same compaction step.

## Per-delta ARTable shape

Each `Delta_i` for `i > 0` carries an ARTable whose semantics are
"changes from base":

- `vrefs[j]`: pointer into the (extended) kref tree where leaf j
  is being inserted/updated/deleted
- `krefs[k]`: parent pointer for kref slot k (indices in the
  delta's kref space, possibly bumped by `base.krefs.length` to
  avoid collision with base krefs)
- `vtypes[j]`: the new vtype, or 0 (or a deletion escape) for
  removals
- value columns: new values (for insertions/replacements) or
  empty (for pure deletions)

The compact step matches up the delta's krefs against the base's
krefs by walking each leaf's ref chain. A delta kref whose chain
matches an existing base kref's chain refers to the same logical
position; otherwise it's a new path.

## Snapshot emission

A consumer MAY periodically emit a **snapshot** to short-circuit
chain replay. A snapshot is a fresh anchor encoded from the current
materialized state. After a snapshot:

```
new chain = ⟨snapshot, Delta_{N+1}, Delta_{N+2}, ...⟩
```

The old chain is still valid; the snapshot is an alternative entry
point that replay-compatible consumers may use. Whether to use the
snapshot or replay the original chain is a consumer choice.

Snapshots are NOT required by the core spec; profiles MAY define
when/how to emit them. For permanent storage use cases (e.g.,
weavedb), snapshots are useful for capping unbounded chain growth.

## Conformance

A Level 1 decoder MUST:
- Correctly replay any conformance-corpus chain
- Support cascading delete
- Support strmap renumbering across compact steps

A Level 2 encoder MUST:
- Produce deltas that satisfy delta-correctness
- Emit re-anchors when the diff would be larger than a fresh encode
- Preserve composition (chain of N deltas applied in order produces
  the final state)

A Level 3 encoder MUST additionally:
- Produce byte-equivalent deltas for the same input pair
- Use the same re-anchor thresholds as the JS reference
- Use the same strdiff thresholds

## Open issues

These are deferred to future revisions:

1. **Snapshot format**: should snapshots have a wire-format flag
   distinguishing them from regular anchors? Currently they're
   indistinguishable, which means consumers must track snapshot
   metadata externally.

2. **Delta merge / squash**: combining `delta(a, b)` and
   `delta(b, c)` into a single `delta(a, c)` without re-running
   the differ. This is useful for chain compaction but is not
   currently specified or implemented.

3. **Concurrent deltas**: two parallel branches of deltas applied
   to the same anchor would produce diverging chains. The protocol
   does not specify a merge semantics; that's a consumer-level
   concern (CRDT, lock-and-rebase, etc.).
