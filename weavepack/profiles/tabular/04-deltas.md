# weavepack-tabular — 04: Deltas

**Status:** Draft. Phase T of the weavepack v0.4 roadmap.

## Scope

This document specifies the **delta operation vocabulary** of
weavepack-tabular and how each op is encoded on the wire. The chain
semantics inherit from `weavepack-core/05-deltas.md`; this profile
defines the op set tailored to row/column tabular data.

## Operation set

Seven operations cover the tabular update space:

| Op | Wire code | Purpose |
|---|---|---|
| `row_insert` | 0 | Insert N new rows with values for all columns |
| `row_update` | 1 | Update specific column values for given row_ids |
| `row_delete` | 2 | Remove rows by row_id |
| `column_add` | 3 | Add a new column (existing rows get NULL or default) |
| `column_drop` | 4 | Remove a column by col_id |
| `column_rename` | 5 | Rename a column (schema-layer change) |
| `batch_upsert` | 6 | Insert-or-update by row_id (CDC use case) |

The op code is 3 bits. Code 7 is reserved for future extension.
A decoder reading op code 7 MUST refuse with `unknown_delta_op`.

## Per-op encoding

### `row_insert` (code 0)

Insert N new rows into the table. The new rows have row_ids assigned
by the encoder (monotonically increasing, strictly greater than all
existing row_ids).

```
op code     : 3 bits = 000
num_rows    : LEB128 uint64
row_ids     : row_id_block (delta-coded; see 02-containers.md §Row ID encoding)
columns     : insert_col[num_cols_in_frame]
```

Per-column insertion data:

```
insert_col:
  col_id    : LEB128 uint32
  nullable  : 1 bit
  [null_bitmap] : ceil(num_rows / 8) bytes, if nullable = 1
  values    : value_column[non-null count] (encoded per ctype)
```

Columns are listed in col_id order. A col_id absent from the insertion
data defaults to NULL for nullable columns; the op is malformed if any
non-nullable column is absent.

After this op, the new rows are visible with the inserted values.

### `row_update` (code 1)

Update the values of specific cells for one or more existing row_ids.
Only the columns listed in the op are modified; all other columns
retain their current values.

```
op code     : 3 bits = 001
num_rows    : LEB128 uint64
row_ids     : row_id_block (delta-coded; strictly ascending)
num_cols    : LEB128 uint32
columns     : update_col[num_cols]
```

Per-column update data:

```
update_col:
  col_id    : LEB128 uint32
  ctype     : 4 bits (MUST match declared ctype; decoder validates)
  nullable  : 1 bit
  [null_bitmap] : ceil(num_rows / 8) bytes, if nullable = 1
  values    : value_column[non-null count]
```

A row_id in the op that does not exist in the current logical state
MUST cause the decoder to refuse with `unknown_row_id`. Encoders MUST
only reference row_ids that are present.

### `row_delete` (code 2)

Remove rows from the table. The row_ids are removed from the logical
state permanently; they will never be reused.

```
op code     : 3 bits = 010
num_rows    : LEB128 uint64
row_ids     : row_id_block (delta-coded; strictly ascending)
```

A row_id that does not exist in the current logical state MUST cause
the decoder to refuse with `unknown_row_id`.

After this op, any reference to the deleted row_ids is invalid.

### `column_add` (code 3)

Add a new column to the table. Existing rows receive NULL for the new
column if `nullable = 1`; if `nullable = 0` and no default is supplied,
the op is malformed.

```
op code     : 3 bits = 011
col_id      : LEB128 uint32
ctype       : 4 bits
nullable    : 1 bit
has_default : 1 bit
[default_value] : ctype-encoded single value, if has_default = 1
```

A col_id that already exists in the current logical state MUST cause
the decoder to refuse with `duplicate_col_id`.

If `has_default = 1`, all existing rows receive the default value for
this column. If `has_default = 0` and `nullable = 1`, all existing rows
receive NULL for this column. If `has_default = 0` and `nullable = 0`,
the op is malformed: a non-nullable column without a default cannot be
added to a non-empty table.

After this op, the new column is visible in all subsequent frames.

### `column_drop` (code 4)

Remove a column from the table. The column's data is discarded.

```
op code     : 3 bits = 100
col_id      : LEB128 uint32
```

A col_id that does not exist in the current logical state MUST cause
the decoder to refuse with `unknown_col_id`.

After this op, any reference to the dropped col_id is invalid.

### `column_rename` (code 5)

Rename a column. This is a schema-layer change only — it modifies the
schema sidecar but does not alter any cell values or the col_id.

```
op code     : 3 bits = 101
col_id      : LEB128 uint32
name_len    : LEB128 uint32
name        : name_len bytes of UTF-8
```

A col_id that does not exist in the current logical state MUST cause
the decoder to refuse with `unknown_col_id`. A zero-length name MUST
be refused with `invalid_col_name`.

The new name MUST be unique among all column names in the current
schema. Decoders MUST refuse with `duplicate_col_name` if the target
name already belongs to another column.

Note: `column_rename` updates the active schema. The schema_hash in
the next delta frame MUST reflect the post-rename schema.

### `batch_upsert` (code 6)

Insert-or-update rows by row_id. For each row_id in the op:

- If the row_id exists in the current logical state: update the
  specified columns (same semantics as `row_update`).
- If the row_id does not exist: insert a new row with the given values
  (same semantics as `row_insert`).

```
op code     : 3 bits = 110
num_rows    : LEB128 uint64
row_ids     : row_id_block (delta-coded; strictly ascending)
num_cols    : LEB128 uint32
columns     : upsert_col[num_cols]
```

Per-column upsert data (same structure as `update_col`):

```
upsert_col:
  col_id    : LEB128 uint32
  ctype     : 4 bits
  nullable  : 1 bit
  [null_bitmap] : ceil(num_rows / 8) bytes, if nullable = 1
  values    : value_column[non-null count]
```

`batch_upsert` is the natural CDC operation: a replication consumer
receives row change events keyed by primary key, not by weavepack
row_id. The CDC consumer maps primary key → row_id and emits
`batch_upsert` ops; the weavepack decoder handles the insert-vs-update
routing.

`batch_upsert` is **idempotent** when applied multiple times with the
same row_ids and values:
```
apply(batch_upsert(R, V), apply(batch_upsert(R, V), T)) =
apply(batch_upsert(R, V), T)
```

## Composition laws

These are the core algebraic invariants that decoders must preserve:

```
(1) apply(row_insert(R, V), T) = T ∪ { r → V(r) for r in R }
    ; insert adds new rows; does not affect existing rows

(2) apply(row_delete(R), T) = T \ { r → _ for r in R }
    ; delete removes rows; does not affect other rows

(3) apply(row_update(R, C, V), apply(row_update(R, C, V2), T)) =
    apply(row_update(R, C, V), T)
    ; last-write-wins for the same row_id and col_id

(4) apply(row_insert(R, V), apply(row_delete(R), T)) =
    apply(row_insert(R, V), T)
    ; insert after delete = insert (row_id is reused)
    ; NOTE: row_ids are normally never reused; this case can only
    ; arise in manually-constructed chains. Conforming encoders MUST
    ; NOT reuse row_ids.

(5) apply(column_add(c), apply(column_drop(c, _), T)) =
    apply(column_add(c), T)
    ; add after drop = add (col_id treated as new)

(6) apply(batch_upsert(R, V), apply(batch_upsert(R, V), T)) =
    apply(batch_upsert(R, V), T)
    ; batch_upsert is idempotent
```

## Error codes

Decoders MUST refuse operations that violate table invariants and
return one of these error codes:

| Error | Trigger |
|---|---|
| `unknown_row_id` | row_update or row_delete references a non-existent row_id |
| `unknown_col_id` | column_drop or column_rename references a non-existent col_id |
| `duplicate_col_id` | column_add or row_insert carries a col_id already in scope |
| `duplicate_row_id` | row_insert carries a row_id already in scope |
| `duplicate_col_name` | column_rename would produce a duplicate column name |
| `non_nullable_null` | NULL value for a non-nullable column |
| `invalid_col_name` | zero-length column name in column_rename |
| `unknown_delta_op` | op code = 7 (reserved) |
| `schema_required` | name-addressed path used without active schema |
| `ctype_mismatch` | row_update carries a ctype that differs from declared type |
