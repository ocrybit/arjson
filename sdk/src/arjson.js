// Backwards-compatibility shim. The ARJSON class and enc/dec helpers
// live at sdk/src/profiles/json/index.js as part of the Phase 3
// protocol/profile boundary refactor. This shim re-exports from the
// new location so existing consumers (test files, npm consumers
// importing arjson@0.1.x) keep working without modification.
//
// New code SHOULD import directly from "./profiles/json/index.js".
export { ARJSON, enc, dec } from "./profiles/json/index.js"
