"""weavepack-tensor — pure-Python implementation.

Proof-of-concept Python implementation of the weavepack-tensor
profile. Supports both schemaless and schemaful document encode +
decode, plus delta computation and encoding for all 6 ops
(tensor_replace, tensor_add, tensor_remove, element_set,
region_replace, quant_change).

Encoder handles tensor_replace mode=1 (delta-from-prior arithmetic,
V0.2 A.3) using the same heuristic as the JS and Rust encoders:
emit mode=1 when max absolute per-element delta ≤ 0.01 (fp32/fp64 only).

Supported dtypes: fp32, fp64, int8/16/32/64, uint8/16/32/64, bool,
fp16/bf16, fp8e4m3/fp8e5m2, cfloat32/64, qint4/qint8/qfp8.
fp16/bf16 round-trip as raw u16 bits with helpers
`fp16_bits_to_f32` / `bf16_bits_to_f32` for consumer-side
conversion (no numpy/ml_dtypes dependency).

A.4 skip-load: `list_tensors_schemaful`, `decode_tensor_schemaful` — seek
directly to a named tensor without decoding preceding tensors.
A.5 streaming: `iterate_tensors_schemaful` — generator yielding
``{name, dtype, shape, data}`` in canonical order with a single cursor.

Conformance: 97/97 tensor corpus vectors pass byte-exact against
the JS reference.
"""

from .decoder import (
    decode_document,
    decode_document_schemaful,
    list_tensors_schemaful,
    decode_tensor_schemaful,
    iterate_tensors_schemaful,
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
    compute_delta,
    encode_delta,
)
from .chain import (
    parse_chain,
    serialize_chain,
    validate_chain,
)

__all__ = [
    "decode_document",
    "decode_document_schemaful",
    "list_tensors_schemaful",
    "decode_tensor_schemaful",
    "iterate_tensors_schemaful",
    "encode_document",
    "encode_document_schemaful",
    "compute_delta",
    "encode_delta",
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
