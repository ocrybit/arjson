import { writeFileSync, readFileSync, existsSync } from "fs"
import { resolve } from "path"

const packageJson = resolve(import.meta.dirname, "package.json")
const packageJsonDist = resolve(import.meta.dirname, "dist/package.json")
const packageJsonDist2 = resolve(import.meta.dirname, "dist/esm/package.json")
const json = JSON.parse(readFileSync(packageJson, "utf8"))
delete json.type
delete json.scripts
json.main = "cjs/index.js"
json.module = "esm/index.js"

console.log(json)
writeFileSync(packageJsonDist, JSON.stringify(json, undefined, 2))

const json2 = {
  type: "module",
}
writeFileSync(packageJsonDist2, JSON.stringify(json2, undefined, 2))

// The bin scripts in `bin/` import from `../src/` for dev-mode
// invocation (running `node sdk/bin/wpkt-json.js` directly). After
// `cp bin -rf dist/`, they live at dist/bin/ where `../src/` no
// longer exists. Rewrite the import path to point at dist/esm/
// (which the build creates as the published-package source root).
const wpktJson = resolve(import.meta.dirname, "dist/bin/wpkt-json.js")
if (existsSync(wpktJson)) {
  let body = readFileSync(wpktJson, "utf8")
  body = body.replace(/from "\.\.\/src\//g, 'from "../esm/')
  writeFileSync(wpktJson, body)
}
