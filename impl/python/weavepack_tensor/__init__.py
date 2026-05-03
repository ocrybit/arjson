"""weavepack-tensor — pure-Python decoder.

Proof-of-concept Python implementation of the weavepack-tensor
profile. Currently supports schemaless document decoding for the
common dtypes: fp32, fp64, int8/16/32, uint8/16/32, bool.

fp16/bf16 require external conversion (numpy/ml_dtypes); the decoder
returns raw u16 bits and provides helpers to convert.
"""

from .decoder import (
    decode_document,
    decode_document_schemaful,
    apply_delta,
    schema_hash,
    schema_hash_hex,
    DTYPE,
    OP,
    fp16_bits_to_f32,
    bf16_bits_to_f32,
)
from .encoder import (
    encode_document,
    encode_document_schemaful,
)

__all__ = [
    "decode_document",
    "decode_document_schemaful",
    "encode_document",
    "encode_document_schemaful",
    "apply_delta",
    "schema_hash",
    "schema_hash_hex",
    "DTYPE",
    "OP",
    "fp16_bits_to_f32",
    "bf16_bits_to_f32",
]
__version__ = "0.0.1"
