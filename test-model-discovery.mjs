// Issue #55: model discovery through the real provider and a fake `agy` that
// speaks ACP. Each test uses its own account so cache scopes never overlap.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { nativeAccountResult } from "./native-accounts.mjs"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-model-discovery-"))
const accountsDir = path.join(root, "accounts")
const configPath = path.join(root, "config.json")
const logPath = path.join(root, "events.jsonl")
const script = path.join(root, "fake-agy.mjs")
const executable = path.join(root, process.platform === "win32" ? "agy.cmd" : "agy")

const CLI = [
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"], ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"], ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"], ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"], ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"], ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"], ["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"], ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]
const FULL = ["claude-opus-5-5", "gemini-3.8-flash", "gemini-4-argon", "gpt-oss-120b-medium", "claude-sonnet-5-5"].sort()
const NO_FLASH = ["claude-opus-5-5", "gemini-4-argon", "gpt-oss-120b-medium", "claude-sonnet-5-5"].sort()

fs.writeFileSync(script, String.raw`
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
const args = process.argv.slice(2)
const dir = args.find(arg => arg.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length)
const scope = dir ? path.basename(dir) : "default"
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_CONFIG, "utf8"))[scope] || {}
const log = event => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ...event, scope, pid: process.pid, at: Date.now() }) + "\n")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms || 0))
if (args.includes("--version")) { console.log("1.5.7"); process.exit(0) }
if (args.includes("models")) {
  log({ type: "models-start" })
  await sleep(cfg.cliDelay)
  process.stdout.write(JSON.parse(process.env.FAKE_CLI).map(([id, name]) => id + "  " + name).join("\n") + "\n")
  log({ type: "models-end" })
  process.exit(0)
}
const live = args.includes("--agent")
log({ type: "acp-start", live, cwd: process.cwd() })
if (!live && cfg.acpMode === "fail") { log({ type: "acp-exit" }); process.exit(1) }
const send = value => process.stdout.write(JSON.stringify(value) + "\n")
const quit = () => { log({ type: "acp-exit" }); process.exit(0) }
process.on("SIGTERM", quit)
let sessionId = null
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line)
  if (message.id == null || !message.method) return
  let result
  if (message.method === "initialize") {
    if (!live) await sleep(cfg.acpDelay)
    result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } },
      agentInfo: { name: "fake", version: (!live && cfg.version) || "1.5.7" } }
  } else if (message.method === "session/new") {
    const ids = live ? cfg.live : cfg.acpMode === "empty" ? [] : cfg.acp
    sessionId = "s-" + process.pid
    result = { sessionId, models: { currentModelId: "gemini-4-argon-medium", availableModels: [] },
      configOptions: [{ id: "model", category: "model", type: "select", currentValue: "gemini-4-argon", options: (ids || []).map(value => ({ value, name: value })) }] }
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } })
    result = { stopReason: "end_turn" }
  } else result = {}
  send({ jsonrpc: "2.0", id: message.id, result })
})
process.stdin.on("end", quit)
`)
fs.writeFileSync(executable, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
  : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 })

const config = {}
const configure = (scope, value) => {
  config[scope] = { ...config[scope], ...value }
  fs.writeFileSync(configPath, JSON.stringify(config))
}
configure("default", { acp: FULL })
Object.assign(process.env, {
  AGY_PATH: executable, AGY_BRIDGE_ACCOUNTS_DIR: accountsDir, AGY_BRIDGE_STATE_FILE: path.join(root, "state.json"),
  AGY_BRIDGE_CONVERSATIONS_DIR: root, AGY_BRIDGE_STEP_USAGE: "0", FAKE_CONFIG: configPath, FAKE_LOG: logPath,
  FAKE_CLI: JSON.stringify(CLI),
})
delete process.env.AGY_BRIDGE_WSL_DISTRO

const { AntigravityBridgePlugin } = await import("./index.mjs")
const plugin = await AntigravityBridgePlugin({ magpie: {}, client: { auth: { set: async () => {} } } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const events = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function account(name, value) {
  fs.mkdirSync(path.join(accountsDir, name, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(path.join(accountsDir, name, "antigravity-cli", "antigravity-oauth-token"), "{}")
  configure(name, value)
  const { type: _, ...fields } = nativeAccountResult(name)
  return { type: "api", ...fields }
}
const models = async auth => Object.keys(await plugin.provider.models({}, { auth })).sort()
const probes = scope => events().filter(e => e.type === "acp-start" && !e.live && e.scope === scope)

async function probesSettled(scope, expected = 1) {
  for (let i = 0; i < 100; i++) {
    const started = probes(scope)
    if (started.length < expected) { await sleep(100); continue }
    if (started.every(e => !alive(e.pid) && !fs.existsSync(e.cwd))) return started
    await sleep(100)
  }
  throw new Error(`probe processes for ${scope} were not cleaned up`)
}

after(() => {
  for (const e of events().filter(e => e.type === "acp-start")) try { process.kill(e.pid, "SIGKILL") } catch {}
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

test("cold start waits for a slow ACP probe concurrently with `agy models`", async () => {
  const auth = account("cold", { cliDelay: 1200, acpDelay: 1500, acp: NO_FLASH })
  const started = Date.now()
  assert.deepEqual(await models(auth), NO_FLASH)
  const elapsed = Date.now() - started
  assert(elapsed >= 1400 && elapsed < 9000, `elapsed ${elapsed}ms`)
  const scoped = events().filter(e => e.scope === "cold")
  const cliEnd = scoped.find(e => e.type === "models-end").at
  const acp = probes("cold")
  assert.equal(acp.length, 1)
  assert(acp[0].at < cliEnd, "ACP probe started before the CLI catalog finished")
  await probesSettled("cold")
})

test("empty ACP, failed ACP and an old CLI keep the full CLI catalog", async () => {
  for (const [name, value] of [["empty", { acpMode: "empty" }], ["failed", { acpMode: "fail" }], ["old", { version: "1.4.0", acp: NO_FLASH }]]) {
    assert.deepEqual(await models(account(name, value)), FULL, name)
    await probesSettled(name)
  }
})

test("stale results are served during one shared refresh; slow or failed refreshes keep them", async () => {
  process.env.AGY_BRIDGE_MODEL_CACHE_TTL_MS = "300"
  process.env.AGY_BRIDGE_MODEL_PROBE_RETRY_MS = "60000"
  try {
    const auth = account("stale", { acp: NO_FLASH })
    assert.deepEqual(await models(auth), NO_FLASH)
    assert.equal(probes("stale").length, 1)
    await sleep(400)
    configure("stale", { acpDelay: 2500, acp: FULL })
    const started = Date.now()
    const concurrent = await Promise.all([models(auth), models(auth), models(auth)])
    assert(Date.now() - started < 2000, "stale value returned without waiting for the refresh")
    for (const result of concurrent) assert.deepEqual(result, NO_FLASH)
    // The stale response can precede the child starting; wait for its log.
    for (let i = 0; i < 50 && probes("stale").length < 2; i++) await sleep(50)
    assert.equal(probes("stale").length, 2, "concurrent refreshes share one probe")
    await probesSettled("stale", 2)
    assert.deepEqual(await models(auth), FULL, "the completed refresh replaces the stale value")

    await sleep(400)
    configure("stale", { acpDelay: 0, acpMode: "fail" })
    assert.deepEqual(await models(auth), FULL)
    await probesSettled("stale", 3)
    const count = probes("stale").length
    assert.deepEqual(await models(auth), FULL, "a failed refresh keeps the last success")
    assert.equal(probes("stale").length, count, "a failed refresh is not retried on every call")
  } finally {
    delete process.env.AGY_BRIDGE_MODEL_CACHE_TTL_MS
    delete process.env.AGY_BRIDGE_MODEL_PROBE_RETRY_MS
  }
})

test("a live session seeds its account; a late older probe neither overwrites nor returns its data", async () => {
  const live = ["gemini-4-argon", "claude-opus-5-5"]
  const auth = account("live", { acpDelay: 2500, acp: FULL, live })
  const other = account("other", { acp: NO_FLASH })
  const pending = models(auth)
  await sleep(200)
  const loader = await plugin.auth.loader(async () => auth)
  const response = await loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify({
    model: "gemini-4-argon", stream: false, messages: [{ role: "user", content: "seed" }] }) })
  assert.equal(response.status, 200, await response.clone().text())
  const liveStart = events().find(e => e.type === "acp-start" && e.live && e.scope === "live")
  assert(liveStart, "the request ran in the live account's own agy process")
  assert(liveStart.at < probes("live")[0].at + 2500, "the live handshake finished before the probe")
  assert.deepEqual(await pending, [...live].sort())
  await probesSettled("live")
  assert.deepEqual(await models(auth), [...live].sort())
  assert.equal(probes("live").length, 1)
  assert.deepEqual(await models(other), NO_FLASH, "another account keeps its own scope")
  assert.deepEqual(probes("other").map(e => e.scope), ["other"])
  await probesSettled("other")
})

test("cold wait is bounded, and old-CLI refresh preserves and throttles a previous success", async () => {
  const auth = account("bounded", { acpDelay: 1000, acp: NO_FLASH })
  process.env.AGY_BRIDGE_MODEL_PROBE_WAIT_MS = "200"
  try {
    const started = Date.now()
    assert.deepEqual(await models(auth), FULL, "a cold wait timeout keeps the CLI catalog")
    assert(Date.now() - started < 900, "the cold discovery wait is bounded")
    await probesSettled("bounded")
    assert.deepEqual(await models(auth), NO_FLASH, "the background probe is cached at completion")
  } finally { delete process.env.AGY_BRIDGE_MODEL_PROBE_WAIT_MS }

  process.env.AGY_BRIDGE_MODEL_CACHE_TTL_MS = "1"
  process.env.AGY_BRIDGE_MODEL_PROBE_RETRY_MS = "60000"
  configure("bounded", { version: "1.4.0", acpDelay: 0 })
  try {
    await sleep(10)
    assert.deepEqual(await models(auth), NO_FLASH)
    await probesSettled("bounded", 2)
    const count = probes("bounded").length
    assert.equal(count, 2)
    assert.deepEqual(await models(auth), NO_FLASH, "an old CLI does not erase an earlier success")
    assert.equal(probes("bounded").length, count, "old-CLI failures use the retry throttle")
  } finally {
    delete process.env.AGY_BRIDGE_MODEL_CACHE_TTL_MS
    delete process.env.AGY_BRIDGE_MODEL_PROBE_RETRY_MS
  }
})
