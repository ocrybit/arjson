"""weavepack-wire — pure-Python implementation.

Proof-of-concept Python implementation of the weavepack-wire profile.
Supports schemaless snapshot encode + decode and delta chain encode +
decode + application for all 8 op types:
  field_set, field_delete, message_replace, repeated_append,
  repeated_splice, map_set, map_delete, oneof_switch.

Profile isolation: imports no JSON or tensor profile code.
"""

from .encoder import encode_document, encode_chain
from .decoder import decode_document, decode_chain
from .apply import apply_chain
from .types import VTYPE, CTYPE, OP, PC

__all__ = [
    "encode_document",
    "encode_chain",
    "decode_document",
    "decode_chain",
    "apply_chain",
    "VTYPE",
    "CTYPE",
    "OP",
    "PC",
]
__version__ = "0.0.1"
