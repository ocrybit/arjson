#!/usr/bin/env node
// wpkt-json — minimal CLI for weavepack-json.
//
// Usage:
//   echo '{"a":1}' | wpkt-json encode > out.wpkt
//   wpkt-json decode < out.wpkt
//   echo '{"a":1}' | wpkt-json encode | xxd
//
// One-shot encode/decode for the JSON profile. Round-trips via the
// JS reference. Intended for quick experimentation and shell-pipeline
// composition.

import { enc, dec } from "../src/profiles/json/index.js"

// Treat broken pipes (e.g. piping to `head`) as a clean exit, not a crash.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e })

const cmd = process.argv[2]

function readAll() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on("data", c => chunks.push(c))
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)))
    process.stdin.on("error", reject)
  })
}

async function main() {
  if (cmd === "encode") {
    const text = (await readAll()).toString("utf8").trim()
    if (!text) { process.stderr.write("error: empty input\n"); process.exit(1) }
    let value
    try { value = JSON.parse(text) }
    catch (e) { process.stderr.write(`error: invalid JSON: ${e.message}\n`); process.exit(1) }
    process.stdout.write(Buffer.from(enc(value)))
    return
  }
  if (cmd === "decode") {
    const bytes = await readAll()
    if (bytes.length === 0) { process.stderr.write("error: empty input\n"); process.exit(1) }
    let value
    try { value = dec(new Uint8Array(bytes)) }
    catch (e) { process.stderr.write(`error: decode failed: ${e.message}\n`); process.exit(1) }
    process.stdout.write(JSON.stringify(value) + "\n")
    return
  }
  if (cmd === "size") {
    const text = (await readAll()).toString("utf8").trim()
    let value
    try { value = JSON.parse(text) }
    catch (e) { process.stderr.write(`error: invalid JSON: ${e.message}\n`); process.exit(1) }
    const wpktBytes = enc(value).length
    const jsonBytes = Buffer.byteLength(JSON.stringify(value))
    process.stdout.write(
      `JSON:     ${jsonBytes} bytes\n` +
      `weavepack: ${wpktBytes} bytes\n` +
      `ratio:    ${(jsonBytes / wpktBytes).toFixed(2)}× smaller\n`
    )
    return
  }
  process.stderr.write(`Usage: wpkt-json {encode|decode|size}

  encode   read JSON from stdin, write weavepack bytes to stdout
  decode   read weavepack bytes from stdin, write JSON to stdout
  size     read JSON from stdin, report sizes (JSON vs weavepack)

Examples:
  echo '{"a":1}' | wpkt-json encode | xxd
  echo '{"a":1}' | wpkt-json encode > /tmp/x.wpkt
  wpkt-json decode < /tmp/x.wpkt
  echo '[1,2,3,4,5,6,7,8,9,10]' | wpkt-json size
`)
  process.exit(1)
}

main().catch(e => {
  process.stderr.write(`error: ${e.message}\n`)
  process.exit(1)
})
