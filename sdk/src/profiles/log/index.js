// weavepack-log profile — v0.1 reference implementation.
//
// Profile isolation: this file imports ONLY from:
//   - ./types.js    (log-specific constants)
//   - ./encoder.js  (batch + chain + header encoder)
//   - ./decoder.js  (batch + chain + header decoder)
//   - ./apply.js    (delta application on decoded state)
// It MUST NOT import from sdk/src/profiles/json/*,
//                         sdk/src/profiles/tensor/*,
//                         sdk/src/profiles/wire/*, or
//                         sdk/src/profiles/tabular/*.

export {
  CTYPE, LEVEL, OP, SCHEMA_SUB_OP,
  FRAME_SNAPSHOT, FRAME_DELTA, FRAME_STREAM_HEADER,
  PROFILE_ID, PROFILE_VERSION,
} from "./types.js"
export { nullBitmapBytes, getNullBit, setNullBit } from "./types.js"
export { encodeBatch, encodeChain, encodeStreamHeader } from "./encoder.js"
export { decodeBatch, decodeChain, decodeStreamHeader } from "./decoder.js"
export { initState, applyChain } from "./apply.js"
