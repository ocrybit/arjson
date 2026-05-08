# weavepack-wire — 04: Deltas

**Status:** Draft. Phase W of the weavepack v0.3 roadmap.

## Scope

This document specifies the **delta operation vocabulary** of
weavepack-wire and how each op is encoded on the wire. The chain
semantics inherit from `weavepack-core/05-deltas.md`; this profile
defines the op set tailored to message / repeated / map / oneof data.

## Operation set

Eight operations cover the message update space:

| Op | Wire code | Purpose |
|---|---|---|
| `field_set` | 0 | Set (or replace) a single scalar or sub-message field |
| `field_delete` | 1 | Remove an optional field (sets it to absent/default) |
| `message_replace` | 2 | Replace an entire sub-message at a path |
| `repeated_append` | 3 | Append N elements to a repeated field |
| `repeated_splice` | 4 | Delete and/or insert at a position in a repeated field |
| `map_set` | 5 | Set or replace a map entry |
| `map_delete` | 6 | Remove a map entry |
| `oneof_switch` | 7 | Change the active oneof case |

The op code is 3 bits. All 8 codes are assigned; no codes are reserved
in this version. Future ops MUST be introduced via the extension gate.

## Per-op encoding

### `field_set` (code 0)

Set or replace a single field at a given path:

```
op code    : 3 bits = 000
path       : encoded per 03-paths.md
value      : encoded per the field's declared type
```

The field at `path` MAY or MAY NOT be present in the base document.
If present, the value is replaced. If absent, the field is added with
the new value. The behavior is **upsert** (set regardless of prior
state).

`field_set` on a sub-message field replaces the sub-message entirely.
To change individual sub-message fields, use a path that descends into
the sub-message.

### `field_delete` (code 1)

Remove an optional field from the message:

```
op code    : 3 bits = 001
path       : encoded per 03-paths.md
```

After this op, the field is absent (consumers see the default value).
Deleting a required field MUST cause refusal (`cannot_delete_required`).
Deleting an already-absent field is a no-op (idempotent).

### `message_replace` (code 2)

Replace an entire sub-message (or root message) with a new one:

```
op code        : 3 bits = 010
path           : encoded per 03-paths.md (may be empty for root)
message bytes  : full message encoding for the replacement
```

After this op, the target sub-message is entirely replaced. Fields in
the base sub-message that are not in the replacement are absent. Fields
in the replacement that were not in the base are added.

`message_replace` with an empty path replaces the root message — this
is equivalent to a new snapshot for the affected clients.

### `repeated_append` (code 3)

Append one or more elements to the end of a repeated field:

```
op code        : 3 bits = 011
path           : path to the repeated field (no index component)
element count  : LEB128
elements       : count × (element encoding per declared type)
```

After this op, `new_length = base_length + element_count`. The appended
elements occupy indices `[base_length, base_length + element_count)`.

`repeated_append` with element_count = 0 is valid (no-op).

### `repeated_splice` (code 4)

Delete and/or insert elements at a specific position:

```
op code        : 3 bits = 100
path           : path to the repeated field (no index component)
start          : LEB128 — starting index
delete_count   : LEB128 — number of elements to delete from start
insert_count   : LEB128 — number of elements to insert at start
elements       : insert_count × (element encoding per declared type)
```

Execution order:
1. Delete `delete_count` elements at index `start`.
2. Insert `insert_count` elements at index `start` (before the element
   that was at `start + delete_count`).

Invariant: `start + delete_count <= base_length`. Out-of-range MUST
cause refusal (`repeated_index_out_of_range`).

To delete only: insert_count = 0 (no element payload).
To insert only: delete_count = 0.
To replace an element: delete_count = 1, insert_count = 1.

### `map_set` (code 5)

Set or replace a map entry:

```
op code    : 3 bits = 101
path       : path including the map field and key (see 03-paths.md)
value      : encoded per declared map value type
```

If the key already exists in the map, its value is replaced. If the
key is new, a new entry is added. Upsert semantics (same as `field_set`).

### `map_delete` (code 6)

Remove a map entry:

```
op code    : 3 bits = 110
path       : path including the map field and key
```

If the key does not exist, this is a no-op (idempotent). The map
field itself remains present (as an empty map, if this was the last
entry). The field is omitted from subsequent payloads only if the
encoder explicitly uses `field_delete` on the map field.

### `oneof_switch` (code 7)

Change the active case in a oneof group:

```
op code          : 3 bits = 111
path             : path to the oneof field
new case number  : LEB128 — field number of the new active case
new value        : encoded per the selected case's declared type
```

After this op, the case identified by `new_case_number` becomes the
active case, carrying `new_value`. Any previously active case is
deactivated (its value is discarded).

Setting `new_case_number = 0` deactivates the oneof without activating
a new case (the oneof is in the "not set" state).

## Algebraic laws

Inherited from weavepack-core. Specific to wire profile:

### Last-write-wins for scalar fields

```
apply(field_set(p, v2), apply(field_set(p, v1), m)) = apply(field_set(p, v2), m)
```

Two consecutive `field_set` ops on the same path compose to the later
one. The earlier is dropped.

### Delete after set

```
apply(field_delete(p), apply(field_set(p, v), m)) = m[without p]
```

A `field_delete` after a `field_set` on the same path produces the
absent state, regardless of `v`.

### Set after delete

```
apply(field_set(p, v), apply(field_delete(p), m)) = m[with p = v]
```

A `field_set` after a `field_delete` on the same path produces the
present state with value `v`.

### Repeated append composition

```
apply(repeated_append(p, elems2), apply(repeated_append(p, elems1), m))
=
apply(repeated_append(p, elems1 ++ elems2), m)
```

Two consecutive appends on the same path compose to a single append
with the concatenated element list.

### Map entry last-write-wins

```
apply(map_set(p, k, v2), apply(map_set(p, k, v1), m)) = apply(map_set(p, k, v2), m)
```

Same as field_set: the later write wins for the same map key.

### oneof switch idempotence

```
apply(oneof_switch(p, c, v), apply(oneof_switch(p, c, v), m)) = apply(oneof_switch(p, c, v), m)
```

Switching to the same case with the same value twice is equivalent to
doing it once.

### Identity delta

```
∀ message m:  diff(m, m)  is empty  (0 ops)
```

### Round-trip invariant

```
∀ m:  decode(encode(m))  ==  m
∀ m1, m2:  apply(delta(m1, m2), m1)  ==  m2  (bit-exact)
```

## Delta heuristics

The differ produces ops by comparing two message snapshots:

```
for each field_number in (base.fields ∪ new.fields):
  if number in new but not base:
    emit field_set(path, new_value)
  if number in base but not new:
    if required: ERROR (required field cannot be absent in new)
    emit field_delete(path)
  if number in both and values differ:
    if field is scalar: emit field_set(path, new_value)
    if field is sub-message:
      sub_delta = diff(base[number], new[number])
      if sub_delta is large relative to message_replace:
        emit message_replace(path, new_value)
      else:
        emit each sub_delta op with path prepended
    if field is repeated:
      diff_repeated(path, base[number], new[number])
    if field is map:
      diff_map(path, base[number], new[number])
    if field is oneof:
      if active case changed: emit oneof_switch(path, new_case, new_value)
      else: emit field_set(path.case_field, new_value)
```

### Repeated field diff heuristic

```
diff_repeated(path, base_seq, new_seq):
  if new_seq is an extension of base_seq:
    emit repeated_append(path, new_seq[len(base_seq):])
  elif edit distance is cheap:
    emit repeated_splice ops for each edit
  else:
    emit message_replace(path, full new sequence encoding)
```

"Cheap" is implementation-defined but the default threshold is: if
the total splice op bytes are less than 50% of the full sequence
encoding bytes, prefer splicing.

### Map diff heuristic

```
diff_map(path, base_map, new_map):
  for k in base_map but not new_map: emit map_delete(path{k})
  for k in new_map:
    if base_map[k] != new_map[k]: emit map_set(path{k}, new_map[k])
```

(Added keys are map_set; deleted keys are map_delete; unchanged keys
produce no ops.)

## Error classes

Errors that MUST cause decoder refusal during delta application:

| Error class | Trigger |
|---|---|
| `field_not_found` | path field_number not in schema or prior payload |
| `cannot_delete_required` | field_delete on a required field |
| `repeated_index_out_of_range` | splice start > length, or append with negative count |
| `map_key_type_mismatch` | key type in path doesn't match field's declared key type |
| `unknown_oneof_case` | oneof_switch case number not declared in schema |
| `nesting_depth_exceeded` | path descends more than 64 levels |
| `unknown_op_code` | 3-bit op code not in {0..7} (impossible in v0.1, extension hook) |

## Re-anchoring

A weavepack-wire chain re-anchors when:

1. The base message was empty (the first payload is the anchor).
2. A schema change occurs (new required fields, field type changes).
3. The accumulated delta chain size exceeds 50% of a fresh snapshot
   (the encoder periodically emits a snapshot to cap chain growth).

The snapshot resets the chain; subsequent deltas are against the
snapshot. The core spec's re-anchor semantics apply (the receiver
discards prior chain state and treats the snapshot as the new base).

## Compression via column compaction

The bit-pack column layout already removes per-field type tags for
schemaful payloads. Additional compaction opportunities:

- **Bool fields**: 1 bit each; a message with 64 bool fields fits in
  8 bytes of bool column storage.
- **Repeated fixed-width scalars**: contiguous bit runs, no inter-
  element overhead.
- **Empty optional fields**: zero bits (omitted from field-number column).

These are structural properties, not compression heuristics. The wire
format naturally represents sparse updates as small payloads.

## Conformance

A Level 1 decoder MUST handle all 8 op codes.

A Level 2 encoder MUST produce decodable deltas satisfying the
round-trip and delta-correctness invariants.

A Level 3 encoder MUST byte-match the reference for the same
(base, new) pair + heuristic thresholds.

## Test vector references

Delta operation test vectors live at
`weavepack/profiles/wire/test-vectors/deltas/`:

- `field_ops.json` — field_set, field_delete, message_replace
- `repeated_ops.json` — repeated_append, repeated_splice
- `map_ops.json` — map_set, map_delete
- `oneof_ops.json` — oneof_switch

(Populated in Stage W.3.)
