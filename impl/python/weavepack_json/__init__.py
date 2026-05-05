"""weavepack-json — pure-Python encoder + decoder.

Proof-of-concept third-language implementation. Validates the spec
in weavepack/profiles/json/ is implementable from prose without
reading the JS or Rust source.

Scope (v0.0.3 — D.2 delta chain decoder):
  - Single-payload mode (mode bit = 1): all 64 tags
  - Structured mode (mode bit = 0): full snapshot decode —
    flat/nested arrays and objects, strmap dedup, all primitive
    vtypes, RLE vlinks/klinks, flag columns.
  - Delta chain application: decode_chain() applies incremental
    deltas (set/delete/splice/strdiff) to the running JSON state.
    parse_chain() exposes the LEB128 framing parser.
    93/93 conformance vectors pass.
  - Encoder: single-payload mode only (byte-exact for 37 vectors)
  - Pure Python 3.10+, no external dependencies

Usage:
    from weavepack_json import encode, decode, decode_chain
    encode(0)                          # → b'\\xc0'
    decode(bytes.fromhex("c0"))        # → 0
    decode(bytes.fromhex("80"))        # → None
    decode_chain(chain_bytes)          # → final JSON value
"""

from .decoder import decode, decode_chain, parse_chain
from .encoder import encode

__all__ = ["decode", "encode", "decode_chain", "parse_chain"]
__version__ = "0.0.3"
