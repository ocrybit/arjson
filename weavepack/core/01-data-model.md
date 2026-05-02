# weavepack-core — 01: Data Model

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the abstract data model underlying weavepack:
the **columnar representation** of structural data, the **typed
streams** that carry values, and the **reference structure** that
links them. It is profile-agnostic — the model applies equally to
JSON, tensors, graphs, tabular data, etc.

## The columnar abstraction

A weavepack payload represents a structured value (a tree, a graph,
a flat record set, etc.) as a tuple of **typed column streams**. The
columns, taken together, allow the decoder to reconstruct the original
structure.

This is the same idea Apache Arrow / Parquet apply to dataframes,
generalized to arbitrary structural data. The key insight is:

> Structured data has structural redundancy that byte-stream compression
> cannot see. By emitting same-typed values into separate columns, the
> redundancy is exposed to dedup, run-length, and bit-packing primitives.

For a JSON tree, this means: all the integers in the tree go into one
column (`nums`), all the strings into another (`strs`), all the
parent-of-leaf indices into another (`vrefs`), etc. Repeated keys go
into a strmap dedup table once, and the rest of the payload references
them by index.

For a tensor, this means: the parameter values go into a column
(possibly a typed `float32` or `int8` column), the tensor shape goes
into a separate small column, etc.

The columnar abstraction is what enables weavepack to outperform
self-describing alternatives like JSON, CBOR, or MessagePack: the
self-describing tag overhead disappears (the column is the type),
and structural regularities compress freely.

## The column registry

Every weavepack payload is composed of columns drawn from a fixed
**core column registry**. Profiles MAY add profile-specific columns
via the extension gate (`07-extensions.md`), but the core registry
is the canonical set every implementation MUST handle.

| Column | Purpose | Bit-level form |
|---|---|---|
| `dc` | Document control: wire mode, single-payload header, query metadata | mixed (1-bit mode, 7-bit single tag, varint metadata) |
| `vrefs` | For each leaf, the parent kref index | delta-pack with RLE |
| `krefs` | For each key step, the parent kref index | delta-pack with RLE |
| `vflags` | 1 bit per leaf indicating delta-pack vs absolute | RLE-prefixed bitstream |
| `kflags` | 1 bit per kref indicating delta-pack vs absolute | RLE-prefixed bitstream |
| `ktypes` | Per-kref type discriminator (profile-defined width) | bit-packed |
| `keys` | Object keys / array indices / string-key lengths | profile-defined |
| `kvals` | Character data for string keys | base64url-6 or LEB128 per char |
| `vtypes` | Per-leaf value type discriminator (profile-defined width) | bit-packed with run-length escape |
| `bools` | Boolean values | RLE-prefixed bitstream |
| `nums` | Integer / float values | delta-pack |
| `vals` (a.k.a. `strs`) | String values | length + base64url-6 or LEB128 |
| `strmap` | Deduplicated string table | section header + per-entry data |
| `strdiffs` | Fast-diff patches for incremental string updates | byte-aligned patch stream |

The columns are emitted in a specific order on the wire
(`02-wire-format.md`). Some columns may be empty for a given payload
(e.g., a payload with no booleans has zero `bools` bits). Each column
carries its own length information so the decoder can skip empty ones.

## The reference structure

The two **reference columns** (`vrefs` and `krefs`) form a tree:

- Each leaf value contributes one entry to `vrefs`. The value of
  `vrefs[i]` is an index into `krefs` pointing to the immediately-
  enclosing key step.
- Each key step contributes one entry to `krefs`. The value of
  `krefs[k]` is an index into `krefs` pointing to the parent key
  step. A `krefs[k]` of 0 means "root level".

Leaf values are recovered by walking the kref chain from `vrefs[i]`
back to root. Each kref step contributes one path component (a key
or an index, depending on `ktypes[k]`).

This representation is **flat** — there are no nested containers in
the encoding itself; nesting is reconstructed during decode by walking
the references. Flatness is what makes columnar dedup, RLE, and bit-
packing applicable; it's the central design choice.

### Delta-pack encoding of refs

The reference values themselves are encoded with **delta-pack** — a
1-bit flag indicates whether each value is an absolute index or a
small delta from the previous value. This compresses well for the
common case of consecutive leaves sharing a parent (e.g., elements
of an array), where the delta is `+1` or `0`.

Details in `03-bit-encoding.md` (delta-pack section).

## Single-payload mode

For payloads encoding a single primitive value (a single number, a
single string, `null`, or an empty container), the columnar
representation has too much overhead. A **single-payload mode** is
defined that bypasses the columns and emits a compact tagged value
in `dc` directly.

The wire envelope's leading bit selects the mode:

- `1` → single-payload mode
- `0` → structured mode

In single-payload mode, all columns except `dc` are absent. The
decoder reads a profile-specific tagged value from `dc` and returns
it.

In structured mode, all columns are present (some may be empty) and
the decoder walks them per `02-wire-format.md`.

The criteria for single-payload eligibility are profile-specific
(`profiles/<name>/`). For the JSON profile, single-payload mode is
used iff the value is a primitive, an empty array, or an empty object.

## Profile-defined fields

Within the core data model, some fields are intentionally
underspecified — they're filled in by each profile.

### Type vocabulary (vtypes)

Each profile MUST define:

- The set of value types it encodes
- The bit width of the `vtypes` column entries
- The mapping from type to value-column (e.g., type 4 → `nums`)
- The encoding of any type-specific metadata (e.g., string length,
  number precision)

For the JSON profile (`profiles/json/01-types.md`):
- 8 value types in 3 bits
- type 0: undefined (internal); type 1: null; type 2: string-base64url;
  type 3: bool; type 4-6: numbers; type 7: string-fallback

Other profiles use different type tables.

### Container vocabulary (ktypes)

Each profile MUST define:

- The set of container shapes (object-like, array-like, etc.)
- The bit width of the `ktypes` column entries
- How keys are encoded for each shape

For the JSON profile (`profiles/json/02-containers.md`):
- 4 container shapes in 2 bits
- 0: array index; 1: object key (numeric placeholder); 2: object key
  (base64url string); 3: object key (fallback string)

### Schema (optional)

A profile MAY declare a schema language. When present, the schema
sidecar (`06-schemas.md`) carries field definitions that further
constrain the encoded data — turning a self-describing weavepack
payload into a schema-driven one with bit-level entropy approaching
the Shannon bound.

Schemaless profiles emit type-discriminator columns (vtypes/ktypes)
inline. Schemaful profiles MAY omit these columns when the schema
fixes the types statically.

## Single-source-of-truth: the ARTable

The decoder reconstructs the columns into an in-memory structure
called the **ARTable** (named for historical reasons; "ARJSON Table").
The ARTable is profile-agnostic in shape:

```
ARTable {
  vrefs:    int[]
  krefs:    int[]
  ktypes:   ktype[]
  keys:     key[]
  vtypes:   vtype[]
  bools:    bool[]
  nums:     number[]
  strs:     string[]
  strmap:   { index: string }
  strdiffs: bytes[]
}
```

Where `ktype`, `vtype`, and `key` types are profile-specific.

The ARTable IS the materialized state of a payload. To recover the
JSON value (or tensor, or graph), a profile-specific **build()**
function walks the ARTable and produces the data structure.

The ARTable is what consumer applications cache for fast random-access
queries (e.g., weavedb's `__deltas__/<key>` KV cache stores
ARTables). The protocol does not specify a binary serialization for
the ARTable; consumers may serialize it however they please. A
future profile feature MAY define a normative ARTable serialization
for inter-implementation cache compatibility.

## Why columnar (not nested)?

This design choice is foundational. The argument:

1. **Nested encoding** (JSON, CBOR, MessagePack) emits each leaf with
   inline type tags and delimiter overhead. Per-leaf overhead is
   typically 1-3 bytes of tags + structural delimiters.

2. **Columnar encoding** emits each leaf's value into its typed
   column with no per-leaf tag — the column IS the type. Per-leaf
   overhead is the value's bit-packed size only.

3. For a payload of N leaves, columnar saves ~1-3 bytes per leaf
   relative to nested. For N=1000 leaves, that's 1-3 KB of pure
   overhead removed.

4. **Run-length and dedup** work naturally on columnar data. A
   column of 1000 same-typed booleans compresses to O(1) bits via
   the RLE prefix. A column of 1000 references to the same parent
   compresses to O(log N) via delta-pack.

5. **Schema awareness**, when applied, can eliminate the type
   columns entirely — the schema fixes types, the columns carry
   only values.

The cost of columnar is loss of streaming-decode (you need the
whole payload to walk the refs). For weavepack's use case
(append-only chains, permanent storage, full-state recovery on
read), this is the right tradeoff.

## Capacity bounds

These are protocol-level bounds that all implementations MUST honor:

- **Maximum kref count** per payload: 2^32 - 1 (32-bit refs)
- **Maximum vref count** per payload: 2^32 - 1
- **Maximum strmap size** per payload: 2^32 - 1 entries
- **Maximum string length** per single string: 2^32 - 1 chars
- **Maximum nesting depth**: not bounded by protocol; bounded by
  implementation (recursive decoders may stack-overflow on adversarial
  input — see `08-security.md`)

These bounds are far above realistic use cases. Implementations MAY
impose tighter bounds (e.g., reject payloads with more than 2^20 refs)
for DoS resistance; doing so is normative if documented.

## Forward references

Subsequent core docs build on this model:

- `02-wire-format.md` specifies the byte layout of the columns.
- `03-bit-encoding.md` specifies the bit-level encoding of each
  primitive (short, uint, leb128, etc.).
- `04-strmap.md` specifies the strmap interning protocol.
- `05-deltas.md` specifies how columns chain across deltas.
- `06-schemas.md` specifies the optional schema sidecar.

Profile docs (e.g., `profiles/json/01-types.md`) plug profile-specific
decisions into this model.
