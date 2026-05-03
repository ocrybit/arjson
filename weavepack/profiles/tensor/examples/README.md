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

## Summary of measured wins

| Scenario | Workload | Saving vs safetensors |
|---|---|---|
| Periodic checkpoints | 100 training steps, 2% sparsity | **30×** smaller |
| Variant collection | 10 variants × 5% sparsity | **7.3×** smaller |

These numbers are hardware-independent (byte counts, not timings)
and reproducible: any consumer running these scripts will get the
same byte values (modulo random seeds in the synthetic data).

## Adding more examples

Each example follows a consistent shape:

1. Construct a base `TensorPack` from a starting state
2. Apply a sequence of `update()` calls
3. Report sizes for the chain vs safetensors-equivalent
4. Verify round-trip via `new TensorPack({ arj: pack.toBuffer() })`

If you want to add a new example, copy `training-checkpoint-chain.js`
as the template. Keep examples small (≤ 100 lines) and runnable
without external dependencies.
