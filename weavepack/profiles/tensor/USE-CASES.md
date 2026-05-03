# weavepack-tensor — Use Cases

Concrete consumer scenarios for the tensor profile, with code
sketches. Useful for understanding "when do I reach for weavepack-
tensor instead of safetensors / pickle / numpy.npy".

## 1. Periodic ML training checkpoints

> **Worked example:** [`examples/training-checkpoint-chain.js`](examples/training-checkpoint-chain.js) —
> 100 training steps over a 1024-element fp32 tensor at 2% per-step
> sparsity → **30× smaller** than safetensors-style snapshots.
>
> Dense-update headroom (V0.2 A.3 ✓ shipped): the encoder now emits
> `tensor_replace` as **delta-from-prior** (mode=1) when the max
> per-element change is ≤ 0.01 (typical for Adam-style training).
> Empirically **1.6× smaller after brotli** than mode=0 on the
> dense-Adam scenario. See
> [`examples/delta-from-prior-mode-bit.js`](examples/delta-from-prior-mode-bit.js)
> for the full sweep across update magnitudes.

**Scenario:** You're training a transformer for 100k steps and want
to save a checkpoint every 100 steps. Each checkpoint is a 7B-param
model = ~28 GB on disk in fp32 (or ~14 GB in fp16). With 1000
checkpoints, that's 14-28 TB.

**Without weavepack:** safetensors saves each checkpoint as a full
snapshot. Total disk: 14 TB minimum.

**With weavepack:** save the first checkpoint as an anchor, then a
delta per subsequent step. Each delta typically ≈ 1-3% of the
anchor (only changed weights, mostly small element_set ops with
contiguous regions for big-block updates).

Estimated total: 14 GB anchor + 999 × 200 MB delta = **~213 GB**.
65× less than safetensors.

```js
import { TensorPack, DTYPE } from "weavepack-tensor"

const initialDoc = { tensors: { /* ...all model params... */ } }
const pack = new TensorPack({ json: initialDoc })

// Each training step:
for (let step = 1; step <= 100000; step++) {
  trainOneStep(model, batch)
  if (step % 100 === 0) {
    const newDoc = modelToDoc(model)
    pack.update(newDoc)  // appends a delta to the chain
    fs.writeFileSync(`ckpt-${step}.wpkt`, pack.toBuffer())
  }
}
```

To restore checkpoint at step N: `new TensorPack({ arj: fs.readFileSync(`ckpt-${N}.wpkt`) })`.

## 2. Multiple fine-tuned variants of a base model

> **Worked example:** [`examples/lora-variants.js`](examples/lora-variants.js) —
> 16k-param base + 10 LoRA-style variants at 5% sparsity each →
> **7.3× smaller** than safetensors-style (1 base + N full snapshots).

**Scenario:** You have a base LLaMA model and 50 fine-tuned variants
(LoRA adapters, full fine-tunes, RLHF variants). Storing all 50 as
full weights is 50× the base model size.

**With weavepack:** anchor = base model, each variant = delta from
base. Total storage ≈ base model + 50 × (variant delta size).

For LoRA-style variants where only a small subset of layers are
modified, deltas are tiny. For full fine-tunes, deltas may be 30-70%
of the base depending on how aggressive the fine-tuning was.

```python
from weavepack_tensor import TensorPack  # via PyO3 binding

# Initial: load base model
base = load_safetensors("llama-7b.safetensors")
pack = TensorPack(json=base)

# Save 50 variants as deltas
for variant_name, variant_weights in fine_tunes.items():
    pack.update(variant_weights)
    save(f"{variant_name}.wpkt", pack.to_buffer())
    pack = TensorPack(json=base)  # reset to base for next variant
```

(Each variant has its own 2-payload chain: base anchor + delta.)

## 3. Permanent ML ledger on Arweave / IPFS

**Scenario:** You want to publish every checkpoint of a research
training run on permanent storage (Arweave). Cost is per-byte. Each
full checkpoint costs $X; deltas cost $X / 30-50.

**With weavepack:** publish the chain of deltas, link by content
hash. Researchers replay from the start to reach any specific step.

Bonus: weavepack's chain framing is brotli-friendly, so
post-compression saves another 20-50%.

## 4. Federated learning aggregation

**Scenario:** N clients each train locally and send weight deltas
to a coordinator. Coordinator averages and broadcasts a new model.

**With weavepack:** clients send `delta(start_of_round, end_of_round)`
as a tensor delta. Coordinator decodes, averages, encodes new
delta, broadcasts.

Bandwidth saving vs sending full weights: same factor as scenario
1 (typically 30-100×).

```python
# Client side
client_delta = encode_delta(start_doc, end_doc)
send_to_coordinator(client_delta)

# Coordinator side
client_docs = []
for client_delta_bytes in received_deltas:
    doc = apply_delta(start_doc, client_delta_bytes)
    client_docs.append(doc)
averaged = average_tensor_docs(client_docs)
new_round_delta = encode_delta(start_doc, averaged)
broadcast_to_clients(new_round_delta)
```

## 5. Quantization ablation

**Scenario:** You want to compare 5 quantization schemes (fp32,
fp16, bf16, int8, int4) on the same base model. Currently you'd
save 5 separate copies.

**With weavepack:** anchor = fp32 base; deltas = quantization
results for each scheme.

Storage saving depends on how lossy each quantization is. For
int8 quantization where the data fundamentally differs from fp32
(magnitude of changes in absolute terms is large), the delta
isn't smaller — but at least the storage is structured.

NOTE: this scenario is more about **organization** than
**compression**. Real quantization schemes change everything,
producing tensor_replace (full re-encode) deltas, not the sparse
deltas where weavepack's compression shines.

## 6. Time-series tensor data

> **Worked example:** [`examples/sensor-grid-stream.js`](examples/sensor-grid-stream.js) —
> 32×32 fp32 temperature grid sampled 60 times with a moving heat
> source (~2.8% per-step changes) → **18× smaller** than full snapshots.

**Scenario:** Sensor or simulation data — a tensor that evolves
over time, with most values changing only slowly.

**With weavepack:** chain of small per-timestep deltas. Same
compression argument as ML training but applied to non-ML data.

Example: a 1024×1024 grid of temperature readings recorded once
per minute. Most cells barely change between minutes; only
boundary cells where heat source moved have material updates.

```python
sensor_grid = read_sensors()  # initial state
pack = TensorPack(json={
    "tensors": {"temp": {"dtype": DTYPE.FP32, "shape": [1024, 1024], "data": sensor_grid}}
})

while True:
    time.sleep(60)
    new_grid = read_sensors()
    pack.update({"tensors": {"temp": {..., "data": new_grid}}})
    # Save chain to disk; each minute adds ~1-10 KB.
```

## What weavepack-tensor is NOT

- A computation graph format (use ONNX for that)
- A model serving format (use TensorFlow SavedModel for that)
- Optimized for sparse tensors with mostly-zero data (use dedicated
  sparse formats; weavepack-tensor stores dense data)
- A replacement for streaming data formats (use Avro / Parquet for
  large analytics data)

It IS:
- A delta-aware storage format for dense tensors
- A bit-level packing format that's brotli-friendly downstream
- A way to ship many checkpoints cheaply
- A protocol with cross-language reference implementations
