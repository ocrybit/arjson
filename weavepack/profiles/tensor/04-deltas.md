# weavepack-tensor — 04: Deltas

**Status:** Draft. Phase 5 of the weavepack roadmap.

## Scope

This document specifies the **delta operation vocabulary** of
weavepack-tensor and how each op is encoded on the wire. The chain
semantics inherit from `weavepack-core/05-deltas.md`; this profile
defines the op set tailored to tensor data.

## Operation set

Six operations cover the tensor update space:

| Op | Wire code | Purpose |
|---|---|---|
| `tensor_replace` | 0 | Replace an entire tensor with new values (same dtype + shape) |
| `tensor_add` | 1 | Add a new tensor to the document |
| `tensor_remove` | 2 | Remove a tensor from the document |
| `region_replace` | 3 | Replace a contiguous region within a tensor |
| `element_set` | 4 | Replace a sparse list of individual elements |
| `quant_change` | 5 | Re-quantize a tensor with new scale/zero-point |

The op code is 3 bits. Codes 6-7 are reserved.

## Per-op encoding

### `tensor_replace` (code 0)

```
op code         : 3 bits = 000
tensor name id  : strmap-index referencing the tensor
new data block  : new tensor data, same dtype/shape as before
```

The replaced tensor MUST exist in the base document with the same
dtype and shape. If shape or dtype changes, use `tensor_remove` +
`tensor_add` instead.

### `tensor_add` (code 1)

```
op code              : 3 bits = 001
tensor name (literal): UTF-8 bytes (with strmap intern if shareable)
dtype                : 5 bits
shape                : rank (short) + dims (LEB128 each)
quant metadata       : if dtype is quantized
data block           : new tensor data
```

The added tensor MUST NOT already exist with the same name in the
base document.

### `tensor_remove` (code 2)

```
op code         : 3 bits = 010
tensor name id  : strmap-index
```

The removed tensor MUST exist in the base document.

### `region_replace` (code 3)

```
op code         : 3 bits = 011
tensor name id  : strmap-index
rank            : short() — number of dims being addressed
range list      : per dim, range encoding from 03-paths.md
new data block  : (region elements) × (dtype bits)
```

The new data block holds exactly `product(range_extent_i for i in dims)`
elements. The decoder writes them into the base tensor at the
specified region.

Order of elements in the data block matches the order of iteration
through the region: outermost dim varies slowest, innermost fastest
(C-style row-major).

### `element_set` (code 4)

For sparse updates — a list of (index, value) pairs:

```
op code            : 3 bits = 100
tensor name id     : strmap-index
element count      : leb128
for each element:
  index list (rank × leb128)
  value (dtype bits)
```

When fewer than 30% of the tensor's elements change, this is more
compact than `region_replace` over a bounding box.

The encoder picks `element_set` vs `region_replace` based on the
density of changes within the bounding box of changed elements:
- If changed elements are < 50% of bounding box: emit `element_set`
- Otherwise: emit `region_replace` over the bounding box

### `quant_change` (code 5)

For re-quantization (rare but useful for QAT pipelines):

```
op code         : 3 bits = 101
tensor name id  : strmap-index
new scale       : fp32
new zero_point  : matching int dtype
new data block  : re-quantized tensor data
```

The dtype and shape don't change; only the scale + zero_point and
the underlying integer values change.

## Delta heuristics

The differ produces ops by walking the tensor name space:

```
for each name in (base.tensors ∪ new.tensors):
  if name in new but not base: emit tensor_add
  if name in base but not new: emit tensor_remove
  if name in both:
    if base[name].dtype != new[name].dtype OR
       base[name].shape != new[name].shape:
      emit tensor_remove + tensor_add
    elif (changed_elements / total_elements) > 0.5:
      emit tensor_replace
    elif changed_elements form a tight bounding box:
      emit region_replace
    else:
      emit element_set
    if quantization params changed:
      emit quant_change
```

Threshold tuning is per-profile; the 0.5 threshold for full vs
partial is a starting point. Workloads vary.

## Compression beyond delta

For training scenarios where most parameters change a tiny amount,
delta-from-prior arithmetic can dramatically shrink updates:

```
new_value[i] = base_value[i] + small_diff[i]
```

If `small_diff[i]` fits in fewer bits than `new_value[i]` (e.g.,
fp32 values changing by < 0.001 each step), the delta storage is
much smaller than the absolute values.

This is implemented as a **sub-mode** of `tensor_replace`:

```
op code            : 3 bits = 000
tensor name id     : strmap-index
mode bit           : 1 bit (0 = absolute values, 1 = delta-from-prior)
data block         : (mode=0) raw values
                   : (mode=1) per-element delta, same dtype as base
```

The decoder, on seeing `mode=1`, computes `new = base + delta` per
element. The data block is fp/int subtraction-amenable (the
underlying type is unchanged; addition is element-wise).

For quantized tensors, this is element-wise delta on the integer
values (not the dequantized fp values), preserving exact round-trip.

## Re-anchoring

A weavepack-tensor chain re-anchors when:

1. The base document was empty and a new tensor is added (the first
   payload is naturally the anchor).
2. A schema change occurs (new tensors added with different shapes
   or dtypes from any existing tensor).
3. The accumulated delta size exceeds 50% of a fresh anchor (the
   encoder periodically emits a snapshot to cap chain growth).

Re-anchoring follows the core spec (`weavepack-core/05-deltas.md`):
the new payload is structurally a fresh anchor; the chain
conceptually restarts from that point.

## Algebraic laws

Inherited from weavepack-core. Specific to tensor profile:

### Round-trip
```
∀ tensor T:  decode(encode(T))  ==  T  (bit-exact)
```

For numerical dtypes, no coercion: every bit is preserved including
NaN signaling bits.

### Delta correctness
```
∀ documents A, B:  apply(delta(A, B), A)  ==  B  (bit-exact)
```

### Composition
```
∀ A, B, C:  apply(chain(delta(A, B), delta(B, C)), A)  ==  C
```

### Identity delta
```
∀ A:  delta(A, A)  is empty
```

### Region replace algebra
```
region_replace(T, range, values) +
region_replace(T, sub_range, sub_values)
=
region_replace(T, range, values_with_sub_overlay)
```

Two region replaces over overlapping regions compose to a single
region replace where the second's values override the first's in
the overlap. This is used by the encoder for chain compaction.

## String diff (strdiff)

Tensors don't have string content (other than names), so the
strdiff machinery from the JSON profile is unused. Tensor name
changes use whole-name replacement via strmap.

## Out of scope for v0.1

- **Sparse-pattern updates** beyond `element_set` (e.g., update a
  specific row pattern). v0.1 has element_set + region_replace;
  v0.2 may add row/column-specific ops if benchmarks justify.

- **Compressed deltas** (e.g., entropy-coded element_set values).
  Deferred until benchmarks show the simple bit-pack form is the
  bottleneck.

- **Per-element type promotion** (e.g., one element changes from
  fp16 to fp32). This is a dtype change which falls under
  remove+add at the tensor level. Per-element type heterogeneity
  is forbidden.

- **Transactional multi-tensor updates** (atomicity guarantees).
  weavepack-tensor is bytes; transactional semantics are caller's
  responsibility.

## Conformance

A Level 1 tensor decoder MUST handle all 6 ops + the delta-from-prior
sub-mode of tensor_replace.

A Level 2 tensor encoder MUST produce decodable deltas satisfying
delta-correctness.

A Level 3 tensor encoder MUST byte-match the reference for the
same input pair (base, new) + heuristic thresholds.

## Test vector references

Delta operation test vectors live at
`weavepack/profiles/tensor/test-vectors/deltas/`:

| Subdirectory | Vectors | Coverage |
|---|---|---|
| `tensor_replace/` | 4 | mode=0 absolute; one no-op |
| `tensor_add_remove/` | 4 | add + remove with various dtypes |
| `element_set/` | 2 | sparse fp32 + int32 element-set |
| `region_replace/` | 4 | bbox region updates |
| `delta_from_prior/` | 3 | mode=1 raw-delta tests (decoder-only via `delta_bytes_hex` field; encoder doesn't yet emit mode=1) |

All vectors verified in JS, Rust, and Python implementations
(58/58 in each).
