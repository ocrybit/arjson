// Worked example: per-version addressability of a weavepack chain.
//
// The previous example (config-versioning.js) showed that bundled
// brotli on a snapshot-blob beats the chain on raw size. The chain's
// actual win is per-payload addressability: each version is
// independently retrievable.
//
// This example demonstrates that. We build a 100-version chain, then
// restore each of 5 specific versions WITHOUT decoding the rest of
// the chain past that version, and verify each matches its snapshot
// counterpart byte-for-byte.
//
// Run: node weavepack/profiles/json/examples/chain-partial-restore.js

import { ARJSON } from "../../../../sdk/src/profiles/json/index.js"

let seed = 17
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 0x100000000
  return seed / 0x100000000
}

const initial = { count: 0, items: [], flags: { a: false, b: false } }
const VERSIONS = 100
const RESTORE_AT = [10, 25, 50, 75, 99]  // pick arbitrary "audit points"

const clone = o => JSON.parse(JSON.stringify(o))
const live = clone(initial)
const snapshots = [clone(initial)]
const pack = new ARJSON({ json: initial })

for (let v = 1; v <= VERSIONS; v++) {
  const r = rand()
  if (r < 0.4) live.count = v
  else if (r < 0.7) live.items.push(`item${v}`)
  else if (r < 0.85) live.flags.a = !live.flags.a
  else live.flags.b = !live.flags.b
  snapshots.push(clone(live))
  pack.update(clone(live))
}

const chainBytes = pack.toBuffer()
console.log(`Chain encoded: ${chainBytes.length} bytes for ${VERSIONS + 1} versions`)
console.log(`Average per version: ${(chainBytes.length / (VERSIONS + 1)).toFixed(1)} bytes`)
console.log()

// Decompose chain into individual payloads without replaying anything.
const payloads = ARJSON.fromBuffer(chainBytes)
console.log(`Chain contains ${payloads.length} addressable payloads`)
const headerOverhead = chainBytes.length - payloads.reduce((s, p) => s + p.length, 0)
console.log(`Length-prefix overhead: ${headerOverhead} bytes (${(headerOverhead / payloads.length).toFixed(1)} bytes/payload)`)
console.log()

// Restore each target version by reconstructing from payloads[0..target].
// We rebuild a "truncated chain buffer" containing only the prefix we need,
// then construct an ARJSON from it. This proves that retrieving version N
// only requires the first N+1 payloads — not the whole chain.
console.log("Per-version restore (only payloads 0..N needed):")
console.log()
for (const target of RESTORE_AT) {
  const prefixPayloads = payloads.slice(0, target + 1)
  const prefixBytes = ARJSON.toBuffer(prefixPayloads)
  const restored = new ARJSON({ arj: prefixBytes })
  const expected = JSON.stringify(snapshots[target])
  const got = JSON.stringify(restored.json)
  const ok = got === expected ? "✓" : "✗"
  console.log(`  v${String(target).padStart(2)}: prefix ${String(prefixBytes.length).padStart(4)} bytes (${((prefixBytes.length / chainBytes.length) * 100).toFixed(0)}% of chain) — ${ok}`)
}
console.log()
console.log("Each retrieval reads strictly the required prefix, then stops.")
console.log("This is what brotli-on-bundled-snapshots cannot give you:")
console.log("the brotli stream must be decompressed in full to reach any one version.")
