// OpenCode 2.x loads package.json exports["."] (opencode2.mjs) and wants a
// default {id, setup(ctx)}. These run that adapter against a fake of 2.x's
// plugin context: no OpenCode, no agy, no network, no account.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-opencode2-"))
const homedir = os.homedir
os.homedir = () => root
const saved = {}
const isolate = {
  PATH: path.join(root, "bin"), Path: path.join(root, "bin"),
  AGY_PATH: path.join(root, "no-agy"), XDG_DATA_HOME: path.join(root, "data"), LOCALAPPDATA: path.join(root, "local"),
  AGY_CLI_DISABLE_AUTO_UPDATE: "1", AGY_BRIDGE_STORED_SIGNIN: "skip", AGY_BRIDGE_ACCOUNTS_DIR: path.join(root, "accounts"),
}
for (const [k, v] of Object.entries(isolate)) { saved[k] = process.env[k]; process.env[k] = v }
fs.mkdirSync(path.join(root, "bin"))
const realFetch = globalThis.fetch
globalThis.fetch = async (input) => { throw new Error(`no network in tests: ${input?.url ?? input}`) }
after(() => {
  globalThis.fetch = realFetch
  os.homedir = homedir
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  fs.rmSync(root, { recursive: true, force: true })
  // the bridge's own timers are unref'd but its pools may linger
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})

const unhandled = []
process.on("unhandledRejection", (error) => unhandled.push(error))

function fakeContext() {
  const methods = []
  const providerTransforms = []
  const hooks = []
  const conns = new Map()
  const reloads = { provider: 0, model: 0 }
  const ctx = {
    location: { directory: root },
    integration: {
      transform: async (fn) => fn({ update() {}, method: { update: (m) => methods.push(m) } }),
      connection: {
        active: async (id) => conns.get(id)?.connection,
        resolve: async (c) => [...conns.values()].find((x) => x.connection === c)?.value,
      },
    },
    provider: { transform: async (fn) => providerTransforms.push(fn), reload: async () => void reloads.provider++ },
    model: { reload: async () => void reloads.model++ },
    aisdk: { hook: async (name, fn, filter) => hooks.push({ name, fn, filter }) },
    storage: { get: async () => undefined, set: async () => {} },
  }
  const providers = () => {
    const out = []
    for (const fn of providerTransforms) fn({ add: (p) => out.push(p) })
    return out
  }
  return { ctx, methods, providers, hooks, conns, reloads }
}

const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(cond(), true)
}

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))
const entry = new URL(pkg.exports["."], import.meta.url)

test("exports['.'] is a 2.x plugin and main stays the 1.x/magpie plugin", async () => {
  const mod = await import(entry.href)
  assert.equal(mod.default.id, pkg.name)
  assert.equal(typeof mod.default.setup, "function")
  const v1 = await import(new URL(pkg.main, import.meta.url).href)
  assert.equal(typeof v1.default.server, "function")
  const shim = await import(new URL("./opencode.mjs", import.meta.url).href)
  assert.equal(shim.default, v1.default)
  for (const f of ["index.mjs", "opencode.mjs", "opencode2.mjs", "install.mjs"]) assert.ok(pkg.files.includes(f), f)
})

test("on 2.x the bridge has a provider for its own model list, not only sign-ins", async () => {
  const { setup } = await import(entry.href)
  const f = fakeContext()
  // signed in with the CLI login, as 2.x saves the 1.x {type:"api", key:"agy"}
  f.conns.set("antigravity-bridge", { connection: { type: "credential", id: "c1" }, value: { type: "oauth", methodID: "v1-0", access: "agy", refresh: "", expires: 0, metadata: { v1: { type: "api", key: "agy" } } } })
  const stop = await setup(f.ctx)
  try {
    assert.ok(f.methods.length >= 1)
    assert.ok(f.methods.every((m) => m.integrationID === "antigravity-bridge"))
    const provs = f.providers()
    assert.deepEqual(provs.map((p) => p.info.id), ["antigravity-bridge"])
    assert.equal(provs[0].info.package, "aisdk:@ai-sdk/anthropic@ai-v6")
    assert.equal(provs[0].info.integrationID, "antigravity-bridge")
    const hook = f.hooks.find((h) => h.filter.providerID === "antigravity-bridge")
    assert.equal(hook?.name, "sdk")

    // 2.x reads the bridge's own list (its static one with no agy here)
    // into that provider, as 2.x Model.Info
    await until(() => f.reloads.model > 0)
    const models = f.providers()[0].models
    assert.ok(models.length > 0)
    for (const m of models) {
      assert.equal(m.providerID, "antigravity-bridge")
      assert.ok(Number.isInteger(m.limit.context) && m.limit.context > 0)
      assert.ok(Number.isInteger(m.limit.output) && m.limit.output > 0)
      assert.ok(Array.isArray(m.variants))
    }
    const gemini = models.find((m) => /^gemini-/.test(m.id))
    assert.ok(gemini?.capabilities.input.includes("image"), "Gemini takes images")
  } finally {
    stop()
  }
})

test("requests go through the bridge's loader fetch with its local base URL", async () => {
  const { setup } = await import(entry.href)
  const f = fakeContext()
  f.conns.set("antigravity-bridge", { connection: { type: "credential", id: "c1" }, value: { type: "oauth", access: "agy", refresh: "", expires: 0, metadata: { v1: { type: "api", key: "agy" } } } })
  const stop = await setup(f.ctx)
  try {
    const hook = f.hooks.find((h) => h.filter.providerID === "antigravity-bridge")
    const options = { baseURL: "agy://local" }
    await hook.fn({ model: {}, options })
    assert.equal(typeof options.fetch, "function")
    // count_tokens is answered locally by the loader's fetch
    const r = await options.fetch("agy://local/messages/count_tokens", {
      method: "POST", headers: { "x-api-key": options.apiKey }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal(r.status, 200)
    assert.ok((await r.json()).input_tokens > 0)
    // no agy on this machine: an Anthropic-shaped error, not a thrown fetch
    const m = await options.fetch("agy://local/messages", { method: "POST", headers: {}, body: JSON.stringify({ model: "gemini-3-flash", messages: [{ role: "user", content: "hi" }] }) })
    assert.equal(m.status, 503)
    const body = await m.json()
    assert.equal(body.type, "error")
    assert.match(body.error.message, /agy/)
  } finally {
    stop()
  }
})

test("a failed 1.x key sign-in fails its 2.x callback without an unhandled rejection", async () => {
  const { setup } = await import(entry.href)
  const f = fakeContext()
  const seen = unhandled.length
  await setup(f.ctx, {
    default: { id: "x", server: async () => ({ auth: { provider: "x", methods: [
      { type: "api", label: "k", authorize: async () => ({ type: "failed", error: "agy CLI not found" }) },
      { type: "oauth", label: "o", authorize: async () => ({ type: "failed", error: "no url for you" }) },
    ] } }) },
  })
  const key = await f.methods[0].authorize({})
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(unhandled.length, seen)
  await assert.rejects(key.callback, /agy CLI not found/)
  // an OAuth sign-in that fails before its URL says why instead of
  // "r.callback is not a function"
  await assert.rejects(f.methods[1].authorize({}), /no url for you/)
})

test("a hook-only provider is not invented when the plugin has a config provider", async () => {
  const { setup } = await import(entry.href)
  const f = fakeContext()
  await setup(f.ctx, {
    P: async () => ({
      auth: { provider: "acme", methods: [{ type: "api", label: "key" }] },
      config: async (cfg) => { cfg.provider.acme = { npm: "@ai-sdk/openai-compatible", models: { m: { name: "M" } } } },
      provider: { id: "acme", npm: "@ai-sdk/anthropic", models: async () => ({}) },
    }),
  })
  const provs = f.providers()
  assert.equal(provs.length, 1)
  assert.equal(provs[0].info.package, "aisdk:@ai-sdk/openai-compatible@2.0.41")
  assert.deepEqual(provs[0].models.map((m) => m.id), ["m"])
})

test("the entry file is importable by its file URL as 2.x resolves it", async () => {
  const mod = await import(new URL("./opencode2.mjs", import.meta.url).href)
  assert.equal(typeof mod.setup, "function")
})
