# weavepack-log — 04: Deltas

**Status:** Draft. Phase L of the weavepack v0.5 roadmap.

## Scope

This document specifies the **delta operation vocabulary** of
weavepack-log and how each op is encoded on the wire. The chain
semantics inherit from `weavepack-core/05-deltas.md`; this profile
defines the op set tailored to append-oriented event streams with
cursor semantics.

## Operation set

Five operations cover the event-stream update space:

| Op | Wire code | Purpose |
|---|---|---|
| `event_append` | 0 | Append N events to the stream |
| `field_update` | 1 | Correct field values for a specific event by seq |
| `event_expire` | 2 | Mark a seq range as logically expired (retention) |
| `schema_evolve` | 3 | Add, drop, or rename a field for future events |
| `cursor_checkpoint` | 4 | Record a named consumer cursor at a seq position |

The op code is 3 bits. Codes 5–7 are reserved for future extension.
A decoder reading op code 5, 6, or 7 MUST refuse with
`unknown_delta_op`.

## Per-op encoding

### `event_append` (code 0)

Append N new events to the stream. The new events have seq values
assigned by the encoder: strictly greater than all previously appended
seqs and strictly monotonically increasing within the op.

```
op code       : 3 bits = 000
num_events    : LEB128 uint64
seq_block     : mandatory_seq_block (delta-coded; see 02-containers.md)
ts_block      : mandatory_ts_block (delta-coded; non-decreasing)
num_user_cols : LEB128 uint32
columns       : append_col[num_user_cols]
```

Per-column append data:

```
append_col:
  col_id      : LEB128 uint32  (MUST be >= 2)
  ctype       : 5 bits
  nullable    : 1 bit
  [null_bitmap] : ceil(num_events / 8) bytes, if nullable = 1
  values      : value_column[non-null count]
```

Columns are listed in col_id order. A col_id absent from the append
data defaults to NULL for nullable columns; the op is malformed if any
non-nullable column is absent (encoder MUST include all non-nullable
user columns).

The first_seq in `seq_block` MUST be strictly greater than the highest
seq already in the stream. A decoder verifying this constraint MUST
refuse with `seq_not_monotone` on violation.

After this op, the N new events are visible in the logical stream.

### `field_update` (code 1)

Correct the value of one or more fields for a specific event identified
by seq. Used for compliance corrections (e.g., redacting a PII field)
and data-quality fixes. Only the listed columns are modified; all other
fields of the event retain their current values.

```
op code       : 3 bits = 001
seq           : LEB128 uint64  (target event)
num_cols      : LEB128 uint32
columns       : update_col[num_cols]
```

Per-column update data:

```
update_col:
  col_id      : LEB128 uint32
  ctype       : 5 bits  (MUST match declared ctype; decoder validates)
  has_value   : 1 bit   (0 = set to NULL; 1 = set to encoded value)
  [value]     : single encoded value, if has_value = 1
```

A seq that does not exist in the current logical stream MUST cause the
decoder to refuse with `unknown_seq`.

A `field_update` targeting a non-nullable column with `has_value = 0`
(set to NULL) MUST be refused with `non_nullable_null`.

**Compliance semantics**: a `field_update` that sets a `null`-type
column (ctype 15 with ext_id indicating a null sentinel) to NULL
erases the field's value from the logical view without destroying the
physical chain. This supports GDPR erasure ("right to be forgotten")
within a weavepack-log stream.

### `event_expire` (code 2)

Mark a seq range as logically expired. Expired events are retained in
the physical chain but excluded from logical stream views. Used to
implement time-based retention policies (e.g., "keep 30 days of
events") without invalidating the chain's hash ancestry.

```
op code       : 3 bits = 010
seq_lo        : LEB128 uint64  (inclusive lower bound)
seq_hi        : LEB128 uint64  (inclusive upper bound)
```

`seq_lo` MUST be ≤ `seq_hi`. A decoder reading `seq_lo > seq_hi` MUST
refuse with `invalid_seq_range`.

`event_expire` is **idempotent**: expiring an already-expired range is
a no-op. A decoder MUST accept and silently ignore a second
`event_expire` covering a range that overlaps with a previously expired
range.

Expiration is **monotone**: once expired, events cannot be un-expired.
There is no `event_unexpire` op.

A `seq_lo` or `seq_hi` that refers to a seq not present in the current
logical stream MUST cause the decoder to refuse with `unknown_seq`.
This prevents silent typos from expiring out-of-range seqs without the
encoder's knowledge.

### `schema_evolve` (code 3)

Modify the schema for events appended **after** this op. Events before
the `schema_evolve` retain their original schema. Sub-ops:

```
op code       : 3 bits = 011
sub_op        : 2 bits
  0 = column_add
  1 = column_drop
  2 = column_rename
  3 = reserved (decoder MUST refuse with unknown_schema_sub_op)
```

#### sub-op `column_add` (sub_op = 0)

Add a new field to the stream's schema. Existing events do not
retroactively gain this field; only events appended after this op
carry it.

```
col_id        : LEB128 uint32   (MUST be >= 2 and not already in schema)
ctype         : 5 bits
nullable      : 1 bit
name_len      : LEB128 uint32
name          : name_len bytes of UTF-8
```

A col_id that already exists in the current schema MUST cause the
decoder to refuse with `duplicate_col_id`. A name that already exists
in the current schema MUST cause the decoder to refuse with
`duplicate_col_name`. A zero-length name MUST be refused with
`invalid_col_name`.

#### sub-op `column_drop` (sub_op = 1)

Remove a field from the stream's schema. Events appended after this op
do not carry the field.

```
col_id        : LEB128 uint32
```

A col_id that does not exist in the current schema MUST cause the
decoder to refuse with `unknown_col_id`.

#### sub-op `column_rename` (sub_op = 2)

Rename a field. Schema-layer change only; col_id and encoding are
unchanged.

```
col_id        : LEB128 uint32
name_len      : LEB128 uint32
name          : name_len bytes of UTF-8
```

A col_id that does not exist in the current schema MUST cause the
decoder to refuse with `unknown_col_id`. A zero-length name MUST be
refused with `invalid_col_name`. The new name MUST be unique; a
collision MUST be refused with `duplicate_col_name`.

**Schema hash update**: after any `schema_evolve` op, the active
schema_hash changes to reflect the new schema. The `schema_hash` field
in the next delta frame's header MUST carry the post-evolution hash.

### `cursor_checkpoint` (code 4)

Record a named consumer cursor at a seq position. A cursor is a
(name, seq) pair that a consumer can use to resume stream processing
after a restart.

```
op code       : 3 bits = 100
seq           : LEB128 uint64  (last processed seq for this consumer)
name_len      : LEB128 uint32
name          : name_len bytes of UTF-8
```

`cursor_checkpoint` is **idempotent**: checkpointing the same (name,
seq) pair twice is a no-op. A decoder MUST accept and ignore a second
identical checkpoint without error.

A seq that does not exist in the current logical stream MUST cause the
decoder to refuse with `unknown_seq`. Checkpointing a seq that was
never appended is an encoder bug.

A zero-length name MUST be refused with `invalid_cursor_name`.

**Consumer semantics**: a consumer named "analytics-pipeline" that has
processed all events up to seq=50000 emits:
```
cursor_checkpoint(seq=50000, name="analytics-pipeline")
```
After restart, the consumer reads the stream from seq=50001 onward by
scanning forward from the last `cursor_checkpoint` with its name.
Multiple consumers may embed independent cursors in the same stream.

## Composition laws

```
(1) append(E, T) = T ∪ { e.seq → { col → value } for e in E }
    ; event_append adds new events; does not affect existing events

(2) field_update(seq, col, v, apply(field_update(seq, col, v2, T))) =
    apply(field_update(seq, col, v, T))
    ; last-write-wins for the same (seq, col) pair

(3) expire(lo, hi, expire(lo, hi, T)) = expire(lo, hi, T)
    ; event_expire is idempotent

(4) expire is monotone:
    lo1 ≤ hi1, lo2 ≤ hi2 ⟹
    expired(expire(lo2,hi2, expire(lo1,hi1,T))) ⊇ expired(expire(lo1,hi1,T))
    ; the set of expired seqs only grows

(5) cursor_checkpoint(name, seq, cursor_checkpoint(name, seq, T)) =
    cursor_checkpoint(name, seq, T)
    ; cursor_checkpoint is idempotent

(6) schema_evolve ops do not commute:
    column_add(c1, column_add(c2, T)) ≠ column_add(c2, column_add(c1, T))
    in general (column ordering in schema_set may differ)
    ; apply schema_evolve ops strictly in chain order
```

## Error codes

Decoders MUST refuse operations that violate stream invariants:

| Error | Trigger |
|---|---|
| `unknown_seq` | field_update, event_expire, or cursor_checkpoint targets a seq not in the logical stream |
| `seq_not_monotone` | event_append first_seq ≤ last known seq |
| `duplicate_seq` | seq delta = 0 (strict ascent violation) |
| `non_monotone_timestamp` | ts delta < 0 |
| `invalid_seq_range` | seq_lo > seq_hi in event_expire |
| `unknown_col_id` | column_drop or column_rename targets unknown col_id |
| `duplicate_col_id` | column_add or event_append carries a col_id already in schema |
| `duplicate_col_name` | column_add or column_rename would produce a duplicate name |
| `non_nullable_null` | NULL value for a non-nullable column |
| `invalid_col_name` | zero-length column name |
| `invalid_cursor_name` | zero-length cursor name |
| `unknown_delta_op` | op code = 5, 6, or 7 (reserved) |
| `unknown_schema_sub_op` | schema_evolve sub_op = 3 (reserved) |
| `schema_required` | name-addressed path used without active schema |
| `ctype_mismatch` | field_update carries a ctype that differs from declared type |
| `reserved_col_id` | user column with col_id < 2 |
| `unknown_ctype` | ctype value ≥ 17 |
| `unknown_level` | level value 6 or 7 |
| `invalid_level_padding` | non-zero padding bits in final level byte |
| `invalid_null_bitmap` | non-zero padding bits in final null bitmap byte |
| `unknown_ext_type` | unrecognized ext_id in extension column |
| `duplicate_stream_header` | second stream_header in same chain |
| `invalid_path_tag` | path_tag value 5, 6, or 7 (reserved) |
| `unsupported_feature` | schema_set encountered but schema multiplexing not supported |
| `value_too_large` | string or bytes LEB128 byte count > 256 MiB |
| `frame_too_large` | total encoded byte count > 2 GiB |
| `batch_too_large` | num_events > 2^32 − 1 |
