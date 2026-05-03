"""weavepack-json — pure-Python single-payload encoder + decoder.

Proof-of-concept third-language implementation. Validates the spec
in weavepack/profiles/json/01-types.md is implementable from prose
without reading the JS or Rust source.

Scope (v0.1):
  - Single-payload mode only (mode bit = 1)
  - All 64 single-payload tags (null/bool/int/float/string/empty
    containers)
  - Encoder + decoder both byte-exact for the single-payload subset
    (37/93 conformance vectors; the remaining 56 are
    structured-mode containers + deltas, V0.2 D.2 follow-up)
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
