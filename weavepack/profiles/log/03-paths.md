# weavepack-log — 03: Paths

**Status:** Draft. Phase L of the weavepack v0.5 roadmap.

## Scope

This document specifies the **path grammar** of weavepack-log. Paths
identify events, fields, or individual cells for delta operations.
The log path grammar differs from weavepack-tabular in two ways:

1. Events are addressed by **seq** (monotone sequence number), not by
   `row_id`. Seq is a protocol-level concept available without a schema.

2. The mandatory columns `seq` (col_id 0) and `ts` (col_id 1) have
   reserved aliases (`@seq`, `@ts`) that are valid in schemaless mode.

## Grammar

```
path        = col-path
            | event-path
            | cell-path
            | seq-range
            | "" (empty path = the whole stream)

col-path    = "[" col-id "]"
            | "." col-name
            | "@seq"
            | "@ts"

event-path  = "#" seq-num

cell-path   = "#" seq-num "[" col-id "]"
            | "#" seq-num "." col-name

seq-range   = "seq:" "[" seq-lo "," seq-hi "]"

col-id      = digit+           ; uint32 column identifier (always works)
col-name    = identifier       ; schema-declared name (requires schema)
seq-num     = digit+           ; uint64 event sequence number
seq-lo      = digit+           ; uint64 inclusive lower bound
seq-hi      = digit+           ; uint64 inclusive upper bound
identifier  = [A-Za-z_][A-Za-z0-9_]*
digit       = [0-9]
```

## Semantics

### Column path `[col_id]` / `.col_name` / `@seq` / `@ts`

Refers to a column across all events. Used by `schema_evolve`
sub-ops (`column_add`, `column_drop`, `column_rename`).

- `[col_id]` — identifies the column whose `col_id` matches. Valid
  in schemaless and schema-addressed mode.
- `.col_name` — identifies the column by schema-declared name.
  A decoder MUST refuse with `schema_required` when no schema is
  active.
- `@seq` — alias for the mandatory seq column (col_id 0). Always
  valid; no schema required.
- `@ts` — alias for the mandatory ts column (col_id 1). Always
  valid; no schema required.

Column paths are not valid in `event_append`, `field_update`,
`event_expire`, or `cursor_checkpoint` operations.

### Event path `#seq`

Refers to a specific event by its sequence number. Used in
`field_update` and `event_expire` to identify which event(s) to target.

A seq value that does not exist in the current logical stream MUST
cause the decoder to refuse with `unknown_seq`.

### Cell path `#seq[col_id]` / `#seq.col_name`

Refers to a specific cell — the intersection of one event and one
column. Used in `field_update` to address individual fields.

- `#42[3]` — cell at seq=42, col_id=3
- `#42.duration_ms` — cell at seq=42, column named "duration_ms"
  (schema required)

### Seq range `seq:[lo,hi]`

An inclusive range of seq values. Used in `event_expire` to mark a
contiguous window of events as expired.

`lo` MUST be ≤ `hi`. A decoder reading a range where lo > hi MUST
refuse with `invalid_seq_range`.

Both `lo` and `hi` MUST refer to seqs that exist in the current
logical stream (not just any uint64). A decoder reading a seq_range
that extends beyond known seqs MUST refuse with `unknown_seq`. (This
is intentional: expiring events that were never appended is an encoder
bug, not a valid no-op.)

## On-wire encoding

Paths are encoded in binary within delta ops (see 04-deltas.md). The
on-wire form uses type-tagged components, not the string grammar above.
The string grammar is the human-readable canonical form used in test
vectors and error messages.

```
path_tag    : 3 bits
              0 = whole-stream (empty path)
              1 = col-path
              2 = event-path
              3 = cell-path
              4 = seq-range
              5–7 = reserved (decoder MUST refuse with invalid_path_tag)

col-path:
  addr_mode : 2 bits
              0 = by col_id
              1 = by col_name
              2 = @seq alias (no further bytes)
              3 = @ts alias (no further bytes)
  col_id    : LEB128 uint32           (if addr_mode = 0)
  col_name  : LEB128 byte-count + UTF-8   (if addr_mode = 1)

event-path:
  seq       : LEB128 uint64

cell-path:
  seq       : LEB128 uint64
  addr_mode : 1 bit   0 = by col_id, 1 = by col_name
  col_id    : LEB128 uint32           (if addr_mode = 0)
  col_name  : LEB128 byte-count + UTF-8   (if addr_mode = 1)

seq-range:
  seq_lo    : LEB128 uint64
  seq_hi    : LEB128 uint64
```

## Examples

| Path | Refers to |
|---|---|
| `""` | The whole stream (used in snapshot replacement) |
| `@seq` | The mandatory seq column (col_id 0) |
| `@ts` | The mandatory ts column (col_id 1) |
| `[2]` | User column with col_id=2 |
| `.request_id` | Column named "request_id" (schema required) |
| `#1000` | Event with seq=1000 |
| `#1000[3]` | Cell: seq=1000, col_id=3 |
| `#1000.level` | Cell: seq=1000, column "level" (schema required) |
| `seq:[0,999]` | Events with seq 0 through 999 inclusive |

## Addressing by col_id vs. col_name

Column IDs are the canonical on-wire identity. Column names are
schema-layer aliases.

- **Schemaless mode**: name-addressed paths are forbidden. Only col_id
  paths, @seq/@ts aliases, and seq-numbered paths are valid. A decoder
  MUST refuse with `schema_required` on any name-addressed path when no
  schema is active.

- **Schema mode**: either form is valid. Encoders SHOULD use col_id
  paths in production streams (shorter and schema-independent).
  Name-addressed paths in test vectors improve readability.
