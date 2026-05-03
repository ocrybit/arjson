// Worked example: 100-version chain of an application config.
//
// Models a typical SaaS deployment: a feature-flag/config JSON
// document edited once a day for ~3 months. Each edit touches
// 1-3 leaf values (toggle a flag, bump a numeric threshold,
// add/remove a name from a list).
//
// Run: node weavepack/profiles/json/examples/config-versioning.js

import { ARJSON, enc } from "../../../../sdk/src/profiles/json/index.js"
import { brotliCompressSync } from "node:zlib"

// Deterministic PRNG so numbers are reproducible.
let seed = 7
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 0x100000000
  return seed / 0x100000000
}

// Initial config: representative shape for a real app.
const initialConfig = {
  version: 1,
  features: {
    new_dashboard: false,
    beta_search: true,
    rate_limit_v2: false,
    audit_log_streaming: true,
  },
  rate_limits: {
    api_per_minute: 1000,
    upload_per_hour: 100,
    auth_per_minute: 30,
  },
  allowed_origins: [
    "https://app.example.com",
    "https://staging.example.com",
  ],
  email_templates: {
    welcome: { subject: "Welcome", body_id: "tpl_w1" },
    reset:   { subject: "Reset password", body_id: "tpl_r1" },
    invite:  { subject: "You're invited", body_id: "tpl_i1" },
  },
}

const VERSIONS = 100

// Helper: deep clone (config is plain JSON).
const clone = o => JSON.parse(JSON.stringify(o))

const featureNames = Object.keys(initialConfig.features)
const limitNames = Object.keys(initialConfig.rate_limits)

// Apply one realistic edit to a config.
function editConfig(c, version) {
  const r = rand()
  if (r < 0.3) {
    // Toggle a feature flag.
    const f = featureNames[Math.floor(rand() * featureNames.length)]
    c.features[f] = !c.features[f]
  } else if (r < 0.6) {
    // Tweak a rate limit by ±20%.
    const k = limitNames[Math.floor(rand() * limitNames.length)]
    c.rate_limits[k] = Math.round(c.rate_limits[k] * (0.8 + rand() * 0.4))
  } else if (r < 0.8) {
    // Add a new allowed origin.
    c.allowed_origins.push(`https://tenant${version}.example.com`)
  } else {
    // Bump a template body_id (e.g. content edit).
    const t = ["welcome", "reset", "invite"][Math.floor(rand() * 3)]
    c.email_templates[t].body_id = `tpl_${t[0]}${version}`
  }
  c.version = version + 1
}

// Build raw-snapshot bundle and weavepack chain in parallel.
const snapshots = [Buffer.from(JSON.stringify(initialConfig))]
const pack = new ARJSON({ json: initialConfig })
const live = clone(initialConfig)

for (let v = 1; v <= VERSIONS; v++) {
  editConfig(live, v)
  snapshots.push(Buffer.from(JSON.stringify(live)))
  pack.update(clone(live))
}

const rawBundle = Buffer.concat(snapshots)
const rawBundleBytes = rawBundle.length
const rawBrotli = brotliCompressSync(rawBundle).length

const chainBytes = pack.toBuffer().length
const chainBrotli = brotliCompressSync(pack.toBuffer()).length

// Single anchor (latest) — what you'd ship if you only kept the current state.
const latestRawBytes = Buffer.byteLength(JSON.stringify(live))
const latestArjsonBytes = enc(live).length

const fmt = n => n.toString().padStart(7) + " bytes"

console.log("Application-config edit history (100 versions):")
console.log()
console.log("Single latest snapshot only:")
console.log(`  raw JSON (latest config):       ${fmt(latestRawBytes)}`)
console.log(`  weavepack-json (latest):        ${fmt(latestArjsonBytes)}  (${(latestRawBytes / latestArjsonBytes).toFixed(2)}× smaller)`)
console.log()
console.log("Full edit history (anchor + 100 versions):")
console.log(`                                  raw       + brotli`)
console.log(`  JSON snapshots (concat all):    ${fmt(rawBundleBytes)}  ${fmt(rawBrotli)}`)
console.log(`  weavepack chain (anchor+deltas):${fmt(chainBytes)}  ${fmt(chainBrotli)}`)
console.log()
console.log("Multipliers vs raw JSON snapshot bundle:")
console.log(`  weavepack chain alone:    ${(rawBundleBytes / chainBytes).toFixed(1)}× smaller`)
console.log(`  JSON + brotli:            ${(rawBundleBytes / rawBrotli).toFixed(1)}× smaller`)
console.log(`  weavepack chain + brotli: ${(rawBundleBytes / chainBrotli).toFixed(1)}× smaller`)
console.log()
console.log(`Per-version cost (chain): ${((chainBytes - latestArjsonBytes) / VERSIONS).toFixed(0)} bytes/edit average`)
console.log(`Round-trip restored to current state: ${JSON.stringify(pack.json) === JSON.stringify(live) ? "✓" : "✗"}`)
