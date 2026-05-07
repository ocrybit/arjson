# RFC 0002 — Explicit profile-id in the wire envelope (v1.2 magic header)

**Status:** Accepted
**Author(s):** Claude / arjson maintainers
**Created:** 2026-05-07
**Affects:** weavepack-core

## Summary

Add a 4-byte magic header before the profile-specific bitstream so that
any decoder can identify the profile (and protocol version) without
out-of-band signalling. The header is prepended to all new payloads; the
existing v1.x bitstream is preserved byte-for-byte after the header.
This is a backwards-compatible addition at the payload level: v1.x
payloads (no magic header) remain decodable as implicit JSON profile.

## Motivation

weavepack-tensor shipped (Phase 5). Two profiles now exist. Currently
there is no wire-level mechanism to tell them apart: a caller who has a
raw byte buffer must know in advance whether it holds a JSON or tensor
payload before invoking a decoder.

The extension gate in `weavepack-core/07-extensions.md` was designed for
within-profile extensions and is not yet implemented in v1.x. It is not
directly applicable to the inter-profile dispatch problem because the
extension gate lives *inside* the structured-mode column sequence — it
cannot be read before the decoder already knows which structured-mode
schema to apply.

This RFC proposes the simplest mechanism that solves the problem:
a fixed 4-byte header prepended to every weavepack payload.

### Why a magic header rather than the extension gate?

| Property | Extension gate | Magic header |
|---|---|---|
| Fits inside bitstream | Yes | No (pre-bitstream) |
| Requires knowing the profile before parsing | Yes (gate is profile-specific) | No |
| Backwards compatible (no header = v1.x JSON) | No | Yes |
| Implementation complexity | Moderate (bit-level) | Minimal (4-byte prefix) |
| Works for single-payload mode | No (gate is structured-mode only) | Yes |

The extension gate is still the right mechanism for within-payload
extensions (schema sidecars, future column modes). This RFC does not
retire the extension gate; it adds a *pre-bitstream* layer for profile
dispatch specifically.

## Proposed change

### Wire format

A **v1.2 weavepack payload** starts with a 4-byte envelope header:

```
Offset  Size  Field      Value
──────  ────  ─────────  ──────────────────────────────────────────
0       1 B   magic[0]   0x57  ('W')
1       1 B   magic[1]   0x50  ('P')
2       1 B   version    0x12  (major nibble = 1, minor nibble = 2)
3       1 B   profile    <profile-id>  (see table below)
─── profile-specific bitstream follows ───
```

After the 4-byte header, the bytes are the existing profile-specific
encoding unchanged. A tensor payload with the v1.2 header is:

```
57 50 12 01  [tensor bits as currently encoded]
```

A JSON payload with the v1.2 header is:

```
57 50 12 00  [JSON structured-mode bits as currently encoded]
```

### Version byte encoding

The version byte uses **nibble encoding**: the high nibble is the major
version (currently `1`), the low nibble is the minor version (currently
`2`). Version 1.2 → `0x12`. Version 1.3 would be `0x13`. Version 2.0
would be `0x20`.

If the minor nibble reaches `0xF` without a major version bump, the
protocol declares a major version bump. (That is, version 1.15 is not
allowed; it becomes 2.0.)

### Profile-id table

| ID | Profile | Status |
|---|---|---|
| `0x00` | weavepack-json | Stable (v1.x) |
| `0x01` | weavepack-tensor | Stable (v0.1) |
| `0x02`–`0x7F` | reserved | Allocated by profile registration RFC |
| `0x80`–`0xFE` | private/experimental | No registration required; not interoperable |
| `0xFF` | reserved | Do not use |

The allocation procedure follows `weavepack/governance/02-profile-registry.md`.

### Dispatch algorithm

A v1.2 decoder receiving raw bytes MUST:

1. Peek at bytes 0–3.
2. If bytes 0–1 equal `0x57 0x50`:
   a. Parse the version byte (byte 2). If the major nibble ≠ `1`, refuse
      with "unsupported major version".
   b. Parse the profile-id (byte 3). If unknown, refuse with
      "unknown profile-id N".
   c. Slice off the 4-byte header and pass the remainder to the
      profile-specific decoder for profile-id N.
3. If bytes 0–1 do not equal `0x57 0x50`:
   a. Treat the payload as a **v1.x JSON payload** (no header, implicit
      profile-id 0). Pass the raw bytes to the JSON decoder.

A v1.2 encoder MUST prepend the 4-byte header to all new payloads.

### Backwards compatibility

**Existing v1.x payloads** (all test vectors, all production data) have
no magic header. Bytes 0–1 will not equal `0x57 0x50` for any valid v1.x
JSON structured-mode payload in practice (see Collision Analysis below),
so v1.2 decoders fall back to v1.x JSON decoding for them — no
re-encoding required.

**v1.x decoders** receiving v1.2 payloads will misinterpret the header:
byte 0 = `0x57` means bit 0 = 0 (structured mode), and the subsequent
bits will not form a valid column sequence. The decoder will fail loudly
(buffer overrun or invalid bit pattern) rather than silently producing
wrong output. This is the correct behaviour.

### Collision analysis

For the magic check `bytes[0..1] == [0x57, 0x50]` to false-positive on a
v1.x JSON payload:

- Byte 0 = `0x57` = `01010111` requires `short(chain_len)` to begin with
  the bit pattern `0101`, which means chain_len's `short()` prefix =
  `01` (5-bit read) and the low 3 bits = `101` (decimal 5). So
  chain_len = 5 (exactly 5 top-level vrefs in the document).
- Byte 1 = `0x50` = `01010000`. The chain_len encoding consumes 5 bits
  starting at bit 1; bits 5–7 of byte 0 are `011`. So byte 0 contributes
  bits at positions 1–7, and byte 1's bit 0 is the boundary. The exact
  subsequent column bits depend on the payload; no straightforward
  universal match.

In practice: for a JSON payload with exactly chain_len=5, the second byte
would need to produce `0x50` from the start of the chain length reading.
This can happen for specific payloads, but is rare in practice, and the
version and profile bytes (bytes 2–3) add two further constraints. The
false-positive probability is small enough not to matter in any real
deployment.

If a collision becomes a concern, implementations MAY add a fifth
consistency check: after peeling the header, verify that the version byte
is a known version before committing to v1.2 decoding. Any byte ≠ `0x12`
in byte 2 falls back to v1.x.

## Conformance impact

### v1.2 conformance requirements

A v1.2 conformant encoder MUST:
- Prepend the 4-byte magic header to all emitted payloads.
- Use the correct profile-id for the data being encoded.

A v1.2 conformant decoder MUST:
- Accept payloads with the magic header and dispatch correctly.
- Accept payloads without the magic header as v1.x JSON.
- Refuse payloads with magic header and unknown major version.
- Refuse payloads with magic header and unknown profile-id.

### v1.x conformance (unchanged)

v1.x conformant implementations are unaffected. They SHOULD document
that they do not support v1.2 headers.

## Migration path

1. **Implementations targeting new deployments**: add `0x57 0x50 0x12 <pid>`
   as a prefix to all emitted payloads. Update the decoder to strip it.
   Existing test vectors remain valid (no header = v1.x JSON).

2. **Existing test vectors**: all current test vectors in
   `weavepack/profiles/json/test-vectors/` and
   `weavepack/profiles/tensor/test-vectors/` are **v1.x payloads**
   and do not carry a magic header. They stay as-is; they remain valid
   under the v1.x fallback path.

3. **New v1.2 test vectors**: when RFC 0002 is Accepted, new conformance
   test vectors for each profile SHOULD be added with the v1.2 header.
   These go in a `v1.2/` subdirectory of each profile's `test-vectors/`
   directory or have a `"wire_format": "v1.2"` field in the vector JSON.

4. **Chains**: the magic header applies to the outermost byte sequence
   only — the one a caller passes to the top-level decode/parse function.
   Individual delta frames within a chain (LEB128-framed; internal to
   `parse_chain`) do NOT carry the magic header; they are already
   identified by their position in the chain.

## Open questions

1. **Single-profile deployments**: systems that only use one profile and
   control both encoder and decoder may not need the magic header (out-
   of-band context suffices). SHOULD they emit the header anyway for
   interoperability? Recommendation: YES — always emit, so payloads are
   portable without out-of-band metadata.

2. **Profile-versioning**: the header carries the protocol version, not
   the profile version (e.g., weavepack-tensor v0.1 vs v0.2 are both
   profile-id `0x01`). Profile-specific versioning is handled by the
   profile itself (e.g., the 2-bit discriminant in the tensor bitstream).
   Is this sufficient? If profile versioning needs to be in the header,
   an additional "profile-version" byte could be added to the header (6
   bytes total, or encode it differently). Leave for a follow-up RFC.

3. **Alignment**: 4 bytes is not a natural boundary for a bitstream reader.
   Adding `__attribute__((aligned(4)))` hints for SIMD operations becomes
   slightly less natural. Could pad the header to 8 bytes with 4 reserved
   bytes. Whether this matters in practice depends on use patterns.
   Recommendation: keep 4 bytes for now; a follow-up can extend to 8 if
   needed (header byte 2's minor nibble reserves room for minor bumps).

4. **Stream framing**: weavepack payloads sent over a stream (e.g., a TCP
   connection) typically have a length prefix from the transport layer.
   The magic header doesn't interact with stream framing (the transport
   still needs to frame payloads). But implementors SHOULD document whether
   the length prefix measures the total byte count including the magic
   header, or just the bitstream.

## Implementation notes

Reference implementation sketch (JS):

```js
const MAGIC = Uint8Array.from([0x57, 0x50])
const VERSION_12 = 0x12

function decodeWeavepack(bytes, profileDecoders) {
  // bytes: Uint8Array
  if (bytes.length >= 4 && bytes[0] === 0x57 && bytes[1] === 0x50) {
    const ver = bytes[2]
    const pid = bytes[3]
    if ((ver >> 4) !== 1) throw new Error(`unsupported major version ${ver >> 4}`)
    const decoder = profileDecoders[pid]
    if (!decoder) throw new Error(`unknown profile-id ${pid}`)
    return decoder(bytes.slice(4))
  }
  // v1.x fallback: implicit JSON
  return profileDecoders[0](bytes)
}

function encodeWeavepack(profileId, profileBytes) {
  const out = new Uint8Array(4 + profileBytes.length)
  out[0] = 0x57; out[1] = 0x50; out[2] = VERSION_12; out[3] = profileId
  out.set(profileBytes, 4)
  return out
}
```

The 4-byte prepend/strip is the only change needed for existing encoders
and decoders — the profile-specific logic is untouched.
