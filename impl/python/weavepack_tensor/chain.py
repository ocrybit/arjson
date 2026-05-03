"""Chain serialization helpers for weavepack-tensor (and weavepack-json).

A weavepack chain is a sequence of independently-encoded payloads
concatenated together, each preceded by a LEB128 length. Splitting a
chain into its constituent payloads requires no profile-specific
knowledge — only the LEB128 length-prefix loop. These helpers are the
Python analogue of weavepack-core's chain module in the Rust impl,
and of chainParse/chainSerialize in the JS reference.

Per-payload addressability: re-emitting any prefix of `parse_chain`'s
output via `serialize_chain` produces a valid chain that decodes to
the corresponding intermediate state. See the Rust core unit test
`prefix_is_a_valid_chain` and the JS regression tests
"any chain prefix decodes to its corresponding intermediate state".
"""


def parse_chain(chain_bytes):
    """Split a LEB128-length-prefixed chain into individual payloads.

    Returns a list of bytes objects, one per payload, in chain order.
    """
    out = []
    off = 0
    n = len(chain_bytes)
    while off < n:
        length = 0
        shift = 0
        while True:
            b = chain_bytes[off]
            off += 1
            length |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        out.append(bytes(chain_bytes[off:off + length]))
        off += length
    return out


def serialize_chain(payloads):
    """Concatenate payloads into a single chain, each prefixed with its LEB128 length.

    Inverse of `parse_chain`: parse_chain(serialize_chain(xs)) == xs.
    """
    out = bytearray()
    for p in payloads:
        length = len(p)
        while length >= 128:
            out.append((length & 0x7F) | 0x80)
            length >>= 7
        out.append(length)
        out.extend(p)
    return bytes(out)
