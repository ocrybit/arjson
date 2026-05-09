# weavepack-log — 00: Overview

**Status:** Draft. Phase L of the weavepack v0.5 roadmap.

## What weavepack-log is

weavepack-log is a profile of the weavepack universal protocol for
encoding **structured event streams** — typed, column-oriented log
batches with native delta-chain support and protocol-level cursor
semantics. It targets the same problem space as JSON Lines, NDJSON,
Logfmt, and OpenTelemetry OTLP, but adds capabilities those formats
lack:

- **Column encoding with RLE**: field names are declared once per
  schema, not repeated per event. Runs of identical field values
  (e.g., the same host, service, env, or severity level across
  hundreds of consecutive events) collapse to near-zero wire overhead.

- **Native delta chains**: an `event_append` frame carries only the N
  new events since the last frame. A tailing consumer receives O(new)
  bytes per micro-batch rather than O(all) for a re-snapshot.

- **Protocol-level cursors**: a `cursor_checkpoint` op embeds a named
  consumer offset in the wire stream itself, eliminating the
  application-layer offset tracking that Kafka, Kinesis, and similar
  systems bolt on externally.

- **Schema evolution**: `schema_evolve` ops add, drop, or rename fields
  in-band, without invalidating earlier frames or forcing a new stream.

A weavepack-log document is an **event batch** or a **delta frame**
in a chain. The chain accumulates to a materialized stream; a reader
reconstitutes the full stream by applying frames in order.

## Why it exists

Existing structured log formats:

| | Typed | Schema | Deltas | Column-enc | Cursor | Self-desc |
|---|---|---|---|---|---|---|
| JSON Lines | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Logfmt | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| NDJSON | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| OpenTelemetry OTLP | ✓ | ✓ | ✗ | ✗ | ✗ | ~ |
| **weavepack-log** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |

The win is sharpest for two scenarios:

1. **High-repetition batch** — application logs where 60–80% of fields
   are identical across consecutive events (same host, service, env,
   level=INFO). JSON Lines encodes every field name and value in every
   event. weavepack-log encodes field names once and bit-packs values;
   repeated fields compress to near-zero per event via column RLE.

2. **Streaming append pipeline** — consumers that tail a log stream and
   process events in micro-batches. Without delta semantics, each
   consumer checkpoint requires re-encoding all events since the last
   full snapshot. weavepack-log emits `event_append` delta frames
   containing only the new events, giving O(new) bytes per micro-batch
   vs. O(all) for a re-snapshot.

Estimated compression win over JSON Lines + gzip for high-repetition
streams: same structural advantage as weavepack-tabular (3–20×) when
60–80% of field values repeat across consecutive events within a batch.
Streaming delta chains amplify this further for tailing workloads.

## Relationship to weavepack-core

weavepack-log uses the same core machinery as weavepack-tabular,
weavepack-json, weavepack-tensor, and weavepack-wire:

- Bit-pack column buffers (`Encoder` from `sdk/src/encoder.js`)
- Wire envelope structure (mode bit + columns)
- Delta chain framing (LEB128 length-prefixed frames)
- Schema sidecar hash (SHA-256, same mechanism as tabular and tensor)

weavepack-log is a **superset of weavepack-tabular's column type
vocabulary** — it inherits all 15 tabular ctypes (bool through ext)
and adds ctype 16 (`level`) for log severity encoding. Implementations
MUST NOT import weavepack-tabular code directly; the log profile is
profile-isolated.

What is profile-specific:

- **Mandatory columns**: `seq` (ctype uint64, col_id 0) and `ts`
  (ctype timestamp64, col_id 1) are mandatory in every event batch.
- **ctype 16 `level`**: 3-bit packed severity (TRACE–FATAL).
- **Stream header**: `stream_id`, `source`, `schema_hash`, `seq_start`.
- **Path grammar**: `@seq`, `@ts`, `#seq` (event-by-sequence-number).
- **Delta vocabulary**: `event_append`, `field_update`, `event_expire`,
  `schema_evolve`, `cursor_checkpoint`.

## Key design decisions

### Why mandatory seq and ts columns?

Every log event has a timestamp and a sequence number. Making seq and
ts mandatory (rather than schema-declared) means:

1. A schemaless consumer always knows where in the stream it is and
   when events occurred — it does not need a schema to parse the
   event timeline.

2. Delta operations that address events by seq (field_update,
   cursor_checkpoint, event_expire) can be decoded without a schema.

3. Encoders can enforce monotonicity invariants (seq strictly
   increasing, ts non-decreasing) without schema knowledge.

seq uses delta coding (see 02-containers.md) for efficient encoding of
the common dense-contiguous case. ts uses delta coding for monotone
timestamp sequences with efficient encoding of small deltas (e.g.,
microsecond-range inter-event gaps within a batch).

### Why a 3-bit `level` type?

Six severity levels (TRACE, DEBUG, INFO, WARN, ERROR, FATAL) fit in 3
bits with 2 values reserved for future extension. Compared to encoding
level as a string column:

- String: ≥5 bytes per non-null event (LEB128 + UTF-8), or dict-coded.
- `level` ctype: 3 bits per event + RLE collapses long runs (most
  server logs are long INFO runs) to near-constant overhead.

At 10 000 events/batch with 80% INFO: string = ~40 kB; level ctype +
RLE ≈ 4 bytes per uniform run.

### Why protocol-level cursors?

Application-layer consumer offsets (Kafka consumer group offsets,
Kinesis shard iterators) require out-of-band coordination. A
`cursor_checkpoint` op embeds the consumer's acknowledged position
directly in the log stream, making consumer state recoverable from the
stream itself without external coordination. This is the minimal
addition that eliminates the external offset-store problem.

### Sequence identity over row identity

weavepack-tabular uses `row_id` (stable uint64 identity, never
reassigned). weavepack-log uses `seq` (monotonically increasing uint64,
assigned by the encoder). The difference reflects the different
invariants:

- Log events are **immutable once appended**. seq is assigned once;
  there is no "row moved" operation.
- Log events can be **expired** (retention policy), but expiry is
  logical — expired events remain in the physical chain. `event_expire`
  marks a seq range as logically invisible without destroying the
  chain's hash ancestry.
- Log events can be **corrected** via `field_update` (e.g., redacting
  a PII field). The seq identifies which event to correct; the op
  body carries the new value for the specified field.

### Schema multiplexing

A single weavepack-log stream may contain mixed event types (HTTP
request events, DB query events, cache events). Rather than requiring
separate streams per type, the schema sidecar supports a
`schema_set` (array of schemas keyed by schema_id). Events carry a
`schema_id` field (uint8, col_id 2 when schema multiplexing is
enabled). See 06-schemas.md.

## Scope of this spec

`00-overview.md` — this document: motivation, design decisions, scope.
`01-types.md` — column type vocabulary (ctype table, `level` encoding, null).
`02-containers.md` — event_batch structure, stream_header, column layout.
`03-paths.md` — path grammar for delta addressing.
`04-deltas.md` — delta operation vocabulary and wire encoding.
`05-conformance.md` — test corpus structure and conformance levels.
`06-schemas.md` — schema sidecar format and schema multiplexing.
`07-benchmarks.md` — benchmark methodology and results vs. JSON Lines + gzip.
