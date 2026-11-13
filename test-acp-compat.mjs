import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Exercise the public provider and its real Proc/AcpConnection with a subprocess.
// The fake has no network, credentials, context unlock or MCP dependencies.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy acp compat-"))
const executable = path.join(root, process.platform === "win32" ? "agy.cmd" : "agy")
const source = path.join(root, "fake.mjs")
const logFile = path.join(root, "wire.jsonl")
fs.writeFileSync(source, String.raw`
import fs from "node:fs"
import readline from "node:readline"
const mode = process.env.COMPAT_MODE
const log = event => fs.appendFileSync(process.env.COMPAT_LOG, JSON.stringify({ mode, pid: process.pid, ...event }) + "\n")
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")
if (process.argv.includes("--version")) { console.log("1.5.4"); process.exit(0) }
if (process.argv.includes("models")) { console.log("gemini-test-high\tTest High"); process.exit(0) }
log({ kind: "spawn" })
let sessionId, model = "other", effort = "low", append = ""
const options = () => [
  { id: "model", category: "model", type: "select", currentValue: model, options: ["other", "gemini-test"].map(value => ({ value, name: value })) },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: effort,
    options: (model === "other" ? ["low"] : ["low", "high"]).map(value => ({ value, name: value })) },
]
const update = (configOptions, id = sessionId) => {
  log({ kind: "notification", sessionId: id, configOptions })
  send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "config_option_update", configOptions } } })
}
process.stdin.on("end", () => process.exit(0))
setInterval(() => { if (fs.existsSync(process.env.COMPAT_STOP)) process.exit(0) }, 20).unref()
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line), p = msg.params || {}
  log({ kind: "request", method: msg.method, params: p })
  const reply = result => { log({ kind: "response", method: msg.method }); send({ id: msg.id, result }) }
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentInfo: { version: mode.startsWith("legacy") ? "1.4.12" : "1.5.4" },
    agentCapabilities: { sessionCapabilities: { resume: {} }, _meta: { antigravity: { systemPrompt: { append: mode !== "no-append" } } } } })
  if (["session/new", "session/resume"].includes(msg.method)) {
    sessionId = p.sessionId || "session-" + process.pid
    append = p._meta?.antigravity?.systemPrompt?.append || ""
    return reply({ sessionId, configOptions: options(), models: { currentModelId: "other", availableModels: [] } })
  }
  if (msg.method === "session/set_config_option") {
    if (mode === "unsupported" || mode === "real-error") return send({ id: msg.id, error: { code: mode === "unsupported" ? -32601 : -32602, message: "fixture rejection" } })
    if (p.configId === "model") { model = p.value; effort = "low" } else effort = p.value
    const next = options()
    if (mode === "close") return process.exit(0)
    if (mode === "hang" || mode === "legacy-hang") return
    if (mode === "bad-response") return reply({ configOptions: [] })
    if (mode === "notification-first") { update(next); return setTimeout(() => reply({ configOptions: next }), 30) }
    reply({ configOptions: next })
    if (mode.startsWith("legacy") || mode === "missing" || (mode === "missing-effort" && p.configId === "thought_level")) return
    if (mode === "cross-session") return update(next, "wrong-session")
    if (mode === "conflict" || (mode === "conflict-effort" && p.configId === "thought_level")) {
      next.find(o => o.id === p.configId).currentValue = "wrong"
      return update(next)
    }
    setTimeout(() => update(next), 40)
    return
  }
  if (msg.method === "session/set_model") { model = p.modelId; return reply({}) }
  if (msg.method === "session/prompt") {
    log({ kind: "prompt", append, model, effort, prompt: p.prompt })
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture answer" } } } })
    return reply({ stopReason: "end_turn" })
  }
  if (msg.id) reply({})
})
`)
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
fs.writeFileSync(executable, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "${source}" %*\r\n`
  : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`, { mode: 0o755 })
Object.assign(process.env, {
  AGY_PATH: executable, COMPAT_LOG: logFile, COMPAT_STOP: path.join(root, "stop"),
  AGY_BRIDGE_STATE_FILE: path.join(root, "sessions.json"), AGY_BRIDGE_CONVERSATIONS_DIR: path.join(root, "conversations"),
  AGY_BRIDGE_ACCOUNTS_DIR: path.join(root, "accounts"), AGY_BRIDGE_CONTEXT_DIR: path.join(root, "context"),
  AGY_BRIDGE_CONFIG_TIMEOUT_MS: "500", AGY_BRIDGE_START_TIMEOUT_MS: "3000",
})
delete process.env.AGY_BRIDGE_WSL_DISTRO
const logs = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
let serial = 0
async function loader() {
  const { default: Bridge } = await import(`./index.mjs?acp-compat-${serial++}`)
  return (await Bridge.server({ directory: root }, {})).auth.loader(async () => ({ key: "agy" }))
}
const request = (client, messages, extra = {}, signal) => client.fetch("agy://local/messages", {
  method: "POST", headers: { "content-type": "application/json" }, signal,
  body: JSON.stringify({ model: "gemini-test-high", max_tokens: 128, stream: false, messages, ...extra }),
})
async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), "fixture reached expected protocol event")
}
test.after(async () => {
  fs.writeFileSync(process.env.COMPAT_STOP, "1")
  const pids = [...new Set(logs().filter(e => e.kind === "spawn").map(e => e.pid))]
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  await waitFor(() => pids.every(pid => !alive(pid)))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  // The production provider owns long-lived servers; all fixture children have
  // exited above. Match the existing production-entry auth test teardown.
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})

for (const mode of ["response-first", "notification-first", "legacy", "legacy-hang", "unsupported", "missing", "missing-effort", "cross-session", "conflict", "conflict-effort", "bad-response", "real-error", "close", "hang"]) {
  test(`configuration protocol: ${mode}`, async () => {
    process.env.COMPAT_MODE = mode
    const start = logs().length
    const client = await loader()
    const result = await request(client, [{ role: "user", content: `case ${mode}` }])
    const body = await result.json()
    const events = logs().slice(start)
    const success = ["response-first", "notification-first", "legacy", "unsupported"].includes(mode)
    assert.equal(result.status === 200, success, JSON.stringify(body))
    assert.equal(events.filter(e => e.kind === "prompt").length, success ? 1 : 0)
    if (!success) assert.equal(events.filter(e => e.method === "session/set_model").length, 0, "real failures do not fall back")
    if (["conflict", "conflict-effort"].includes(mode)) {
      assert.equal(result.status, 502)
      assert.equal(body.error?.code, "config_confirmation_conflict")
      assert.match(body.error?.message || "", /contradicted/, "a contradictory notification fails immediately, not through a later timeout")
    }
    if (["missing", "missing-effort", "cross-session", "hang", "legacy-hang"].includes(mode)) {
      assert.equal(result.status, 503, "confirmation deadlines remain retryable service failures")
      assert.equal(body.error?.code, "config_confirmation_timeout")
      assert.match(body.error?.message || "", /confirmation timed out/)
    }
    if (mode === "unsupported") assert.ok(events.some(e => e.method === "session/set_model"))
    if (["response-first", "notification-first"].includes(mode)) {
      const effortAt = events.findIndex(e => e.kind === "request" && e.params?.configId === "thought_level")
      const modelNotice = events.findIndex(e => e.kind === "notification")
      const modelResponse = events.findIndex(e => e.kind === "response" && e.method === "session/set_config_option")
      assert.ok(effortAt > modelNotice && effortAt > modelResponse, "effort waits for both model confirmations")
      assert.equal(events.find(e => e.kind === "prompt").effort, "high", "new model menu supplies high")
    }
  })
}

for (const mode of ["response-first", "legacy-resume", "no-append"]) {
  test(`resume append: ${mode}`, async () => {
    process.env.COMPAT_MODE = mode
    const start = logs().length
    let messages = [{ role: "user", content: `resume opening ${mode}` }]
    for (let round = 0; round < 3; round++) {
      const response = await request(await loader(), messages, { system: "APPEND_COMPAT_MARKER" })
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      messages = [...messages, { role: "assistant", content: body.content }, { role: "user", content: `next ${mode} ${round}` }]
    }
    const events = logs().slice(start)
    const opens = events.filter(e => e.kind === "request" && ["session/new", "session/resume"].includes(e.method))
    assert.equal(opens.length, 3)
    assert.deepEqual(opens.map(e => e.method), ["session/new", "session/resume", "session/resume"])
    for (const [i, event] of opens.entries()) {
      const append = event.params._meta?.antigravity?.systemPrompt?.append || ""
      assert.equal(append.split("APPEND_COMPAT_MARKER").length - 1, mode === "no-append" || (mode === "legacy-resume" && i > 0) ? 0 : 1)
    }
    const prompts = events.filter(e => e.kind === "prompt")
    assert.equal(prompts.length, 3)
    for (let i = 1; i < prompts.length; i++) {
      assert.equal(prompts[i].prompt.map(p => p.text || "").join(""), `next ${mode} ${i - 1}`, "resume submits only the new user turn")
    }
  })
}

test("startup deadline and cancellation leave no prompt or delayed effort", async () => {
  for (const cancel of [false, true]) {
    process.env.COMPAT_MODE = "missing"
    process.env.AGY_BRIDGE_START_TIMEOUT_MS = cancel ? "3000" : "70"
    process.env.AGY_BRIDGE_CONFIG_TIMEOUT_MS = "1500"
    const start = logs().length
    const ac = new AbortController()
    const pending = request(await loader(), [{ role: "user", content: `startup cleanup ${cancel}` }], {}, ac.signal)
    if (cancel) {
      await waitFor(() => logs().slice(start).some(e => e.kind === "request" && e.method === "session/set_config_option"))
      ac.abort(new Error("fixture cancellation"))
    }
    const result = await pending.then(async r => ({ status: r.status, body: await r.text() }), error => ({ error }))
    assert.notEqual(result.status, 200)
    const events = logs().slice(start)
    assert.equal(events.filter(e => e.kind === "prompt").length, 0)
    assert.equal(events.filter(e => e.params?.configId === "thought_level").length, 0)
  }
})
