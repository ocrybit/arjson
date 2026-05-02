# weavepack property-based tests

Algebraic-law tests for the protocol. Each file generates random JSON
values from deterministic seeds and checks that a property holds across
all generated cases. See `weavepack/core/05-deltas.md` for the
normative statements of the laws being tested.

## Files

- `generators.js` — deterministic seed-driven JSON value generators
  (no external deps; uses an inline LCG)
- `round-trip.test.js` — `decode(encode(x)) ≡_JSON x`
- `delta-correctness.test.js` — `apply(delta(a, b), a) ≡_JSON b`,
  including self-delta no-op and chained-update equivalence
- `composition.test.js` — incremental and direct paths to a final
  state agree; identity updates are no-ops

## Running

```bash
cd sdk && npm run properties
```

Or run individual files:

```bash
node --test weavepack/properties/round-trip.test.js
```

## On failures

Each property test reports the **seed** that produced the failing
case. To regenerate that exact case:

```js
import { sampleAny } from "./generators.js"
const failing = sampleAny(SEED_FROM_REPORT)
```

Then debug from there. The seed-driven generators are fully
deterministic — same seed always produces the same value across
Node versions.

## Adding new properties

1. Add generators to `generators.js` if a new value shape is needed
2. Add a `.test.js` file with `describe(...)` blocks for each property
3. Update the npm script in `sdk/package.json` to include the new
   test file
4. Update this README with the property statement

## Coverage notes

The current property suite covers:

- Round-trip across primitive/object/array/any/deep cases (1100 cases per run)
- Delta correctness for random pairs, self-deltas, and chained updates
  (400 cases per run)
- Composition: chained vs direct paths to final state (200 cases per run)
- Idempotence: identity updates produce no extra payloads (200 cases per run)

NOT covered (deferred):

- Compression bound (`bit_length(encode(x)) ≤ K · entropy(x) + ε`)
  — requires entropy estimation; statistical not absolute
- Schema-driven properties (no schema profile yet)
- Adversarial inputs (covered by core security corpus, not properties)
- Cross-implementation equivalence (covered by conformance corpus,
  not properties)
