"""weavepack-json — pure-Python encoder + decoder.

Proof-of-concept third-language implementation. Validates the spec
in weavepack/profiles/json/ is implementable from prose without
reading the JS or Rust source.

Scope (v0.0.2 — D.2 structured-mode snapshot decoder):
  - Single-payload mode (mode bit = 1): all 64 tags
  - Structured mode (mode bit = 0): full snapshot decode —
    flat/nested arrays and objects, strmap dedup, all primitive
    vtypes, RLE vlinks/klinks, flag columns.
    68/93 conformance vectors pass; 25 delta vectors (chain
    application) remain as skips — see V0.2-PLANNING.md D.2.
  - Encoder: single-payload mode only (byte-exact for 37 vectors)
  - Pure Python 3.10+, no external dependencies

Usage:
    from weavepack_json import encode, decode
    encode(0)                          # → b'\\xc0'
    decode(bytes.fromhex("c0"))        # → 0
    decode(bytes.fromhex("80"))        # → None
"""

from .decoder import decode
from .encoder import encode

__all__ = ["decode", "encode"]
__version__ = "0.0.1"
