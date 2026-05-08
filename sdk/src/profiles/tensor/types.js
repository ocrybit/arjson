// weavepack-tensor — dtype manifest.
//
// See weavepack/profiles/tensor/01-types.md for the normative spec.

export const DTYPE = Object.freeze({
  BOOL:     0,
  INT4:     1,
  UINT4:    2,
  INT8:     3,
  UINT8:    4,
  INT16:    5,
  UINT16:   6,
  INT32:    7,
  UINT32:   8,
  INT64:    9,
  UINT64:  10,
  FP8E4M3: 11,
  FP8E5M2: 12,
  FP16:    13,
  BF16:    14,
  FP32:    15,
  FP64:    16,
  CFLOAT32: 17,
  CFLOAT64: 18,
  // 19..27 reserved
  QINT4:   28,
  QINT8:   29,
  QFP8:    30,
  // 31 reserved for extension
})

export const DTYPE_BITS = 5

// Bits per element for each dtype (excluding quant metadata).
export const DTYPE_BITS_PER_ELEM = Object.freeze({
  [DTYPE.BOOL]:     1,
  [DTYPE.INT4]:     4,
  [DTYPE.UINT4]:    4,
  [DTYPE.INT8]:     8,
  [DTYPE.UINT8]:    8,
  [DTYPE.INT16]:   16,
  [DTYPE.UINT16]:  16,
  [DTYPE.INT32]:   32,
  [DTYPE.UINT32]:  32,
  [DTYPE.INT64]:   64,
  [DTYPE.UINT64]:  64,
  [DTYPE.FP8E4M3]:  8,
  [DTYPE.FP8E5M2]:  8,
  [DTYPE.FP16]:    16,
  [DTYPE.BF16]:    16,
  [DTYPE.FP32]:    32,
  [DTYPE.FP64]:    64,
  [DTYPE.CFLOAT32]: 64,
  [DTYPE.CFLOAT64]: 128,
  [DTYPE.QINT4]:    4,
  [DTYPE.QINT8]:    8,
  [DTYPE.QFP8]:     8,
})

// Wire op codes for delta operations (3 bits).
export const OP = Object.freeze({
  TENSOR_REPLACE: 0,
  TENSOR_ADD:     1,
  TENSOR_REMOVE:  2,
  REGION_REPLACE: 3,
  ELEMENT_SET:    4,
  QUANT_CHANGE:   5,
})

export const OP_BITS = 3

export const PROFILE_ID = "tensor"
export const PROFILE_VERSION = "0.1"

// Maximum tensor data block size the decoder will allocate.  Larger tensors
// require streaming or external storage; 256 MiB covers the largest single
// parameter tensors seen in practice while preventing allocation bombs.
const MAX_TENSOR_BYTES = 256 * 1024 * 1024

// Compute data block size in bytes for a tensor with given dtype and shape.
export function dataBytes(dtype, shape) {
  const bitsPerElem = DTYPE_BITS_PER_ELEM[dtype]
  if (bitsPerElem === undefined) {
    throw new Error(`unknown dtype ${dtype}`)
  }
  let elements = 1
  for (const dim of shape) {
    if (dim < 0) throw new Error(`negative dim ${dim} in shape`)
    elements *= dim
  }
  if (elements === 0) return 0
  const totalBits = elements * bitsPerElem
  const totalBytes = Math.ceil(totalBits / 8)
  if (totalBytes > MAX_TENSOR_BYTES) {
    throw new Error(`tensor data (${totalBytes} bytes) exceeds 256 MiB limit; use streaming decode for large tensors`)
  }
  return totalBytes
}
