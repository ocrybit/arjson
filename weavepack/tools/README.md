# weavepack/tools/

Build, verification, and corpus-generation tools.

## Verification

| Script | What it does |
|---|---|
| [`cross-language-check.sh`](./cross-language-check.sh) | Runs every implementation's conformance binary in turn; prints a colored summary. Fails if any implementation reports failures. **Headline check.** |
| [`run-examples.sh`](./run-examples.sh) | Smoke-runs every worked example under `weavepack/profiles/*/examples/`. Catches example bitrot if JS/Python APIs drift. |
| [`verify-test-vectors.js`](./verify-test-vectors.js) | JS-side verifier: walks the corpus and validates the JS reference reproduces every `expected_bytes_hex` and `expected_chain_bytes_hex` byte-exact. |

Run all three from the repo root:

```bash
bash weavepack/tools/cross-language-check.sh
bash weavepack/tools/run-examples.sh
node weavepack/tools/verify-test-vectors.js
```

## Corpus generation

| Script | Output |
|---|---|
| [`generate-test-vectors.js`](./generate-test-vectors.js) | JSON profile vectors under `weavepack/profiles/json/test-vectors/` |
| [`generate-tensor-vectors.js`](./generate-tensor-vectors.js) | Tensor profile vectors under `weavepack/profiles/tensor/test-vectors/` |
| [`gen-tensor-half-vectors.js`](./gen-tensor-half-vectors.js) | RFC 0001 fp16/bf16 vectors |
| [`gen-tensor-region-vectors.js`](./gen-tensor-region-vectors.js) | region_replace delta vectors |

Generators use the JS reference encoder, so re-running them
produces byte-identical output unless the wire format itself
changes. Adding a new vector category typically means adding a
new generator + extending `verify-test-vectors.js` to recognize
the new vector schema.

## Benchmarks

| Script | What it measures |
|---|---|
| [`benchmark-tensor.js`](./benchmark-tensor.js) | weavepack-tensor vs safetensors size + delta efficiency on synthetic models |

Benchmark numbers feed into
`weavepack/profiles/tensor/07-benchmarks.md`.
