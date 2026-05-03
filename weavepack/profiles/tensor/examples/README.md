# weavepack-tensor — worked examples

Runnable demos of the use cases described in
[`../USE-CASES.md`](../USE-CASES.md). Each script is self-contained,
prints its measurements to stdout, and exits 0 on round-trip success.

## training-checkpoint-chain.js

Simulated ML training: 100 steps of fine-tuning a 1024-element fp32
tensor with ~2% per-step sparsity. Demonstrates USE-CASES scenario
1 (periodic ML training checkpoints).

```bash
node weavepack/profiles/tensor/examples/training-checkpoint-chain.js
```

Sample output:
```
Storage:
  Anchor (initial encode):     4111 bytes
  Total delta cost:            9896 bytes
  Average delta size:          99.0 bytes/step
  Final chain (anchor+deltas): 14007 bytes

Comparison:
  safetensors-style (1 full snapshot per step): 413696 bytes
  weavepack chain:                              14007 bytes
  Saving:                                       30× smaller
```

## lora-variants.js

Multiple fine-tuned variants of a base model: 10 variants each
modifying a different 5% of the base's 16384 fp32 parameters.
Demonstrates USE-CASES scenario 2 (multiple fine-tuned variants).

```bash
node weavepack/profiles/tensor/examples/lora-variants.js
```

Sample output:
```
Storage:
  Base anchor:                       65553 bytes
  Average variant delta:             3297 bytes
  Total (base + 10 variant deltas): 98522 bytes

Comparison:
  safetensors (1 base + 10 full snapshots): 720896 bytes
  weavepack (base + deltas):                       98522 bytes
  Saving:                                          7.3× smaller
```

## sensor-grid-stream.js

Time-series sensor data: a 32×32 fp32 temperature grid sampled
60 times (1/min for an hour) where only cells near a moving
"heat source" change between timesteps. Demonstrates USE-CASES
scenario 6 (time-series tensor data).

```bash
node weavepack/profiles/tensor/examples/sensor-grid-stream.js
```

Sample output:
```
Storage:
  Anchor (initial encode):    4108 bytes
  Total delta cost:           9544 bytes
  Average delta size:         159 bytes/step
  Final chain:                13652 bytes

Comparison:
  safetensors-style (1 snapshot per step): 249856 bytes
  weavepack chain:                         13652 bytes
  Saving:                                  18× smaller
```

## brotli-stacking.js

Honest comparison of weavepack vs `safetensors-bundled + brotli`
across two workloads (sparse-update vs dense-update). Demonstrates
where weavepack's structural compression wins, and where brotli on
a concatenated-blob baseline already extracts most of the win.

```bash
node weavepack/profiles/tensor/examples/brotli-stacking.js
```

The example exists to be honest about a real tradeoff: in a
**bundled** comparison (concat all snapshots, then compress the
whole blob), brotli often beats weavepack alone. weavepack's win
is **per-payload addressability** — each chain payload is
independently retrievable, which a single brotli'd blob is not.
Critical for Arweave / IPFS / per-payload-billing scenarios.

## Summary of measured wins

| Scenario | Workload | Saving vs safetensors |
|---|---|---|
| Periodic checkpoints | 100 training steps, 2% sparsity | **30×** smaller |
| Variant collection | 10 variants × 5% sparsity | **7.3×** smaller |
| Time-series sensor stream | 60 timesteps, 2.8% per-step changes | **18×** smaller |
| Bundled + brotli (sparse) | 100 steps, 2% sparsity | brotli alone wins (47× vs 30×); weavepack wins on per-payload addressability, not bundled size |
| Bundled + brotli (dense) | 100 steps, every-element noise | both ~1× (no compression to extract); weavepack wins on partial-decode |

These numbers are hardware-independent (byte counts, not timings)
and reproducible: any consumer running these scripts will get the
same byte values (modulo random seeds in the synthetic data).

## chain-partial-restore.py (Python)

Python analogue of the JSON profile's chain-partial-restore demo,
specifically demonstrating per-payload addressability for the tensor
profile from Python. Loads chain bytes produced by the JS reference
encoder (from the conformance corpus), parses them with the new
public Python `parse_chain` / `serialize_chain` API, and reconstructs
each intermediate version from chain prefixes.

```bash
PYTHONPATH=impl/python python3 weavepack/profiles/tensor/examples/chain-partial-restore.py
```

Doubly useful: exercises the public Python chain API and demonstrates
cross-language interop (JS-encoded chain bytes → Python decode +
delta application, no contact with the JS implementation).

## Adding more examples

Each example follows a consistent shape:

1. Construct a base `TensorPack` from a starting state
2. Apply a sequence of `update()` calls
3. Report sizes for the chain vs safetensors-equivalent
4. Verify round-trip via `new TensorPack({ arj: pack.toBuffer() })`

If you want to add a new example, copy `training-checkpoint-chain.js`
as the template. Keep examples small (≤ 100 lines) and runnable
without external dependencies.
