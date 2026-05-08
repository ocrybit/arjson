// weavepack-wire profile — v0.1 reference implementation.
//
// Profile isolation: this file imports ONLY from:
//   - ./types.js    (wire-specific constants)
//   - ./encoder.js  (snapshot + delta encoder)
//   - ./decoder.js  (snapshot + delta decoder)
//   - ./apply.js    (delta application on decoded state)
// It MUST NOT import from sdk/src/profiles/json/* or sdk/src/profiles/tensor/*.

export { VTYPE, CTYPE, OP, PC, PROFILE_ID, PROFILE_VERSION } from "./types.js"
export { FLAG_SCHEMALESS, FLAG_DELTA, FLAG_SCHEMAFUL } from "./types.js"
export { scalarTag, containerTag, isContainer } from "./types.js"
export { encodeDocument, encodeChain } from "./encoder.js"
export { decodeDocument, decodeChain } from "./decoder.js"
export { applyChain } from "./apply.js"
