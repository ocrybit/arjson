# weavepack-tensor — 03: Paths

**Status:** Draft. Phase 5 of the weavepack roadmap.

## Scope

This document specifies the **path grammar** of weavepack-tensor.
Paths identify positions within a tensor document for delta
operations: a specific tensor by name, or a specific element /
region within a tensor.

## Grammar

```
path             = tensor-path | element-path | region-path

tensor-path      = name
                 ; refers to the entire tensor as a unit

element-path     = name "[" index-list "]"
                 ; refers to a single element

region-path      = name "[" range-list "]"
                 ; refers to a multi-dimensional contiguous region

name             = utf8-byte+
                 ; UTF-8 bytes of the tensor name
                 ; same as keys in the document map

index-list       = index ("," index)*
index            = digit+
                 ; non-negative integer

range-list       = range ("," range)*
range            = index | index ":" index
                 ; "5:10" means [5, 10)  (5 inclusive, 10 exclusive)
                 ; "5"    means [5, 6)    (single index, equivalent to index)
```

## Examples

| Path | Refers to |
|---|---|
| `transformer.layers.0.attn.q_proj.weight` | The entire q-proj weight tensor |
| `embedding[42]` | Element 42 of a 1-D tensor `embedding` |
| `weight[0, 5]` | Element at row 0, column 5 of a 2-D tensor |
| `weight[0:64, :]` | First 64 rows of `weight` (`:` means all columns) |
| `weight[0:64, 0:64]` | Top-left 64×64 block |
| `weight[0:64, 0:64, :, :]` | Top-left 64×64 in the first two dims, all of remaining |
| `bn.running_mean` | A buffer (non-parameter) tensor |

## The colon shortcut

The colon `:` matches "all values along this axis". For an N-D
tensor, the path MUST have an index or range for every axis (or
end with `:` to fill remaining axes implicitly).

```
weight[:]          → all rows of a 1D tensor (equivalent to whole tensor)
weight[0, :]       → row 0 of a 2D tensor
weight[:, 0]       → column 0 of a 2D tensor
weight[0]          → row 0 of a 2D tensor (implicit : for remaining)
```

For deltas targeting a whole tensor, prefer the bare name (no
brackets) over `name[:]` — both are equivalent but the former is
more compact in the wire format.

## Disambiguation

- A tensor name MAY contain dots (`.`); they are part of the name,
  not path separators (unlike the JSON profile). A dot inside a
  tensor name is treated literally.
- Brackets `[`, `]` cannot appear in tensor names. If a name
  somehow contains them, they MUST be escaped via `\[` and `\]`
  (escape rules same as the JSON profile's path grammar).
- The path grammar has no equivalent to JSON's `.<key>` separator;
  tensor documents are flat dictionaries, not nested trees.

## Path encoding on the wire

Paths in delta operations are encoded as:

1. Tensor name (looked up in schema or strmap; emitted as
   strmap-index in delta payloads)
2. Optional index/range list (for sub-tensor ops)

The wire format for a per-element index list:

```
short()  : index count (number of dimensions referenced)
for each dim:
  leb128()   : the index
```

The wire format for a region (range list):

```
short()  : range count
for each dim:
  short()  : 0 = single index, 1 = range, 2 = wildcard (":")
  if 0:    leb128() (index)
  if 1:    leb128() (start) + leb128() (end)
  if 2:    no payload
```

Deltas affecting whole tensors emit only the tensor name with no
index/range payload.

## Path consumption (decoder)

When a delta op is applied:

1. Parse the path: tensor name + optional indices/ranges.
2. Look up the tensor in the document by name.
3. If indices are present:
   - Validate against the schema's declared shape (out-of-range
     indices MUST cause refusal).
   - Compute the element / region offset within the data block.
4. Apply the op (replace, region-replace, etc.).

## Path equivalence

Two paths are equivalent iff they identify the same set of elements:

- `weight` ≡ `weight[:]` ≡ `weight[:, :, :, :]` (for the rank
  matching the tensor)
- `weight[5]` ≡ `weight[5, :]` (for a 2D tensor; trailing `:`
  implicit)
- `weight[5:6]` ≡ `weight[5]` (single-element range = index)

The encoder produces canonical paths (smallest valid form). Two
canonical paths that identify the same elements MUST be the same
string.

## Limitations

These are deliberately deferred:

- **Ellipsis `...`**: NumPy supports `weight[..., 0]` to mean
  "all leading dims, last dim 0". v0.1 does not; spell it out
  with `:`.
- **Stride / step**: NumPy supports `weight[0:10:2]` (step 2). v0.1
  does not; only contiguous regions are supported in path syntax.
- **Negative indices**: `weight[-1]` (last element). v0.1 does not;
  use the explicit positive index.
- **Boolean / fancy indexing**: `weight[mask]` or `weight[indices]`.
  v0.1 does not. These would require a more general op set.

## Conformance

A conforming tensor decoder MUST parse the path grammar above and
reject malformed paths with a clear error.

A conforming encoder MUST emit canonical paths (no equivalent
forms; the smallest valid representation).

## Test vector references

Path grammar test vectors live at
`weavepack/profiles/tensor/test-vectors/paths/` (to be populated
in Phase 5.6).
