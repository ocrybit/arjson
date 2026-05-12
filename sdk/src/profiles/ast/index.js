// weavepack-ast profile — v0.1 reference implementation.
//
// Profile isolation: this file imports ONLY from:
//   - ./types.js    (ast-specific constants)
//   - ./encoder.js  (ast document + chain encoder)
//   - ./decoder.js  (ast document + chain decoder)
//   - ./apply.js    (delta application on decoded state)
// It MUST NOT import from sdk/src/profiles/json/*,
//                         sdk/src/profiles/tensor/*,
//                         sdk/src/profiles/wire/*,
//                         sdk/src/profiles/tabular/*,
//                         sdk/src/profiles/log/*, or
//                         sdk/src/profiles/graph/*.

export {
  CTYPE, OP, PATH_KIND,
  BLOCK_TYPE_NODE, BLOCK_TYPE_MIXED,
  PROFILE_ID, PROFILE_VERSION, PROFILE_NUM,
  AST_VERSION,
} from "./types.js"
export { nullBitmapBytes, getNullBit, setNullBit } from "./types.js"
export { encodeTree, encodeChain } from "./encoder.js"
export { decodeTree, decodeChain } from "./decoder.js"
export { initState, applyChain } from "./apply.js"
