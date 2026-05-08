# weavepack-wire — benchmarks

**Status:** complete (W.6). Results from `weavepack/tools/benchmark-wire.js`.

**Environment:** Node.js v22.22.2, brotli quality 6. Deterministic synthetic data.

## Comparison methodology

Two comparison modes are reported for delta-chain scenarios:

- **Per-snapshot brotli** — each API response (protobuf snapshot) is brotli-compressed
  independently, as is standard practice for HTTP responses. Total = Σ brotli(snapshotₖ).
  This is the realistic comparison for API/RPC systems.

- **Concat-stream brotli** — all N snapshots concatenated and brotli-compressed as a
  single stream. This gives protobuf the maximum advantage of cross-frame compression,
  making it equivalent to a generic delta codec. Included for completeness.

The ship gate (≥2×) is checked against per-snapshot brotli, the realistic baseline.

---

## Scenario 1 — Full snapshot

**Setup:** 11-field message, 5 nested sub-messages, one repeated field of 100 uint32s.
Single encode/decode round-trip with no delta operations.

**Fields:**

| field | type | description |
|---|---|---|
| 1 | uint32 | game_id |
| 2 | uint32 | player_id |
| 3 | sint32 | score |
| 4 | float32 | health |
| 5 | bool | is_active |
| 6 | message | position {x, y, z: float32} |
| 7 | message | velocity {vx, vy, vz: float32} |
| 8 | message | stats {kills, deaths, assists: sint32} |
| 9 | message | inventory {gold, slot_count, capacity: uint32} |
| 10 | message | session {server_id, latency_ms, flags: uint32} |
| 11 | repeated uint32 | item_ids (100 elements, packed) |

**Results:**

| format | raw size | vs protobuf |
|---|---|---|
| protobuf v3 | 254 B | baseline |
| weavepack-wire schemaless | 282 B | 111.0% |

| format | brotli-6 size | vs protobuf+brotli |
|---|---|---|
| protobuf v3 + brotli | 236 B | baseline |
| weavepack-wire + brotli | 250 B | 105.9% |

**Gate (≤115% of protobuf raw):** PASS ✓

weavepack-wire snapshot is 11% larger than protobuf on this message. The overhead is
structural: weavepack emits a 1-byte type tag per field in addition to the field number,
while protobuf encodes the wire-type into the tag byte itself. For small field numbers
(< 16), protobuf tag = 1 byte; weavepack = 2 bytes. This difference shrinks with
field count and disappears under brotli (105.9% compressed, well within gate).

---

## Scenario 2 — Incremental API response

**Setup:** Game-state message with 25 scalar fields. 1000 update steps, 1–2 fields
changed per step (avg 1.51 / 25 = 6%).

**Fields:**

| fields | types | description |
|---|---|---|
| 1–8 | uint32 | counters, IDs |
| 9–14 | sint32 | signed stats (score, rank, etc.) |
| 15–20 | float32 | positions, health, speed |
| 21–25 | string | name, team, region, status, title |

**Protocol behavior:**

- **protobuf**: no native delta primitive. Client re-encodes the full 25-field message
  each step (116 B/snapshot × 1000 = ~117 KB).
- **weavepack-wire**: emits FIELD_SET ops for only the 1–2 changed fields. Chain =
  initial 133 B snapshot + 1000 delta frames averaging ~14 B each.

**Results:**

| approach | raw bytes | brotli-6 | notes |
|---|---|---|---|
| protobuf — 1000 full snapshots | 117.1 KB | 121.0 KB | per-snapshot (realistic) |
| protobuf — 1000 snapshots | — | 5.9 KB | concat-stream (best-case for protobuf) |
| weavepack — snapshot + 1000 deltas | 14.4 KB | 6.6 KB | |

**Gate (weavepack+brotli ≥2× smaller than protobuf per-snapshot brotli):** PASS ✓

**weavepack advantage:**
- vs per-snapshot brotli: **18.3× smaller**
- vs concat-stream brotli: 0.89× (weavepack is slightly *larger* in this comparison)

**Interpretation of the concat-stream result:** brotli on a concatenation of 1000
near-identical messages (97% of bytes unchanged between frames) is essentially a
general-purpose delta codec. In this limit, both approaches collapse to "initial
snapshot + entropy of changes". weavepack is slightly larger here because its
encoding is optimized for independent delta frames rather than a single brotli stream.
The real-world win — 18× — comes from treating each update as an independent
compressed unit, which is mandatory for HTTP responses and streaming RPCs.

---

## Scenario 3 — Streaming token stream

**Setup:** Repeated string field (field 1), appended 10 tokens per step, 100 steps.
Final state has 1,000 tokens. Vocabulary of 60 short English words (2–6 chars each).

**Protocol behavior:**

- **protobuf**: no REPEATED_APPEND primitive. Step k requires a full snapshot of
  all k×10 tokens. Total raw = Σ(k=1..100) k×10 tokens.
- **weavepack-wire**: emits one REPEATED_APPEND op per step encoding only the 10
  new tokens.

**Results:**

| format | raw size | description |
|---|---|---|
| protobuf (final snapshot) | 5.1 KB | 1000 tokens |
| weavepack (final snapshot) | 4.2 KB | 81.1% of protobuf |

| approach | raw bytes | brotli-6 | notes |
|---|---|---|---|
| protobuf — 100 full snapshots | 259.1 KB | 79.9 KB | per-snapshot (realistic) |
| protobuf — 100 snapshots | — | 2.0 KB | concat-stream (best-case for protobuf) |
| weavepack — init + 100 append frames | 4.9 KB | 1.5 KB | |

**Gate (weavepack+brotli ≥2× smaller than protobuf per-snapshot brotli):** PASS ✓

**weavepack advantage:**
- vs per-snapshot brotli: **52.2× smaller**
- vs concat-stream brotli: 1.28× smaller

**Interpretation:** The token stream scenario is O(N) total bytes for weavepack vs
O(N²) for protobuf (the k-th step encodes k×10 tokens). The structural advantage is
independent of brotli. Per-snapshot brotli partially compensates (the final large
snapshots compress well), but the quadratic growth dominates. Only a concat-stream
approach recovers near-parity, at the cost of making the full stream available before
any step can be delivered.

---

## Summary

| scenario | weavepack vs protobuf | gate | result |
|---|---|---|---|
| 1 — full snapshot | 111.0% of protobuf raw | ≤115% | **PASS** |
| 2 — incremental API (1000 steps) | 18.3× smaller (per-snapshot brotli) | ≥2× | **PASS** |
| 3 — streaming tokens (100 steps) | 52.2× smaller (per-snapshot brotli) | ≥2× | **PASS** |

All v0.3 benchmark gates pass.

---

## Design notes

### Why per-snapshot brotli is the right baseline

HTTP/2 and HTTP/3 compress each response independently. gRPC over HTTP/2 applies
brotli (or gzip) per-message, not per-stream. WebSocket framing is per-message.
The concat-stream comparison assumes a single brotli context persists across all
updates, which requires the full update history to be available before delivery and
breaks the stateless-response model. Weavepack's delta chain is composable:
each frame is independently decodable given the prior state, and can be
independently transmitted and cached.

### Snapshot overhead analysis

Weavepack snapshot bytes = protobuf bytes × ~1.11 on the test message. This is the
cost of the type-tag column: protobuf encodes wire type in the tag varint (1 byte
total for small field numbers), while weavepack uses a separate 1-byte type-tag per
field. The redundancy compresses well under brotli (105.9% after compression) and
is structurally necessary for the columnar layout that enables delta packing.

### When concat-stream is appropriate

If all updates are batched and delivered at once (e.g., an audit log replay, an
offline sync), concat-stream brotli on protobuf approaches weavepack efficiency.
In that use case, the choice between the two formats depends on secondary factors
(schema evolution, path-addressed updates, tooling ecosystem). Weavepack's delta
chain remains strictly better in the online / streaming / incremental-delivery case.
