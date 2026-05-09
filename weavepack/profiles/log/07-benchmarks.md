# weavepack-log — benchmarks

**Status:** complete (L.6). Results from `weavepack/tools/benchmark-log.js`.

**Environment:** Node.js v22, brotli quality 6. Deterministic synthetic data.

## Comparison methodology

The baseline is **JSON Lines + gzip-6** — the most common structured-log
transport format. Each event is serialized as a JSON object on its own line;
the entire file (or per-step snapshot) is compressed with gzip at quality 6.

This gives gzip the full benefit of cross-event back-references, which is gzip's
primary compression mechanism for repetitive text. weavepack-log's column encoding
provides a different structural advantage: identical field values compress to
near-zero per event even before external compression.

For delta scenarios, the JSON Lines baseline is the sum of per-step gzip-compressed
full re-snapshots (realistic: a consumer re-encoding all events after each batch
arrives). weavepack emits only the incremental delta frame per step.

---

## Scenario 1 — High-repetition batch

**Setup:** 10 000 events from a single service. 70% of fields constant across
all events (host, service, env, level=INFO). Varying fields: ts, seq, request_id
(unique hex string), duration_ms (float32), status_code (uint16).

| Format | Size (bytes) |
|--------|-------------|
| weavepack raw | 693,806 |
| **weavepack brotli-6** | **66,686** |
| JSON Lines gzip-6 | 166,369 |

**Ratio (JSON Lines / weavepack brotli-6):** 2.49×

**Gate (weavepack within 20% of JSON Lines gzip — i.e. ratio ≥ 0.8):** PASS ✓

*Note: weavepack is 2.5× smaller, comfortably within gate. The spec gate is
deliberately lenient for single-batch comparison because gzip has strong
back-reference advantage on repetitive text field names. Column encoding + RLE
gives weavepack a different structural advantage.*

---

## Scenario 2 — Streaming append

**Setup:** 1 000 steps, each appending 10 events (total 10 000 events).
weavepack emits one `event_append` delta frame per step (33 bytes header +
~660 bytes of column data per step on average).
JSON Lines baseline: full re-snapshot of all accumulated events, gzip-6 per step
(realistic: O(all_events) bytes per micro-batch for a re-snapshot consumer).

| Format | Total bytes |
|--------|------------|
| weavepack delta sum raw | 659,987 |
| **weavepack delta sum brotli-6** | **234,892** |
| JSON Lines per-step gzip sum | 85,450,034 |

**Ratio raw (JSON Lines / weavepack):** 129.5×
**Ratio brotli (JSON Lines / weavepack):** 363.8×

**Gate (weavepack brotli ≥ 2× smaller than JSON Lines per-step gzip):** PASS ✓

*The 364× win reflects the fundamental O(N) vs O(N²) asymmetry: each JSON
Lines step re-encodes all prior events; weavepack encodes only the 10 new events
per step. At step 1000 the re-snapshot is 1000× larger than the delta frame.*

---

## Scenario 3 — Multi-schema stream

**Setup:** 1 000 events mixing 3 event types: HTTP (40%), DB (35%), cache (25%).
weavepack encodes as a single batch with nullable columns for type-specific fields
(null bitmap compresses the absent fields). JSON Lines: full object per event
including type discriminator, with each type's field names repeated every event.

| Format | Size (bytes) |
|--------|-------------|
| weavepack raw | 13,931 |
| **weavepack brotli-6** | **3,718** |
| JSON Lines gzip-6 | 10,716 |

**Ratio (JSON Lines / weavepack brotli-6):** 2.88×

**Gate (weavepack brotli ≥ 2× smaller than JSON Lines gzip):** PASS ✓

---

## Gate summary

| Scenario | Gate | Result |
|----------|------|--------|
| 1 — High-repetition batch | wp within 20% of jsonl gzip | PASS ✓ |
| 2 — Streaming append | wp ≥ 2× smaller brotli | PASS ✓ (363.8×) |
| 3 — Multi-schema stream | wp ≥ 2× smaller brotli | PASS ✓ (2.88×) |

All gates pass. v0.5 ship criterion met.

---

## Structural advantage analysis

**Why column encoding beats JSON Lines for high-repetition streams:**

JSON Lines encodes every field name in every event (`"host":"web-01..."`),
consuming ~50–200 bytes of field-name overhead per event. Column encoding
records field ids once in the schema and packs values contiguously; repeated
values across consecutive events compress to near-zero via column-level RLE.

**Why delta chains beat re-snapshots for streaming append:**

JSON Lines + gzip requires O(N) bytes per step when there are N accumulated
events — the full text of all prior events is re-emitted every micro-batch.
The `event_append` op encodes only the new events (10 per step = constant
cost per step), giving O(new_events) bytes regardless of total stream length.
At 1000 steps this produces a 364× size advantage over the re-snapshot baseline.

**Why nullable columns beat separate per-type encodings:**

For multi-schema streams, the null bitmap uses 1 bit per absent field per event.
For 1 000 events across 3 types, ~60–75% of column cells are null. The bitmap
adds only `(1000 / 8)` = 125 bytes per column overhead, while JSON Lines pays
the full key+value text cost on every non-null field. Column encoding eliminates
the key-name repetition entirely (field ids are 1–2 bytes via LEB128 in the
schema, not repeated per event).
