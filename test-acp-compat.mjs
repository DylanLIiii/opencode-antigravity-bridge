import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { v2 as compactionPrompt } from "./test/fixtures/opencode-compaction-prompts.mjs"

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
let sessionId, model = "other", effort = "low", append = "", fragments = 0, cancelPrompt = null
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
    if (mode === "context-usage") setTimeout(() => {
      const usage = (used, size, id = sessionId) => send({ method: "session/update", params: { sessionId: id, update: { sessionUpdate: "usage_update", used, size } } })
      usage(42, 1048576)
      usage(99, 1048576, "wrong-session")
      usage(-1, 1048576)
      usage(0, 0)
      usage("42", 1048576)
    }, 10)
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
  if (msg.method === "session/cancel") {
    cancelPrompt?.({ stopReason: "cancelled" })
    cancelPrompt = null
    return
  }
  if (msg.method === "session/prompt") {
    log({ kind: "prompt", append, model, effort, prompt: p.prompt })
    if (mode === "context-usage") send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 123456, size: 1048576 } } })
    const text = p.prompt.map(part => part.text || "").join("")
    const chunk = text => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })
    const notAdded = () => send({ id: msg.id, error: { code: -32603, message: "Can't add this prompt to session: waiting for a permission" } })
    if (text.includes("PROMPT_NOT_ADDED_FIRST")) return notAdded()
    if (text.includes("PROMPT_NOT_ADDED_LATE")) {
      chunk("Accepted original prompt")
      return reply({ stopReason: "max_tokens" })
    }
    if (mode === "late-prompt-rejected" && text.startsWith("Continue exactly")) return notAdded()
    if (text.startsWith("CANCEL_RETRY original")) {
      cancelPrompt = reply
      if (mode !== "cancel-before-text") chunk("Partial answer")
      return
    }
    if (text === "[The previous reply was interrupted before it finished. Answer my last message again, in full.]") {
      if (mode === "cancel-nudge-rejected") return notAdded()
      chunk("Complete replacement answer")
      return reply({ stopReason: "end_turn" })
    }
    if (text.includes("[Bridge compaction fragment ")) {
      fragments++
      if (mode === "compaction-prompt-rejected" && fragments === 2) return notAdded()
      if (mode === "compaction-empty-fragment" && fragments === 2) return reply({ stopReason: "end_turn" })
      if (mode === "compaction-failure" && fragments === 2) {
        chunk("\n⚠ Your AI credits balance is too low to continue.\n")
        return reply({ stopReason: "end_turn" })
      }
      if (mode === "compaction-refusal") return reply({ stopReason: "refusal" })
      if (mode === "compaction-cancel") { cancelPrompt = reply; return }
      if (mode === "compaction-hang") return
      chunk("ACK-INTERNAL")
      return reply({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } })
    }
    if (text.startsWith("All conversation fragments") || text.includes("\n\nAll conversation fragments")) {
      if (mode === "compaction-empty-final") return reply({ stopReason: "end_turn" })
      if (mode === "compaction-thought-only-final") {
        send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning the summary" } } } })
        return reply({ stopReason: "end_turn" })
      }
      chunk("## Objective\nKeep LATEST-INSTRUCTION pending.\n## Next Move\nContinue from the summary.")
      return reply({ stopReason: "end_turn", usage: { inputTokens: 30, outputTokens: 12 } })
    }
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
  // The fake ACP owns authentication outcomes. Host keychain state must never
  // reject a fixture request or provide credentials to background discovery.
  AGY_BRIDGE_STORED_SIGNIN: "skip", AGY_BRIDGE_CLOUDCODE_METADATA: "0", AGY_CLI_DISABLE_AUTO_UPDATE: "1",
  AGY_BRIDGE_STATE_FILE: path.join(root, "sessions.json"), AGY_BRIDGE_CONVERSATIONS_DIR: path.join(root, "conversations"),
  AGY_BRIDGE_ACCOUNTS_DIR: path.join(root, "accounts"), AGY_BRIDGE_CONTEXT_DIR: path.join(root, "context"),
  AGY_BRIDGE_CONFIG_TIMEOUT_MS: "1500", AGY_BRIDGE_START_TIMEOUT_MS: "5000",
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

const largeHistory = "ISSUE65-HISTORY-START\n" + "😀历史".repeat(40000) + "\nLATEST-INSTRUCTION: preserve this entire request."
const summaryMessages = (kind = "flattened") => kind === "flattened"
  ? [{ role: "user", content: largeHistory }, { role: "user", content: compactionPrompt }]
  : [{ role: "user", content: "Read the report and keep LATEST-INSTRUCTION pending." },
    { role: "assistant", content: [{ type: "tool_use", id: "already-executed", name: "Read", input: { path: "report" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "already-executed", content: largeHistory }] },
    { role: "user", content: compactionPrompt }]

for (const mode of ["first-prompt-rejected", "late-prompt-rejected", "compaction-prompt-rejected", "compaction-empty-fragment", "compaction-empty-final", "compaction-thought-only-final"]) {
  test(`PR75 rejected or empty follow-ups preserve logical attempt state: ${mode}`, async () => {
    process.env.COMPAT_MODE = mode
    const client = await loader()
    const messages = mode.startsWith("compaction-") ? summaryMessages()
      : [{ role: "user", content: mode === "first-prompt-rejected" ? "PROMPT_NOT_ADDED_FIRST" : "PROMPT_NOT_ADDED_LATE" }]
    const before = logs().length
    const first = await request(client, messages)
    assert.equal(first.status, 502, await first.text())
    const submitted = logs().slice(before).filter(event => event.kind === "prompt").length
    const retry = await request(client, messages)
    const retryBody = await retry.json()
    if (mode === "first-prompt-rejected") {
      assert.equal(retry.status, 502, JSON.stringify(retryBody))
      assert.equal(logs().slice(before).filter(event => event.kind === "prompt").length, submitted + 1)
    } else {
      assert.equal(retry.status, 409, JSON.stringify(retryBody))
      assert.equal(retryBody.error.code, "prompt_outcome_unknown")
      assert.equal(logs().slice(before).filter(event => event.kind === "prompt").length, submitted,
        "rejecting a later prompt cannot authorize replay of already accepted input")
    }
  })
}

test("PR75 rejected cancel nudge cannot release the already submitted original prompt", async () => {
  process.env.COMPAT_MODE = "cancel-nudge-rejected"
  const client = await loader()
  const messages = [{ role: "user", content: "CANCEL_RETRY original nudge rejected" }]
  const abort = new AbortController()
  const before = logs().length
  const response = await request(client, messages, { stream: true }, abort.signal)
  const read = response.text().catch(() => {})
  await waitFor(() => logs().slice(before).some(event => event.kind === "prompt"))
  abort.abort()
  await read
  const rejected = await request(client, messages)
  assert.equal(rejected.status, 502, await rejected.text())
  const replay = await request(client, messages, { stream: true })
  if (replay.status === 200) await replay.body.cancel()
  assert.equal(replay.status, 409)
  assert.equal(logs().slice(before).filter(event => event.kind === "prompt").length, 2)
})

for (const mode of ["response-first", "no-append"]) for (const stream of [false, true]) {
  test(`oversized OpenCode compaction stages the full history, ${mode}, stream=${stream}`, async () => {
    process.env.COMPAT_MODE = mode
    const client = await loader()
    const before = logs().length
    let messages = summaryMessages(stream ? "tools" : "flattened")
    if (mode === "no-append") {
      const instruction = messages.pop().content
      const last = messages.at(-1)
      last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]),
        { type: "text", text: instruction }]
    }
    const response = await request(client, messages, { stream })
    const raw = await response.text()
    assert.equal(response.status, 200, raw)
    assert.ok(!raw.includes("ACK-INTERNAL"), "ingestion responses stay internal")
    assert.match(raw, /Keep LATEST-INSTRUCTION pending/)
    const sent = logs().slice(before).filter(event => event.kind === "prompt")
    assert.ok(sent.length >= 3, "multiple fragments plus the final summary request")
    assert.equal(new Set(sent.map(event => event.pid)).size, 1, "all fragments share one isolated session")
    for (const event of sent) assert.ok(event.prompt.reduce((sum, part) => sum + Buffer.byteLength(part.text || ""), 0) <= 180000)
    const contents = sent.slice(0, -1).map(event => {
      const text = event.prompt.map(part => part.text || "").join("")
      const header = /\[Bridge compaction fragment \d+; quoted conversation data follows\]\n/.exec(text)
      const footer = text.lastIndexOf("\n[End of fragment.")
      assert.ok(header && footer > header.index)
      return text.slice(header.index + header[0].length, footer)
    }).join("")
    assert.ok(contents.includes(largeHistory), "the complete original content is delivered in order")
    assert.ok(contents.includes(compactionPrompt), "the client format is preserved")
    assert.ok(!contents.includes("\ufffd"))
    if (mode !== "no-append" || stream) assert.match(contents, /Summarize this conversation/)
    if (mode === "no-append") assert.ok(sent.every(event => event.prompt[0].text.startsWith("You are summarizing an existing conversation")))
    if (!stream) {
      const payload = JSON.parse(raw)
      assert.equal(payload.stop_reason, "end_turn")
      assert.equal(payload.usage.input_tokens, (sent.length - 1) * 10 + 30)
      assert.equal(payload.usage.output_tokens, (sent.length - 1) * 2 + 12)
    }
    const session = "session-" + sent[0].pid
    const saved = fs.existsSync(process.env.AGY_BRIDGE_STATE_FILE) ? fs.readFileSync(process.env.AGY_BRIDGE_STATE_FILE, "utf8") : ""
    assert.ok(!saved.includes(session), "temporary summary sessions are not parked for conversation reuse")
  })
}

for (const mode of ["compaction-failure", "compaction-refusal"]) {
  test(`failed compaction ingestion stops before the summary: ${mode}`, async () => {
    process.env.COMPAT_MODE = mode
    const client = await loader()
    const before = logs().length
    const messages = summaryMessages()
    const response = await request(client, messages)
    const payload = await response.json()
    assert.equal(response.status, mode === "compaction-failure" ? 429 : 502, JSON.stringify(payload))
    const sent = logs().slice(before).filter(event => event.kind === "prompt")
    assert.equal(sent.length, mode === "compaction-failure" ? 2 : 1)
    assert.ok(sent.every(event => event.prompt.some(part => part.text?.includes("[Bridge compaction fragment "))))
    assert.ok(!JSON.stringify(payload).includes("ACK-INTERNAL"))
    const retry = await request(client, messages)
    assert.notEqual(retry.status, 200)
    await retry.text()
    assert.equal(logs().slice(before).filter(event => event.kind === "prompt").length, sent.length, "submitted fragments are not automatically replayed")
  })
}

test("ordinary oversized requests and over-budget compactions reject before session creation", async () => {
  process.env.COMPAT_MODE = "response-first"
  const client = await loader()
  for (const [messages, compacting] of [
    [[{ role: "user", content: largeHistory }], false],
    [[{ role: "user", content: "x".repeat(1100000) }, { role: "user", content: compactionPrompt }], true],
  ]) {
    const before = logs().length
    const response = await request(client, messages)
    const payload = await response.json()
    assert.equal(response.status, 400, JSON.stringify(payload))
    assert.equal(payload.error.code, compacting ? "prompt_budget_exceeded" : "context_length_exceeded")
    assert.equal(/prompt is too long/i.test(payload.error.message), !compacting)
    assert.equal(response.headers.get("x-should-retry"), "false")
    assert.ok(!logs().slice(before).some(event => event.kind === "prompt" || event.method === "session/new"))
  }
})

test("a customized compaction-looking prompt keeps the ordinary request and instruction semantics", async () => {
  process.env.COMPAT_MODE = "response-first"
  const client = await loader()
  const before = logs().length
  const latest = compactionPrompt + "\n\nActually continue the work and use tools."
  const response = await request(client, [{ role: "user", content: "history" }, { role: "user", content: latest }],
    { system: "Keep the user's instructions." })
  assert.equal(response.status, 200, await response.text())
  const sent = logs().slice(before).filter(event => event.kind === "prompt")
  assert.equal(sent.length, 1)
  const promptText = sent[0].prompt.map(part => part.text || "").join("")
  assert.equal(sent[0].append, "")
  assert.match(promptText, /Keep the user's instructions/)
  assert.ok(!promptText.includes("You are summarizing an existing conversation"))
  assert.ok(promptText.includes(latest))
})

test("cancelling an ingestion prompt prevents remaining fragments from being submitted and blocks retry", async () => {
  for (const mode of ["compaction-hang", "compaction-cancel"]) {
    process.env.COMPAT_MODE = mode
    const client = await loader()
    const abort = new AbortController()
    const before = logs().length
    const messages = summaryMessages()
    const response = await request(client, messages, { stream: true }, abort.signal)
    const reading = response.text().catch(() => "aborted")
    await waitFor(() => logs().slice(before).some(event => event.kind === "prompt"))
    abort.abort()
    await reading
    await waitFor(() => logs().slice(before).some(event => event.method === "session/cancel"))
    if (mode === "compaction-cancel") {
      await waitFor(() => logs().slice(before).some(event => event.kind === "response" && event.method === "session/prompt"))
    }
    assert.equal(logs().slice(before).filter(event => event.kind === "prompt").length, 1)
    const retry = await request(client, messages, { stream: true })
    const payload = await retry.json()
    assert.equal(retry.status, 409)
    assert.equal(payload.error?.code, "prompt_outcome_unknown")
    assert.equal(retry.headers.get("x-should-retry"), "false")
    assert.equal(logs().slice(before).filter(event => event.kind === "prompt").length, 1)
  }
})

for (const mode of ["cancel-before-text", "cancel-partial"]) for (const stream of [true, false]) {
  test(`client cancellation continues once in the original session: ${mode}, retry stream=${stream}`, async () => {
    process.env.COMPAT_MODE = mode
    const client = await loader()
    const start = logs().length
    const messages = [{ role: "user", content: `CANCEL_RETRY original ${mode} ${stream}` }]
    const abort = new AbortController()
    const response = await request(client, messages, { stream: true }, abort.signal)
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text())
    const reader = response.body.getReader()
    if (mode === "cancel-partial") {
      let text = ""
      while (!text.includes("Partial answer")) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false, `response ended before partial answer: ${text}`)
        text += new TextDecoder().decode(chunk.value)
      }
      await reader.cancel()
    } else {
      await waitFor(() => logs().slice(start).some(event => event.kind === "prompt"))
      abort.abort()
      await reader.read().catch(() => {})
    }
    const retry = await request(client, messages, { stream })
    const raw = await retry.text()
    assert.equal(retry.status, 200, raw)
    assert.match(raw, /Complete replacement answer/)
    const prompts = logs().slice(start).filter(event => event.kind === "prompt")
    assert.equal(prompts.length, 2, "one original submission and one nudge")
    assert.equal(prompts[0].pid, prompts[1].pid)
    assert.equal(prompts[1].prompt.map(part => part.text || "").join(""),
      "[The previous reply was interrupted before it finished. Answer my last message again, in full.]")
    const followup = await request(client, [...messages,
      { role: "assistant", content: "Complete replacement answer" }, { role: "user", content: "next task" }])
    assert.equal(followup.status, 200, await followup.text())
    const sent = logs().slice(start).filter(event => event.kind === "prompt")
    assert.equal(sent.length, 3)
    assert.equal(sent[2].pid, prompts[0].pid)
    assert.equal(sent[2].prompt.map(part => part.text || "").join(""), "next task")
  })
}

test("ACP context usage is observed while idle and generating without unlocking or billing the physical window", async () => {
  process.env.COMPAT_MODE = "context-usage"
  const savedOverride = process.env.AGY_BRIDGE_CONTEXT_WINDOW
  process.env.AGY_BRIDGE_CONTEXT_WINDOW = "900000"
  const write = process.stderr.write
  const events = []
  process.stderr.write = function(chunk, ...args) {
    for (const line of String(chunk).split("\n")) {
      if (line.startsWith("[agy-bridge] ")) events.push(JSON.parse(line.slice(13)))
    }
    return write.call(this, chunk, ...args)
  }
  try {
    const response = await request(await loader(), [{ role: "user", content: "context usage fixture" }])
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    const context = events.filter(event => event.action === "context_usage")
    assert.deepEqual(context.map(event => event.context_tokens), [42, 123456])
    assert.ok(context.every(event => event.upstream_context_window === 1048576 && event.declared_context_window === 512000))
    assert.ok(body.usage.input_tokens < 123456, "rolling occupancy is not per-call billed usage")
  } finally {
    process.stderr.write = write
    if (savedOverride === undefined) delete process.env.AGY_BRIDGE_CONTEXT_WINDOW
    else process.env.AGY_BRIDGE_CONTEXT_WINDOW = savedOverride
  }
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

test("default first-turn external system instructions do not send systemPrompt.append on new or resume", async () => {
  process.env.COMPAT_MODE = "response-first"
  delete process.env.AGY_BRIDGE_SYSTEM_APPEND
  const start = logs().length
  let messages = [{ role: "user", content: "default external opening" }]
  for (let round = 0; round < 3; round++) {
    const response = await request(await loader(), messages, { system: "DEFAULT_EXTERNAL_MARKER" })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    messages = [...messages, { role: "assistant", content: body.content }, { role: "user", content: `next default ${round}` }]
  }
  const events = logs().slice(start)
  const opens = events.filter(e => e.kind === "request" && ["session/new", "session/resume"].includes(e.method))
  assert.equal(opens.length, 3)
  assert.deepEqual(opens.map(e => e.method), ["session/new", "session/resume", "session/resume"])
  for (const event of opens) {
    assert.equal(event.params._meta?.antigravity?.systemPrompt?.append, undefined)
  }
  const prompts = events.filter(e => e.kind === "prompt")
  assert.equal(prompts.length, 3)
  assert.match(prompts[0].prompt.map(p => p.text || "").join(""), /<external_system_instructions>[\s\S]*DEFAULT_EXTERNAL_MARKER[\s\S]*<\/external_system_instructions>/)
  for (let i = 1; i < prompts.length; i++) {
    assert.equal(prompts[i].prompt.map(p => p.text || "").join(""), `next default ${i - 1}`)
  }
})

for (const mode of ["response-first", "legacy-resume", "no-append"]) {
  test(`resume append: ${mode}`, async () => {
    const prevAppend = process.env.AGY_BRIDGE_SYSTEM_APPEND
    process.env.AGY_BRIDGE_SYSTEM_APPEND = "1"
    process.env.COMPAT_MODE = mode
    try {
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
    } finally {
      if (prevAppend === undefined) delete process.env.AGY_BRIDGE_SYSTEM_APPEND
      else process.env.AGY_BRIDGE_SYSTEM_APPEND = prevAppend
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
