# weavepack-json — worked examples

Runnable demos of the JSON profile. Same conventions as the
[tensor examples README](../../tensor/examples/README.md):
self-contained scripts, byte-count reporting, round-trip verified.

## config-versioning.js

100-version edit history of a typical SaaS application config
(feature flags, rate limits, allowed origins, email templates).
Each version differs from the previous by 1-3 leaf-value changes.

```bash
node weavepack/profiles/json/examples/config-versioning.js
```

Sample output:
```
Single latest snapshot only:
  raw JSON (latest config):          1048 bytes
  weavepack-json (latest):            875 bytes  (1.20× smaller)

Full edit history (anchor + 100 versions):
                                  raw       + brotli
  JSON snapshots (concat all):      85240 bytes      889 bytes
  weavepack chain (anchor+deltas):   1823 bytes     1055 bytes

Per-version cost (chain): 9 bytes/edit average
```

**Honest finding:** As with the tensor profile, bundled brotli
on a snapshot-blob beats the weavepack chain on raw size (96× vs
47×). The weavepack win is per-payload addressability: each
version is independently retrievable at ~9 bytes per edit on
average. The brotli'd blob can't give you version 50 without
decompressing the entire 89-version history.

## When to reach for weavepack-json

| Workload | Recommended |
|---|---|
| Single document, ship-and-forget | raw JSON or JSON+brotli |
| Document version chain, archived | bundled JSON+brotli (size); weavepack (addressable history) |
| Document version chain, per-version retrieval | weavepack (each version independently fetchable) |
| Append-only document log on Arweave/IPFS | weavepack (per-payload billing) |
| Real-time CRDT sync | not weavepack — use Yjs / Automerge |

## Adding more examples

Same shape as tensor examples: construct an `ARJSON` from initial
state, apply `update()` calls in a loop, report sizes and verify
round-trip. Keep examples ≤ 100 lines and dependency-free.
