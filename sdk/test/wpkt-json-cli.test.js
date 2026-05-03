// Smoke tests for the wpkt-json CLI.

import { describe, it } from "node:test"
import assert from "assert"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const CLI = join(dirname(__filename), "..", "bin", "wpkt-json.js")

function run(stdin, ...args) {
  // Pass stdin as a Buffer; capture stdout as a Buffer (no string
  // decoding since some outputs are raw bytes).
  return execSync(`node ${CLI} ${args.join(" ")}`, {
    input: typeof stdin === "string" ? Buffer.from(stdin) : stdin,
  })
}

describe("wpkt-json CLI", () => {
  it("encode → decode round-trip for primitive", () => {
    const bytes = run("42", "encode")
    const out = run(bytes, "decode").toString("utf8").trim()
    assert.equal(out, "42")
  })

  it("encode → decode round-trip for object", () => {
    const bytes = run('{"a":1,"b":2}', "encode")
    const out = run(bytes, "decode").toString("utf8").trim()
    assert.equal(out, '{"a":1,"b":2}')
  })

  it("encode → decode round-trip for array of ints", () => {
    const bytes = run("[1,2,3,4,5]", "encode")
    const out = run(bytes, "decode").toString("utf8").trim()
    assert.equal(out, "[1,2,3,4,5]")
  })

  it("size reports JSON vs weavepack bytes", () => {
    const out = run('[1,2,3,4,5,6,7,8,9,10]', "size").toString("utf8")
    assert.match(out, /JSON:\s+\d+ bytes/)
    assert.match(out, /weavepack:\s+\d+ bytes/)
    assert.match(out, /ratio:\s+\d+\.\d+× smaller/)
  })

  it("encode rejects invalid JSON with non-zero exit", () => {
    let threw = false
    try { run("not json at all", "encode") } catch (_) { threw = true }
    assert.ok(threw, "expected non-zero exit on invalid JSON")
  })

  it("decode rejects empty input with non-zero exit", () => {
    let threw = false
    try { run("", "decode") } catch (_) { threw = true }
    assert.ok(threw, "expected non-zero exit on empty input")
  })

  it("usage message printed for unknown subcommand", () => {
    let stderr = ""
    try {
      execSync(`node ${CLI} foo`, { input: "", encoding: "utf8" })
    } catch (e) {
      stderr = e.stderr.toString()
    }
    assert.match(stderr, /Usage: wpkt-json/)
  })
})
