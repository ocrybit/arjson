// weavepack-tabular profile — v0.1 reference implementation.
//
// Profile isolation: this file imports ONLY from:
//   - ./types.js    (tabular-specific constants)
//   - ./encoder.js  (snapshot + delta encoder)
//   - ./decoder.js  (snapshot + delta decoder)
//   - ./apply.js    (delta application on decoded state)
// It MUST NOT import from sdk/src/profiles/json/*,
//                         sdk/src/profiles/tensor/*, or
//                         sdk/src/profiles/wire/*.

export { CTYPE, OP, FRAME_SNAPSHOT, FRAME_DELTA, PROFILE_ID, PROFILE_VERSION } from "./types.js"
export { nullBitmapBytes, getNullBit, setNullBit } from "./types.js"
export { encodeFrame, encodeChain } from "./encoder.js"
export { decodeFrame, decodeChain } from "./decoder.js"
export { applyChain } from "./apply.js"
