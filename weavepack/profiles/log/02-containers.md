# weavepack-log — 02: Containers (Event Batch Structure)

**Status:** Draft. Phase L of the weavepack v0.5 roadmap.

## Scope

This document specifies the **container model** of weavepack-log: how
an event batch is structured, how columns are laid out, how the
mandatory `seq` and `ts` columns are encoded, and how a stream header
declares stream identity.

## The event batch

A weavepack-log document is an **event batch** — the top-level
container. An event batch holds:

- A schema hash (32 bytes; all-zero = no schema attached)
- A mandatory `seq` column (uint64, col_id 0)
- A mandatory `ts` column (timestamp64, col_id 1)
- Zero or more user-defined typed columns (col_ids ≥ 2)
- A contiguous block of N events (rows)

Event batches are the unit of transport and storage. A delta chain is
a sequence of frames, each carrying a `frame_type` tag:

| frame_type | Code | Description |
|---|---|---|
| `snapshot` | 0 | Complete materialized stream state (all events) |
| `delta` | 1 | Incremental change over the previous frame |

The first frame in a chain MUST be a `snapshot` (frame_type = 0).

## Snapshot frame layout

A snapshot frame encodes all events in the stream up to a point in
time — the materialized view.

```
snapshot_frame:
  frame_type    : 1 bit  = 0 (snapshot)
  schema_hash   : 256 bits (32 bytes), big-endian
  num_events    : LEB128 uint64
  seq_block     : mandatory_seq_block (see §Mandatory column encoding)
  ts_block      : mandatory_ts_block (see §Mandatory column encoding)
  num_user_cols : LEB128 uint32
  columns       : user_column_block[num_user_cols]
```

The mandatory columns precede user-defined columns so a reader can
locate any event's seq and ts without parsing unknown column types.

## Mandatory column encoding

### seq column (col_id 0, ctype uint64)

The `seq` column stores the event sequence numbers. Within a batch,
seq values MUST be strictly monotonically increasing. The first seq
in a stream MUST be ≥ 0; subsequent batches MUST begin with a seq
strictly greater than the last seq in the previous batch.

seq encoding uses **delta coding**:

```
mandatory_seq_block:
  first_seq     : LEB128 uint64
  deltas[num_events − 1] : LEB128 uint64 (each delta ≥ 1)
```

For the common case where events are assigned densely (seq = 0, 1, 2,
…), every delta = 1 and the RLE mechanism compresses this to near-
constant overhead regardless of `num_events`.

A decoder MUST verify that all seq deltas are ≥ 1 (strict ascent). A
delta of 0 MUST be refused with `duplicate_seq`.

### ts column (col_id 1, ctype timestamp64)

The `ts` column stores event timestamps as microseconds since the Unix
epoch (UTC). Within a batch, ts values MUST be non-decreasing (equal
timestamps are allowed, e.g., two events in the same microsecond).

ts encoding uses **delta coding** with an initial value and signed
per-event deltas:

```
mandatory_ts_block:
  first_ts      : LEB128 sint64 (zigzag encoded for compact negative-epoch support)
  deltas[num_events − 1] : LEB128 uint64 (each delta ≥ 0)
```

A decoder MUST verify that all ts deltas are ≥ 0 (non-decreasing). A
negative delta MUST be refused with `non_monotone_timestamp`.

Zigzag encoding for `first_ts`: `enc = (v << 1) ^ (v >> 63)`.
Decoders read a LEB128 uint64 and apply `v = (enc >> 1) ^ -(enc & 1)`.

## User column layout

Each user-defined column:

```
user_column_block:
  col_id        : LEB128 uint32   (MUST be ≥ 2)
  ctype         : 5 bits          (from 01-types.md; values 0–16)
  nullable      : 1 bit           (1 = column may contain NULL)
  [null_bitmap] : ceil(num_events / 8) bytes, if nullable = 1
  value_count   : derived: num_events − popcount(null_bitmap)
  values        : value_column[value_count]  (encoded per ctype)
```

col_id values MUST be ≥ 2 (col_ids 0 and 1 are reserved for the
mandatory seq and ts columns). A decoder reading col_id < 2 for a
user column MUST refuse with `reserved_col_id`.

col_id values within a frame MUST be unique. A decoder reading a
duplicate col_id MUST refuse with `duplicate_col_id`.

### Null bitmap details

Present only when `nullable = 1`. Stored as `ceil(num_events / 8)`
bytes, packed MSB-first:

```
null_bitmap[event_i] = (byte[event_i >> 3] >> (7 − (event_i & 7))) & 1
```

A bit of 1 = NULL for that event. Padding bits in the final byte MUST
be 0; a decoder reading a non-zero padding bit MUST refuse with
`invalid_null_bitmap`.

`value_count = num_events − popcount(null_bitmap)`.

### Value column

Packed sequence of `value_count` values, each encoded per its ctype
(see 01-types.md). Variable-width values (string, bytes) are stored
sequentially with no additional index. Fixed-width values are packed at
their declared bit width. RLE applies via the core RLE mechanism.

## Delta frame layout

A delta frame encodes a change to the stream relative to the previous
frame. It is smaller than a full snapshot when the change affects a
small fraction of the total event history.

```
delta_frame:
  frame_type    : 1 bit  = 1 (delta)
  schema_hash   : 256 bits (same or updated schema)
  num_ops       : LEB128 uint32
  ops           : delta_op[num_ops]  (see 04-deltas.md)
```

The `schema_hash` in a delta frame MUST match the current active schema
(the schema_hash of the most recent frame with a non-zero hash). If a
`schema_evolve` delta changes the schema, the new schema_hash reflects
the post-op schema.

## Stream header

A **stream header** is an optional preamble that declares stream
identity. It is not itself an event batch or a delta frame; it is a
separate framing unit that precedes the first snapshot frame when
present.

```
stream_header:
  frame_type    : 1 bit  = 2 (stream_header; distinct from snapshot/delta)
  stream_id     : 128 bits (16-byte UUID, raw bytes, big-endian)
  source_len    : LEB128 uint32
  source        : source_len bytes of UTF-8 (stream source identifier)
  schema_hash   : 256 bits (32 bytes; all-zero = schemaless)
  seq_start     : LEB128 uint64 (first seq number in this stream segment)
```

Streams without a header are **anonymous**: no stream_id, no source
attribution, no seq_start guarantee. Anonymous streams support encoding
and decoding of event batches but do not support cursor_checkpoint ops
(which require a stream_id to associate cursor names).

Streams with a header support cursor-checkpoint ops and schema evolution
with full audit-trail semantics.

`seq_start` is informational: it tells a reader the seq at which this
stream segment begins (useful for partial-stream consumers that receive
a segment rather than the full chain). Encoders MUST set seq_start to
the first_seq of the first snapshot frame in this segment.

A stream header MUST appear at most once per chain. A decoder reading a
second stream_header MUST refuse with `duplicate_stream_header`.

## Logical stream state

The **logical stream state** at any point in the chain is:

1. Start with the snapshot frame: `events = { seq → { col_id → value } }`.
2. For each subsequent delta frame, apply each op in order (see 04-deltas.md).

Invariants:
- Every `seq` in the logical state is unique (enforced by delta encoding).
- `seq` values are strictly monotonically increasing in arrival order.
- `ts` values are non-decreasing in arrival order.
- NULL values for nullable columns are represented as absent entries.
- Non-nullable columns have a non-NULL value for every seq in scope.
- Expired events remain in the physical chain but are excluded from
  logical views (see `event_expire` in 04-deltas.md).

## Schema multiplexing

When schema multiplexing is enabled (indicated by the active schema
containing a `schema_set` — see 06-schemas.md), col_id 2 is reserved
for the `schema_id` field (uint8). Each event carries a schema_id
selecting which sub-schema applies to it. Implementations that do not
support schema multiplexing MUST refuse with `unsupported_feature` when
they read a `schema_set` in the active schema.
