// weavepack-geo profile — v0.1 reference implementation.
//
// Profile isolation: this file imports ONLY from:
//   - ./types.js    (geo-specific constants)
//   - ./encoder.js  (geo document encoder)
//   - ./decoder.js  (geo document decoder)
//   - ./apply.js    (delta application on decoded state)
// It MUST NOT import from sdk/src/profiles/json/*,
//                         sdk/src/profiles/tensor/*,
//                         sdk/src/profiles/wire/*,
//                         sdk/src/profiles/tabular/*,
//                         sdk/src/profiles/log/*,
//                         sdk/src/profiles/graph/*, or
//                         sdk/src/profiles/ast/*.

export {
  CTYPE, GEOM_TYPE, COORD_PRECISION, FID_KIND,
  OP, PATH_KIND, BLOCK_TYPE, PROFILE_NUM,
} from "./types.js"
export { nullBitmapBytes, getNullBit, setNullBit } from "./types.js"
export { encodeDocument }  from "./encoder.js"
export { decodeDocument }  from "./decoder.js"
export { initState, applyChain } from "./apply.js"
