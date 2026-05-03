# Weavepack FAQ

Honest answers to questions evaluators ask. Skip the marketing.

## Is weavepack always smaller than safetensors / JSON / msgpack + brotli?

**No.** For a single bundled blob (concatenate everything, then
brotli the result), brotli is hard to beat — it has access to the
whole byte sequence and exploits identical fp32 patterns or repeated
JSON keys aggressively. See
[`weavepack/profiles/tensor/examples/brotli-stacking.js`](profiles/tensor/examples/brotli-stacking.js)
for the measurements: in both sparse and dense ML workloads,
`safetensors + brotli` (one blob) typically beats `weavepack` alone
on raw byte count.

The win for weavepack is **per-payload addressability**, not
bundled compression. See next question.

## What does "per-payload addressability" actually mean?

Each payload in a weavepack chain is independently retrievable.
A consumer can fetch the chain bytes up to version N, decode them
as a complete chain, and reconstruct the state at version N — without
needing the rest of the chain. A single brotli'd blob can't give you
that: the entire stream must be decompressed to reach any one version.

This matters when:
- Payloads are billed independently (Arweave, IPFS, S3 Glacier-style
  per-object storage)
- A consumer needs random access into an edit history (e.g. "show me
  the config from 47 deployments ago")
- Network bandwidth is asymmetric (downloading a small prefix beats
  downloading the whole blob)

See [`weavepack/profiles/json/examples/chain-partial-restore.js`](profiles/json/examples/chain-partial-restore.js)
for a concrete demo: 100 versions of a JSON config in 616 bytes,
each independently restorable.

## Can I use this from Python?

Yes, two ways:

1. **Pure-Python PoC** at `impl/python/`. No external dependencies.
   Single-payload weavepack-json + full weavepack-tensor (encoder,
   decoder, delta application, schemaful + schemaless, all 5 delta
   ops including region_replace).

2. **PyO3 wheel** at `impl/rust/weavepack-tensor-py/`. Rust-backed
   bindings (faster, broader profile coverage). Build with `maturin
   develop` from that directory.

Both expose `parse_chain` / `serialize_chain`; the byte format is
identical.

## How does it compare to safetensors for ML?

For **single checkpoints**: weavepack is within 2% of safetensors
(see `weavepack/profiles/tensor/07-benchmarks.md`). No advantage.

For **chains of related checkpoints** (training runs, multiple
fine-tunes, time-series sensor data): weavepack's structural deltas
shine. Worked examples in
[`weavepack/profiles/tensor/examples/`](profiles/tensor/examples/)
show measured savings of 7×, 18×, and 30× vs. snapshot-per-step
safetensors. As the chain length grows, the advantage grows.

## Why not just use protobuf / Avro / Cap'n Proto?

They're schema-first formats designed for high-throughput RPC. They
don't pack bits below the byte level, don't support delta chains,
don't have profile-specific compression knobs (like the tensor
profile's region_replace heuristic). For RPC payloads, use protobuf;
for archived structural data with delta chains, use weavepack.

Trade-offs:
- protobuf is faster to encode/decode (no bit packing)
- protobuf has wider tooling support (codegen for ~12 languages)
- weavepack is smaller for the same data when chains exist
- weavepack's wire format is profile-specific (JSON-shaped vs
  tensor-shaped vs future shapes)

## What's "re-anchor" and why does my chain shrink after some updates?

A re-anchor happens when a JSON update is "too structural" to
express as a delta against the running state — e.g. swapping the
root from a primitive to an object, or replacing a primitive root
with a fresh value. In those cases, the encoder discards the
prior chain and emits a single fresh anchor payload.

Concretely:

```js
const arj = new ARJSON({ json: { a: 1 } })
arj.update({ a: 2 })       // delta added: deltas.length = 2
arj.update({ a: 3 })       // delta added: deltas.length = 3
arj.update("primitive")    // RE-ANCHOR: deltas.length = 1
```

`toBuffer()` after re-anchor returns just the fresh anchor's bytes.
This is by design (see `weavepack/core/05-deltas.md` §"Encoder
buffer policy on re-anchor"): it's simpler than carrying history
the receiver can't directly use, and matches the consumer model
"give me bytes that decode to the current state".

If you need durable history across re-anchors (e.g. for a
permanent ledger on Arweave), snapshot `arj.toBuffer()` to
external storage between updates. Each snapshot is its own
self-contained chain. **Do not concatenate two encoder outputs as
one chain** — multiple standalone anchors in a single chain buffer
is malformed and decodes incorrectly (the second anchor gets
mis-applied as a delta against the first).

## What happens if my schema changes mid-chain?

Each chain payload encodes its own structure. The schemaful tensor
mode hashes the schema and refuses to apply a delta when the schema
hash doesn't match — you'd need to start a new chain (anchor) when
the schema changes. The schemaless mode (default) doesn't enforce
this; consumers just see the new shape in the next payload.

For JSON, structural changes are first-class: an object can gain or
lose keys between payloads via `add` / `remove` ops; arrays can
splice. The strmap reuses across payloads (schemaful key dedup).

## What's the wire-format stability guarantee?

**v1.x JSON profile** is stable: 93 conformance vectors lock the
byte format. Any change requires an RFC (see
`weavepack/governance/01-rfc-process.md`).

**v0.1 tensor profile** is stable for the dtypes + ops it covers
(55 vectors). Future RFCs (e.g. fp16/bf16 in RFC 0001) extend
without breaking existing payloads.

**Profile boundary** is stable: the chain framing (LEB128 length-
prefixed payloads) and the protocol-vs-profile split are not going
to change.

See `weavepack/governance/03-versioning.md` for the formal policy.

## Why is the JS implementation called arjson and the protocol called weavepack?

Historical accident. ARJSON (Arweave-JSON) was the original
JSON-specific library, designed for permanent storage on Arweave.
When it generalized to a multi-profile protocol, the name "weavepack"
was chosen for the protocol; the JS library kept the arjson name on
npm (where the package is published).

The package is one and the same — `npm install arjson` gives you
the JS reference implementation of weavepack-json (and
weavepack-tensor, and the protocol substrate).

## How big is the test suite?

- 2184 sdk tests (JS)
- 2000+ property-based test cases per run (14 algebraic-law
  properties)
- 388 conformance vectors agreeing across 3 languages
  (JS / Rust / Python)
- 4 chain unit tests in Rust core, 5 chain tests in Python
- Cross-language CI runs on every push

See `weavepack/tools/cross-language-check.sh` for the headline
verification.

## Is this production-ready?

The wire format and JS reference: yes (in active use).
The Rust crates: yes for read-only / decoder use; encoder coverage
is L3 for single-payload values.
The Python PoC: proof-of-concept; use the Rust-backed PyO3 wheel
for production Python.

If you want to evaluate, run
`weavepack/tools/cross-language-check.sh` from the repo root —
all 388 vectors should pass in ~3 seconds.

## Where do I report bugs / propose changes?

Bugs: open an issue (or PR) at the repository where you got the code.

Spec/protocol changes: follow the RFC process in
`weavepack/governance/01-rfc-process.md`. RFC 0001 (fp16/bf16 in the
tensor profile) is the worked example of how a real change moves
from Discussion → Accepted.

Implementations: register your impl in
`weavepack/governance/05-implementation-registry.md` once it passes
the relevant conformance vectors. The barrier is "do the work", not
"ask permission".
