# weavepack-tabular — 03: Paths

**Status:** Draft. Phase T of the weavepack v0.4 roadmap.

## Scope

This document specifies the **path grammar** of weavepack-tabular.
Paths identify rows, columns, or individual cells for delta operations.
Unlike weavepack-wire (which navigates nested message fields) or
weavepack-json (which navigates nested object/array trees), the tabular
path grammar reflects the two-dimensional structure of a table: a path
is either a column reference, a row reference, or a cell reference.

## Grammar

```
path        = col-path
            | row-path
            | cell-path
            | "" (empty path = the whole table)

col-path    = "[" col-id "]"
            | "." col-name

row-path    = "#" row-id

cell-path   = "#" row-id "[" col-id "]"
            | "#" row-id "." col-name

col-id      = digit+          ; uint32 column identifier (always works)
col-name    = identifier      ; schema-declared name (requires schema)
row-id      = digit+          ; uint64 row identifier
identifier  = [A-Za-z_][A-Za-z0-9_]*
digit       = [0-9]
```

## Semantics

### Column path `[col_id]` / `.col_name`

Refers to an entire column across all rows. Used by `column_add`,
`column_drop`, and `column_rename`.

- `[col_id]` — identifies the column whose `col_id` matches. Works in
  both schemaless and schema-addressed mode.
- `.col_name` — identifies the column whose schema-declared name
  matches. A decoder MUST refuse with `schema_required` if no schema
  is active when a name-addressed path is used.

Column paths are **not** valid in `row_insert`, `row_update`,
`row_delete`, or `batch_upsert` operations; those ops use row paths or
cell paths.

### Row path `#row_id`

Refers to an entire row across all columns. Used by `row_delete`. Also
used in `row_update` and `batch_upsert` to identify which row is being
modified (the op body carries the per-column values separately).

### Cell path `#row_id[col_id]` / `#row_id.col_name`

Refers to a specific cell — the intersection of one row and one column.
Used in `row_update` to address individual cells.

- `#42[3]` — cell at row_id=42, col_id=3
- `#42.status` — cell at row_id=42, column named "status" (schema required)

## Examples

| Path | Refers to |
|---|---|
| `""` | The whole table (used in snapshot replacement) |
| `[0]` | Column with col_id=0 |
| `.created_at` | Column named "created_at" (schema required) |
| `#0` | Row with row_id=0 |
| `#42` | Row with row_id=42 |
| `#42[3]` | Cell: row_id=42, col_id=3 |
| `#42.status` | Cell: row_id=42, column "status" (schema required) |

## On-wire encoding

Paths are encoded in binary within delta ops (see 04-deltas.md).
The on-wire form uses type-tagged components, not the string grammar
above. The string grammar is the human-readable canonical form used
in test vectors and error messages.

```
path_tag    : 2 bits
              0 = whole-table (empty path)
              1 = col-path
              2 = row-path
              3 = cell-path

col-path:
  addr_mode : 1 bit   0 = by col_id, 1 = by col_name
  col_id    : LEB128 uint32    (if addr_mode = 0)
  col_name  : LEB128 byte-count + UTF-8   (if addr_mode = 1)

row-path:
  row_id    : LEB128 uint64

cell-path:
  row_id    : LEB128 uint64
  addr_mode : 1 bit   0 = by col_id, 1 = by col_name
  col_id    : LEB128 uint32    (if addr_mode = 0)
  col_name  : LEB128 byte-count + UTF-8   (if addr_mode = 1)
```

## Addressing by col_id vs. col_name

Column IDs are the canonical on-wire identity. Column names are
schema-layer aliases.

In practice:

- **Schemaless mode**: name-addressed paths are forbidden. Only col_id
  paths and row_id paths are valid. A decoder MUST refuse with
  `schema_required` on any name-addressed path when no schema is active.

- **Schema mode**: either form is valid. Encoders SHOULD use col_id
  paths in production streams (they are shorter and schema-independent).
  Name-addressed paths in test vectors improve readability.

## Uniqueness

Within a single delta op, each row_id MUST appear at most once as the
target of a mutating operation. A decoder receiving two ops in the same
delta frame that target the same row_id with conflicting mutations MUST
apply them in order (last op wins). Encoders SHOULD merge same-row ops
to avoid ambiguity.
