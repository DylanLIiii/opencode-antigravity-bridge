import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test, after } from "node:test"

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-model-discovery-"))
const entry = new URL("./index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
source = source.replace('new URL("./package.json", import.meta.url)', JSON.stringify(new URL("./package.json", entry).pathname))
source += "\nexport { offeredModelsFromSession, seedOfferedModels };\n"
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source)
const { offeredModelsFromSession, seedOfferedModels } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

test("ACP model options and availableModels normalize into one offered directory", () => {
  assert.deepEqual(offeredModelsFromSession({
    configOptions: [{ type: "select", category: "model", options: [{ value: "claude-sonnet", name: "Sonnet" }] }],
    models: { availableModels: [{ modelId: "gpt-oss-120b-medium", name: "GPT OSS" }] },
  }), [
    { id: "claude-sonnet", name: "Sonnet" },
    { id: "gpt-oss-120b-medium", name: "GPT OSS" },
  ])
})

test("empty probe data is unknown and never erases a successful account cache", () => {
  const account = { key: `discovery-${process.pid}` }
  assert.deepEqual(seedOfferedModels("agy-fixture", account, [{ id: "claude-sonnet", name: "Sonnet" }]), [{ id: "claude-sonnet", name: "Sonnet" }])
  assert.equal(seedOfferedModels("agy-fixture", account, []), null)
  assert.deepEqual(seedOfferedModels("agy-fixture", account, [{ id: "gpt-oss-120b-medium", name: "GPT OSS" }]), [{ id: "gpt-oss-120b-medium", name: "GPT OSS" }])
})
