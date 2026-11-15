import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const KEYS = ["AGY_BRIDGE_CLOUDCODE_URL", "AGY_BRIDGE_STORED_SIGNIN", "AGY_BRIDGE_DISABLE_KEYCHAIN", "AGY_BRIDGE_CLOUDCODE_METADATA", "AGY_BRIDGE_WSL_DISTRO"]
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-metadata-"))
// Stub only the credential reader's home lookup; don't repurpose process HOME.
const fixtureHome = path.join(root, "home")
const homedir = os.homedir
const realishAgy = path.join(process.cwd(), ".fake-agy-not-in-tmpdir")

function writeToken(dir, token) {
  fs.mkdirSync(path.join(dir, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(path.join(dir, "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ token }))
}

const realFetch = globalThis.fetch
let calls = []
let respond = () => ({ ok: true, json: async () => ({ models: { "gemini-3.8-flash": { maxTokens: 500_000, maxOutputTokens: 1000 } } }) })

const { fetchCloudCodeModels, invalidateModelMetadataCache, getCachedCloudCodeModels } = await import("./model-metadata.mjs")

test.beforeEach(() => {
  for (const k of KEYS) delete process.env[k]
  os.homedir = () => fixtureHome
  process.env.AGY_BRIDGE_DISABLE_KEYCHAIN = "1"
  process.env.AGY_BRIDGE_CLOUDCODE_URL = "http://cloudcode.invalid"
  calls = []
  respond = () => ({ ok: true, json: async () => ({ models: { "gemini-3.8-flash": { maxTokens: 500_000, maxOutputTokens: 1000 } } }) })
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization })
    return respond(url)
  }
  invalidateModelMetadataCache()
  fs.rmSync(fixtureHome, { recursive: true, force: true })
  writeToken(path.join(fixtureHome, ".gemini"), { access_token: "host-default-token" })
})

test.after(() => {
  globalThis.fetch = realFetch
  os.homedir = homedir
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test("a custom CloudCode endpoint never unlocks the host default token for a mock agy", async () => {
  const result = await fetchCloudCodeModels({ key: "default" }, path.join(os.tmpdir(), "fake-agy"), true)
  assert.equal(result, null)
  assert.equal(calls.length, 0)
})

test("AGY_BRIDGE_STORED_SIGNIN=skip blocks the host default token even for a non-tmp agy path", async () => {
  process.env.AGY_BRIDGE_STORED_SIGNIN = "skip"
  assert.equal(await fetchCloudCodeModels({ key: "default" }, realishAgy, true), null)
  assert.equal(calls.length, 0)
})

test("AGY_BRIDGE_CLOUDCODE_METADATA=0 opts out, even for a named account", async () => {
  process.env.AGY_BRIDGE_CLOUDCODE_METADATA = "0"
  const dir = path.join(root, "named-optout")
  writeToken(dir, { access_token: "named-token" })
  assert.equal(await fetchCloudCodeModels({ key: "dir:" + dir, dir }, realishAgy, true), null)
  assert.equal(calls.length, 0)
})

test("WSL mode never reads Windows-host credentials", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32" })
  try {
    process.env.AGY_BRIDGE_WSL_DISTRO = "Ubuntu"
    const dir = path.join(root, "named-wsl")
    writeToken(dir, { access_token: "named-token" })
    assert.equal(await fetchCloudCodeModels({ key: "default" }, realishAgy, true), null)
    assert.equal(await fetchCloudCodeModels({ key: "dir:" + dir, dir }, realishAgy, true), null)
  } finally {
    Object.defineProperty(process, "platform", platform)
  }
  assert.equal(calls.length, 0)
})

test("a named account uses only its own token", async () => {
  const dir = path.join(root, "named")
  writeToken(dir, { access_token: "named-token" })
  const result = await fetchCloudCodeModels({ key: "dir:" + dir, dir }, path.join(os.tmpdir(), "fake-agy"), true)
  assert.equal(result.models.get("gemini-3.8-flash").context, 500_000)
  assert.ok(calls.length > 0)
  assert.ok(calls.every(call => call.auth === "Bearer named-token"))
})

test("a failed forced refresh keeps the last good limits", async () => {
  const dir = path.join(root, "named-keep")
  writeToken(dir, { access_token: "named-token" })
  const account = { key: "dir:" + dir, dir }
  await fetchCloudCodeModels(account, realishAgy, true)
  respond = () => ({ ok: false, json: async () => ({}) })
  const again = await fetchCloudCodeModels(account, realishAgy, true)
  assert.equal(again.models.get("gemini-3.8-flash")?.context, 500_000)
})

test("invalidation discards an in-flight fetch for the previous account state", async () => {
  const dir = path.join(root, "named-race")
  writeToken(dir, { access_token: "old-token" })
  const account = { key: "dir:" + dir, dir }
  let release
  const gate = new Promise(resolve => { release = resolve })
  respond = async () => { await gate; return { ok: true, json: async () => ({ models: { old: { maxTokens: 1 } } }) } }
  const stale = fetchCloudCodeModels(account, realishAgy, true)
  await new Promise(resolve => setImmediate(resolve))
  invalidateModelMetadataCache()
  release()
  await stale
  assert.equal(getCachedCloudCodeModels(account), null)
})

test("go-keyring-encoded tokens are accepted", async () => {
  const dir = path.join(root, "named-hex")
  fs.mkdirSync(path.join(dir, "antigravity-cli"), { recursive: true })
  const hex = Buffer.from(JSON.stringify({ token: { access_token: "hex-token" } })).toString("hex")
  fs.writeFileSync(path.join(dir, "antigravity-cli", "antigravity-oauth-token"), "go-keyring-encoded:" + hex)
  await fetchCloudCodeModels({ key: "dir:" + dir, dir }, realishAgy, true)
  assert.ok(calls.length > 0 && calls.every(call => call.auth === "Bearer hex-token"))
})
