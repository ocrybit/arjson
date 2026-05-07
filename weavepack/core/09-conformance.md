# weavepack-core — 09: Conformance

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies **core-level conformance** — the obligations
an implementation must satisfy to claim conformance to weavepack-core,
independent of any specific profile. Per-profile conformance is in
each profile's `05-conformance.md`.

## Conformance hierarchy

Three levels (matching the JSON profile's hierarchy):

### Level 1 — Core decoder

The implementation correctly decodes byte sequences produced by a
reference encoder for any **registered profile** the implementation
supports. A Level 1 core decoder is profile-aware: it dispatches
the profile-id to the appropriate per-profile decoder.

A Level 1 implementation MUST:

- Read the wire mode bit and dispatch to single-payload or
  structured mode
- Read the extension gate (if present) and either handle the
  extension or refuse cleanly
- Decode the chain framing (LEB128 length-prefixed)
- Apply the bit-encoding primitives (`short`, `uint`, `leb128`,
  `dint`, RLE flag prefix, delta-pack) per `03-bit-encoding.md`
- Maintain the strmap protocol per `04-strmap.md`
- Apply delta semantics per `05-deltas.md`
- Honor security bounds per `08-security.md`

A Level 1 implementation MAY support a subset of registered
profiles — e.g., a JSON-only decoder. The implementation MUST
gracefully refuse payloads for unsupported profiles via the
extension gate's unknown-extension rule.

### Level 2 — Core encoder

The implementation correctly encodes structured data into byte
sequences accepted by a reference Level 1 decoder. The encoded
payloads MAY be byte-different from a reference encoder's output
but MUST round-trip via the reference decoder.

A Level 2 implementation MUST:

- Produce structurally valid payloads (bit ordering, column
  sequencing, RLE prefix selection, padding)
- Correctly emit chain framing for delta sequences
- Maintain the strmap protocol when encoding strings
- Produce delta payloads satisfying delta-correctness
  (`05-deltas.md`)
- Support every column the supported profile defines
- Honor encoder-side security guarantees (`08-security.md`)

### Level 3 — Reference encoder

The implementation produces **byte-equivalent** output to the JS
reference for all conformance corpus inputs. Required for:

- Canonical hashing (content-addressed storage)
- Cryptographic signatures
- Inter-implementation cache compatibility
- Determinism across deployments

Level 3 requires Level 2, plus:

- Use the same RLE thresholds (run if count ≥ 4 for vlinks/klinks,
  count ≥ 3 for nums)
- Use the same single-payload tag selection
- Use the same insertion order for the strmap (depth-first encode-
  walk order)
- Use the same precision rounding for floats (precision = digit
  count after the point, capped at 308)

For a profile to support Level 3 conformance, the profile MUST
fully specify all such thresholds.

## Test corpus structure

The core-level conformance corpus lives at
`weavepack/core/test-vectors/`:

```
test-vectors/
├── primitives/                   bit-encoding primitives
│   ├── short.json
│   ├── uint.json
│   ├── leb128.json
│   ├── dint.json
│   ├── rle-prefix.json
│   └── delta-pack.json
├── strmap/                       strmap protocol
│   ├── single-payload-charmap.json
│   ├── interning-order.json
│   ├── reference-vs-literal.json
│   └── compact.json
├── chains/                       delta chain framing
│   ├── single-payload-chain.json
│   ├── short-chain.json
│   ├── long-chain.json
│   └── reanchor-chain.json
├── extensions/                   extension gate (forward-compat)
│   ├── no-extension.json
│   ├── known-extension.json
│   └── unknown-extension-refusal.json
└── security/                     adversarial inputs
    ├── truncated-payloads.json
    ├── runlength-bombs.json
    ├── strmap-bombs.json
    ├── recursion-bombs.json
    ├── strdiff-bombs.json
    └── invalid-tags.json
```

Each test vector follows the same JSON shape as profile-level
vectors (see e.g. `profiles/json/test-vectors/README.md`).

## Profile / core split

The core-level corpus tests profile-agnostic primitives. Profile-
specific behavior (e.g., "what value type is at JSON's vtype 4")
is in profile-level corpora.

A complete conformance suite for an implementation that supports
the JSON profile is:

```
core test-vectors PASS
  + profile/json test-vectors PASS
```

Both must pass for end-to-end conformance.

## Acceptance criteria

For each level:

- **Level 1**: 100% of decoder-relevant vectors PASS
- **Level 2**: 100% of round-trip-via-reference-decoder vectors
  PASS
- **Level 3**: 100% of byte-exact vectors PASS

A conformance run produces a structured report:

```
Implementation: ImplName vX.Y.Z
Level claim: 2

[Core conformance]
  primitives/short.json: PASS (10 / 10 vectors)
  primitives/uint.json:  PASS (10 / 10 vectors)
  ... etc ...

[Profile conformance: json]
  types/primitives: PASS (45 / 45 vectors)
  ... etc ...

Result: PASS at Level 2 (claimed level)
       FAIL at Level 3 (3 vectors with byte mismatch)
```

## Reference implementation

The JS implementation in `sdk/src/` is the reference for v1.x.
Implementations in other languages MUST agree with the JS
implementation on all corpus vectors. Disagreements between
implementations are resolved by checking the corpus; if the
JS implementation diverges from the spec, this is a JS bug
(file an issue).

For v2.x and beyond, a normative prose specification will be
the source of truth, and reference implementations will be
adversarial implementations that conform to the spec.

## Tooling

The core conformance test runner will be packaged with each
reference implementation:

```bash
cd sdk
npm run conformance:core
npm run conformance:json     # also runs core (transitive dependency)
npm run conformance          # runs all
```

The runner accepts:

```bash
--level [1|2|3]              # claim a specific level
--profile [json|tensor|...]  # restrict to one profile
--vectors [path/to/dir]      # alternate corpus location
--fail-fast                  # stop at first failure
--verbose                    # detailed output per vector
```

Other-language runners SHOULD follow the same CLI convention so
multi-implementation conformance matrices can be auto-generated.

## Reporting and registry

Implementations that pass the conformance suite MAY claim conformance
publicly. A registry of conforming implementations will be maintained
at the profile registry described in `07-extensions.md`.

The registry entry for an implementation includes:
- Implementation name and version
- Languages / platforms supported
- Profiles supported
- Conformance level claimed
- Last verified date
- Link to the test report

Implementations are encouraged to re-verify against new corpus
versions when published.

## Open issues

1. **Tooling cross-language**: a Python or Rust implementation
   needs its own runner. The corpus format is JSON, so portable;
   the runner is per-language.

2. **Performance benchmarks**: not part of conformance per se,
   but a comparison harness across implementations would be
   valuable. Possibly Phase 6+.

3. **Adversarial corpus expansion**: the security corpus grows
   as new attack vectors are discovered. Versioned corpus
   releases will follow. Current corpus at
   `weavepack/core/test-vectors/security/` (13 vectors, 4 files):
   truncated-payloads (3), invalid-mode-tags (4),
   runlength-bombs (3: vrefs, vtypes, krefs),
   column-overflow (3: vflags, string-length, key-length).
   Initial release 2026-05-07 (11 vectors); expanded 2026-05-07
   (+2: krefs run-length bomb, key-length column overflow).
