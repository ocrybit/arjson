"""weavepack-tensor — pure-Python implementation.

Proof-of-concept Python implementation of the weavepack-tensor
profile. Supports both schemaless and schemaful document encode +
decode, plus delta application for 5 of 6 ops (tensor_replace,
tensor_add, tensor_remove, element_set, region_replace; quant_change
not implemented).

Decoder also handles tensor_replace mode=1 (delta-from-prior
arithmetic, V0.2 A.3); the Python encoder always emits mode=0.

Supported dtypes: fp32, fp64, int8/16/32/64, uint8/16/32/64, bool.
fp16/bf16 round-trip as raw u16 bits with helpers
`fp16_bits_to_f32` / `bf16_bits_to_f32` for consumer-side
conversion (no numpy/ml_dtypes dependency).

Conformance: 58/58 tensor corpus vectors pass byte-exact against
the JS reference.
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
from .chain import (
    parse_chain,
    serialize_chain,
    validate_chain,
)

__all__ = [
    "decode_document",
    "decode_document_schemaful",
    "encode_document",
    "encode_document_schemaful",
    "apply_delta",
    "schema_hash",
    "schema_hash_hex",
    "parse_chain",
    "serialize_chain",
    "validate_chain",
    "DTYPE",
    "OP",
    "fp16_bits_to_f32",
    "bf16_bits_to_f32",
]
__version__ = "0.0.1"
