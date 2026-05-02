# weavepack-core — 08: Security and Adversarial Inputs

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies **security obligations** for weavepack
implementations: bounds, refusal rules, and defenses against
adversarial inputs.

weavepack is designed for permanent storage and untrusted-input
contexts (e.g., decoding arbitrary blobs from a public network).
A conforming decoder MUST be safe to invoke on adversarial input
without:

- Excessive memory allocation (DoS via decoder)
- Excessive CPU time (DoS via decoder)
- Stack overflow from deeply nested structures
- Reading past the end of the buffer
- Producing malformed output that crashes downstream consumers

This document is non-negotiable for production use. Implementations
that don't enforce these rules MUST NOT be deployed against
untrusted input.

## Bounds and limits

### Memory bounds

A decoder MUST bound the resources it allocates:

| Resource | Recommended cap | Why |
|---|---|---|
| Total payload size | configurable; default 64 MiB | Reject mega-bombs |
| Strmap entry count | configurable; default 2^20 (1 Mi) | Reject strmap-bomb |
| Total kref count | configurable; default 2^20 | Reject kref-bomb |
| Total vref count | configurable; default 2^20 | Reject vref-bomb |
| Recursion depth | configurable; default 256 | Reject deeply-nested |
| String length per entry | configurable; default 16 MiB | Reject string-bomb |
| Run-length L in dint / vlinks | bounded by remaining slots | Reject RLE-bomb |
| LEB128 chunks | configurable; default 10 | Reject leb128-bomb |

Caps are configurable: applications with legitimate large payloads
(e.g., a 64-MiB JSON document) can raise them. Defaults are
conservative for general public input.

### Time bounds

A decoder SHOULD complete in time linear in the **payload size**,
not in the **encoded structure size**. RLE expansion can decode to
arbitrarily large structures; the decoder MUST bound the expansion
at decode time, not at output time.

For example, a 100-byte payload that RLE-expands to a 10-MiB tree:

- Naive: decoder allocates 10 MiB
- Bounded: decoder caps RLE expansion at total kref/vref count

The decoder MUST refuse if expansion would exceed the configured
cap.

## Adversarial inputs and required refusals

The following input patterns MUST be rejected:

### Truncated payloads

A payload whose declared length doesn't match its actual data, or
whose column lengths exceed the remaining buffer, MUST be rejected
with a clear error.

The JS reference implementation throws specific errors for each
case:

- `"ARJSON decoder: read past end of buffer"` — n() request exceeds
  remaining bits
- `"ARJSON decoder: vflags length exceeds remaining buffer"` — column
  length implies reading past end
- `"ARJSON decoder: krefs run-length exceeds remaining flags"` — RLE
  count > remaining slots
- `"ARJSON decoder: vtypes run-length exceeds remaining slots"` —
  similar for vtypes column
- `"ARJSON decoder: invalid vflags mode"` — mode prefix is
  reserved value (3)

These error strings are non-normative; the message text MAY differ
across implementations. The behavior (raise distinct error per
failure mode) IS normative.

### Malformed mode bits / type tags

A payload whose:

- vtypes column carries values outside the profile's defined range
- ktypes column carries values outside the profile's defined range
- single-payload tag is outside the profile's defined range
- run-length escape is followed by an invalid count
- splice escape carries `index + remove > array length`

MUST be rejected. The decoder MUST NOT silently coerce invalid
values to defaults.

### Strmap collisions

A payload whose strmap declares two distinct strings at the same
index, or whose strmap reference points to an index that has not
been populated, MUST be rejected.

Similarly, a strdiff reference in `strdiffs` whose `pos` is past
the end of the prior string, or whose `len` exceeds the remaining
characters, MUST be rejected.

### Run-length bombs

The RLE flag prefix (modes 0 and 1: all-zeros / all-ones) compresses
arbitrarily long flag streams to 2 bits. A decoder MUST bound the
expansion: when the flag stream's count is read from chain header
or other context, the decoder MUST verify the count is sensible
before expanding.

Specifically: a payload whose chain header declares `len = 2^32 - 1`
but whose flag stream is 2 bits (mode 0) cannot be safely expanded
to 2^32 zero flags. The decoder MUST detect this via the kref/vref
count cap.

### Recursion bombs

For decoders using recursive descent (e.g., the JS reference's
`build()` method), deeply nested containers can exhaust the stack.

A decoder MUST bound the recursion depth (`build()` call depth)
at the configured cap. Implementations using iterative builds
(worklist + explicit stack) avoid this issue but should still
bound the worklist size.

### Strdiff bombs

A strdiff patch with many small inserts / deletes can produce a
string vastly larger than the patch. A decoder MUST bound the
output string length per the configured cap.

A patch whose ops imply a result string longer than the cap MUST
cause refusal.

### Buffer overflow attempts

A decoder MUST NOT trust any size declared in the payload without
checking against the actual buffer length. Specifically:

- The chain frame's LEB128 length MUST be checked against the
  remaining buffer
- Each column's length (derived from prior columns) MUST be checked
  against the remaining bit count

The JS reference implementation does these checks; other
implementations MUST follow.

## Decoder guarantees

A conforming decoder MUST guarantee:

1. **Termination**: every `decode(buf)` call terminates in time
   bounded by `O(buf.length)` (with the configured caps).

2. **No memory blowup**: total allocations during `decode(buf)`
   are bounded by `O(buf.length × constant)` for the configured
   caps. The constant accounts for typed-array allocations.

3. **No information leak via timing**: validity checks (mode bits,
   type tags) are constant-time so an attacker cannot probe the
   protocol state via timing side channels.

4. **No silent corruption**: any malformed input MUST produce a
   clearly-failed result, not a silently-incorrect result.

## Encoder guarantees

A conforming encoder MUST:

1. Not produce payloads exceeding the protocol-defined bounds (no
   strmap > 2^32 entries, no string > 2^32 chars, etc.)

2. Validate input before encoding: an input that contains a value
   outside the profile's value space (e.g., `BigInt` in JSON
   profile) MUST be coerced or rejected with a clear error, not
   encoded silently with undefined behavior.

3. Produce only deterministic output (Level 3 conformance) or
   semantically-equivalent output (Level 2). Random or non-
   deterministic encoding patterns MUST NOT be used; this would
   defeat hashing / signature schemes layered above.

## Cryptographic considerations

weavepack itself does NOT provide:

- Encryption: the wire format is plaintext. Apply encryption
  before / after weavepack as needed.

- Authentication: the wire format has no integrity check. Apply
  HMAC or signatures over the byte stream as needed.

- Confidentiality of structure: even encrypted, weavepack reveals
  the size and column structure of the payload via the byte
  count. Use this knowledge in conjunction with traffic analysis
  defenses if your threat model includes structure leakage.

## Hash / signature integration (informational)

For Level 3 conformance, the byte output is deterministic given
the input. This makes weavepack suitable for content-addressed
storage (hash the payload, address by hash) and for cryptographic
signatures (sign the payload, verify against the signed bytes).

Caveats:

1. Level 2 implementations are NOT byte-deterministic. Don't sign
   payloads from Level 2 encoders unless you're prepared to handle
   verification with multiple valid byte representations.

2. Strmap renumbering across deltas means the same logical update
   produces different byte sequences depending on the chain
   history. Sign each delta separately; don't try to compute a
   hash of the entire chain by hashing each delta independently
   and combining (unless your scheme accounts for renumbering).

3. The wire format is byte-stable but bit-stable only after
   the final byte pad. Implementations using bit-level
   verification must account for the trailing zero-pad bits
   being normative-but-arbitrary.

## Conformance test corpus (security)

Adversarial test vectors will live at
`weavepack/core/test-vectors/security/`. Each vector is shaped:

```json
{
  "name": "human-readable name",
  "description": "what attack this exercises",
  "input_bytes_hex": "hex bytes of the adversarial input",
  "expected_behavior": "refusal | clean-decode | bounded-decode",
  "expected_error_class": "string class of the error (if refusal)"
}
```

The corpus initially covers:
- Truncated payloads at every column boundary
- Run-length bombs (max counts)
- Strmap bombs (max entries)
- Recursion bombs (max depth)
- Invalid mode prefixes / type tags
- Strdiff bombs

Implementations passing the security corpus MUST refuse each
adversarial input cleanly (with the expected error class) AND
MUST NOT exceed configured resource bounds when processing.

## Open issues

1. **Bounds harmonization across profiles**: each profile may
   define stricter bounds than the core defaults. Should the
   core impose minimums (e.g., "every implementation MUST cap
   strmap at 2^32")?

2. **Streaming security**: streaming-mode decoding (incremental
   processing of a large payload) has its own security model
   not currently specified.

3. **Differential privacy**: a payload's column sizes leak
   information about the encoded structure. For high-sensitivity
   contexts, padding to fixed sizes may be needed; not currently
   specified.
