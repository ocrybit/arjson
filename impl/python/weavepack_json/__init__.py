"""weavepack-json — pure-Python decoder (single-payload mode).

Proof-of-concept third-language implementation. Validates the spec
in weavepack/profiles/json/01-types.md is implementable from prose
without reading the JS or Rust source.

Scope (v0.1):
  - Single-payload mode only (mode bit = 1)
  - All 64 single-payload tags (null/bool/int/float/string/empty
    containers)
  - Decoder only (no encoder yet)
  - Pure Python 3.10+, no external dependencies

Usage:
    from weavepack_json import decode
    decode(bytes.fromhex("c0"))        # → 0
    decode(bytes.fromhex("80"))        # → None
"""

from .decoder import decode
from .encoder import encode

__all__ = ["decode", "encode"]
__version__ = "0.0.1"
