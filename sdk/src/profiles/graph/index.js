// weavepack-graph profile — v0.1 reference implementation.
//
// Profile isolation: this file imports ONLY from:
//   - ./types.js    (graph-specific constants)
//   - ./encoder.js  (graph document + chain encoder)
//   - ./decoder.js  (graph document + chain decoder)
//   - ./apply.js    (delta application on decoded state)
// It MUST NOT import from sdk/src/profiles/json/*,
//                         sdk/src/profiles/tensor/*,
//                         sdk/src/profiles/wire/*,
//                         sdk/src/profiles/tabular/*, or
//                         sdk/src/profiles/log/*.

export {
  CTYPE, OP, PATH_KIND,
  BLOCK_TYPE_NODE, BLOCK_TYPE_EDGE,
  PROFILE_ID, PROFILE_VERSION, PROFILE_NUM,
  GRAPH_VERSION,
} from "./types.js"
export { nullBitmapBytes, getNullBit, setNullBit } from "./types.js"
export { encodeGraph, encodeChain } from "./encoder.js"
export { decodeGraph, decodeChain } from "./decoder.js"
export { initState, applyChain } from "./apply.js"
