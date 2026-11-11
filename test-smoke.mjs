import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
const suffix = `-${process.pid}`
const fakeAgy = path.join(here, `.tmp-fake-agy${suffix}.mjs`)
const wrapper = path.join(here, `.tmp-agy${suffix}`)
const logPath = path.join(here, `.tmp-fake-agy-log${suffix}`)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-state-"))
const originalAutoUpdate = process.env.AGY_CLI_DISABLE_AUTO_UPDATE
process.env.AGY_CLI_DISABLE_AUTO_UPDATE = "false"
process.env.FAKE_AGY_LOG = logPath
process.env.FAKE_AGY_STATE = stateDir
const bridgeStateFile = path.join(stateDir, "bridge-sessions.json")
process.env.AGY_BRIDGE_STATE_FILE = bridgeStateFile
process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "1000"
process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "5000"
process.env.AGY_BRIDGE_PING_INTERVAL_MS = "100"
process.env.AGY_BRIDGE_CONVERSATIONS_DIR = stateDir
process.env.AGY_BRIDGE_MAX_PROCS = "4"
process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "30000"

// A fake `agy` that speaks ACP on stdio and reaches the client tools the way
// the real one does: by running `nc 127.0.0.1 <--ide-mcp-port>` from PATH.
fs.writeFileSync(fakeAgy, String.raw`
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { createRequire } from "node:module"

const argv = process.argv.slice(2)
const log = value => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(value) + "\n")
const send = value => process.stdout.write(JSON.stringify(value) + "\n")

if (argv.includes("--version")) {
  process.stdout.write("1.5.0\n")
  process.exit(0)
}
if (argv.includes("/usage")) {
  log({ type: "usage", cwd: process.cwd(), args: argv, wslInterop: process.env.WSL_INTEROP ?? null })
  send({ status: "SUCCESS", command: { name: "usage", data: { groups: [{
    name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.6, reset_time: "2026-10-27T00:00:00Z" }],
  }] } } })
  process.exit(0)
}
if (argv.includes("models")) {
  log({
    type: "models",
    update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
    geminiDir: argv.find(a => a.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length) ?? null,
    wslInterop: process.env.WSL_INTEROP ?? null,
  })
  process.stdout.write("gemini-test-medium\tGemini Test (Medium)\ngemini-test-high\tGemini Test (High)\ngemini-test-low\tGemini Test (Low)\nclaude-test-medium\tClaude Test (Medium)\n")
  process.stdout.write("gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n")
  process.stdout.write("gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n")
  process.exit(0)
}
if (argv[0] !== "acp") {
  process.stderr.write("unknown subcommand\n")
  process.exit(2)
}

const flag = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1] }
const agentName = flag("--agent")
const agentConfig = agentName ? fs.readFileSync(path.join(process.cwd(), ".agents", "agents", agentName, "agent.md"), "utf8") : ""
const agentLog = flag("--log-file")
const idePort = flag("--ide-mcp-port")
const addDir = flag("--add-dir")
const statePath = id => path.join(process.env.FAKE_AGY_STATE, id + ".json")
let clientInfo = null
let session = null
let model = "gemini-test-medium"
let tools = []
let toolListTimeouts = Number(process.env.FAKE_AGY_TOOL_LIST_TIMEOUTS) || 0
let mcp = null
let mcpReady = null
let nextMcpId = 0
const mcpPending = new Map()
let cancelWaiter = null
let activePrompt = null

function update(value) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: value } })
}
const chunk = text => {
  if (activePrompt?.steers.length && !activePrompt.delivering) return
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
}
const thought = text => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } })

function mcpRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextMcpId
    mcpPending.set(id, { resolve, reject })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}

async function listTools(reason) {
  if (reason === "list_changed" && process.env.FAKE_AGY_TOOL_LIST_DELAY_MS) {
    log({ type: "toolsListDelayed", convId: session?.id })
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_AGY_TOOL_LIST_DELAY_MS)))
  }
  if (reason === "list_changed" && toolListTimeouts > 0) {
    toolListTimeouts--
    log({ type: "toolsListTimeout", reason, convId: session?.id })
    return
  }
  tools = (await mcpRequest("tools/list", {})).tools
  log({ type: "toolsList", reason, convId: session?.id, tools: tools.map(tool => tool.name) })
}

function connectIde() {
  if (!idePort) return Promise.resolve()
  if (mcpReady) return mcpReady
  mcpReady = (async () => {
    mcp = spawn("nc", ["127.0.0.1", idePort], { stdio: ["pipe", "pipe", "pipe"] })
    let error = ""
    mcp.stderr.on("data", data => { error += data })
    mcp.on("exit", code => { if (code) log({ type: "ncExit", code, error }) })
    readline.createInterface({ input: mcp.stdout }).on("line", line => {
      const message = JSON.parse(line)
      if (message.method === "notifications/tools/list_changed") {
        listTools("list_changed").catch(() => {})
        return
      }
      const waiter = mcpPending.get(message.id)
      if (!waiter) return
      mcpPending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    await mcpRequest("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }).catch(() => {})
    await mcpRequest("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "antigravity-client", version: "v1.0.0" } })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")
    await listTools("preload")
  })()
  return mcpReady
}

function saveState() {
  fs.writeFileSync(statePath(session.id), JSON.stringify({ prompts: session.prompts }))
}

async function invoke(name, args) {
  update({ sessionUpdate: "tool_call", toolCallId: "call_" + (++nextMcpId), name: "mcp_ide-tools_" + name, status: "in_progress", kind: "other", rawInput: args })
  log({ type: "mcpPending", convId: session.id, name, arguments: args })
  let result
  try {
    result = await mcpRequest("tools/call", { name, arguments: args, _meta: { progressToken: "pt-" + nextMcpId } })
  } catch (error) {
    result = { content: [{ type: "text", text: error.message }], isError: true }
  }
  log({ type: "mcpResult", convId: session.id, name, result })
  return result
}

const textOf = result => (result.content || []).map(part => part.text || "").join("")

// agy's conversation store: one steps row per model call, usage in metadata field 9.
const sqliteOpen = (() => {
  const require = createRequire(import.meta.url)
  try {
    const { DatabaseSync } = require("node:sqlite")
    if (DatabaseSync) return file => { const db = new DatabaseSync(file); return { run: (sql, ...args) => db.prepare(sql).run(...args), close: () => db.close() } }
  } catch {}
  try {
    const { Database } = require("bun:sqlite")
    return file => { const db = new Database(file); return { run: (sql, ...args) => db.query(sql).run(...args), close: () => db.close() } }
  } catch {}
  return null
})()
const varint = n => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
function recordModelCall({ input = 0, read = 0, output = 0, thinking = 0 }) {
  const dir = process.env.AGY_BRIDGE_CONVERSATIONS_DIR
  if (!sqliteOpen || !dir) return
  const db = sqliteOpen(path.join(dir, session.id + ".db"))
  try {
    const usage = [0x10, ...varint(input), 0x18, ...varint(output), 0x28, ...varint(read), 0x48, ...varint(thinking)]
    session.stepIdx = (session.stepIdx ?? -1) + 1
    const store = process.env.FAKE_AGY_USAGE_STORE
    if (store) {
      db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
      if (store !== "empty-generation") {
        const estimate = [0x52, ...varint(varint(input + read + 100).length + 1), 8, ...varint(input + read + 100)]
        const chat = [0x22, ...varint(usage.length), ...usage, 0x4a, ...varint(estimate.length), ...estimate]
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", session.stepIdx, new Uint8Array([0x0a, ...varint(chat.length), ...chat]))
      }
    }
    if (store !== "generation") {
      db.run("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
      db.run("INSERT INTO steps VALUES (?, 132, 3, ?)", session.stepIdx, new Uint8Array([0x18, 2]))
      session.stepIdx++
      db.run("INSERT INTO steps VALUES (?, 15, 3, ?)", session.stepIdx, new Uint8Array([0x18, 2, 0x4a, usage.length, ...usage]))
    }
  } finally {
    db.close()
  }
}

function finish(reply, extra = {}) {
  const cached = extra.cached || 0
  const thought = extra.thought || 0
  const input = extra.input ?? 10
  log({ type: "result", convId: session.id, prompt: session.prompts, response: reply })
  return {
    stopReason: "end_turn",
    usage: {
      // agy 1.5.1 reports cached reads separately; the older shape folded them
      // into inputTokens. totalTokens includes both either way.
      inputTokens: extra.exclusive ? input : input + cached,
      outputTokens: reply.length,
      cachedReadTokens: cached,
      cachedWriteTokens: 0,
      thoughtTokens: thought,
      totalTokens: input + cached + reply.length + thought,
    },
  }
}

async function reply(text) {
  const half = Math.floor(text.length / 2)
  chunk(text.slice(0, half))
  chunk(text.slice(half))
}

function recordPrompt(params) {
  session.prompts++
  saveState()
  log({ type: "user", convId: session.id, prompt: session.prompts,
    text: params.prompt.map(block => block.text || "").join(""),
    images: params.prompt.filter(block => block.type === "image").length, content: params.prompt, model })
}

async function prompt(params, recorded = false) {
  const text = params.prompt.map(block => block.text || "").join("")
  const images = params.prompt.filter(block => block.type === "image").length
  if (!recorded) recordPrompt(params)
  if (text.includes("NATIVE_FINAL")) {
    await new Promise(resolve => setTimeout(resolve, 80))
    chunk("NATIVE_FINAL_AFTER_ACK")
    return finish("NATIVE_FINAL_AFTER_ACK")
  }
  if (text === "TOOL_FINISH_EARLY") {
    invoke("echo", { text: "finished prompt" }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    return finish("ended before tool result")
  }
  if (text.includes("DELAY_BEFORE_TOOL")) await new Promise(resolve => setTimeout(resolve, 1500))
  if (text.includes("IDLE_SILENT") || text.includes("IDLE_METADATA")) {
    if (text.includes("IDLE_METADATA")) {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
      log({ type: "idleChild", convId: session.id, pid: child.pid })
    }
    if (text.includes("IDLE_METADATA")) setInterval(() => {
      update({ sessionUpdate: "session_info_update", title: "upstream retrying" })
      update({ sessionUpdate: "usage_update", used: 0, size: 1000 })
      update({ sessionUpdate: "tool_call_update", toolCallId: "metadata-only", status: "in_progress" })
      chunk("")
      thought("")
      fs.appendFileSync(agentLog, "Run: stream idle timeout, retrying upstream\n")
      log({ type: "idleMetadata", convId: session.id })
    }, 100)
    await new Promise(() => {})
  }
  if (text.includes("IDLE_PROGRESS")) {
    for (let n = 0; n < 4; n++) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      thought("still reasoning " + n)
    }
    chunk("progress completed")
    return finish("progress completed")
  }
  if (text.includes("REFUSAL_CLEAN")) {
    return { stopReason: "refusal" }
  }
  if (text.includes("DIE")) {
    chunk("before death")
    process.exit(2)
  }
  if (text.includes("SLOW")) {
    chunk("partial slow answer")
    await new Promise(resolve => { cancelWaiter = resolve })
    log({ type: "cancelled", convId: session.id })
    return { stopReason: "cancelled" }
  }
  if (text.includes("AGENTERROR")) {
    chunk("partial before failure")
    fs.appendFileSync(agentLog, "E1103 17:11:25.570096 685 errorreport.go:224] agent executor error: generating and executing: FAILED_PRECONDITION (code 400): fake upstream failure.\n")
    chunk("\n⚠ Agent execution terminated due to error.\n")
    log({ type: "agentError", convId: session.id })
    return { stopReason: "end_turn" }
  }
  if (text.includes("GENERIC429")) {
    fs.appendFileSync(agentLog, "E1103 17:11:25.570096 685 errorreport.go:224] agent executor error: generating and executing: RESOURCE_EXHAUSTED (code 429): upstream rejected request.\n")
    chunk("\n⚠ Agent execution terminated due to error.\n")
    return { stopReason: "end_turn" }
  }
  if (text.includes("QUOTA")) {
    fs.appendFileSync(agentLog, "E1103 17:11:25.570096 685 errorreport.go:224] agent executor error: generating and executing: RESOURCE_EXHAUSTED (code 429): quota exhausted.\n")
    chunk("\n⚠ Agent execution ")
    chunk("terminated due to error.\n")
    return { stopReason: "end_turn" }
  }
  if (text.includes("PERMISSION")) {
    const outcome = await new Promise(resolve => {
      pendingClient.set("perm", resolve)
      send({ jsonrpc: "2.0", id: "perm", method: "session/request_permission", params: {
        sessionId: session.id,
        toolCall: { toolCallId: "call_perm", title: "Run run_command?", rawInput: { CommandLine: "printf SHOULD_NOT_RUN" } },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Allow always", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      } })
    })
    log({ type: "permission", convId: session.id, outcome })
    await reply("permission answered " + JSON.stringify(outcome))
    return finish("permission answered")
  }
  if (text.includes("THINK_BLOCKS")) {
    thought("**Planning**\n\nConsider the request.")
    thought(" Then answer.")
    chunk("Answer after thinking.")
    return finish("Answer after thinking.", { thought: 12 })
  }
  if (text.includes("SUMMARY_LEAK")) {
    // agy's title summarizer shares the turn's thought stream (#39): the same
    // prompt echo arrives in several chunks per call, for several calls, split
    // across the header and at a field boundary so the bridge must decide per
    // stream, not per chunk.
    const summary = "Thinking Process: 1. **Analyze the Request:** * **Goal:** Summarize the provided thoughts in " +
      "the first person (\"I\"). * **Length:** Maximum 50 words for the preview."
    const split = summary.indexOf("* **Length:**")
    for (let call = 0; call < 3; call++) {
      thought(summary.slice(0, 9))
      thought(summary.slice(9, split))
      thought(summary.slice(split) + " ".repeat(2800))
    }
    thought("User asks: keep the real reasoning. Key insight: only the summary echo is dropped.")
    chunk("Answer after summaries.")
    return finish("Answer after summaries.", { thought: 9 })
  }
  if (text.includes("SUMMARY_TOOL")) {
    // A tool call ends the thought burst: held or echoed thought text must be
    // flushed ahead of the tool block, not only at the answer or end of turn.
    const summary = "Thinking Process: 1. **Analyze the Request:** * **Goal:** Summarize the provided thoughts " +
      "in the first person (\"I\"). * **Length:** Maximum 50 words for the preview."
    thought(summary)
    thought(" * **Length:** Maximum 50 words for the preview. INTERNAL_SUMMARY_REMAINDER")
    thought("Think")
    await invoke("echo", { text: "after summary" })
    thought("User asks: continue the real task. Key insight: the tool result matters.")
    chunk("Answer after summary tool.")
    return finish("Answer after summary tool.")
  }
  if (text.includes("SUMMARY_ONLY")) {
    const summary = "Thinking Process: 1. **Analyze the Request:** * **Goal:** Summarize the provided thoughts " +
      "in the first person (\"I\"). * **Length:** Maximum 50 words for the preview."
    for (let n = 0; n < 5; n++) {
      await new Promise(resolve => setTimeout(resolve, 400))
      thought(summary)
    }
    chunk("Answer after summaries only.")
    return finish("Answer after summaries only.")
  }
  if (text.includes("UNICODE")) {
    const message = { jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "中文😀" } } } }
    const wire = Buffer.from(JSON.stringify(message) + "\n")
    const cut = wire.indexOf(Buffer.from("😀")) + 1
    process.stdout.write(wire.subarray(0, cut))
    await new Promise(resolve => setImmediate(() => { process.stdout.write(wire.subarray(cut)); resolve() }))
    return finish("中文😀")
  }
  if (text.includes("PARALLEL")) {
    chunk("Before parallel.\n")
    await Promise.all([invoke("echo", { text: "same" }), invoke("echo", { text: "same" })])
    chunk("After parallel.\n")
    return finish("Before parallel.\nAfter parallel.\n")
  }
  if (text.includes("BACKGROUND_SUMMARY")) {
    if (text.includes("SUMMARY_PENDING")) await invoke("echo", { text: "summary side request" })
    chunk("Background summary.")
    return finish("Background summary.")
  }
  if (text.includes("TWOSTEP")) {
    chunk("Before two-step.\n")
    await invoke("echo", { text: "first" })
    await invoke("echo", { text: "second" })
    chunk("After two-step.\n")
    return finish("Before two-step.\nAfter two-step.\n")
  }
  if (text.includes("LONGTOOL")) {
    let result = await invoke("echo", { text: "long" })
    let rounds = 0
    while (/still running/.test(textOf(result))) {
      rounds++
      result = await invoke("echo", { text: "long" })
    }
    log({ type: "longDone", convId: session.id, rounds, text: textOf(result) })
    chunk("Long done: " + textOf(result))
    return finish("Long done")
  }
  if (text.includes("LONGQUIT")) {
    const result = await invoke("echo", { text: "quit" })
    chunk("I will not wait. " + (/still running/.test(textOf(result)) ? "deferred" : "direct"))
    return finish("quit")
  }
  if (text.includes("Their real results")) {
    chunk("Late result seen: " + (/\[tool result for echo call_id=\S+\]\n([^\n]*)/.exec(text)?.[1] || "none"))
    return finish("late")
  }
  if (text.includes("SKILLCALL")) {
    chunk("Before skill.\n")
    await invoke("Skill", { skill: "hengjian-chat-archive" })
    chunk("After skill.\n")
    return finish("Before skill.\nAfter skill.\n")
  }
  if (text.includes("TOOLSEARCHCALL")) {
    await invoke("ToolSearch", { query: "select:WebFetch" })
    if (text.includes("use loaded tool")) {
      if (!tools.some(tool => tool.name === "WebFetch")) throw new Error("Loaded WebFetch missing from catalog")
      await invoke("WebFetch", { url: "https://example.com" })
    }
    chunk("After tool search.\n")
    return finish("After tool search.\n")
  }
  if ((text.includes("ESCCALL") && !text.includes("<conversation_history>")) ||
    /^BRANCHCALL branch \d+$/.test(text.trim()) || /<current_turn>\s*BRANCHCALL branch \d+\s*<\/current_turn>/.test(text)) {
    await invoke("echo", { text: "probe" })
    if (text.includes("STEER_CANCEL_DELAY")) await new Promise(resolve => setTimeout(resolve, 300))
    chunk("After esc.\n")
    return finish("After esc.\n")
  }
  if (text.includes("Continue exactly where your previous output stopped")) {
    if (session.cutOff === "always") {
      chunk(" more")
      return { stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    }
    chunk("\n⚠ Your previous response was cut off because it exceeded the output token limit\n")
    chunk("Please continue from where you left off, keeping your response shorter\nRetries remaining: 3\n")
    chunk("part two")
    return finish("part two")
  }
  if (text.includes("CUTOFF")) {
    session.cutOff = text.includes("CUTOFF_ALWAYS") ? "always" : "once"
    chunk("part one, ")
    return { stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  }
  if (text.includes("MEASURED_INFLATED")) {
    // One call whose recorded prompt wildly exceeds ACP's total for the turn.
    chunk("Inflated one.\n")
    recordModelCall({ input: 99999, output: 40, thinking: 4 })
    await invoke("echo", { text: "inflated" })
    chunk("Inflated two.\n")
    recordModelCall({ input: 500, read: 3000, output: 20 })
    return finish("Inflated one.\nInflated two.\n", { input: 3500, cached: 3000, exclusive: true })
  }
  if (text.includes("MEASURED")) {
    const lag = text.includes("MEASURED_LAG")
    chunk("Measured one.\n")
    recordModelCall({ input: 3000, output: 40, thinking: 4 })
    await invoke("echo", { text: "measured" })
    chunk("Measured two.\n")
    // agy commits the last call a moment after answering session/prompt.
    if (lag) setTimeout(() => recordModelCall({ input: 500, read: 3000, output: 20 }), 150)
    else recordModelCall({ input: 500, read: 3000, output: 20 })
    return finish("Measured one.\nMeasured two.\n", { input: 3500, cached: 3000, exclusive: true })
  }
  if (text.includes("MULTISTEP")) {
    chunk("Step one.\n")
    await invoke("echo", { text: "probe" })
    chunk("Step two.\n")
    // ACP reports one accumulated total for both model steps of this prompt.
    return finish("Step one.\nStep two.\n", { input: 9000 })
  }
  if (text.includes("TOOL")) {
    chunk("Before tool.\n")
    await invoke("echo", { text: "probe" })
    chunk("After tools.\n")
    return finish("Before tool.\nAfter tools.\n")
  }
  if (text.includes("MEMORY")) {
    const answer = "prompts so far " + session.prompts
    await reply(answer)
    return finish(answer)
  }
  if (text.includes("THINKING_USAGE")) {
    await reply("thinking usage")
    return finish("thinking usage", { thought: 7, cached: 3 })
  }
  if (text.includes("EXCLUSIVE_USAGE")) {
    await reply("exclusive usage")
    return finish("exclusive usage", { input: 2133, cached: 4899, exclusive: true })
  }
  if (text.includes("CACHED_ONLY_USAGE")) {
    await reply("cached only")
    return finish("cached only", { input: 0, cached: 4899, exclusive: true })
  }
  if (text.includes("CONFIGRESET")) {
    await reply("configuration updated")
    model = "gemini-test-low"
    update({ sessionUpdate: "config_option_update", configOptions: configOptions() })
    return finish("configuration updated")
  }
  if (text.includes("COMBINED_PENDING") && !text.includes("COMBINED_RESUME")) {
    await invoke("echo", { text: "combined pending call" })
    chunk("Combined result delivered.")
    return finish("Combined result delivered.")
  }
  const prefix = text.includes("SAME") ? "You said [" + session.id + "]: " : "You said: "
  const answer = prefix + text.slice(-120).replace(/"/g, "'")
  await reply(answer)
  return finish(answer)
}

const pendingClient = new Map()

function configOptions() {
  if (process.env.FAKE_AGY_CONFIG === "omit" || process.env.FAKE_AGY_IMAGES === "omit") return []
  const family = model.replace(/-(low|medium|high|xhigh|max)$/, "")
  const configurable = family === "gemini-test" || family === "gemini-config-only" || family === "gemini-4-argon"
  const grouped = process.env.FAKE_AGY_CONFIG === "grouped"
  const models = ["gemini-test", "gemini-config-only", "gemini-4-argon", "claude-test-medium"].map(value => ({ value, name: value }))
  return [
    { id: grouped ? "model-picker" : "model", name: "Model", category: "model", type: "select", currentValue: configurable ? family : model,
      options: grouped ? [{ group: "Test models", options: models }] : models },
    ...(configurable ? [{ id: grouped ? "thinking-picker" : "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: model.slice(family.length + 1),
      options: (family === "gemini-config-only" ? ["low", "high", "max"] : ["low", "medium", "high"]).map(value => ({ value, name: value })) }] : []),
  ]
}

async function handle(message) {
  const params = message.params || {}
  switch (message.method) {
    case "initialize":
      clientInfo = params.clientInfo
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          ...(process.env.FAKE_AGY_IMAGES === "omit" ? {} : { promptCapabilities: { image: process.env.FAKE_AGY_IMAGES !== "0", audio: false, embeddedContext: true } }),
          sessionCapabilities: { resume: {}, close: {} },
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
        agentInfo: { name: "Antigravity ACP Server", version: process.env.FAKE_AGY_VERSION || (process.env.FAKE_AGY_IMAGES === "omit" ? "1.4.12" : "1.5.0") },
        authMethods: [],
      }
    case "session/new":
    case "session/resume": {
      if (process.env.FAKE_AGY_INIT_MODE === "slow") await new Promise(resolve => setTimeout(resolve, 100))
      if (process.env.FAKE_AGY_INIT_MODE === "early-error") throw { code: -32603, message: "Eligibility check failed: test EOF" }
      if (message.method === "session/resume" && process.env.FAKE_AGY_RESUME_ERROR) {
        const mode = process.env.FAKE_AGY_RESUME_ERROR
        log({ type: "resumeError", convId: params.sessionId, mode })
        if (mode === "permission") throw { code: -32603, message: "Permission denied by test account" }
        if (mode === "method") throw { code: -32601, message: "Method not found" }
        if (mode === "not-found") throw { code: -32602, message: "Conversation Not Found" }
      }
      let prompts = 0
      if (message.method === "session/resume") {
        if (!fs.existsSync(statePath(params.sessionId))) throw { code: -32602, message: "Conversation Not Found" }
        prompts = JSON.parse(fs.readFileSync(statePath(params.sessionId), "utf8")).prompts
      }
      session = { id: message.method === "session/new" ? "sess-" + Math.random().toString(36).slice(2, 10) : params.sessionId, prompts }
      model = "gemini-test-medium"
      await connectIde()
      log({
        type: "init", pid: process.pid, convId: session.id, resumed: message.method === "session/resume", update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
        cwd: process.cwd(), addDir, agentConfig, clientInfo, systemAppend: params._meta?.antigravity?.systemPrompt?.append ?? null,
        tools, idePort, mcpPid: mcp?.pid,
        geminiDir: argv.find(a => a.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length) ?? null,
        wslInterop: process.env.WSL_INTEROP ?? null,
      })
      return { sessionId: session.id, models: { currentModelId: model, availableModels: [] }, configOptions: configOptions() }
    }
    case "session/set_config_option": {
      log({ type: "setConfig", convId: session.id, configId: params.configId, value: params.value })
      if (process.env.FAKE_AGY_CONFIG === "unimplemented") throw { code: -32601, message: "Method not found" }
      if (process.env.FAKE_AGY_CONFIG === "error") throw { code: -32602, message: "Configuration rejected by test account" }
      if (process.env.FAKE_AGY_SET_MODEL_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_AGY_SET_MODEL_DELAY)))
      if (params.configId === "model" || params.configId === "model-picker") model = params.value === "claude-test-medium" ? params.value : params.value + "-low"
      else if (params.configId === "thought_level" || params.configId === "thinking-picker") model = model.replace(/-(low|medium|high|max)$/, "") + "-" + params.value
      else throw { code: -32602, message: "Unknown configId" }
      const options = configOptions()
      update({ sessionUpdate: "config_option_update", configOptions: options })
      return { configOptions: options }
    }
    case "session/set_model":
      if (process.env.FAKE_AGY_SET_MODEL_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_AGY_SET_MODEL_DELAY)))
      model = params.modelId
      log({ type: "setModel", convId: session.id, model })
      return {}
    case "session/prompt": {
      if (activePrompt) {
        if (process.env.FAKE_AGY_STEER === "reject" || process.env.FAKE_AGY_STEER === "auth-error") {
          log({ type: "steerRejected", convId: session.id })
          throw { code: -32000, message: process.env.FAKE_AGY_STEER === "reject"
            ? "Concurrent prompts are not supported: another prompt is already running"
            : "Authentication required" }
        }
        recordPrompt(params)
        log({ type: "nativeSteer", convId: session.id })
        const item = { params, resolve: null }
        activePrompt.steers.push(item)
        if (process.env.FAKE_AGY_STEER === "original-first") {
          return new Promise(resolve => { item.resolve = resolve })
        }
        // Acceptance is not completion: the original prompt keeps streaming.
        return { stopReason: "end_turn" }
      }
      const context = { steers: [], delivering: false }
      activePrompt = context
      const result = await prompt(params)
      const drain = async () => {
        let final = result
        while (context.steers.length) {
          const item = context.steers.shift()
          context.delivering = true
          final = await prompt(item.params, true)
          item.resolve?.(final)
        }
        activePrompt = null
        return final
      }
      if (context.steers.length && process.env.FAKE_AGY_STEER === "original-first") {
        drain().catch(() => {})
        return { stopReason: "cancelled" }
      }
      return drain()
    }
    default:
      throw { code: -32601, message: "unknown method " + message.method }
  }
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === "session/cancel") {
    log({ type: "cancel", convId: session?.id })
    cancelWaiter?.()
    return
  }
  if (!message.method && pendingClient.has(message.id)) {
    const resolve = pendingClient.get(message.id)
    pendingClient.delete(message.id)
    resolve(message.result?.outcome)
    return
  }
  if (!message.method) return
  handle(message).then(
    result => send({ jsonrpc: "2.0", id: message.id, result }),
    error => send({ jsonrpc: "2.0", id: message.id, error: { code: error?.code ?? -32603, message: String(error?.message ?? error) } }),
  )
}).on("close", () => {
  mcp?.kill("SIGTERM")
  process.exit(0)
})
`)

fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgy)} "$@"\n`)
fs.chmodSync(wrapper, 0o755)
process.env.AGY_PATH = wrapper

const { default: pluginDefault } = await import("./index.mjs")
const plugin = await pluginDefault.server({ client: null, directory: os.tmpdir() }, {})
const loader = await plugin.auth.loader(async () => ({ key: "agy" }))
let failures = 0
let checks = 0

function check(name, condition, detail = "") {
  checks++
  if (condition) console.log(`ok  - ${name}`)
  else {
    console.log(`BAD - ${name}${detail ? ": " + detail : ""}`)
    failures++
  }
}

async function callFetch(body, headers = {}, signal) {
  return loader.fetch("agy://local/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}

async function readSSE(response) {
  let text = ""
  let streamError = null
  try {
    text = await new Response(response.body).text()
  } catch (error) {
    streamError = error
  }
  const events = []
  for (const chunk of text.split("\n\n")) {
    const eventLine = chunk.split("\n").find(line => line.startsWith("event: "))
    const dataLine = chunk.split("\n").find(line => line.startsWith("data: "))
    if (!eventLine || !dataLine) continue
    try {
      events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
    } catch {}
  }
  return { events, raw: text, streamError }
}

function logs() {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
}

const inits = () => logs().filter(event => event.type === "init")
const lastOf = type => logs().filter(event => event.type === type).at(-1)

function textOf(events) {
  return events.filter(event => event.event === "content_block_delta")
    .map(event => event.data.delta?.text || "").join("")
}

function stopOf(events) {
  return events.find(event => event.event === "message_delta")?.data?.delta?.stop_reason
}

function assistantBlocks(events) {
  const blocks = new Map()
  for (const event of events) {
    if (event.event === "content_block_start") {
      const index = event.data.index
      const block = event.data.content_block
      if (block.type === "text") blocks.set(index, { type: "text", text: "" })
      if (block.type === "thinking") blocks.set(index, { type: "thinking", thinking: "" })
      if (block.type === "tool_use") {
        blocks.set(index, { type: "tool_use", id: block.id, name: block.name, input: {}, partial: "" })
      }
    }
    if (event.event === "content_block_delta") {
      const block = blocks.get(event.data.index)
      if (!block) continue
      if (event.data.delta?.type === "text_delta") block.text += event.data.delta.text
      if (event.data.delta?.type === "thinking_delta") block.thinking += event.data.delta.thinking
      if (event.data.delta?.type === "signature_delta") block.signature = (block.signature || "") + event.data.delta.signature
      if (event.data.delta?.type === "input_json_delta") block.partial += event.data.delta.partial_json
    }
  }
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => {
    if (block.type === "tool_use") {
      const input = JSON.parse(block.partial || "{}")
      return { type: "tool_use", id: block.id, name: block.name, input }
    }
    return block
  })
}

function toolCalls(events) {
  return assistantBlocks(events).filter(block => block.type === "tool_use")
}

function toolCall(events) {
  return toolCalls(events)[0]
}

function continuation(previous, events, resultText, options = {}) {
  const content = toolCalls(events).map(call => {
    const result = { type: "tool_result", tool_use_id: call.id, content: resultText }
    if (options.isError) result.is_error = true
    return result
  }).slice(0, options.only ?? undefined)
  if (options.extraText) content.push({ type: "text", text: "extra user text" })
  return {
    ...previous,
    messages: [
      ...previous.messages,
      { role: "assistant", content: assistantBlocks(events) },
      { role: "user", content },
    ],
  }
}

function nextTurn(previous, events, text) {
  return {
    ...previous,
    messages: [...previous.messages, { role: "assistant", content: assistantBlocks(events) }, { role: "user", content: text }],
  }
}

// Answer tool rounds until the turn ends; returns the final events.
async function drive(body, events, resultText = "ok") {
  let current = body
  let latest = events
  for (let round = 0; round < 6 && stopOf(latest) === "tool_use"; round++) {
    current = continuation(current, latest, resultText)
    latest = (await readSSE(await callFetch(current))).events
  }
  return { body: current, events: latest }
}

const echoTool = {
  name: "echo",
  description: "Echo the supplied text without executing it",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
}
const model = "antigravity-bridge/gemini-test"
const legacyModel = "antigravity-bridge/gemini-test-low"

{
  const usage = await plugin.auth.usage(async () => ({ key: "agy" }), {})
  check("auth.usage exposes measured CLI quota", usage.windows?.[0]?.used === 40 && usage.windows[0].name === "Gemini · 7 days")
  check("auth.usage preserves explicit cadence and reset", usage.windows?.[0]?.span === 604800 && usage.windows[0].resetsAt === "2026-10-27T00:00:00.000Z")
  check("auth.usage is display-only and keeps bridge auth", usage.windows?.[0]?.aside === true && usage.signIn === "kept")
  check("auth.usage does not invent Google account identity", !usage.user && !usage.plan)
  const calls = logs().filter(event => event.type === "usage")
  check("auth.usage uses a separate cleaned workspace", calls.length === 1 && !fs.existsSync(calls[0].cwd))
  check("auth.usage runs only the native usage command", calls[0]?.args.includes("/usage") && calls[0]?.args.includes("magpie-usage"))
  check("auth.usage isolates the CLI profile", calls[0]?.args.some(arg => arg.startsWith("--gemini_dir=")))
}

{
  const probesBefore = logs().filter(event => event.type === "models").length
  const models = await plugin.provider.models()
  const probes = logs().filter(event => event.type === "models").slice(probesBefore)
  check("directory refresh disables auto update even when the parent enables it", probes.length > 0 && probes.every(event => event.update === "true"))
  check("dynamic models accept tab-separated agy output", !!models["gemini-test"])
  check("dynamic models do not fall back to stale list", !models["gemini-3.7-flash-high"])
  check("models declare Anthropic through OpenCode api.npm", models["gemini-test"]?.api?.npm === "@ai-sdk/anthropic")
  check("effort variants collapse into one model", !models["gemini-test-low"] && !models["gemini-test-medium"] && !models["gemini-test-high"])
  check("grouped model has a level-free display name", models["gemini-test"]?.name === "Gemini Test")
  check("grouped model declares sorted variants", Object.keys(models["gemini-test"]?.variants || {}).join(",") === "low,medium,high")
  check("grouped model declares Magpie and OpenCode reasoning", models["gemini-test"]?.capabilities?.reasoning === true && models["gemini-test"]?.reasoning === true)
  check("Gemini and Claude models expose image input to the host", models["gemini-test"]?.capabilities?.input?.image === true && models["claude-test-medium"]?.capabilities?.input?.image === true)
  check("single-effort models stay ungrouped", models["claude-test-medium"]?.name === "Claude Test (Medium)" && !models["claude-test-medium"]?.variants)
  check("models declare the conservative client context window", models["gemini-test"]?.limit?.context === 256000)
  check("GPT-OSS declares its smaller physical window", models["gpt-oss-120b-medium"]?.limit?.context === 131072)
  process.env.AGY_BRIDGE_CONTEXT_WINDOW = "512000"
  const expanded = await plugin.provider.models()
  check("context declaration accepts an explicit verified-window override", expanded["gemini-test"]?.limit?.context === 512000)
  check("expanded Gemini windows keep GPT-OSS within its physical window", expanded["gpt-oss-120b-medium"]?.limit?.context === 131072)
  for (const invalid of ["0", "-1", "bad", "512000.5", "1048577", "Infinity"]) {
    process.env.AGY_BRIDGE_CONTEXT_WINDOW = invalid
    check(`invalid context declaration ${invalid} retains the default`, (await plugin.provider.models())["gemini-test"]?.limit?.context === 256000)
  }
  delete process.env.AGY_BRIDGE_CONTEXT_WINDOW
}

{
  const before = logs().filter(event => event.type === "models").length
  const result = await plugin.auth.methods[0].authorize()
  const probes = logs().filter(event => event.type === "models").slice(before)
  check("authorize login probe still succeeds", result.type === "success" && result.key === "agy")
  check("authorize login probe disables auto update", probes.length === 1 && probes[0].update === "true")
}

async function launchedModel(body) {
  const response = await callFetch(body)
  await readSSE(response)
  return lastOf("user")?.model
}

{
  check("grouped model defaults to high", await launchedModel({ model, messages: [{ role: "user", content: "MODEL default effort" }] }) === "gemini-test-high")
  check("Argon alone defaults to medium", await launchedModel({ model: "gemini-4-argon", messages: [{ role: "user", content: "MODEL Argon default" }] }) === "gemini-4-argon-medium")
  check("Argon explicit high remains available", await launchedModel({ model: "gemini-4-argon", reasoning_effort: "high", messages: [{ role: "user", content: "MODEL Argon explicit" }] }) === "gemini-4-argon-high")
  check("Argon legacy low remains available", await launchedModel({ model: "gemini-4-argon-low", messages: [{ role: "user", content: "MODEL Argon legacy" }] }) === "gemini-4-argon-low")
  check("thinking budget selects the matching agy model", await launchedModel({ model, thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: "MODEL low effort" }] }) === "gemini-test-low")
  check("output effort selects the matching agy model", await launchedModel({ model, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, messages: [{ role: "user", content: "MODEL medium effort" }] }) === "gemini-test-medium")
  check("high thinking budget selects high", await launchedModel({ model, thinking: { type: "enabled", budget_tokens: 24000 }, messages: [{ role: "user", content: "MODEL high effort" }] }) === "gemini-test-high")
  check("output effort without thinking keeps the default", await launchedModel({ model, output_config: { effort: "low" }, messages: [{ role: "user", content: "MODEL title request" }] }) === "gemini-test-high")
  check("legacy effort ids pass through unchanged", await launchedModel({ model: legacyModel, thinking: { type: "enabled", budget_tokens: 10000 }, messages: [{ role: "user", content: "MODEL legacy id" }] }) === "gemini-test-low")
  check("single-effort model requests pass through unchanged", await launchedModel({ model: "antigravity-bridge/claude-test-medium", thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: "MODEL singleton" }] }) === "claude-test-medium")
  check("modern sessions select models and levels through ACP config options", logs().some(event => event.type === "setConfig" && event.configId === "model") && logs().some(event => event.type === "setConfig" && event.configId === "thought_level" && event.value === "low"))
  check("modern model selection does not call legacy set_model", !logs().some(event => event.type === "setModel"), JSON.stringify(logs().filter(event => event.type === "setModel")))
}

{
  const beforeInits = inits().length
  const beforePrompts = logs().filter(event => event.type === "user").length
  const response = await callFetch({
    model: "antigravity-bridge/claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "Haiku must not borrow Gemini small-fast routing" }],
  })
  const payload = await response.json()
  check("Claude Haiku without an advertised Haiku family is explicitly unavailable",
    response.status === 400 && response.headers.get("x-should-retry") === "false" &&
    payload.error?.code === "model_unavailable" && payload.error?.message?.includes("no Claude Haiku family"),
    JSON.stringify({ status: response.status, payload }))
  check("unavailable Haiku never starts or prompts a Gemini session",
    inits().length === beforeInits && logs().filter(event => event.type === "user").length === beforePrompts)
}

{
  process.env.FAKE_AGY_CONFIG = "grouped"
  const first = { model: "gemini-config-only", metadata: { user_id: "grouped-config" }, thinking: { type: "adaptive" }, output_config: { effort: "max" }, messages: [{ role: "user", content: "config only maximum" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  check("grouped ACP options can select a model absent from the CLI list", lastOf("user").model === "gemini-config-only-max" && stopOf(firstEvents) === "end_turn")
  check("ACP config category selects custom option IDs", logs().some(event => event.type === "setConfig" && event.convId === convId && event.configId === "model-picker") && logs().some(event => event.type === "setConfig" && event.convId === convId && event.configId === "thinking-picker"))
  const second = { ...nextTurn(first, firstEvents, "lower the level"), output_config: { effort: "low" } }
  const secondEvents = (await readSSE(await callFetch(second))).events
  check("changing only ACP effort updates the same model in the same session", lastOf("user").convId === convId && lastOf("user").model === "gemini-config-only-low")
  const switched = { ...nextTurn(second, secondEvents, "switch families"), model: "gemini-test", output_config: { effort: "max" } }
  await readSSE(await callFetch(switched))
  check("model switches refresh available thinking levels before setting effort", lastOf("user").model === "gemini-test-high" && lastOf("user").convId === convId)
  check("grouped config selection never falls back to legacy model IDs", !logs().some(event => event.type === "setModel" && event.convId === convId))
  delete process.env.FAKE_AGY_CONFIG

  for (const mode of ["omit", "unimplemented"]) {
    process.env.FAKE_AGY_CONFIG = mode
    const body = { model, metadata: { user_id: "legacy-config-" + mode }, messages: [{ role: "user", content: "legacy config " + mode }] }
    const events = (await readSSE(await callFetch(body))).events
    const convId = inits().at(-1).convId
    check(`config ${mode} falls back to legacy set_model`, lastOf("user").model === "gemini-test-high" && logs().some(event => event.type === "setModel" && event.convId === convId))
    await readSSE(await callFetch({ ...nextTurn(body, events, "legacy level change"), model: legacyModel }))
    check(`config ${mode} keeps in-session legacy model switching`, lastOf("user").convId === convId && lastOf("user").model === "gemini-test-low")
    check(`config ${mode} does not repeatedly probe an unsupported method`, logs().filter(event => event.type === "setConfig" && event.convId === convId).length === (mode === "omit" ? 0 : 1))
    delete process.env.FAKE_AGY_CONFIG
  }

  process.env.FAKE_AGY_CONFIG = "error"
  const before = logs().filter(event => event.type === "setModel").length
  const rejectedBody = { model, messages: [{ role: "user", content: "rejected config" }] }
  const rejected = await callFetch(rejectedBody)
  const error = await rejected.json()
  check("real config errors remain visible before streaming", rejected.status === 400 && error.error?.message.includes("Configuration rejected"))
  check("real config errors do not trigger a legacy fallback", logs().filter(event => event.type === "setModel").length === before)
  delete process.env.FAKE_AGY_CONFIG
  const retryResponse = await callFetch(rejectedBody)
  const retryEvents = (await readSSE(retryResponse)).events
  check("a failure before session/prompt can retry the same request",
    retryResponse.status === 200 && stopOf(retryEvents) === "end_turn" &&
    logs().filter(event => event.type === "user" && event.text === "rejected config").length === 1)

  const body = { model, messages: [{ role: "user", content: "CONFIGRESET first turn" }] }
  const events = (await readSSE(await callFetch(body))).events
  const resetConvId = inits().at(-1).convId
  await readSSE(await callFetch(nextTurn(body, events, "restore requested level")))
  check("config_option_update invalidates cached selection between turns", lastOf("user").model === "gemini-test-high" && lastOf("user").convId === resetConvId)
}

{
  const response = await callFetch({ model, system: "SYSTEM-PROMPT-MARKER", messages: [{ role: "user", content: "hello world" }] })
  check("single turn returns 200", response.status === 200, `got ${response.status}`)
  const { events } = await readSSE(response)
  const kinds = events.map(event => event.event)
  check("has message_start", kinds.includes("message_start"))
  check("response preserves the grouped model id", events.find(event => event.event === "message_start")?.data?.message?.model === "gemini-test")
  check("has content_block_delta", kinds.includes("content_block_delta"))
  check("has message_delta", kinds.includes("message_delta"))
  check("has message_stop", kinds.includes("message_stop"))
  check("text contains echo", textOf(events).includes("hello world"), textOf(events))
  const usage = events.find(event => event.event === "message_delta")?.data?.usage
  check("output_tokens reported", (usage?.output_tokens ?? 0) > 0)
  check("input_tokens reported", (usage?.input_tokens ?? 0) > 0)
  const init = inits().at(-1)
  const user = lastOf("user")
  check("ACP session uses the minimal isolated agent", ["tools: []", "inheritMcp: false", "inheritCustomizations: false", "excludeDefaultComponents: true"].every(line => init.agentConfig.includes(line)), init.agentConfig)
  check("ACP client identifies as an allowlisted client", init.clientInfo?.name === "zed" && init.clientInfo?.version === "0.0.0")
  check("client system prompt is appended to the session instructions", init.systemAppend?.includes("SYSTEM-PROMPT-MARKER"))
  check("fresh prompt carries only the user text", user.text === "hello world", JSON.stringify(user.text))
  check("client tools are served through the ide-tools port", !!init.idePort && !logs().some(event => event.type === "ncExit"))
}

{
  const billing = "x-anthropic-billing-header: cc_version=2.1.234; cc_entrypoint=sdk-cli;"
  const sdkIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  const inlineIdentity = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
  const body = {
    model,
    system: [
      { type: "text", text: billing },
      { type: "text", text: `${sdkIdentity}\nKeep Anthropic, OpenAI and Deepseek as ordinary words.`, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "system", content: inlineIdentity },
      { role: "user", content: `PROMPTGUARD user text stays unchanged: ${sdkIdentity}` },
    ],
  }
  const response = await callFetch(body)
  const events = (await readSSE(response)).events
  const init = inits().at(-1)
  const user = lastOf("user")
  check("prompt guard covers top-level and inline system blocks before flattening",
    response.status === 200 && stopOf(events) === "end_turn" &&
    !init.systemAppend?.includes("x-anthropic-billing-header") &&
    !init.systemAppend?.includes("Claude Agent SDK") &&
    (init.systemAppend?.match(/You are an AI coding assistant\./g) || []).length === 2,
    init.systemAppend)
  check("prompt guard preserves ordinary vendor words and user text",
    init.systemAppend?.includes("Anthropic, OpenAI and Deepseek") &&
    user.text === `PROMPTGUARD user text stays unchanged: ${sdkIdentity}`,
    JSON.stringify({ system: init.systemAppend, user: user.text }))
}

{
  const initialInits = inits().length
  const first = { model, messages: [{ role: "user", content: "first message" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const second = nextTurn(first, firstEvents, "second message")
  const { events } = await readSSE(await callFetch(second))
  check("second turn gets reply", textOf(events).includes("second message"), textOf(events))
  check("conversation reuses one session", inits().length === initialInits + 1)
  check("continued turn sends only the new message", lastOf("user").text === "second message")
}

{
  const first = { model, messages: [{ role: "user", content: "THINKING_USAGE first" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const firstUsage = firstEvents.find(event => event.event === "message_delta")?.data?.usage
  check("thinking tokens use Anthropic output details", firstUsage?.output_tokens_details?.thinking_tokens === 7, JSON.stringify(firstUsage))
  check("output tokens include thinking tokens", firstUsage?.output_tokens === "thinking usage".length + 7, JSON.stringify(firstUsage))
  check("cached prompt tokens are reported separately", firstUsage?.cache_read_input_tokens === 3 && firstUsage?.input_tokens === 10, JSON.stringify(firstUsage))
  const second = nextTurn(first, firstEvents, "THINKING_USAGE second")
  const secondEvents = (await readSSE(await callFetch(second))).events
  const secondUsage = secondEvents.find(event => event.event === "message_delta")?.data?.usage
  check("thinking usage is per turn", secondUsage?.output_tokens_details?.thinking_tokens === 7, JSON.stringify(secondUsage))
}

{
  const body = { model, messages: [{ role: "user", content: "EXCLUSIVE_USAGE" }] }
  const { events } = await readSSE(await callFetch(body))
  const usage = events.find(event => event.event === "message_delta")?.data?.usage
  check("agy 1.5.1 inputTokens is not reduced by cache reads",
    usage?.input_tokens === 2133 && usage?.cache_read_input_tokens === 4899, JSON.stringify(usage))
  check("exclusive input and cache read keep the ACP total",
    usage?.input_tokens + usage?.cache_read_input_tokens === 7032, JSON.stringify(usage))
}

{
  const body = { model, messages: [{ role: "user", content: "CACHED_ONLY_USAGE" }] }
  const { events } = await readSSE(await callFetch(body))
  const usage = events.find(event => event.event === "message_delta")?.data?.usage
  check("a fully cached prompt keeps its cache read instead of dropping it",
    usage?.input_tokens === 0 && usage?.cache_read_input_tokens === 4899, JSON.stringify(usage))
}

{
  const body = { model, messages: [{ role: "user", content: "THINK_BLOCKS please" }] }
  const { events } = await readSSE(await callFetch(body))
  const blocks = assistantBlocks(events)
  check("thought summaries stream as thinking blocks", blocks[0]?.type === "thinking" && blocks[0].thinking === "**Planning**\n\nConsider the request. Then answer.", JSON.stringify(blocks))
  check("text follows the thinking block", blocks[1]?.type === "text" && blocks[1].text === "Answer after thinking.")
  const signatureIndex = events.findIndex(event => event.data?.delta?.type === "signature_delta")
  const thinkingStop = events.findIndex(event => event.event === "content_block_stop" && event.data.index === 0)
  check("thinking block ends with a signature_delta before its stop", signatureIndex >= 0 && signatureIndex === thinkingStop - 1 && events[signatureIndex].data.index === 0, JSON.stringify(events[signatureIndex]))
  check("thinking signature is a bridge-issued HMAC", /^agyb1\.[A-Za-z0-9_-]{43}$/.test(blocks[0]?.signature || ""), blocks[0]?.signature)
  check("text blocks carry no signature", !events.some(event => event.data?.delta?.type === "signature_delta" && event.data.index !== 0))
  const disabled = (await readSSE(await callFetch({ ...body, thinking: { type: "disabled" }, messages: [{ role: "user", content: "THINK_BLOCKS hidden" }] }))).events
  check("thinking: disabled suppresses thought summaries", !assistantBlocks(disabled).some(block => block.type === "thinking") && textOf(disabled) === "Answer after thinking.")
  const next = nextTurn(body, events, "after thinking")
  check("signed thinking block round-trips in history", next.messages[1].content[0].type === "thinking" && next.messages[1].content[0].signature === blocks[0].signature)
  const followEvents = (await readSSE(await callFetch(next))).events
  check("signed thinking blocks in history do not break continuation", stopOf(followEvents) === "end_turn" && lastOf("user").text === "after thinking")
  const again = assistantBlocks((await readSSE(await callFetch({ model, messages: [{ role: "user", content: "THINK_BLOCKS again" }] }))).events)
  check("signatures are bound to the session and text", again[0]?.thinking === blocks[0].thinking && again[0].signature !== blocks[0].signature)
}

{
  const body = { model, messages: [{ role: "user", content: "SUMMARY_LEAK please" }] }
  const { events } = await readSSE(await callFetch(body))
  const blocks = assistantBlocks(events)
  const thoughts = blocks.filter(block => block.type === "thinking")
  check("#39: agy's title-summary reasoning is not forwarded as thinking",
    thoughts.length === 1 && !thoughts[0].thinking.includes("Summarize the provided thoughts"), JSON.stringify(blocks))
  check("#39: the primary turn's own reasoning survives",
    thoughts[0]?.thinking === "User asks: keep the real reasoning. Key insight: only the summary echo is dropped.")
  check("#39: suppressing summary thoughts keeps the answer and its ordering",
    blocks.at(-1)?.type === "text" && blocks.at(-1).text === "Answer after summaries.")
  check("#39: dropped summaries leave a single signed thinking block",
    events.filter(event => event.data?.delta?.type === "signature_delta").length === 1)
}

{
  const saved = process.env.AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS
  let unfiltered
  try {
    process.env.AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS = "1"
    ;({ default: unfiltered } = await import("./index.mjs?summary-thoughts-opt-out"))
  } finally {
    if (saved === undefined) delete process.env.AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS
    else process.env.AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS = saved
  }
  const loaderOptOut = await (await unfiltered.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  const response = await loaderOptOut.fetch("agy://local/messages", {
    method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "SUMMARY_LEAK opt out" }] }),
  })
  const thoughts = assistantBlocks((await readSSE(response)).events).filter(block => block.type === "thinking")
  check("#39: AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS=1 forwards every thought chunk",
    thoughts.length === 1 && thoughts[0].thinking.startsWith("Thinking Process: 1. **Analyze the Request:**") &&
    thoughts[0].thinking.includes("Key insight"), JSON.stringify(thoughts.map(block => block.thinking.slice(0, 40))))
}

{
  // Suppressed summaries must still count as agy activity: five summary-only
  // thoughts at 400 ms apart would otherwise exceed this shortened turn limit.
  const saved = process.env.AGY_BRIDGE_TURN_TIMEOUT_MS
  let limited
  try {
    process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "1200"
    ;({ default: limited } = await import("./index.mjs?summary-thoughts-activity"))
  } finally {
    process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = saved
  }
  const loaderLimited = await (await limited.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  const response = await loaderLimited.fetch("agy://local/messages", {
    method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "SUMMARY_ONLY please" }] }),
  })
  const { events } = await readSSE(response)
  check("#39: suppressed summary chunks still renew the activity timeout",
    stopOf(events) === "end_turn" && textOf(events) === "Answer after summaries only." && !events.some(event => event.event === "error"),
    JSON.stringify(events.filter(event => event.event === "error").map(event => event.data)))
}

{
  // A tool call is a real response boundary: buffered thought text must be
  // delivered before the tool block, and the echo region must not leak past it.
  const first = { model, messages: [{ role: "user", content: "SUMMARY_TOOL please" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const blocks = assistantBlocks(firstEvents)
  const toolIndex = blocks.findIndex(block => block.type === "tool_use")
  const lastThinkingIndex = blocks.reduce((last, block, index) => block.type === "thinking" ? index : last, -1)
  check("#39: a tool call flushes the held thought before the tool block",
    lastThinkingIndex >= 0 && lastThinkingIndex < toolIndex, JSON.stringify(blocks.map(block => block.type)))
  const beforeTool = blocks.filter(block => block.type === "thinking").map(block => block.thinking).join("")
  check("#39: no summary echo reaches the client before a tool call",
    !beforeTool.includes("Summarize the provided thoughts") && !beforeTool.includes("Maximum 50 words"), beforeTool.slice(0, 200))
  const continued = (await readSSE(await callFetch(continuation(first, firstEvents, "after the tool")))).events
  const afterTool = assistantBlocks(continued).filter(block => block.type === "thinking").map(block => block.thinking).join("")
  check("#39: real reasoning on both sides of a tool call survives",
    beforeTool.includes("Think") && afterTool.includes("Key insight: the tool result matters."),
    JSON.stringify({ beforeTool, afterTool, stop: stopOf(continued) }))
}

{
  const before = inits().length
  const shared = { model, messages: [{ role: "user", content: "SAME opening" }] }
  const firstA = (await readSSE(await callFetch(shared))).events
  const convA = inits().at(-1).convId
  await readSSE(await callFetch(shared))
  const convB = inits().at(-1).convId
  const secondA = nextTurn(shared, firstA, "second turn for A")
  await readSSE(await callFetch(secondA))
  const replay = lastOf("user").text
  check("same-opening conversations replay their own history", replay.includes("<conversation_history>") && replay.includes(convA) && !replay.includes(convB), replay)
  check("same-opening conversations do not share a live session", inits().length === before + 3)
}

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "UNICODE split" }] })
  const { events } = await readSSE(response)
  check("UTF-8 split inside a code point preserves text", textOf(events).includes("中文😀"), textOf(events))
}

for (const [name, system, headers, expectedDir, named] of [
  ["local prompt", `Working directory: ${os.tmpdir()}`, {}, path.resolve(os.tmpdir()), os.tmpdir()],
  ["remote prompt", "<cwd>/remote-mac/project</cwd>", {}, null, "/remote-mac/project"],
  ["header precedence", "Current working directory: /remote-mac/project", { "x-magpie-work-dir": encodeURIComponent(os.tmpdir()) }, path.resolve(os.tmpdir()), os.tmpdir()],
  ["relative prompt", "Primary working directory: relative-project", {}, null, "relative-project"],
]) {
  const body = { model, system, messages: [{ role: "user", content: `environment ${name}` }] }
  const final = (await readSSE(await callFetch(body, headers))).events
  const init = inits().at(-1)
  check(`${name} uses only an available absolute add-dir`, stopOf(final) === "end_turn" && init.addDir === expectedDir)
  check(`${name} identifies where client tools run`, init.systemAppend?.includes(JSON.stringify(named)) && init.systemAppend.includes("where every tool runs"))
  check(`${name} keeps agent configuration isolated`, init.cwd !== expectedDir && init.cwd.includes("magpie-agy-bridge-"))
}

let nativeBody
let nativeEvents
let nativeConv
{
  nativeBody = { model, messages: [{ role: "user", content: "TOOL native once" }], tools: [echoTool] }
  const first = await callFetch(nativeBody)
  check("native tool first response returns 200", first.status === 200)
  nativeEvents = (await readSSE(first)).events
  const call = toolCall(nativeEvents)
  check("native MCP emits tool_use", call?.name === "echo" && call.input.text === "probe")
  check("native MCP stops at tool_use", stopOf(nativeEvents) === "tool_use")
  check("text before the call stays in the tool_use response", textOf(nativeEvents) === "Before tool.\n", JSON.stringify(textOf(nativeEvents)))
  nativeConv = inits().at(-1)?.convId
  check("MCP stays pending after first response", !logs().some(event => event.type === "mcpResult" && event.convId === nativeConv))
  check("agy has not finished its turn", !logs().some(event => event.type === "result" && event.convId === nativeConv))
  const listed = inits().at(-1)
  check("tools/list preserves JSON schema", listed?.tools?.[0] === "echo" || logs().some(event => event.type === "toolsList" && event.tools.includes("echo")))
}

{
  const secondBody = continuation(nativeBody, nativeEvents, "native-result")
  const assistant = secondBody.messages[1]
  secondBody.messages[1] = {
    content: assistant.content.map(block => Object.fromEntries(Object.keys(block).sort().reverse().map(key => [key, block[key]]))),
    role: assistant.role,
  }
  const { events } = await readSSE(await callFetch(secondBody))
  check("field-order-independent history continues to end_turn", stopOf(events) === "end_turn" && textOf(events).includes("After tools"))
  const delivered = logs().find(event => event.type === "mcpResult" && event.convId === nativeConv)
  check("MCP receives actual result without placeholder", delivered?.result?.content?.[0]?.text === "native-result")
  check("continuation sends no new agy prompt", logs().filter(event => event.type === "user" && event.convId === nativeConv).length === 1)
  check("native tool reuses the same agy session", inits().filter(event => event.convId === nativeConv).length === 1)
}

{
  // One session/prompt spans two HTTP responses; ACP's accumulated 9000 input
  // tokens must not all land on the last one.
  const firstBody = { model, messages: [{ role: "user", content: "MULTISTEP usage" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const lastEvents = (await readSSE(await callFetch(continuation(firstBody, firstEvents, "multistep-result")))).events
  const window = (events) => {
    const usage = events.find(event => event.event === "message_delta")?.data?.usage || {}
    return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
  }
  const stepUsage = firstEvents.find(event => event.event === "message_delta")?.data?.usage
  const finalUsage = lastEvents.find(event => event.event === "message_delta")?.data?.usage
  check("multi-step turn ends after the tool round-trip", stopOf(firstEvents) === "tool_use" && stopOf(lastEvents) === "end_turn")
  check("tool step reports non-zero single-step usage", window(firstEvents) > 0 && stepUsage?.output_tokens > 0, JSON.stringify(stepUsage))
  check("final response does not carry the accumulated ACP input", window(lastEvents) > 0 && window(lastEvents) < 9000, JSON.stringify(finalUsage))
  check("responses together stay below the accumulated ACP input", window(firstEvents) + window(lastEvents) < 9000)
}

{
  const first = { model, messages: [{ role: "user", content: "TWOSTEP formatted history" }], tools: [echoTool] }
  const before = inits().length
  const events = (await readSSE(await callFetch(first))).events
  const second = continuation(first, events, "formatted-one")
  second.messages[0].content = [{ type: "text", text: first.messages[0].content, cache_control: { type: "ephemeral" } }]
  const blocks = second.messages[1].content
  second.messages.splice(1, 1,
    { role: "assistant", content: blocks.filter(block => block.type === "text").map(block => ({ ...block, text: block.text.trimEnd() })) },
    { role: "assistant", content: blocks.filter(block => block.type === "tool_use").map(block => ({ ...block, cache_control: { type: "ephemeral" } })) })
  const response = await callFetch(second)
  check("client formatting and cache markers do not reject results", response.status === 200, `got ${response.status}`)
  const next = (await readSSE(response)).events
  if (toolCall(next)) {
    const final = (await readSSE(await callFetch(continuation(second, next, "formatted-two")))).events
    check("formatted history survives another tool round", stopOf(final) === "end_turn")
  } else {
    await readSSE(await callFetch(continuation(first, events, "cleanup")))
  }
  check("formatting-only changes keep the live session", inits().length === before + 1)
}

{
  const first = { model, messages: [{ role: "user", content: "TWOSTEP renamed calls" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const second = continuation(first, events, "remapped-one")
  second.messages[1].content.find(block => block.type === "tool_use").id = "TU-client-first"
  second.messages[2].content[0].tool_use_id = "TU-client-first"
  const response = await callFetch(second)
  check("client-renamed tool ID finds its pending call", response.status === 200, `got ${response.status}`)
  const next = (await readSSE(response)).events
  if (toolCall(next)) {
    const third = continuation(second, next, "remapped-two")
    third.messages.at(-2).content.find(block => block.type === "tool_use").id = "TU-client-second"
    third.messages.at(-1).content[0].tool_use_id = "TU-client-second"
    const final = (await readSSE(await callFetch(third))).events
    check("renamed IDs survive consecutive rounds", stopOf(final) === "end_turn")
    const results = logs().filter(event => event.type === "mcpResult" && event.convId === convId)
    check("renamed results reach the original MCP calls", results.map(event => event.result.content[0].text).join(",") === "remapped-one,remapped-two")
  } else {
    await drive(first, events, "cleanup")
  }
}

{
  const first = { model, messages: [{ role: "user", content: "TOOL before compaction" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const old = inits().at(-1)
  const second = continuation(first, events, "already-executed-result")
  second.messages[0].content = "Compacted summary of the conversation"
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  check("edited history replays instead of returning 409", response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  const replay = lastOf("user")
  check("replay includes current history and the real result", replay.convId !== old.convId && replay.text.includes("Compacted summary") && replay.text.includes("already-executed-result") && !replay.text.includes("TOOL before compaction"))
  check("replaced pending process is cleaned up", !fs.existsSync(old.cwd))
}

{
  const firstBody = { model, messages: [{ role: "user", content: "PARALLEL native" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const seen = toolCalls(firstEvents).map(call => call.id)
  let body = firstBody
  let events = firstEvents
  let rounds = 0
  while (stopOf(events) === "tool_use" && rounds < 4) {
    body = continuation(body, events, "parallel-" + (++rounds))
    events = (await readSSE(await callFetch(body))).events
    seen.push(...toolCalls(events).map(call => call.id))
  }
  check("parallel calls each reach the client once", new Set(seen).size === 2 && seen.length === 2, seen.join(","))
  check("parallel calls finish after both real results", stopOf(events) === "end_turn" && textOf(events).includes("After parallel"))
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TWOSTEP native" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const secondBody = continuation(firstBody, firstEvents, "step-one")
  const secondEvents = (await readSSE(await callFetch(secondBody))).events
  check("consecutive tool call uses same live turn", stopOf(secondEvents) === "tool_use")
  const conflicting = continuation(firstBody, firstEvents, "conflicting-result")
  const conflictResponse = await callFetch(conflicting)
  check("conflicting duplicate result returns 409", conflictResponse.status === 409, `got ${conflictResponse.status}`)
  const thirdBody = continuation(secondBody, secondEvents, "step-two")
  const thirdEvents = (await readSSE(await callFetch(thirdBody))).events
  check("conflict does not corrupt pending turn", stopOf(thirdEvents) === "end_turn")
}

// A summary can fork from an answered step while the same ACP turn is waiting
// for a newer call. Both a text response and a summary that asks for a tool must
// leave the main branch's process, pending call and later session reuse intact.
for (const [summaryTool, withNotice] of [[false, false], [true, false], [false, true], [true, true]]) {
  const { default: summaryDefault } = await import("./index.mjs?historical-summary")
  const summaryPlugin = await summaryDefault.server({ client: null, directory: os.tmpdir() }, {})
  const summaryLoader = await summaryPlugin.auth.loader(async () => ({ key: "agy" }))
  const callFetch = body => summaryLoader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
  const label = (summaryTool ? "summary with tool" : "text summary") + (withNotice ? " and context notice" : "")
  const first = { model, metadata: { user_id: `historical-${label}` }, tools: [echoTool],
    messages: [{ role: "user", content: `TWOSTEP historical ${label}` }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const primary = inits().at(-1)
  const second = continuation(first, firstEvents, "historical step A result")
  if (withNotice) second.messages.at(-1).content.push({ type: "text", text: "<system-reminder>Keep the original context.</system-reminder>" })
  const secondEvents = (await readSSE(await callFetch(second))).events
  check(`${label}: the primary has advanced to a newer pending call`, stopOf(secondEvents) === "tool_use" &&
    toolCall(secondEvents)?.id !== toolCall(firstEvents)?.id)

  const summary = structuredClone(second)
  summary.messages.push({ role: "user", content: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. " +
    "BACKGROUND_SUMMARY: Summarize the conversation so far." + (summaryTool ? " SUMMARY_PENDING" : "") })
  const before = inits().length
  const summaryResponse = await callFetch(summary)
  const summaryEvents = (await readSSE(summaryResponse)).events
  const side = inits().at(-1)
  check(`${label}: the historical result starts an isolated session`, summaryResponse.status === 200 &&
    inits().length === before + 1 && side.convId !== primary.convId &&
    stopOf(summaryEvents) === (summaryTool ? "tool_use" : "end_turn"))
  check(`${label}: isolation preserves the primary process and pending call`, fs.existsSync(primary.cwd) &&
    logs().filter(event => event.type === "mcpResult" && event.convId === primary.convId).length === 1)
  if (withNotice) {
    const changed = structuredClone(summary)
    changed.messages.at(-2).content[0].content = "conflicting historical result"
    check(`${label}: a changed historical result remains a conflict`, (await callFetch(changed)).status === 409 &&
      fs.existsSync(primary.cwd))
  }

  const completed = { body: summary, events: summaryEvents }
  if (summaryTool) {
    completed.body = continuation(summary, summaryEvents, "summary tool result")
    completed.events = (await readSSE(await callFetch(completed.body))).events
  }
  check(`${label}: the summary completes independently`, stopOf(completed.events) === "end_turn")
  const beforeFollow = inits().length
  const summaryFollow = nextTurn(completed.body, completed.events, "MEMORY summary follow-up")
  const followed = (await readSSE(await callFetch(summaryFollow))).events
  check(`${label}: answered historical IDs do not redirect the summary follow-up`, stopOf(followed) === "end_turn" &&
    inits().length === beforeFollow && lastOf("user").convId === side.convId && fs.existsSync(primary.cwd))

  const mainResult = continuation(second, secondEvents, "primary step B result")
  const mainResponse = await callFetch(mainResult)
  const mainDone = (await readSSE(mainResponse)).events
  const delivered = logs().filter(event => event.type === "mcpResult" && event.convId === primary.convId)
  check(`${label}: the newer tool result completes in its original session`, mainResponse.status === 200 &&
    stopOf(mainDone) === "end_turn" && inits().length === beforeFollow &&
    delivered.map(event => event.result.content[0].text).join(",") === "historical step A result,primary step B result")
  const mainFollow = (await readSSE(await callFetch(nextTurn(mainResult, mainDone, "MEMORY primary follow-up")))).events
  check(`${label}: the main follow-up retains its original session`, stopOf(mainFollow) === "end_turn" &&
    inits().length === beforeFollow && lastOf("user").convId === primary.convId)
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL failure" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const secondBody = continuation(firstBody, firstEvents, "permission denied", { isError: true })
  const secondEvents = (await readSSE(await callFetch(secondBody))).events
  const delivered = lastOf("mcpResult")
  check("tool execution failure maps to MCP isError", delivered?.result?.isError === true)
  check("tool execution failure still completes natively", stopOf(secondEvents) === "end_turn")
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL atomic duplicates" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const convId = inits().at(-1).convId
  const invalidBody = continuation(firstBody, firstEvents, "first-value")
  const result = invalidBody.messages[invalidBody.messages.length - 1].content[0]
  invalidBody.messages[invalidBody.messages.length - 1].content.push({ ...result, content: "conflicting-value" })
  const invalid = await callFetch(invalidBody)
  check("same-batch conflicting results return 409", invalid.status === 409, `got ${invalid.status}`)
  check("conflicting batch commits no MCP result", !logs().some(event => event.type === "mcpResult" && event.convId === convId))
  const validEvents = (await readSSE(await callFetch(continuation(firstBody, firstEvents, "first-value")))).events
  const delivered = logs().find(event => event.type === "mcpResult" && event.convId === convId)
  check("valid retry completes without partial commit", stopOf(validEvents) === "end_turn" && delivered?.result?.content?.[0]?.text === "first-value")
}

{
  const before = inits().length
  const bodyA = { model, messages: [{ role: "user", content: "TOOL conversation A" }], tools: [echoTool] }
  const bodyB = { model, messages: [{ role: "user", content: "TOOL conversation B" }], tools: [echoTool] }
  const [responseA, responseB] = await Promise.all([callFetch(bodyA), callFetch(bodyB)])
  const [eventsA, eventsB] = await Promise.all([readSSE(responseA), readSSE(responseB)])
  const mixed = continuation(bodyA, eventsA.events, "must-not-deliver")
  mixed.messages.at(-1).content.push(continuation(bodyB, eventsB.events, "must-not-deliver").messages.at(-1).content[0])
  check("mixed-conversation batch is rejected", (await callFetch(mixed)).status === 409)
  const wrongArgs = continuation(bodyA, eventsA.events, "must-not-deliver")
  const renamed = wrongArgs.messages.at(-2).content.find(block => block.type === "tool_use")
  renamed.id = "TU-wrong-arguments"
  renamed.input.text = "different-arguments"
  wrongArgs.messages.at(-1).content[0].tool_use_id = renamed.id
  check("ID remapping cannot ignore changed arguments", (await callFetch(wrongArgs)).status === 409)
  const [resultA, resultB] = await Promise.all([
    readSSE(await callFetch(continuation(bodyA, eventsA.events, "result-A"))),
    readSSE(await callFetch(continuation(bodyB, eventsB.events, "result-B"))),
  ])
  const delivered = logs().filter(event => event.type === "mcpResult").slice(-2).map(event => event.result.content[0].text)
  check("concurrent conversations keep tool results isolated", delivered.includes("result-A") && delivered.includes("result-B"))
  check("concurrent conversations use independent sessions", inits().length === before + 2)
  check("both concurrent conversations complete", stopOf(resultA.events) === "end_turn" && stopOf(resultB.events) === "end_turn")
}

{
  const bodyA = { model, metadata: { user_id: "ambiguous-A" }, messages: [{ role: "user", content: "TOOL identical history" }], tools: [echoTool] }
  const bodyB = { ...bodyA, metadata: { user_id: "ambiguous-B" } }
  const [a, b] = await Promise.all([callFetch(bodyA), callFetch(bodyB)])
  const [eventsA, eventsB] = await Promise.all([readSSE(a), readSSE(b)])
  const ambiguous = continuation(bodyA, eventsA.events, "ambiguous-output")
  ambiguous.messages.at(-2).content.find(block => block.type === "tool_use").id = "TU-ambiguous"
  ambiguous.messages.at(-1).content[0].tool_use_id = "TU-ambiguous"
  check("ambiguous renamed calls are never guessed", (await callFetch(ambiguous)).status === 503)
  const finals = await Promise.all([
    callFetch(continuation(bodyA, eventsA.events, "unambiguous-A")).then(readSSE),
    callFetch(continuation(bodyB, eventsB.events, "unambiguous-B")).then(readSSE),
  ])
  const delivered = logs().filter(event => event.type === "mcpResult").slice(-2).map(event => event.result.content[0].text).sort()
  check("ambiguity leaves both original calls intact", finals.every(final => stopOf(final.events) === "end_turn") && delivered.join(",") === "unambiguous-A,unambiguous-B")
}

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "please DIE now" }] })
  const { events } = await readSSE(response)
  check("error frame emitted on agy death", events.some(event => event.event === "error"))
}

{
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=" } }
  const secondImage = { ...image, source: { ...image.source, data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", media_type: "image/gif" } }
  const acpImage = value => ({ type: "image", data: value.source.data, mimeType: value.source.media_type })
  const first = { model, messages: [{ role: "user", content: [{ type: "text", text: "compare pictures " }, image, { type: "text", text: " and " }, secondImage] }] }
  const response = await callFetch(first)
  const { events } = await readSSE(response)
  const firstSession = inits().at(-1).convId
  check("image input completes with an image-capable server", response.status === 200 && stopOf(events) === "end_turn")
  check("text and multiple images keep their order in ACP", JSON.stringify(lastOf("user").content) === JSON.stringify([
    { type: "text", text: "compare pictures " }, acpImage(image), { type: "text", text: " and " }, acpImage(secondImage),
  ]))
  check("image bytes are not interpolated into prompt text", !lastOf("user").text.includes(image.source.data))

  const followup = nextTurn(first, events, [secondImage, { type: "text", text: "describe this next picture" }])
  followup.messages[0] = structuredClone(followup.messages[0])
  followup.messages[0].content[1].cache_control = { type: "ephemeral" }
  const nextEvents = (await readSSE(await callFetch(followup))).events
  check("image continuation keeps the same session", lastOf("user").convId === firstSession && stopOf(nextEvents) === "end_turn")
  check("image continuation sends only new content", JSON.stringify(lastOf("user").content) === JSON.stringify([acpImage(secondImage), { type: "text", text: "describe this next picture" }]))

  const changed = structuredClone(followup)
  changed.messages[0].content[1] = secondImage
  await readSSE(await callFetch(changed))
  const replay = lastOf("user")
  check("changing historical image content starts a new session", replay.convId !== firstSession)
  check("history replay preserves historical and current images", replay.content.filter(block => block.type === "image").length === 3 && replay.content.filter(block => block.type === "image").every(block => block.data === secondImage.source.data))
  check("history replay retains role and turn boundaries around images", replay.text.includes("Human: compare pictures") && replay.text.includes("</conversation_history>") && replay.text.includes("<current_turn>"))

  const { default: imageRestartDefault } = await import("./index.mjs?image-restart")
  const imageRestart = await imageRestartDefault.server({}, {})
  const imageLoader = await imageRestart.auth.loader(async () => ({ key: "agy" }))
  const resumed = await imageLoader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(nextTurn(followup, nextEvents, "recall the pictures")) })
  await readSSE(resumed)
  check("a restarted bridge resumes an image conversation", inits().at(-1).resumed && lastOf("user").convId === firstSession)
  check("image resume does not replay previously sent images", lastOf("user").content.length === 1 && lastOf("user").text === "recall the pictures")
  check("persisted session state contains no image data", !fs.readFileSync(bridgeStateFile, "utf8").includes(image.source.data))

  for (const capability of ["0", "omit"]) {
    process.env.FAKE_AGY_IMAGES = capability
    const body = { ...first, metadata: { user_id: "legacy-image-" + capability } }
    const before = logs().filter(event => event.type === "user").length
    const rejected = await callFetch(body)
    const error = await rejected.json()
    check(`image capability ${capability} returns HTTP 400 before streaming`, rejected.status === 400 && error.error?.message.includes("image-capable"))
    check(`image capability ${capability} sends no model prompt`, logs().filter(event => event.type === "user").length === before)
    const textResponse = await callFetch({ ...body, messages: [{ role: "user", content: "legacy text still works " + capability }] })
    check(`image capability ${capability} still allows text`, stopOf((await readSSE(textResponse)).events) === "end_turn")
    delete process.env.FAKE_AGY_IMAGES
  }

  const invalid = [
    { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
    { ...image, source: { ...image.source, data: "" } },
    { ...image, source: { ...image.source, data: "not base64!" } },
    { ...image, source: { ...image.source, media_type: "application/pdf" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } },
  ]
  const before = inits().length
  for (const block of invalid) {
    const rejected = await callFetch({ model, messages: [{ role: "user", content: [block] }] })
    check(`invalid ${block.type} source ${block.source.type}/${block.source.media_type || "URL"} returns HTTP 400`, rejected.status === 400)
    await rejected.text()
  }
  check("invalid image and document inputs start no agy process", inits().length === before)
}

{
  const before = inits().length
  const firstBody = { model, messages: [{ role: "user", content: "stable tools" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const convId = inits().at(-1).convId
  const secondBody = {
    ...nextTurn(firstBody, firstEvents, "still stable"),
    tools: [echoTool, { name: "other", description: "Other", input_schema: { type: "object" } }],
  }
  const secondEvents = (await readSSE(await callFetch(secondBody))).events
  check("changed tool definitions keep the live session", inits().length === before + 1 && stopOf(secondEvents) === "end_turn")
  check("changed tool definitions reach agy through list_changed", logs().some(event => event.type === "toolsList" && event.reason === "list_changed" && event.convId === convId && event.tools.includes("other")))
  check("tool change sends no history replay", lastOf("user").text === "still stable")
}

{
  process.env.FAKE_AGY_TOOL_LIST_TIMEOUTS = "1"
  process.env.AGY_BRIDGE_TOOL_LIST_WAIT_MS = "150"
  try {
    const first = { model, messages: [{ role: "user", content: "catalog timeout setup" }], tools: [echoTool] }
    const firstEvents = (await readSSE(await callFetch(first))).events
    const convId = inits().at(-1)?.convId
    const second = {
      ...nextTurn(first, firstEvents, "catalog change must wait"),
      tools: [echoTool, { name: "timeout_other", input_schema: { type: "object" } }],
    }
    const promptCount = () => logs().filter(event => event.type === "user" && event.text === "catalog change must wait").length
    const failed = await callFetch(second)
    const payload = await failed.json()
    check("an unconfirmed tools/list_changed fails explicitly before prompt",
      failed.status === 503 && payload.error?.code === "tool_list_unconfirmed" &&
      payload.error?.message?.includes("no prompt was sent") && promptCount() === 0,
      JSON.stringify({ status: failed.status, payload, prompts: promptCount() }))
    check("the fake really withheld one changed-tool confirmation",
      logs().filter(event => event.type === "toolsListTimeout" && event.convId === convId).length === 1)
    const retried = await callFetch(second)
    const events = (await readSSE(retried)).events
    check("the identical prompt retries after catalog confirmation",
      retried.status === 200 && stopOf(events) === "end_turn" && promptCount() === 1 && lastOf("user").convId === convId,
      `status=${retried.status}, prompts=${promptCount()}`)
    check("retry performs the normal list_changed catalog refresh",
      logs().some(event => event.type === "toolsList" && event.reason === "list_changed" && event.convId === convId && event.tools.includes("timeout_other")))
  } finally {
    delete process.env.FAKE_AGY_TOOL_LIST_TIMEOUTS
    delete process.env.AGY_BRIDGE_TOOL_LIST_WAIT_MS
  }
}

{
  const firstBody = { model, messages: [{ role: "user", content: "MODEL switching" }] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const convId = inits().at(-1).convId
  const before = inits().length
  const secondEvents = (await readSSE(await callFetch({ ...nextTurn(firstBody, firstEvents, "MODEL after switch"), model: legacyModel }))).events
  const user = lastOf("user")
  check("model change switches inside the live session", inits().length === before && user.convId === convId && user.model === "gemini-test-low" && stopOf(secondEvents) === "end_turn")
}

for (const change of ["tools", "model"]) {
  const first = { model, messages: [{ role: "user", content: `TOOL live configuration ${change}` }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const old = inits().at(-1)
  const second = continuation(first, events, "completed-before-change")
  if (change === "tools") {
    second.tools = [...second.tools, { name: "other", input_schema: { type: "object" } }]
    second.messages.push({ role: "user", content: [{ type: "text", text: "<system-update>tool catalog changed</system-update>" }] })
  } else second.model = legacyModel
  const final = (await readSSE(await callFetch(second))).events
  const delivered = logs().filter(event => event.type === "mcpResult" && event.convId === old.convId).at(-1)
  check(`live ${change} change continues the pending turn`, stopOf(final) === "end_turn" && inits().at(-1).convId === old.convId && delivered?.result?.content?.[0]?.text === "completed-before-change")
  if (change === "tools") {
    check("live tool change reaches agy", logs().some(event => event.type === "toolsList" && event.convId === old.convId && event.tools.includes("other")))
    check("system update reaches the pending MCP result", delivered?.result?.content?.some(part => part.text?.includes("tool catalog changed")))
  } else {
    const next = (await readSSE(await callFetch({ ...nextTurn(second, final, "MODEL next prompt"), model: legacyModel }))).events
    check("live model change applies to the next prompt", stopOf(next) === "end_turn" && lastOf("user").model === "gemini-test-low" && lastOf("user").convId === old.convId)
  }
}

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "PERMISSION for a built-in tool" }] })
  const { events } = await readSSE(response)
  const permission = lastOf("permission")
  check("built-in tool permission requests are denied", permission?.outcome?.outcome === "selected" && permission.outcome.optionId === "deny", JSON.stringify(permission))
  check("a denied built-in tool does not fail the turn", stopOf(events) === "end_turn")
}

{
  const opening = { model, messages: [{ role: "user", content: "before the upstream error" }] }
  const openingEvents = (await readSSE(await callFetch(opening))).events
  const before = inits().length
  const convId = inits().at(-1).convId
  const body = nextTurn(opening, openingEvents, "AGENTERROR upstream")
  const promptCount = () => logs().filter(event => event.type === "user" && event.text.includes("AGENTERROR upstream")).length
  const { events } = await readSSE(await callFetch(body))
  const error = events.find(event => event.event === "error")?.data?.error
  check("agy's in-band failure becomes an error frame", error?.message?.includes("fake upstream failure"), JSON.stringify(error))
  check("error marker text is not streamed as content", textOf(events) === "partial before failure", JSON.stringify(textOf(events)))
  const retryResponse = await callFetch(body)
  const retryError = await retryResponse.json()
  check("retry after an upstream error returns outcome_unknown without another prompt",
    retryResponse.status === 409 && retryResponse.headers.get("x-should-retry") === "false" &&
    retryError.error?.code === "prompt_outcome_unknown" && promptCount() === 1 && inits().length === before,
    JSON.stringify({ status: retryResponse.status, error: retryError, prompts: promptCount() }))
  const nonstreamRetry = await callFetch({ ...body, stream: false })
  const nonstreamError = await nonstreamRetry.json()
  check("streaming and non-streaming retries share the submitted-prompt record",
    nonstreamRetry.status === 409 && nonstreamError.error?.code === "prompt_outcome_unknown" && promptCount() === 1)

  const changedPrompt = { ...body, messages: [...body.messages] }
  changedPrompt.messages[changedPrompt.messages.length - 1] = { role: "user", content: "a different prompt after the upstream failure" }
  const changedResponse = await callFetch(changedPrompt)
  const changedEvents = (await readSSE(changedResponse)).events
  check("a different current prompt is not swallowed by prompt dedupe",
    changedResponse.status === 200 && stopOf(changedEvents) === "end_turn" &&
    lastOf("user").convId === convId && lastOf("user").text === "a different prompt after the upstream failure" && promptCount() === 1)

  const changedHistory = { ...body, messages: [...body.messages] }
  changedHistory.messages[1] = { role: "assistant", content: [{ type: "text", text: "an edited prior answer" }] }
  const changedHistoryEvents = (await readSSE(await callFetch(changedHistory))).events
  check("the same current prompt with different base history is not deduped",
    promptCount() === 2 && changedHistoryEvents.some(event => event.event === "error"), `prompts=${promptCount()}`)
}

{
  const body = { model, stream: false, messages: [{ role: "user", content: "AGENTERROR nonstream origin" }] }
  const failed = await callFetch(body)
  await failed.json()
  const promptCount = () => logs().filter(event => event.type === "user" && event.text === "AGENTERROR nonstream origin").length
  const retry = await callFetch({ ...body, stream: true })
  const error = await retry.json()
  check("a non-streaming failure also blocks its streaming retry without resending",
    failed.status === 502 && retry.status === 409 && error.error?.code === "prompt_outcome_unknown" && promptCount() === 1,
    JSON.stringify({ first: failed.status, retry: retry.status, prompts: promptCount() }))
}

{
  const { events } = await readSSE(await callFetch({ model, messages: [{ role: "user", content: "QUOTA exhausted" }] }))
  const error = events.find(event => event.event === "error")?.data?.error
  check("split error marker and quota map to rate_limit_error", error?.type === "rate_limit_error" && error.message.includes("quota exhausted") && textOf(events) === "", JSON.stringify({ error, text: textOf(events) }))
}

{
  const streamBody = { model, messages: [{ role: "user", content: "GENERIC429 streaming" }] }
  const { events } = await readSSE(await callFetch(streamBody))
  const error = events.find(event => event.event === "error")?.data?.error
  check("unspecified resource exhaustion is not presented as confirmed quota exhaustion",
    error?.type === "rate_limit_error" && error?.code === "AGY_ERROR_RESOURCE_EXHAUSTED_UNSPECIFIED" &&
    error?.retryable === false && error.message.includes("quota exhaustion is not confirmed"), JSON.stringify(error))

  const response = await callFetch({ model, stream: false, messages: [{ role: "user", content: "GENERIC429 nonstream" }] })
  const payload = await response.json()
  check("nonstream generic 429 carries an explicit no-retry contract",
    response.status === 429 && response.headers.get("x-should-retry") === "false" &&
    payload.error?.code === "AGY_ERROR_RESOURCE_EXHAUSTED_UNSPECIFIED" && payload.error?.retryable === false,
    JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers), payload }))
}

{
  process.env.AGY_BRIDGE_START_TIMEOUT_MS = "40"
  process.env.FAKE_AGY_INIT_MODE = "slow"
  const response = await callFetch({ model, messages: [{ role: "user", content: "slow init" }] })
  const payload = await response.json()
  check("startup timeout is configurable", response.status === 502 && payload.error?.message?.includes("after 40ms"), `got ${response.status}: ${payload.error?.message}`)
  delete process.env.AGY_BRIDGE_START_TIMEOUT_MS
  delete process.env.FAKE_AGY_INIT_MODE
}

{
  process.env.FAKE_AGY_INIT_MODE = "early-error"
  const response = await callFetch({ model, messages: [{ role: "user", content: "early init failure" }] })
  const payload = await response.json()
  check("session start failure reports the actual agy error", response.status === 502 && payload.error?.message?.includes("Eligibility check failed: test EOF"), `got ${response.status}: ${payload.error?.message}`)
  delete process.env.FAKE_AGY_INIT_MODE
}

{
  process.env.FAKE_AGY_INIT_MODE = "slow"
  process.env.FAKE_AGY_SET_MODEL_DELAY = "150"
  const body = { model, messages: [{ role: "user", content: "cancel during startup before prompt" }] }
  const aborter = new AbortController()
  const timer = setTimeout(() => aborter.abort(new Error("client left during startup")), 50)
  await callFetch(body, {}, aborter.signal)
  clearTimeout(timer)
  delete process.env.FAKE_AGY_INIT_MODE
  delete process.env.FAKE_AGY_SET_MODEL_DELAY
  const init = inits().at(-1)
  check("startup cancellation never submits a late prompt and removes its workspace",
    !logs().some(event => event.type === "user" && event.text === body.messages[0].content) && !fs.existsSync(init.cwd))
  const { events } = await readSSE(await callFetch(body))
  check("startup cancellation releases the unsubmitted claim for safe retry", stopOf(events) === "end_turn" &&
    logs().filter(event => event.type === "user" && event.text === body.messages[0].content).length === 1)
}

// A hung upstream must remain observable without letting its title/status
// updates (or our downstream heartbeats) keep it alive indefinitely.
for (const mode of ["IDLE_SILENT", "IDLE_METADATA"]) {
  const body = { model: "gemini-4-argon", messages: [{ role: "user", content: mode }], stream: true }
  const aborter = new AbortController()
  const watchdog = setTimeout(() => aborter.abort(new Error("timeout regression watchdog")), 8000)
  const started = Date.now()
  const response = await callFetch(body, {}, aborter.signal)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ""
  try {
    const first = await reader.read()
    raw += decoder.decode(first.value)
    const firstEvents = (await readSSE(new Response(raw))).events
    check(`${mode}: lifecycle arrives before any upstream content`, Date.now() - started < 1500 &&
      firstEvents[0]?.event === "message_start" && firstEvents[0].data.message.content.length === 0)
    const second = await reader.read()
    raw += decoder.decode(second.value)
    check(`${mode}: a valid Anthropic heartbeat arrives during silence`, Date.now() - started < 1500 &&
      (await readSSE(new Response(raw))).events.some(event => event.event === "ping" && event.data.type === "ping"))
    const duplicate = await callFetch(body)
    check(`${mode}: concurrent duplicate is held while upstream runs`, duplicate.status === 503)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    check(`${mode}: stream finishes without the regression watchdog`, false, error.message)
  } finally {
    clearTimeout(watchdog)
    reader.releaseLock()
  }
  const elapsed = Date.now() - started
  const { events } = await readSSE(new Response(raw))
  const failure = events.find(event => event.event === "error")?.data.error
  check(`${mode}: inactivity is bounded despite heartbeat/metadata`, elapsed >= 4500 && elapsed < 7500 &&
    failure?.code === "upstream_idle_timeout", `${elapsed}ms ${JSON.stringify(failure)}`)
  check(`${mode}: error identifies chosen effort and safe recovery`, failure?.retryable === false &&
    failure.message.includes("effort=medium") && failure.message.includes("AGY_BRIDGE_TURN_TIMEOUT_MS") &&
    failure.message.includes("outcome is unknown"))
  check(`${mode}: error is terminal, with no invented answer`, events.at(-1)?.event === "error" &&
    !events.some(event => ["content_block_start", "message_stop"].includes(event.event)))
  const user = logs().find(event => event.type === "user" && event.text === mode)
  const init = inits().find(event => event.convId === user?.convId)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  check(`${mode}: ACP, helper and workspace are cleaned`, init && !fs.existsSync(init.cwd) &&
    !alive(init.pid) && !alive(init.mcpPid))
  if (mode === "IDLE_METADATA") {
    const child = logs().find(event => event.type === "idleChild" && event.convId === user?.convId)
    check("timeout also reaps an owned descendant that ignores SIGTERM", child?.pid && !alive(child.pid))
  }
  if (mode === "IDLE_METADATA") check("fake ACP repeatedly emitted metadata throughout the wait",
    logs().filter(event => event.type === "idleMetadata" && event.convId === user?.convId).length >= 20)
  const retry = await callFetch(body)
  const retryError = await retry.json()
  check(`${mode}: completed timeout leaves an uncertain-outcome guard, not a busy claim`, retry.status === 409 &&
    retryError.error?.code === "prompt_outcome_unknown" && retry.headers.get("x-should-retry") === "false" &&
    logs().filter(event => event.type === "user" && event.text === mode).length === 1)
}

{
  const body = { model: "gemini-4-argon-high", messages: [{ role: "user", content: "IDLE_SILENT nonstream" }], stream: false }
  const response = await callFetch(body, {}, AbortSignal.timeout(8000))
  const payload = await response.json()
  check("nonstream timeout returns HTTP 504 and non-retryable diagnostics", response.status === 504 &&
    response.headers.get("x-should-retry") === "false" && payload.error?.code === "upstream_idle_timeout" &&
    payload.error.retryable === false && payload.error.message.includes("effort=high"))
}

{
  const started = Date.now()
  const body = { model: "gemini-4-argon", messages: [{ role: "user", content: "IDLE_PROGRESS" }], thinking: { type: "disabled" } }
  const { events } = await readSSE(await callFetch(body, {}, AbortSignal.timeout(9000)))
  check("real thought progress renews inactivity even when thought forwarding is disabled", Date.now() - started > 5000 &&
    stopOf(events) === "end_turn" && textOf(events) === "progress completed" && !events.some(event => event.event === "error"))
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL timeout" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const init = inits().at(-1)
  await new Promise(resolve => setTimeout(resolve, 1200))
  const secondBody = continuation(firstBody, firstEvents, "too late")
  const { events } = await readSSE(await callFetch(secondBody))
  const error = events.find(event => event.event === "error")?.data?.error?.message || ""
  check("missing client result times out explicitly", error.includes("timed out waiting for a client tool result"), error)
  check("timed-out process workspace is removed", !fs.existsSync(init.cwd), init.cwd)
}

{
  const body = { model, messages: [{ role: "user", content: "DELAY_BEFORE_TOOL" }], tools: [echoTool] }
  const { events } = await readSSE(await callFetch(body))
  const final = (await readSSE(await callFetch(continuation(body, events, "delayed-tool-result")))).events
  check("a new client tool wait gets its own budget after slow model output", toolCalls(events).length === 1 &&
    stopOf(final) === "end_turn" && lastOf("mcpResult")?.result?.content?.[0]?.text === "delayed-tool-result")
}

{
  process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = "150"
  const firstBody = { model, messages: [{ role: "user", content: "LONGTOOL build" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const convId = inits().at(-1).convId
  check("long tool reaches the client once", toolCalls(firstEvents).length === 1 && stopOf(firstEvents) === "tool_use")
  await new Promise(resolve => setTimeout(resolve, 500))
  const { events } = await readSSE(await callFetch(continuation(firstBody, firstEvents, "long-result")))
  const done = logs().find(event => event.type === "longDone" && event.convId === convId)
  check("a tool past agy's MCP deadline is awaited by repeating the call", stopOf(events) === "end_turn" && done?.text === "long-result" && done.rounds >= 1, JSON.stringify(done))
  check("the repeated call never reaches the client again", !toolCalls(events).length && textOf(events).includes("Long done: long-result"))

  const quitBody = { model, messages: [{ role: "user", content: "LONGQUIT build" }], tools: [echoTool] }
  const quitEvents = (await readSSE(await callFetch(quitBody))).events
  await new Promise(resolve => setTimeout(resolve, 400))
  const quitFinal = (await readSSE(await callFetch(continuation(quitBody, quitEvents, "late-output")))).events
  check("a result agy stopped waiting for is delivered in a follow-up prompt", stopOf(quitFinal) === "end_turn" && textOf(quitFinal).includes("Late result seen: late-output"), textOf(quitFinal))

  const renamedLongBody = { model, messages: [{ role: "user", content: "LONGTOOL renamed id" }], tools: [echoTool] }
  const renamedLongEvents = (await readSSE(await callFetch(renamedLongBody))).events
  await new Promise(resolve => setTimeout(resolve, 350))
  const renamedLongCont = continuation(renamedLongBody, renamedLongEvents, "renamed-long-result")
  renamedLongCont.messages[1].content.find(block => block.type === "tool_use").id = "toolu_client_rewritten_long"
  renamedLongCont.messages[2].content[0].tool_use_id = "toolu_client_rewritten_long"
  const renamedLongRes = await callFetch(renamedLongCont)
  const renamedLongFinal = (await readSSE(renamedLongRes)).events
  check("deferred long tool past deadline still matches client-renamed tool IDs without 409",
    renamedLongRes.status === 200 && stopOf(renamedLongFinal) === "end_turn" && textOf(renamedLongFinal).includes("Long done: renamed-long-result"),
    `status=${renamedLongRes.status} text=${textOf(renamedLongFinal)}`)
  delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
}

for (const mode of ["LONGTOOL", "LONGQUIT"]) {
  for (const marker of ["", "[Request interrupted by user]\n"]) {
    process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = "150"
    const first = { model, messages: [{ role: "user", content: `${mode} deferred steering ${!!marker}` }], tools: [echoTool] }
    const pending = (await readSSE(await callFetch(first))).events
    const session = inits().at(-1)
    await new Promise(resolve => setTimeout(resolve, 400))
    const second = continuation(first, pending, "DEFERRED-RESULT-731")
    second.messages.push({ role: "user", content: marker + "Use the real result and follow NEW-INSTRUCTION-942." })
    const response = await callFetch(second)
    const final = (await readSSE(response)).events
    const prompts = logs().filter(event => event.type === "user" && event.convId === session.convId)
    check(`${mode}/${!!marker}: deferred steering keeps the original session`, response.status === 200 &&
      stopOf(final) === "end_turn" && inits().at(-1).convId === session.convId && prompts.length === 2)
    check(`${mode}/${!!marker}: deferred steering preserves the result and new instruction once`,
      (prompts.at(-1).text.split("DEFERRED-RESULT-731").length - 1 + logs().filter(event =>
        event.type === "mcpResult" && event.convId === session.convId && JSON.stringify(event.result).includes("DEFERRED-RESULT-731")).length) === 1 &&
      prompts.at(-1).text.includes("NEW-INSTRUCTION-942") && !prompts.at(-1).text.includes("<conversation_history>") &&
      !toolCalls(final).length)
    const follow = nextTurn(second, final, "MEMORY after deferred steering")
    const resumed = (await readSSE(await callFetch(follow))).events
    check(`${mode}/${!!marker}: follow-up keeps the steered session`, stopOf(resumed) === "end_turn" &&
      lastOf("user").convId === session.convId && lastOf("user").text === "MEMORY after deferred steering")
    delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
  }
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL extra text" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const beforeResult = continuation(firstBody, firstEvents, "result")
  beforeResult.messages.at(-1).content.unshift({ type: "text", text: "<task-notification>too early</task-notification>" })
  const systemBeforeResult = continuation(firstBody, firstEvents, "result")
  systemBeforeResult.messages.at(-1).content.unshift({ type: "text", text: "<system-update>too early</system-update>" })
  const unclosedSystem = continuation(firstBody, firstEvents, "result")
  unclosedSystem.messages.at(-1).content.push({ type: "text", text: "<system-update>not a complete protocol notice" })
  const rejected = await Promise.all([beforeResult, systemBeforeResult, unclosedSystem].map(body => callFetch(body)))
  check("malformed or pre-result notices return 400", rejected.every(response => response.status === 400), rejected.map(response => response.status).join(","))
  const validBody = continuation(firstBody, firstEvents, "result")
  const validEvents = (await readSSE(await callFetch(validBody))).events
  check("valid result can continue after rejected extra text", stopOf(validEvents) === "end_turn")
}

for (const [index, text] of [
  "Please explain the result before continuing",
  "PreToolUse:Read hook additional context: hook output\n\nThe user sent a new message while you were working:\nstop now",
  "<system-update>catalog changed</system-update>\n\nordinary user instruction",
  "Follow-up with notice\n<task-notification>background completed</task-notification>",
].entries()) {
  for (const before of index === 0 ? [false, true] : [false]) {
    const first = { model, metadata: { user_id: `merged-followup-${index}-${before}` },
      messages: [{ role: "user", content: "ESCCALL merged follow-up" }], tools: [echoTool] }
    const pending = (await readSSE(await callFetch(first))).events
    const old = inits().at(-1)
    const body = continuation(first, pending, "real merged output")
    body.messages.at(-1).content[before ? "unshift" : "push"]({ type: "text", text })
    const response = await callFetch(body)
    if (response.status === 200) await readSSE(response)
    else await response.text()
    check(`merged follow-up ${index}/${before} retains the session and sends user text as a new prompt`, response.status === 200 &&
      lastOf("user").convId === old.convId && lastOf("user").text.includes(text) &&
      !lastOf("user").text.includes("real merged output") && !lastOf("user").text.includes("<conversation_history>"))
    check(`merged follow-up ${index}/${before} delivers the actual result once`, logs().filter(event =>
      event.type === "mcpResult" && event.convId === old.convId && JSON.stringify(event.result).includes("real merged output")).length === 1)
    check(`merged follow-up ${index}/${before} never injects user text into MCP`, !logs().some(event =>
      event.type === "mcpResult" && event.convId === old.convId && JSON.stringify(event.result).includes(text)))
  }
}

for (const location of ["inline", "system", "developer", "user"]) {
  const first = { model, messages: [{ role: "user", content: `TOOL task notice ${location}` }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const second = continuation(first, events, "real tool output")
  const notice = { type: "text", text: "<system-reminder>[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>job-7</task-id><summary>subagent finished</summary></task-notification>\n<task-notification><task-id>job-8</task-id><summary>another subagent finished</summary></task-notification></system-reminder>" }
  second.messages.at(-1).content.push(
    { type: "text", text: "<total_tokens>12345</total_tokens>" },
    { type: "text", text: "PreToolUse:Read hook success: Success" },
    { type: "text", text: "PreToolUse:Read hook additional context: hook-only-output" },
  )
  if (location === "inline") second.messages.at(-1).content.push(notice)
  else second.messages.push({ role: location, content: [notice] })
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  check(`${location} task notification continues the live turn`, response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  const delivered = logs().find(event => event.type === "mcpResult" && event.convId === convId)
  const content = delivered?.result?.content?.map(part => part.text).join("\n") || ""
  check(`${location} task notifications and hook context reach MCP without token/boilerplate noise`, content.startsWith("real tool output") && content.includes("<system-reminder>") && content.includes("job-7") && content.includes("job-8") && content.includes("hook-only-output") && !content.includes("12345") && !content.includes("hook success: Success"), content)
  check(`${location} task notification does not add an agy prompt`, logs().filter(event => event.type === "user" && event.convId === convId).length === 1)
  if (response.status !== 200) await drive(first, events, "cleanup")
}

for (const location of ["inline", "system", "developer", "user"]) {
  const first = { model, messages: [{ role: "user", content: `TOOL system update ${location}` }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const second = continuation(first, events, "real tool output")
  const updates = [
    { type: "text", text: "<system-update>\nThe Code Mode tool catalog has changed.\ncatalog-alpha\n</system-update>" },
    { type: "text", text: "<system-update>catalog-beta</system-update>\n<task-notification><task-id>job-9</task-id></task-notification>" },
  ]
  second.messages.at(-1).content.push({ type: "text", text: "<total_tokens>12345</total_tokens>" })
  if (location === "inline") second.messages.at(-1).content.push(...updates)
  else second.messages.push({ role: location, content: location === "user" ? updates.map(block => block.text).join("\n") : updates })
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  check(`${location} system update continues the live turn`, response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  const delivered = logs().find(event => event.type === "mcpResult" && event.convId === convId)
  const content = delivered?.result?.content?.map(part => part.text).join("\n") || ""
  check(`${location} system updates reach MCP with other protocol notices`, content.startsWith("real tool output") && content.includes("<system-reminder>") && content.includes("catalog-alpha") && content.includes("catalog-beta") && content.includes("job-9") && !content.includes("12345"), content)
  check(`${location} system update does not add an agy prompt`, logs().filter(event => event.type === "user" && event.convId === convId).length === 1)
  if (response.status !== 200) await drive(first, events, "cleanup")
}

{
  const before = inits().length
  const body = { model, messages: [{ role: "user", content: "SLOW cancellation" }] }
  const responses = await Promise.all([callFetch(body), callFetch(body)])
  const response = responses.find(item => item.status === 200)
  check("simultaneous startup allows only one live response", responses.filter(item => item.status === 200).length === 1 && responses.some(item => item.status === 503), responses.map(item => item.status).join(","))
  check("simultaneous startup cannot overwrite the pool", inits().length === before + 1)
  const init = inits().at(-1)
  const reader = response.body.getReader()
  let seen = ""
  while (!seen.includes("partial slow answer")) {
    const { value, done } = await reader.read()
    if (done) break
    seen += new TextDecoder().decode(value)
  }
  await reader.cancel()
  await new Promise(resolve => setTimeout(resolve, 200))
  check("cancellation sends session/cancel instead of killing agy", lastOf("cancel")?.convId === init.convId && lastOf("cancelled")?.convId === init.convId && fs.existsSync(init.cwd))
  const cancelledRetry = await callFetch(body)
  const cancelledError = await cancelledRetry.json()
  check("retrying a cancelled submitted prompt does not send it again",
    cancelledRetry.status === 409 && cancelledError.error?.code === "prompt_outcome_unknown" &&
    logs().filter(event => event.type === "user" && event.text === "SLOW cancellation").length === 1)
  const next = {
    ...body,
    messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "partial slow answer" }] }, { role: "user", content: "after cancel" }],
  }
  const { events } = await readSSE(await callFetch(next))
  check("conversation continues in the cancelled session", stopOf(events) === "end_turn" && lastOf("user").convId === init.convId && lastOf("user").text === "after cancel" && inits().length === before + 1)
}

{
  const first = { model, messages: [{ role: "user", content: "before an early cancel" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  process.env.FAKE_AGY_SET_MODEL_DELAY = "300"
  const controller = new AbortController()
  const early = nextTurn(first, firstEvents, "EARLY message that was cancelled")
  const response = await callFetch({ ...early, model: legacyModel }, {}, controller.signal)
  controller.abort()
  await readSSE(response)
  await new Promise(resolve => setTimeout(resolve, 500))
  delete process.env.FAKE_AGY_SET_MODEL_DELAY
  check("a cancel before the prompt sends no prompt", !logs().some(event => event.type === "user" && event.text.includes("EARLY")))
  const after = { ...early, model: legacyModel, messages: [...early.messages, { role: "user", content: "message after the early cancel" }] }
  const { events } = await readSSE(await callFetch(after))
  const user = lastOf("user")
  check("the undelivered message reaches agy with the next one", stopOf(events) === "end_turn" && user.convId === convId && user.text.includes("EARLY message that was cancelled") && user.text.includes("message after the early cancel"), JSON.stringify(user))
}

{
  // Evict a live conversation through the four-process LRU, then continue it.
  const first = { model, messages: [{ role: "user", content: "MEMORY resume target" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const target = inits().at(-1)
  for (let index = 0; index < 4; index++) {
    await readSSE(await callFetch({ model, messages: [{ role: "user", content: `filler conversation ${index}` }] }))
  }
  check("LRU eviction stops the idle process", !fs.existsSync(target.cwd))
  const second = nextTurn(first, firstEvents, "MEMORY after eviction")
  const { events } = await readSSE(await callFetch(second))
  const resumed = inits().at(-1)
  check("an evicted conversation resumes its agy session", resumed.resumed === true && resumed.convId === target.convId, JSON.stringify(resumed))
  check("resume sends only the new message, not a history replay", lastOf("user").text === "MEMORY after eviction" && textOf(events).includes("prompts so far 2"), textOf(events))
}

{
  // A restarted bridge (fresh module state) resumes a conversation from the state file.
  const first = { model, system: "RESTART-SYSTEM-MARKER", messages: [{ role: "user", content: "MEMORY before restart" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const target = inits().at(-1)
  const stored = fs.readFileSync(bridgeStateFile, "utf8")
  check("session state is written after a completed turn", stored.includes(target.convId))
  check("session state stores hashes, not conversation text", !stored.includes("MEMORY before restart") && !stored.includes("RESTART-SYSTEM-MARKER"))
  check("session state file is private", (fs.statSync(bridgeStateFile).mode & 0o077) === 0)
  const { default: restartedDefault } = await import("./index.mjs?restart")
  const restarted = await restartedDefault.server({ client: null, directory: os.tmpdir() }, {})
  const restartedLoader = await restarted.auth.loader(async () => ({ key: "agy" }))
  const before = inits().length
  const response = await restartedLoader.fetch("agy://local/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextTurn(first, firstEvents, "MEMORY after restart")),
  })
  const { events } = await readSSE(response)
  const resumed = inits().at(-1)
  check("a restarted bridge resumes the agy session", inits().length === before + 1 && resumed.resumed === true && resumed.convId === target.convId, JSON.stringify(resumed))
  check("the restart sends only the new message", lastOf("user").text === "MEMORY after restart" && textOf(events).includes("prompts so far 2"), textOf(events))
  const edited = { ...first, messages: [{ role: "user", content: "MEMORY edited history" }, ...nextTurn(first, firstEvents, "x").messages.slice(1)] }
  const { default: againDefault } = await import("./index.mjs?restart-2")
  const again = await (await againDefault.server({ client: null, directory: os.tmpdir() }, {})).auth.loader(async () => ({ key: "agy" }))
  await readSSE(await again.fetch("agy://local/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edited) }))
  check("a changed history is not resumed", inits().at(-1).resumed === false)

  const crashFirst = { model, messages: [{ role: "user", content: "MEMORY before mid-turn crash" }] }
  const crashFirstEvents = (await readSSE(await callFetch(crashFirst))).events
  const crashTarget = inits().at(-1)
  check("completed turn parks session before crash test", fs.readFileSync(bridgeStateFile, "utf8").includes(crashTarget.convId))
  const crashBody = nextTurn(crashFirst, crashFirstEvents, "DIE mid-turn crash")
  await readSSE(await callFetch(crashBody))
  check("in-flight prompt crash removes stale pre-turn snapshot from state file", !fs.readFileSync(bridgeStateFile, "utf8").includes(crashTarget.convId))
  const crashRetry = await callFetch(crashBody)
  const crashError = await crashRetry.json()
  check("an agy process death cannot cause the same prompt to be sent again",
    crashRetry.status === 409 && crashError.error?.code === "prompt_outcome_unknown" &&
    logs().filter(event => event.type === "user" && event.text.includes("DIE mid-turn crash")).length === 1)
}

{
  const first = { model, system: "CONSECUTIVE-RESUME-SYSTEM", messages: [{ role: "user", content: "MEMORY append installed on new" }] }
  let previous = first
  let events = (await readSSE(await callFetch(first))).events
  const target = inits().at(-1)
  check("the initial session/new installs the system append", target.resumed === false && target.systemAppend?.includes("CONSECUTIVE-RESUME-SYSTEM"))
  for (const round of [1, 2]) {
    const { default: resumedDefault } = await import(`./index.mjs?consecutive-resume-${round}`)
    const resumedLoader = await (await resumedDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
    previous = nextTurn(previous, events, `MEMORY consecutive resume ${round}`)
    const response = await resumedLoader.fetch("agy://local/messages", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(previous),
    })
    events = (await readSSE(response)).events
    check(`consecutive resume ${round} reuses the official session without replaying instructions`,
      response.status === 200 && stopOf(events) === "end_turn" && inits().at(-1)?.resumed === true &&
      inits().at(-1)?.convId === target.convId && lastOf("user").text === `MEMORY consecutive resume ${round}` &&
      !lastOf("user").text.includes("CONSECUTIVE-RESUME-SYSTEM"))
  }
  const related = inits().filter(event => event.convId === target.convId)
  check("system append appears only on new across consecutive resumes",
    related.length === 3 && related.filter(event => event.resumed).length === 2 &&
    related.filter(event => event.resumed).every(event => event.systemAppend === null),
    JSON.stringify(related.map(event => ({ resumed: event.resumed, append: event.systemAppend }))))
}

{
  const cases = []
  for (const mode of ["permission", "model"]) {
    const first = { model, system: `ATOMIC-RESUME-${mode}`, messages: [{ role: "user", content: `MEMORY before ${mode} resume failure` }] }
    const firstEvents = (await readSSE(await callFetch(first))).events
    cases.push({ mode, target: inits().at(-1), request: nextTurn(first, firstEvents, `MEMORY after ${mode} resume failure`) })
  }
  const { default: atomicDefault } = await import("./index.mjs?atomic-resume")
  const atomicLoader = await (await atomicDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  for (const { mode, target, request } of cases) {
    const fetchRetry = () => atomicLoader.fetch("agy://local/messages", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    })
    const newCount = () => inits().filter(event => !event.resumed).length
    const beforeNew = newCount()
    if (mode === "permission") process.env.FAKE_AGY_RESUME_ERROR = "permission"
    else process.env.FAKE_AGY_CONFIG = "error"
    const failed = await fetchRetry()
    const payload = await failed.json()
    delete process.env.FAKE_AGY_RESUME_ERROR
    delete process.env.FAKE_AGY_CONFIG
    check(`${mode} resume/startup failure is surfaced instead of creating a new session`,
      (mode === "permission" ? failed.status === 502 && payload.error?.message?.includes("Permission denied")
        : failed.status === 400 && payload.error?.message?.includes("Configuration rejected")) && newCount() === beforeNew,
      JSON.stringify({ status: failed.status, payload, beforeNew, afterNew: newCount() }))
    check(`${mode} failure restores the durable resume snapshot`,
      fs.readFileSync(bridgeStateFile, "utf8").includes(target.convId) &&
      !logs().some(event => event.type === "user" && event.text === `MEMORY after ${mode} resume failure`))
    const retried = await fetchRetry()
    const events = (await readSSE(retried)).events
    check(`${mode} failure can retry the same prompt and resume the old session`,
      retried.status === 200 && stopOf(events) === "end_turn" && inits().at(-1)?.resumed === true &&
      inits().at(-1)?.convId === target.convId && newCount() === beforeNew && textOf(events).includes("prompts so far 2"),
      `status=${retried.status}, text=${textOf(events)}`)
  }
}

{
  const first = { model, system: "RESUME-METHOD-FALLBACK", messages: [{ role: "user", content: "before unsupported resume" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const target = inits().at(-1)
  const { default: fallbackDefault } = await import("./index.mjs?resume-method-fallback")
  const fallbackLoader = await (await fallbackDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  process.env.FAKE_AGY_RESUME_ERROR = "method"
  const response = await fallbackLoader.fetch("agy://local/messages", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nextTurn(first, firstEvents, "after unsupported resume")),
  })
  delete process.env.FAKE_AGY_RESUME_ERROR
  const events = (await readSSE(response)).events
  check("method-not-supported resume explicitly falls back to session/new",
    response.status === 200 && stopOf(events) === "end_turn" && inits().at(-1)?.resumed === false && inits().at(-1)?.convId !== target.convId)
  check("the fallback new session installs instructions exactly once",
    inits().at(-1)?.systemAppend?.includes("RESUME-METHOD-FALLBACK") &&
    logs().filter(event => event.type === "resumeError" && event.convId === target.convId && event.mode === "method").length === 1)
}

{
  // Claude Code appends trailing role:"system" context messages on user and tool turns.
  const before = inits().length
  const turn1 = {
    model,
    system: "CLAUDE-CODE-SYSTEM",
    messages: [
      { role: "user", content: [{ type: "text", text: "MEMORY Claude Code turn one" }] },
      { role: "system", content: [{ type: "text", text: "SessionStart hook additional context: ok\n\n# Environment\n - Primary working directory: /remote-wsl/project" }] },
    ],
  }
  const r1 = await callFetch(turn1)
  const e1 = (await readSSE(r1)).events
  const init1 = inits().at(-1)
  const u1 = lastOf("user")
  check("trailing system message on fresh turn returns 200", r1.status === 200 && stopOf(e1) === "end_turn", `got ${r1.status}`)
  check("fresh turn sends both user text and wrapped system context",
    u1.text.includes("MEMORY Claude Code turn one") &&
    u1.text.includes("<system-reminder>\nSessionStart hook additional context: ok") &&
    !u1.text.includes("<conversation_history>"), u1.text)
  check("caller working directory is recognized from initial trailing system message",
    init1.systemAppend?.includes('"/remote-wsl/project"'), init1.systemAppend)

  const turn2 = {
    ...turn1,
    messages: [
      ...turn1.messages,
      { role: "assistant", content: assistantBlocks(e1) },
      { role: "user", content: [{ type: "text", text: "MEMORY Claude Code turn two" }] },
      { role: "system", content: [{ type: "text", text: "UserPromptSubmit hook additional context: route hint\n\nWorking directory: /other-later-dir" }] },
    ],
  }
  const r2 = await callFetch(turn2)
  const e2 = (await readSSE(r2)).events
  const u2 = lastOf("user")
  check("continued turn with trailing system message reuses the live session",
    r2.status === 200 && stopOf(e2) === "end_turn" && inits().length === before + 1 && u2.convId === init1.convId)
  check("continued turn preserves user text alongside trailing system message",
    u2.text.includes("MEMORY Claude Code turn two") &&
    u2.text.includes("<system-reminder>\nUserPromptSubmit hook additional context: route hint") &&
    textOf(e2).includes("prompts so far 2"), u2.text)

  const turn3 = {
    ...turn2,
    messages: [
      ...turn2.messages,
      { role: "assistant", content: assistantBlocks(e2) },
      { role: "system", content: [{ type: "text", text: "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>bg-42</task-id></task-notification>" }] },
    ],
  }
  const r3 = await callFetch(turn3)
  const e3 = (await readSSE(r3)).events
  check("post-assistant standalone system notification turn continues the session",
    r3.status === 200 && stopOf(e3) === "end_turn" && lastOf("user").convId === init1.convId && lastOf("user").text.includes("bg-42"))

  const { default: restartedAtisDefault } = await import("./index.mjs?restart-atis")
  const restartedAtis = await (await restartedAtisDefault.server({ client: null, directory: os.tmpdir() }, {})).auth.loader(async () => ({ key: "agy" }))
  const turn4 = {
    ...turn3,
    messages: [
      ...turn3.messages,
      { role: "assistant", content: assistantBlocks(e3) },
      { role: "user", content: "MEMORY Claude Code after restart" },
      { role: "system", content: "UserPromptSubmit hook additional context: after restart" },
    ],
  }
  const r4 = await restartedAtis.fetch("agy://local/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(turn4),
  })
  const e4 = (await readSSE(r4)).events
  const resumedAtis = inits().at(-1)
  check("restarted bridge resumes a conversation with trailing system messages",
    r4.status === 200 && stopOf(e4) === "end_turn" && resumedAtis.resumed === true && resumedAtis.convId === init1.convId &&
    lastOf("user").text.includes("MEMORY Claude Code after restart") && !lastOf("user").text.includes("<conversation_history>"))
}

{
  const opening = {
    model,
    messages: [
      { role: "user", content: "base before trailing-system cancel and error" },
      { role: "system", content: "SessionStart hook additional context: init" },
    ],
  }
  const openingEvents = (await readSSE(await callFetch(opening))).events
  const convId = inits().at(-1).convId

  process.env.FAKE_AGY_SET_MODEL_DELAY = "300"
  const controller = new AbortController()
  const early = {
    ...opening,
    model: legacyModel,
    messages: [
      ...opening.messages,
      { role: "assistant", content: assistantBlocks(openingEvents) },
      { role: "user", content: "EARLY user with trailing system" },
      { role: "system", content: "UserPromptSubmit hook additional context: early-system" },
    ],
  }
  const earlyResponse = await callFetch(early, {}, controller.signal)
  controller.abort()
  await readSSE(earlyResponse)
  await new Promise(resolve => setTimeout(resolve, 500))
  delete process.env.FAKE_AGY_SET_MODEL_DELAY

  const after = {
    ...early,
    messages: [
      ...early.messages,
      { role: "user", content: "NEXT user after cancel" },
      { role: "system", content: "UserPromptSubmit hook additional context: next-system" },
    ],
  }
  const afterEvents = (await readSSE(await callFetch(after))).events
  const deliveredPrompt = lastOf("user")
  check("early cancel preserves both cancelled and next user/system messages",
    stopOf(afterEvents) === "end_turn" && deliveredPrompt.convId === convId &&
    deliveredPrompt.text.includes("EARLY user with trailing system") &&
    deliveredPrompt.text.includes("early-system") &&
    deliveredPrompt.text.includes("NEXT user after cancel") &&
    deliveredPrompt.text.includes("next-system"), deliveredPrompt.text)

  const beforeErrorInits = inits().length
  const errBody = {
    ...opening,
    messages: [
      ...after.messages,
      { role: "assistant", content: assistantBlocks(afterEvents) },
      { role: "user", content: "AGENTERROR with trailing system" },
      { role: "system", content: "UserPromptSubmit hook additional context: retry-system" },
    ],
  }
  const errEvents = (await readSSE(await callFetch(errBody))).events
  check("upstream error on trailing-system turn emits error frame", errEvents.some(event => event.event === "error"))
  const errorPromptCount = () => logs().filter(event => event.type === "user" && event.convId === convId &&
    event.text.includes("AGENTERROR with trailing system")).length
  const retryResponse = await callFetch(errBody)
  const retryError = await retryResponse.json()
  check("trailing-system retry preserves its terminal error without another prompt",
    retryResponse.status === 409 && retryError.error?.code === "prompt_outcome_unknown" && errorPromptCount() === 1 &&
    inits().length === beforeErrorInits && lastOf("user").convId === convId &&
    lastOf("user").text.includes("AGENTERROR with trailing system") &&
    lastOf("user").text.includes("retry-system"))
}

{
  const first = {
    model,
    tools: [echoTool],
    messages: [
      { role: "user", content: "TOOL trailing system notices" },
      { role: "system", content: "# Environment\n - Primary working directory: /remote-wsl/project" },
    ],
  }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const before = inits().length

  const second = continuation(first, events, "real output")
  second.messages.at(-1).content.push({
    type: "text",
    text: "<system-reminder>Note: /remote-wsl/project/file.js changed on disk</system-reminder>",
  })
  second.messages.push({
    role: "system",
    content: [
      { type: "text", text: "SessionStart:startup hook success: Success" },
      { type: "text", text: "tool.call hook additional context: lowercase-hook-context" },
      { type: "text", text: "PostToolUse:Bash hook additional context: hook-head\n\n# Environment update\n - Primary working directory: /remote-wsl/project/subdir" },
      { type: "text", text: "The user hasn't heard from you in a while." },
    ],
  })
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  const delivered = logs().find(event => event.type === "mcpResult" && event.convId === convId)
  const mcpText = delivered?.result?.content?.map(part => part.text).join("\n") || ""
  check("system notices and mid-turn environment update continue the live tool turn",
    response.status === 200 && stopOf(final) === "end_turn" && inits().length === before, `got ${response.status}`)
  check("system notices and hook contexts reach MCP while empty hook success is excluded",
    mcpText.startsWith("real output") &&
    mcpText.includes("changed on disk") &&
    mcpText.includes("lowercase-hook-context") &&
    mcpText.includes("PostToolUse:Bash hook additional context: hook-head") &&
    mcpText.includes("# Environment update") &&
    mcpText.includes("hasn't heard from you") &&
    !mcpText.includes("hook success: Success"), mcpText)
}

{
  const prefillOnly = await callFetch({ model, messages: [{ role: "assistant", content: "prefill" }] })
  const prefillTail = await callFetch({ model, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "prefill" }] })
  const loneSystem = await callFetch({ model, messages: [{ role: "system", content: "system without user or history" }] })
  const nonTextSystem = await callFetch({
    model,
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "audio_chunk", data: "AAAA" }] },
    ],
  })
  const nonTextPayload = await nonTextSystem.json()
  check("assistant prefill and lone system messages return 400",
    prefillOnly.status === 400 && prefillTail.status === 400 && loneSystem.status === 400,
    `${prefillOnly.status},${prefillTail.status},${loneSystem.status}`)
  check("unsupported system content block error names the block type",
    nonTextSystem.status === 400 && nonTextPayload.error?.message?.includes('"audio_chunk"'),
    nonTextPayload.error?.message)
}

{
  // Claude Code Skill tool appends SKILL.md as a user text block beside tool_result.
  const skillTool = {
    name: "Skill",
    description: "Invoke a skill",
    input_schema: { type: "object", properties: { skill: { type: "string" } } },
  }
  const first = { model, messages: [{ role: "user", content: "SKILLCALL load archive skill" }], tools: [skillTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const before = inits().length
  const skillBody = [
    "Base directory for this skill: /root/.claude/skills/hengjian-chat-archive",
    "",
    "# Archive Skill",
    "Docs may quote `<system-reminder>` or `The user sent a new message while you were working:` literally.",
  ].join("\n")
  const second = continuation(first, events, "Launching skill: hengjian-chat-archive")
  second.messages.at(-1).content.push({ type: "text", text: skillBody })
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  const delivered = logs().filter(event => event.type === "mcpResult" && event.convId === convId).at(-1)
  const parts = delivered?.result?.content?.map(part => part.text) || []
  check("Claude Code Skill companion block continues the live turn",
    response.status === 200 && stopOf(final) === "end_turn" && inits().length === before, `got ${response.status}`)
  check("Skill companion body reaches MCP verbatim alongside Launching skill",
    parts[0] === "Launching skill: hengjian-chat-archive" && parts[1] === skillBody, JSON.stringify(parts))
  const third = nextTurn(second, final, "MEMORY after skill")
  const thirdRes = await callFetch(third)
  const thirdEvents = (await readSSE(thirdRes)).events
  check("turn after Skill companion reuses the same live session",
    thirdRes.status === 200 && stopOf(thirdEvents) === "end_turn" && inits().length === before && lastOf("user").convId === convId)
}

{
  // MCP prompt Skill without Base directory header + protocol notice beside tool_result.
  const skillTool = { name: "Skill", description: "Skill", input_schema: { type: "object" } }
  const first = { model, messages: [{ role: "user", content: "SKILLCALL mcp prompt skill" }], tools: [skillTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const before = inits().length
  const second = continuation(first, events, "Launching skill: mcp-review")
  second.messages.at(-1).content.push(
    { type: "text", text: "# MCP Skill Prompt\nReview every changed file carefully." },
    { type: "text", text: "<system-reminder>Allowed tools updated</system-reminder>" },
  )
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  const delivered = logs().filter(event => event.type === "mcpResult" && event.convId === convId).at(-1)
  const mcpText = delivered?.result?.content?.map(part => part.text).join("\n") || ""
  check("prompt-only Skill companion and system-reminder continue the live turn",
    response.status === 200 && stopOf(final) === "end_turn" && inits().length === before &&
    mcpText.includes("# MCP Skill Prompt") && mcpText.includes("Allowed tools updated"), mcpText)
}

{
  // Claude Code image dimension note, ToolSearch tool_reference + Tool loaded., teammate-message, and /loop fold.
  const first = { model, messages: [{ role: "user", content: "TOOL image dimension companion" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const before = inits().length
  const second = continuation(first, events, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ])
  second.messages.at(-1).content.push(
    { type: "text", text: "[Image: original 3423x1834, displayed at 2000x1072. Multiply coordinates by 1.71 to map to original image.]" },
    { type: "text", text: "<teammate-message teammate_id=\"worker-1\">check complete</teammate-message>" },
    { type: "text", text: "[2 prior /loop wakeups found nothing actionable; loop is healthy.]" },
  )
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  const delivered = logs().filter(event => event.type === "mcpResult" && event.convId === convId).at(-1)
  const content = delivered?.result?.content || []
  const texts = content.filter(part => part.type === "text").map(part => part.text).join("\n")
  check("image dimension companion, teammate-message, and loop notice continue live turn",
    response.status === 200 && stopOf(final) === "end_turn" && inits().length === before &&
    content[0]?.type === "image" &&
    texts.includes("Multiply coordinates by 1.71") &&
    texts.includes("worker-1") &&
    texts.includes("prior /loop wakeups"), JSON.stringify(content))

  const searchTool = { name: "ToolSearch", description: "Search deferred tools" }
  const searchFirst = { model, messages: [{ role: "user", content: "TOOLSEARCHCALL load WebFetch and use loaded tool" }], tools: [searchTool] }
  const searchEvents = (await readSSE(await callFetch(searchFirst))).events
  const searchConv = inits().at(-1).convId
  const beforeSearch = inits().length
  const searchSecond = continuation(searchFirst, searchEvents, [
    { type: "tool_reference", tool_name: "WebFetch" },
  ])
  searchSecond.tools = [searchTool, { name: "WebFetch", defer_loading: true, input_schema: {
    type: "object", properties: { url: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["url"],
  } }]
  searchSecond.messages.at(-1).content.push({ type: "text", text: "Tool loaded." })
  const searchRes = await callFetch(searchSecond)
  const searchFinal = (await readSSE(searchRes)).events
  const searchDelivered = logs().filter(event => event.type === "mcpResult" && event.convId === searchConv).at(-1)
  const searchText = searchDelivered?.result?.content?.map(part => part.text).join("\n") || ""
  check("ToolSearch tool_reference and Tool loaded. companion continue live turn",
    searchRes.status === 200 && stopOf(searchFinal) === "tool_use" && inits().length === beforeSearch &&
    searchText.includes("Loaded tool: WebFetch") && searchText.includes("Tool loaded."), searchText)
  check("schema-less ToolSearch exposes usable search parameters",
    inits().at(-1)?.tools?.find(tool => tool.name === "ToolSearch")?.inputSchema?.properties?.query?.type === "string")
  check("loaded deferred tool is callable after catalog refresh in the same turn",
    toolCall(searchFinal)?.name === "WebFetch" && toolCall(searchFinal)?.input?.url === "https://example.com" &&
    logs().some(event => event.type === "toolsList" && event.reason === "list_changed" && event.convId === searchConv && event.tools.includes("WebFetch")))
  const searchThird = continuation(searchSecond, searchFinal, "Fetched example successfully")
  const loadedEvents = (await readSSE(await callFetch(searchThird))).events
  check("loaded tool result completes the original search turn",
    stopOf(loadedEvents) === "end_turn" && inits().length === beforeSearch &&
    logs().some(event => event.type === "mcpResult" && event.convId === searchConv && event.name === "WebFetch" && event.result?.content?.some(part => part.text?.includes("Fetched example successfully"))))
  const afterSearch = nextTurn(searchThird, loadedEvents, "MEMORY after tool search")
  const afterSearchRes = await callFetch(afterSearch)
  await readSSE(afterSearchRes)
  check("turn after ToolSearch tool_reference reuses the live session",
    afterSearchRes.status === 200 && inits().length === beforeSearch)
}

{
  // Pressing Esc during a client tool run appends [Request interrupted by user] + the new user prompt.
  const first = { model, messages: [{ role: "user", content: "ESCCALL interrupted by user" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const old = inits().at(-1)
  const second = continuation(first, events, "partial tool output")
  second.messages.at(-1).content.push(
    { type: "text", text: "[Request interrupted by user]\n" },
    { type: "text", text: "New instruction after Esc" },
  )
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  const replay = lastOf("user")
  check("user-interrupted tool turn steers natively and retains the session",
    response.status === 200 && stopOf(final) === "end_turn" && replay.convId === old.convId &&
    replay.text.includes("New instruction after Esc") && !replay.text.includes("<conversation_history>") &&
    !logs().some(event => event.type === "cancel" && event.convId === old.convId) &&
    logs().some(event => event.type === "nativeSteer" && event.convId === old.convId), `got ${response.status}`)
  const third = nextTurn(second, final, "MEMORY after interrupted tool turn")
  const thirdRes = await callFetch(third)
  await readSSE(thirdRes)
  check("turn after user-interrupted replay reuses the new session",
    thirdRes.status === 200 && lastOf("user").convId === replay.convId)
}

for (const mode of ["ack-first", "original-first", "reject", "auth-error"]) {
  process.env.FAKE_AGY_STEER = mode
  const first = { model, messages: [{ role: "user", content: `ESCCALL native steering ${mode}` }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  delete process.env.FAKE_AGY_STEER
  const session = inits().at(-1)
  const second = continuation(first, pending, "NATIVE-RESULT-731")
  second.messages.push({ role: "user", content: "NATIVE_FINAL" })
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  const records = logs().filter(event => event.convId === session.convId)
  if (mode === "auth-error") {
    check("native steering auth errors do not resend or replay", final.some(event => event.event === "error") &&
      records.filter(event => event.type === "user").length === 1 && inits().at(-1).convId === session.convId)
    const duplicate = await callFetch(second)
    check("a submitted failed steer cannot be automatically retried", duplicate.status !== 200 &&
      duplicate.headers.get("x-should-retry") === "false")
    await duplicate.text()
    continue
  }
  check(`${mode}: steering waits for final output after both ACP replies`, stopOf(final) === "end_turn" &&
    textOf(final).includes("NATIVE_FINAL_AFTER_ACK") && inits().at(-1).convId === session.convId)
  check(`${mode}: steering uses only the expected same-session fallback`,
    records.filter(event => event.type === "cancel").length === (mode === "reject" ? 1 : 0) &&
    records.filter(event => event.type === "user").length === 2 &&
    !records.some(event => event.type === "user" && event.text.includes("<conversation_history>")))
  const follow = nextTurn(second, final, "MEMORY after native steering " + mode)
  const resumed = (await readSSE(await callFetch(follow))).events
  check(`${mode}: follow-up retains native context`, stopOf(resumed) === "end_turn" && lastOf("user").convId === session.convId)
}

{
  const first = { model, messages: [{ role: "user", content: "ESCCALL native steering chain" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  const session = inits().at(-1)
  const second = continuation(first, pending, "FIRST-CHAIN-RESULT")
  second.messages.push({ role: "user", content: "ESCCALL native second tool" })
  const nextPending = (await readSSE(await callFetch(second))).events
  const third = continuation(second, nextPending, "SECOND-CHAIN-RESULT")
  third.messages.push({ role: "user", content: "NATIVE_FINAL" })
  const final = (await readSSE(await callFetch(third))).events
  const records = logs().filter(event => event.convId === session.convId)
  check("multiple steers and intervening tools retain one ACP turn and session", stopOf(nextPending) === "tool_use" &&
    stopOf(final) === "end_turn" && textOf(final).includes("NATIVE_FINAL_AFTER_ACK") &&
    records.filter(event => event.type === "nativeSteer").length === 2 &&
    records.filter(event => event.type === "user").length === 3 &&
    !records.some(event => event.type === "cancel") && inits().at(-1).convId === session.convId)
  const follow = (await readSSE(await callFetch(nextTurn(third, final, "MEMORY after steering chain")))).events
  check("a follow-up after repeated steering does not replay history", stopOf(follow) === "end_turn" &&
    lastOf("user").convId === session.convId && lastOf("user").text === "MEMORY after steering chain")
}

{
  const first = { model, messages: [{ role: "user", content: "TOOL_FINISH_EARLY" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  const session = inits().at(-1)
  await new Promise(resolve => setTimeout(resolve, 60))
  const second = continuation(first, pending, "RESULT-AFTER-PROMPT-END")
  second.messages.push({ role: "user", content: "NATIVE_FINAL" })
  const final = (await readSSE(await callFetch(second))).events
  check("an ended prompt with compatible complete results continues without replay", stopOf(final) === "end_turn" &&
    textOf(final).includes("NATIVE_FINAL_AFTER_ACK") && lastOf("user").convId === session.convId &&
    lastOf("user").text.includes("RESULT-AFTER-PROMPT-END") && !lastOf("user").text.includes("<conversation_history>"))
}

{
  const first = { model, messages: [{ role: "user", content: "ESCCALL native large MCP result" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  const session = inits().at(-1)
  const second = continuation(first, pending, "z".repeat(200_000))
  second.messages.push({ role: "user", content: "NATIVE_FINAL" })
  const response = await callFetch(second)
  const final = response.status === 200 ? (await readSSE(response)).events : []
  check("a large live MCP result is not forced into the ACP user-input ceiling", stopOf(final) === "end_turn" &&
    lastOf("user").convId === session.convId && lastOf("user").text === "NATIVE_FINAL")
  if (response.status !== 200) await response.text()
}

{
  process.env.FAKE_AGY_VERSION = "1.4.12"
  const first = { model, messages: [{ role: "user", content: "ESCCALL STEER_CANCEL_DELAY" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  delete process.env.FAKE_AGY_VERSION
  const session = inits().at(-1)
  const steered = continuation(first, pending, "actual result before cancellation")
  steered.messages.at(-1).content.push({ type: "text", text: "ABORTED-STEERING-731" })
  const controller = new AbortController()
  const request = callFetch(steered, {}, controller.signal)
  for (let attempt = 0; attempt < 60 && !logs().some(event =>
    event.type === "mcpResult" && event.convId === session.convId); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  controller.abort()
  const aborted = await request
  await aborted.text()
  check("abort while settling the old prompt sends no late steering prompt", !logs().some(event =>
    event.type === "user" && event.convId === session.convId && event.text.includes("ABORTED-STEERING-731")))
  const recovered = (await readSSE(await callFetch(steered))).events
  check("an aborted steering instruction can be explicitly recovered", stopOf(recovered) === "end_turn" &&
    lastOf("user").text.includes("ABORTED-STEERING-731"))
}

// Issue #34: a fresh process must recover long client histories without losing
// the orphan result that prompted the replay or changing the client's lineage.
{
  const summary = "This session is being continued from a previous conversation. issue34-skeleton-summary"
  const messages = [{ role: "user", content: summary }]
  const ids = Array.from({ length: 177 }, (_, index) => `issue34-skeleton-${index}`)
  const currentResult = "issue34-skeleton-current-result 中文 " + "r".repeat(2000)
  const instruction = "Use the completed result and reply with issue34-skeleton-current-instruction."
  for (const [index, id] of ids.entries()) {
    messages.push({ role: "assistant", content: [
      { type: "tool_use", id, name: "echo", input: { text: `lookup ${index} ` + "q".repeat(400) } },
    ] })
    messages.push({ role: "user", content: [
      { type: "tool_result", tool_use_id: id, content: index === ids.length - 1
        ? currentResult : `issue34-skeleton-old-result-${index} ` + "r".repeat(1500) },
      ...(index === ids.length - 1 ? [{ type: "text", text: instruction }] : []),
    ] })
  }
  const body = { model, metadata: { user_id: "issue34-skeleton-replay" }, tools: [echoTool], messages }
  const before = inits().length
  const response = await callFetch(body)
  const events = response.status === 200 ? (await readSSE(response)).events : []
  const error = response.status === 200 ? "" : await response.text()
  const replay = inits().length > before ? lastOf("user") : null
  const text = replay?.text || ""
  const callIds = [...text.matchAll(/<tool_record role="call" type="tool_use" id="([^"]+)"/g)].map(match => match[1])
  const resultIds = [...text.matchAll(/<tool_record role="result" type="tool_result" id="([^"]+)"/g)].map(match => match[1])
  check("177 tools after a summary replay with an orphan final result", response.status === 200 &&
    stopOf(events) === "end_turn" && inits().length === before + 1 && !inits().at(-1).resumed, error)
  check("177-tool skeleton fits the ACP byte limit without dropping any call IDs", Buffer.byteLength(text, "utf8") <= 180_000 &&
    JSON.stringify(callIds) === JSON.stringify(ids) && JSON.stringify(resultIds) === JSON.stringify(ids.slice(0, -1)))
  check("177-tool replay retains the summary and complete current result and instruction", text.includes(summary) &&
    text.includes(`[tool result id=${ids.at(-1)}]\n${currentResult}\n[end of tool result]`) && text.includes(instruction))
  check("177-tool replay discloses omitted result bodies without dropping history groups",
    text.includes("Historical tool-result bodies omitted") && !text.includes("issue34-skeleton-old-result-") &&
    !text.includes("older history messages omitted"))
  const followupText = "Continue with issue34-skeleton-followup."
  const followup = await callFetch(nextTurn(body, events, followupText))
  const final = (await readSSE(followup)).events
  check("177-tool follow-up matches the full client history and keeps its session", stopOf(final) === "end_turn" &&
    lastOf("user").convId === replay?.convId && lastOf("user").text === followupText && inits().length === before + 1)
}

for (const oversizedPart of ["arguments", "assistant-text"]) {
  const prefix = `issue34-window-${oversizedPart}`
  const opening = `${prefix}-opening: keep the original task constraints.`
  const summary = `This session is being continued from a previous conversation. ${prefix}-summary: preserve the decisions.`
  const summaryCallId = `${prefix}-summary-call`
  const latestCallId = `${prefix}-latest-call`
  const latestAssistant = `${prefix}-latest-assistant: use the pending result to finish.`
  const currentResult = `${prefix}-current-result ` + "完整结果".repeat(500)
  const history = [{ role: "user", content: opening }]
  const oldGroups = Array.from({ length: 10 }, (_, index) => ({
    id: `${prefix}-old-${index}`,
    payload: `${prefix}-payload-${index} ` + "x".repeat(32_000),
  }))
  for (const [index, group] of oldGroups.entries()) {
    history.push({ role: "assistant", content: [
      ...(oversizedPart === "assistant-text" ? [{ type: "text", text: group.payload }] : []),
      { type: "tool_use", id: group.id, name: "echo", input: { text: oversizedPart === "arguments" ? group.payload : "small argument" } },
    ] }, { role: "user", content: [
      { type: "tool_result", tool_use_id: group.id, content: `${prefix}-old-result-${index} ` + "r".repeat(1000) },
    ] })
    // The summary lives in an otherwise removable exchange, between old groups
    // that must be dropped. Its associated call and result must survive too.
    if (index === 1) history.push({ role: "assistant", content: [
      { type: "tool_use", id: summaryCallId, name: "echo", input: { text: "summary context" } },
    ] }, { role: "user", content: [
      { type: "tool_result", tool_use_id: summaryCallId, content: "summary exchange completed" },
      { type: "text", text: summary },
    ] })
  }
  history.push({ role: "assistant", content: [
    { type: "text", text: latestAssistant },
    { type: "tool_use", id: latestCallId, name: "echo", input: { text: "latest argument" } },
  ] })
  for (const summarizing of [false, true]) {
    const label = `${oversizedPart} ${summarizing ? "client summarization" : "orphan result"}`
    const instruction = summarizing
      ? `Summarize the conversation so far for continuation, preserving decisions and outstanding work. ${prefix}-summarize-current.`
      : `Use the retained context and completed result to answer ${prefix}-current-instruction.`
    const body = { model, metadata: { user_id: `${prefix}-${summarizing ? "summarize" : "replay"}` }, tools: [echoTool], messages: [
      ...history,
      { role: "user", content: [{ type: "tool_result", tool_use_id: latestCallId, content: currentResult }] },
      { role: "user", content: instruction },
    ] }
    const before = inits().length
    const response = await callFetch(body)
    const events = response.status === 200 ? (await readSSE(response)).events : []
    const error = response.status === 200 ? "" : await response.text()
    const replay = inits().length > before ? lastOf("user") : null
    const text = replay?.text || ""
    const calls = new Set([...text.matchAll(/<tool_record role="call" type="tool_use" id="([^"]+)"/g)].map(match => match[1]))
    const results = new Set([...text.matchAll(/<tool_record role="result" type="tool_result" id="([^"]+)"/g)].map(match => match[1]))
    check(`window fallback accepts oversized ${label} in a fresh session`, response.status === 200 &&
      stopOf(events) === "end_turn" && inits().length === before + 1 && !inits().at(-1).resumed, error)
    check(`window fallback for ${label} respects the ACP byte limit and discloses omitted history`, text.length > 0 &&
      Buffer.byteLength(text, "utf8") <= 180_000 && text.includes("older history messages omitted") &&
      text.includes("This history is incomplete; do not infer missing tool outcomes."))
    check(`window fallback for ${label} retains opening, summary exchange and last assistant`, text.includes(opening) &&
      text.includes(summary) && calls.has(summaryCallId) && results.has(summaryCallId) &&
      text.includes(latestAssistant) && calls.has(latestCallId))
    check(`window fallback for ${label} preserves the entire current turn`,
      text.includes(`<current_turn>\n[tool result id=${latestCallId}]\n${currentResult}\n[end of tool result]`) &&
      text.includes(instruction) && text.endsWith("\n</current_turn>"))
    const firstRetained = oldGroups.findIndex(group => calls.has(group.id))
    check(`window fallback for ${label} drops oldest complete exchanges and keeps full retained content`, firstRetained > 0 &&
      oldGroups.every((group, index) => calls.has(group.id) === (index >= firstRetained) &&
        results.has(group.id) === calls.has(group.id) && text.includes(group.payload) === calls.has(group.id)))
    const followupText = `${prefix}-${summarizing ? "summarize" : "replay"}-followup: continue from here.`
    const followup = await callFetch(nextTurn(body, events, followupText))
    const final = (await readSSE(followup)).events
    check(`windowed ${label} follow-up matches full client history and keeps its session`, stopOf(final) === "end_turn" &&
      lastOf("user").convId === replay?.convId && lastOf("user").text === followupText && inits().length === before + 1)
  }
}

for (const recent of [true, false]) {
  const messages = [{ role: "user", content:
    "This session is being continued from a previous conversation. issue34-protected-summary " + "p".repeat(190_000) }]
  if (!recent) for (let index = 0; index < 5; index++) messages.push(
    { role: "assistant", content: `issue34-summary-age-answer-${index}` },
    { role: "user", content: `issue34-summary-age-request-${index}` },
  )
  messages.push({ role: "assistant", content: "The opening summary remains required." },
    { role: "user", content: "Keep issue34-summary-age-current complete." })
  const before = inits().length
  const beforePrompts = logs().filter(event => event.type === "user").length
  const response = await callFetch({ model, metadata: { user_id: `issue34-summary-age-${recent}` }, messages })
  const payload = response.status === 200 ? (await readSSE(response), null) : await response.json()
  check(`${recent ? "recent" : "old"} summary preserves oversized-opening rejection with the correct compaction latch`,
    response.status === 400 && payload?.error?.code === (recent ? "prompt_budget_exceeded" : "context_length_exceeded") &&
    /prompt is too long/.test(payload?.error?.message || "") === !recent && response.headers.get("x-should-retry") === "false",
    JSON.stringify(payload))
  check(`${recent ? "recent" : "old"} oversized protected summary sends no ACP input`, inits().length === before &&
    logs().filter(event => event.type === "user").length === beforePrompts)
}

{
  const before = inits().length
  const oversized = { model, system: "Keep the complete latest instruction.", tools: [echoTool], messages: [
    { role: "user", content: "old history " + "x".repeat(4_000_000) },
    { role: "assistant", content: "An old answer" },
    { role: "user", content: "不要调用任何工具，直接输出 CURRENT-731" },
  ] }
  for (let retry = 0; retry < 2; retry++) {
    const response = await callFetch(oversized)
    const payload = await response.json()
    check(`oversized replay ${retry} fails before session creation`, response.status === 400 &&
      payload.error?.code === "context_length_exceeded" && response.headers.get("x-should-retry") === "false" &&
      inits().length === before, JSON.stringify(payload))
  }
  const compacted = { ...oversized, messages: [
    { role: "user", content: "Compacted summary: The previous task is complete. Follow the latest instruction." },
    oversized.messages.at(-1),
  ] }
  const compactedEvents = (await readSSE(await callFetch(compacted))).events
  check("a client-compacted retry preserves the complete current instruction", stopOf(compactedEvents) === "end_turn" &&
    lastOf("user").text.endsWith("CURRENT-731") && !assistantBlocks(compactedEvents).some(block => block.type === "tool_use"))
}

{
  let body = { model, messages: [{ role: "user", content: "MEMORY " + "h".repeat(150_000) }], tools: [echoTool] }
  let events = (await readSSE(await callFetch(body))).events
  const session = inits().at(-1)
  for (let round = 0; round < 7; round++) {
    body = nextTurn(body, events, "MEMORY " + "h".repeat(150_000))
    events = (await readSSE(await callFetch(body))).events
  }
  body = nextTurn(body, events, "ESCCALL large accumulated history")
  events = (await readSSE(await callFetch(body))).events
  const steered = continuation(body, events, "The tool finished successfully")
  steered.messages.at(-1).content.push({ type: "text", text: "不要调用任何工具，直接输出 LATEST-942" })
  const responses = await Promise.all([callFetch(steered), callFetch(steered)])
  const accepted = responses.find(response => response.status === 200)
  const rejected = responses.find(response => response.status === 503)
  const final = accepted ? (await readSSE(accepted)).events : []
  if (rejected) await rejected.text()
  check("concurrent steering has exactly one owner", !!accepted && !!rejected, responses.map(response => response.status).join(","))
  check("large accumulated history does not replay on user steering", stopOf(final) === "end_turn" &&
    lastOf("user").convId === session.convId && lastOf("user").text.includes("LATEST-942") && lastOf("user").text.length < 1000 &&
    !assistantBlocks(final).some(block => block.type === "tool_use"))

  // Protected opening + current input exceed the ceiling even after history
  // windowing. Reject this incompatible replay before discarding the live session.
  const next = nextTurn(steered, final, "MEMORY after rejected replay")
  const incompatible = { ...next, system: "Different session instructions", messages: [
    ...next.messages.slice(0, -1), { role: "user", content: "MEMORY " + "x".repeat(50_000) },
  ] }
  const response = await callFetch(incompatible)
  check("oversized incompatible replay preserves the existing process", response.status === 400 &&
    (await response.json()).error?.code === "context_length_exceeded" && fs.existsSync(session.cwd))
  const resumed = (await readSSE(await callFetch(next))).events
  check("the preserved session still accepts compatible follow-ups", stopOf(resumed) === "end_turn" && lastOf("user").convId === session.convId)
  const resumeBody = nextTurn(next, resumed, "MEMORY after large history eviction")
  for (let round = 0; round < 4; round++) await readSSE(await callFetch({ model,
    messages: [{ role: "user", content: `MEMORY evict large history ${round}` }],
  }))
  const afterEviction = (await readSSE(await callFetch(resumeBody))).events
  check("large stored histories resume with only the new input", stopOf(afterEviction) === "end_turn" &&
    lastOf("user").convId === session.convId && inits().at(-1).resumed === true &&
    lastOf("user").text === "MEMORY after large history eviction")
}

for (const steering of [false, true]) {
  const first = { model, messages: [{ role: "user", content: `TOOL result budget ${steering}` }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  const session = inits().at(-1)
  const oversized = continuation(first, pending, "z".repeat(1_200_000))
  if (steering) oversized.messages.at(-1).content.push({ type: "text", text: "Please explain this result." })
  const response = await callFetch(oversized)
  check(`oversized tool result ${steering} preserves its pending owner`, response.status === 400 &&
    (await response.json()).error?.code === "context_length_exceeded" &&
    !logs().some(event => event.type === "mcpResult" && event.convId === session.convId))
  const corrected = continuation(first, pending, "The client reduced its tool output.")
  const final = (await readSSE(await callFetch(corrected))).events
  check(`a corrected tool result ${steering} completes in its original session`, stopOf(final) === "end_turn" &&
    inits().at(-1).convId === session.convId)
}

{
  const before = inits().length
  const tooLarge = { model, messages: [{ role: "user", content: "中文".repeat(40_000) + " CURRENT-TAIL-731" }] }
  const rejected = await callFetch(tooLarge)
  check("a user turn below 1 MiB but above AGY's limit is rejected before session creation", rejected.status === 400 &&
    (await rejected.json()).error?.code === "context_length_exceeded" && inits().length === before)

  const first = { model, messages: [{ role: "user", content: "MEMORY before oversized continuation" }] }
  const initial = (await readSSE(await callFetch(first))).events
  const session = inits().at(-1)
  const next = nextTurn(first, initial, "x".repeat(200_000) + " KEEP-TAIL-942")
  const response = await callFetch(next)
  check("oversized native continuation leaves the original session usable", response.status === 400 &&
    (await response.json()).error?.code === "context_length_exceeded" && fs.existsSync(session.cwd) &&
    logs().filter(event => event.type === "user" && event.convId === session.convId).length === 1)
  const corrected = nextTurn(first, initial, "MEMORY smaller continuation")
  const final = (await readSSE(await callFetch(corrected))).events
  check("a corrected native continuation reuses the preserved session", stopOf(final) === "end_turn" &&
    lastOf("user").convId === session.convId)

  process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = "150"
  const late = { model, messages: [{ role: "user", content: "LONGQUIT oversized deferred result" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(late))).events
  const lateSession = inits().at(-1)
  await new Promise(resolve => setTimeout(resolve, 400))
  const oversized = await callFetch(continuation(late, pending, "z".repeat(200_000)))
  check("a deferred result cannot bypass the ACP user-input limit", oversized.status === 400 &&
    (await oversized.json()).error?.code === "context_length_exceeded" && fs.existsSync(lateSession.cwd) &&
    logs().filter(event => event.type === "user" && event.convId === lateSession.convId).length === 1)
  const resumed = (await readSSE(await callFetch(continuation(late, pending, "small-deferred-result")))).events
  check("rejected deferred input retains the pending tool for a corrected result", stopOf(resumed) === "end_turn" &&
    lastOf("user").convId === lateSession.convId && textOf(resumed).includes("small-deferred-result"))
  delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
}

{
  // /v1/messages/count_tokens returns fast token estimate without spawning agy.
  const before = logs().length
  const countRes = await loader.fetch("agy://local/v1/messages/count_tokens?beta=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system: "Be concise.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Hello token counter 中文" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) } },
        ],
      }],
    }),
  })
  const countData = await countRes.json()
  check("count_tokens returns JSON input_tokens without spawning agy",
    countRes.status === 200 && countData.input_tokens >= 1600 && logs().length === before,
    JSON.stringify(countData))
}

{
  // Tool schema sanitization, stream: false JSON response, promptCapabilities.image, text/PDF documents, and clean refusal.
  process.env.FAKE_AGY_PROMPT_IMAGE = "1"
  const trickyTool = {
    name: "tricky_schema",
    description: "Schema sanitizer check",
    input_schema: {
      type: "object",
      properties: {
        union_arr: { type: ["object", "array"], items: { type: "string" } },
        stale_items: { type: ["string", "number"], items: { type: "string" }, properties: { bad: { type: "string" } } },
        num_enum: { type: "integer", enum: [0, 1, 2] },
      },
      required: ["union_arr", "missing_field"],
    },
  }
  const syncRes = await callFetch({
    model,
    stream: false,
    tools: [trickyTool],
    messages: [{
      role: "user",
      content: [
        { type: "document", title: "spec.txt", source: { type: "text", media_type: "text/plain", data: "DOC_MARKER_42" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "inspect multimodal turn" },
      ],
    }],
  })
  const syncMsg = await syncRes.json()
  const initTool = inits().at(-1)?.tools?.[0]
  const lastUser = lastOf("user")
  check("stream: false returns aggregated JSON message with image and text document",
    syncRes.status === 200 && syncMsg.type === "message" && lastUser.images === 1 && lastUser.text.includes("DOC_MARKER_42"),
    JSON.stringify(syncMsg))
  check("sanitizeInputSchema normalizes union types, stale array/object fields, non-string enums, and dangling required",
    initTool?.inputSchema?.properties?.union_arr?.type === "array" &&
    initTool?.inputSchema?.properties?.stale_items?.items === undefined &&
    initTool?.inputSchema?.properties?.stale_items?.properties === undefined &&
    initTool?.inputSchema?.properties?.num_enum?.enum === undefined &&
    /Allowed values: 0, 1, 2/.test(initTool?.inputSchema?.properties?.num_enum?.description || "") &&
    JSON.stringify(initTool?.inputSchema?.required) === JSON.stringify(["union_arr"]),
    JSON.stringify(initTool?.inputSchema))

  const pdfRes = await callFetch({
    model,
    messages: [{
      role: "user",
      content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }],
    }],
  })
  check("binary PDF document block returns HTTP 400", pdfRes.status === 400)

  const refusalRes = await callFetch({ model, stream: false, messages: [{ role: "user", content: "REFUSAL_CLEAN" }] })
  const refusalMsg = await refusalRes.json()
  check("clean ACP refusal stopReason maps to Anthropic refusal without killing session",
    refusalRes.status === 200 && refusalMsg.stop_reason === "refusal", JSON.stringify(refusalMsg))
  delete process.env.FAKE_AGY_PROMPT_IMAGE
}

{
  // Magpie privacy-masking placeholder notice beside live tool_result + session history continuity.
  const magpieNotice = "Values written like {{NAME_ab12cd34}} are placeholders for real values. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs. Don't ask to verify them, and don't replace them with examples."
  const first = {
    model,
    tools: [echoTool],
    messages: [{ role: "user", content: `TOOL masked {{TERM_vgth3dgg}}\n\n${magpieNotice}` }],
  }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const before = inits().length
  const second = {
    ...first,
    // Magpie moves its placeholder notice to the latest user message on Turn 2.
    messages: [
      { role: "user", content: "TOOL masked {{TERM_vgth3dgg}}" },
      { role: "assistant", content: assistantBlocks(events) },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolCall(events).id, content: "SECRET={{SECRET_yv2yqxeq}}" },
          { type: "text", text: magpieNotice },
        ],
      },
    ],
  }
  const secondRes = await callFetch(second)
  const secondFinal = (await readSSE(secondRes)).events
  check("Magpie privacy-masking placeholder notice beside tool_result continues the live session",
    secondRes.status === 200 && stopOf(secondFinal) === "end_turn" && inits().length === before,
    `status=${secondRes.status}, inits=${inits().length - before}`)
  const third = {
    ...second,
    messages: [
      { role: "user", content: "TOOL masked {{TERM_vgth3dgg}}" },
      { role: "assistant", content: assistantBlocks(events) },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolCall(events).id, content: "SECRET={{SECRET_yv2yqxeq}}" }] },
      { role: "assistant", content: assistantBlocks(secondFinal) },
      { role: "user", content: `MEMORY after masked turn\n\n${magpieNotice}` },
    ],
  }
  const thirdRes = await callFetch(third)
  const thirdEvents = (await readSSE(thirdRes)).events
  check("moving Magpie placeholder notice to later user turns preserves convKey and live session",
    thirdRes.status === 200 && stopOf(thirdEvents) === "end_turn" && inits().length === before && lastOf("user").convId === convId)
}

{
  // Claude Code mid-turn queued_command + tool_addition + bounded <system-reminder id="..."> + post-failure unwedge.
  const first = { model, messages: [{ role: "user", content: "ESCCALL queued command mid-turn" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const old = inits().at(-1)
  const second = continuation(first, events, "file-output")
  second.messages.at(-1).content.push(
    { type: "text", text: "<ide_opened_file>/project/a.ts</ide_opened_file>" },
    { type: "text", text: '<system-reminder id="rem123">\nBounded reminder\n</system-reminder id="rem123">' },
    {
      type: "text",
      text: "The user sent a new message while you were working:\nRemove invalid freejev accounts now\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.",
    },
  )
  second.messages.push({
    role: "system",
    content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Extra" } } }],
  })
  const secondRes = await callFetch(second)
  const secondFinal = (await readSSE(secondRes)).events
  const steeredUser = lastOf("user")
  check("Claude Code mid-turn queued_command and tool_addition continue as clean user prompt",
    secondRes.status === 200 && stopOf(secondFinal) === "end_turn" && steeredUser.convId === old.convId &&
    steeredUser.text.includes("Remove invalid freejev accounts now") &&
    !steeredUser.text.includes("This is how Claude Code surfaces"),
    JSON.stringify(steeredUser))

  // Standalone follow-up user message after a failed/aborted tool turn unwedges the conversation.
  const wFirst = { model, messages: [{ role: "user", content: "ESCCALL wedged follow-up" }], tools: [echoTool] }
  const wEvents = (await readSSE(await callFetch(wFirst))).events
  const wOld = inits().at(-1)
  const wedged = continuation(wFirst, wEvents, "tool-output-before-abort")
  wedged.messages.push({ role: "user", content: "Standalone follow-up user instruction" })
  const wRes = await callFetch(wedged)
  const wFinal = (await readSSE(wRes)).events
  check("standalone follow-up user message continues the pending session",
    wRes.status === 200 && stopOf(wFinal) === "end_turn" && lastOf("user").convId === wOld.convId &&
    lastOf("user").text.includes("Standalone follow-up user instruction"),
    `status=${wRes.status}`)
}

{
  // Full Claude Code hook lifecycle: PreToolUse normalized input + additionalContext,
  // PostToolUse blocking error, TaskCreated/Stop/PermissionDenied meta-feedback,
  // rejected tool + merged user follow-up, prompt-hook json_schema, model aliases, and server_tool_use history.
  const hFirst = { model, messages: [{ role: "user", content: "TOOL hook suite" }], tools: [echoTool] }
  const hEvents = (await readSSE(await callFetch(hFirst))).events
  const hConv = inits().at(-1).convId
  const beforeHookInits = inits().length
  const hSecond = continuation(hFirst, hEvents, "rtk-rewritten-output")
  // Simulate Claude Code normalizing assistant tool_use.input (e.g. adding default flags) while keeping toolu_ ID.
  hSecond.messages[1].content.find(block => block.type === "tool_use").input = { text: "probe", normalized_default: false }
  // Pre-result system message + PostToolUse blocking error + TaskCreated hook feedback + PermissionDenied retry hint + channel tag.
  hSecond.messages.splice(2, 0, {
    role: "system",
    content: [{ type: "text", text: "PreToolUse:echo hook additional context: PRE_HOOK_MARKER" }],
  })
  hSecond.messages.at(-1).content.push(
    { type: "text", text: '<system-reminder>\nPostToolUse:echo hook blocking error from command: "lint.sh": POST_BLOCK_MARKER\n</system-reminder>' },
    { type: "text", text: "TaskCreated hook feedback:\nTASK_FEEDBACK_MARKER" },
    { type: "text", text: "The PermissionDenied hook indicated you may retry this tool call." },
    { type: "text", text: '<channel source="mcp-webhook">CHANNEL_EVENT_MARKER</channel>' },
  )
  const hRes = await callFetch(hSecond)
  const hFinal = (await readSSE(hRes)).events
  const hDelivered = logs().filter(event => event.type === "mcpResult" && event.convId === hConv).at(-1)
  const hMcpText = hDelivered?.result?.content?.map(part => part.text).join("\n") || ""
  check("Claude Code PreToolUse/PostToolUse/TaskCreated/PermissionDenied hooks and normalized tool_use.input keep live session",
    hRes.status === 200 && stopOf(hFinal) === "end_turn" && inits().length === beforeHookInits &&
    hMcpText.includes("PRE_HOOK_MARKER") &&
    hMcpText.includes("POST_BLOCK_MARKER") &&
    hMcpText.includes("TASK_FEEDBACK_MARKER") &&
    hMcpText.includes("PermissionDenied hook indicated you may retry") &&
    hMcpText.includes("CHANNEL_EVENT_MARKER"),
    hMcpText)
  const hThird = nextTurn(hSecond, hFinal, "MEMORY after normalized tool_use input")
  const hThirdRes = await callFetch(hThird)
  await readSSE(hThirdRes)
  check("turn after client-normalized tool_use.input reuses the same live session",
    hThirdRes.status === 200 && inits().length === beforeHookInits && lastOf("user").convId === hConv)

  // User rejects tool call in TUI and enters a new prompt merged into the same user message by Claude Code aLe().
  const rFirst = { model, messages: [{ role: "user", content: "ESCCALL user rejected tool" }], tools: [echoTool] }
  const rEvents = (await readSSE(await callFetch(rFirst))).events
  const rOld = inits().at(-1)
  const rSecond = continuation(
    rFirst,
    rEvents,
    "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed.",
    { isError: true },
  )
  rSecond.messages.at(-1).content.push({ type: "text", text: "Write to /tmp/safe instead" })
  const rRes = await callFetch(rSecond)
  const rFinal = (await readSSE(rRes)).events
  check("rejected tool_result merged with follow-up user prompt continues cleanly",
    rRes.status === 200 && stopOf(rFinal) === "end_turn" && lastOf("user").convId === rOld.convId &&
    lastOf("user").text.includes("Write to /tmp/safe instead"),
    `status=${rRes.status}`)

  // type:"prompt" hook request with Gemini Flash small-fast model alias + output_config.format json_schema,
  // plus historical server_tool_use/web_search_tool_result and search_result blocks.
  const promptHookRes = await callFetch({
    model: "antigravity-bridge/gemini-3.8-flash",
    stream: false,
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
    },
    messages: [
      { role: "user", content: "Prior turn before /model switch" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "agy" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com" }] },
          { type: "text", text: "Prior answer" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "search_result", title: "Policy Doc", source: "kb://policy", content: [{ type: "text", text: "RAG_POLICY_MARKER" }] },
          { type: "text", text: "Evaluate hook safety" },
        ],
      },
    ],
  })
  const promptHookMsg = await promptHookRes.json()
  const promptHookUser = lastOf("user")
  check("prompt-hook json_schema, Gemini Flash alias, server_tool_use history, and search_result succeed without 400",
    promptHookRes.status === 200 && promptHookMsg.type === "message" &&
    promptHookUser.model === "gemini-test-low" &&
    promptHookUser.text.includes("Structured output requirement") &&
    promptHookUser.text.includes('"required":["ok"]') &&
    promptHookUser.text.includes("RAG_POLICY_MARKER") &&
    promptHookUser.text.includes('<tool_record role="call" type="server_tool_use" id="srvtoolu_1" name="web_search">'),
    JSON.stringify({ status: promptHookRes.status, user: promptHookUser }))
}

// Integration regressions for review findings: exercise the real fetch/MCP path.
{
  for (const [field, effortBody] of [
    ['reasoning_effort', { reasoning_effort: 'low' }],
    ['reasoningEffort', { reasoningEffort: 'low' }],
    ['reasoning.effort', { reasoning: { effort: 'low' } }],
    ['thinkingLevel', { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }],
  ]) {
    check(`${field} selects effort without an Anthropic thinking block`,
      await launchedModel({ model, ...effortBody, messages: [{ role: 'user', content: `MODEL generic effort ${field}` }] }) === 'gemini-test-low')
  }
}

{
  for (const companion of ['ARGUMENTS: please run the tests', 'Tool loaded.', '[Image: unrelated screenshot]']) {
    const first = { model, messages: [{ role: 'user', content: `TOOL mismatched companion ${companion}` }], tools: [echoTool] }
    const events = (await readSSE(await callFetch(first))).events
    const second = continuation(first, events, 'ordinary echo output')
    second.messages.at(-1).content.push({ type: 'text', text: companion })
    const response = await callFetch(second)
    check(`unmatched companion is not injected into another tool: ${companion}`, response.status === 400, `got ${response.status}`)
    if (response.status === 400) {
      await response.text()
      await drive(first, events, 'cleanup unmatched companion')
    } else await readSSE(response)
  }
}

{
  const skillTool = { name: 'Skill', description: 'Skill', input_schema: { type: 'object' } }
  const first = { model, messages: [{ role: 'user', content: 'SKILLCALL ordinary user steering regression' }], tools: [skillTool] }
  const events = (await readSSE(await callFetch(first))).events
  const second = continuation(first, events, 'Launching skill: archive')
  second.messages.at(-1).content.push({ type: 'text', text: 'Stop this task and explain something else' })
  const response = await callFetch(second)
  check('plain user instructions replay instead of becoming a Skill prompt body', response.status === 200, `got ${response.status}`)
  if (response.status === 400) {
    await response.text()
    await drive(first, events, 'cleanup ordinary Skill text')
  } else await readSSE(response)
}

{
  for (const suffix of ['', '\n\nPlease address this message and continue with your tasks.', '\n\nIMPORTANT: After completing your current task, you MUST address the user\'s message above. Do not ignore it.']) {
    const first = { model, messages: [{ role: 'user', content: `ESCCALL queued envelope ${suffix.length}` }], tools: [echoTool] }
    const events = (await readSSE(await callFetch(first))).events
    const oldId = inits().at(-1).convId
    const second = continuation(first, events, 'queued tool output')
    second.messages.at(-1).content.push({ type: 'text', text: 'The user sent a new message while you were working:\nQUEUED_STEERING_MARKER' + suffix })
    const response = await callFetch(second)
    check(`queued prompt suffix ${suffix.length} is accepted beside a tool result`, response.status === 200, `got ${response.status}`)
    if (response.status === 200) {
      await readSSE(response)
      check(`queued prompt suffix ${suffix.length} continues as user context in the same session`, lastOf('user').convId === oldId && lastOf('user').text.includes('QUEUED_STEERING_MARKER'))
    } else {
      await response.text()
      await drive(first, events, 'cleanup queued envelope')
    }
  }
}

{
  const first = { model, messages: [{ role: 'user', content: 'ESCCALL replay tool image regression' }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const second = continuation(first, events, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cmVwbGF5aW1hZ2U=' } }])
  second.messages.at(-1).content.push({ type: 'text', text: 'The user sent a new message while you were working:\nInspect that returned image' })
  const response = await callFetch(second)
  if (response.status === 200) await readSSE(response)
  else await response.text()
  check('native steering retains image bytes inside the real MCP result', response.status === 200 && logs().some(event =>
    event.type === 'mcpResult' && event.convId === lastOf('user').convId &&
    event.result?.content?.some(part => part.type === 'image' && part.data === 'cmVwbGF5aW1hZ2U=')))
  check('native steering does not duplicate the MCP image in a user prompt', !lastOf('user').content.some(part =>
    part.type === 'image' && part.data === 'cmVwbGF5aW1hZ2U='))
  if (response.status !== 200) await drive(first, events, 'cleanup replay image')
}

{
  // A live owner must keep exclusive access, even if its lock is over five seconds old.
  for (const age of [0, 10_000]) {
    const snapshot = fs.readFileSync(bridgeStateFile, 'utf8')
    fs.writeFileSync(bridgeStateFile + '.lock', JSON.stringify({ pid: process.pid }))
    const when = new Date(Date.now() - age)
    fs.utimesSync(bridgeStateFile + '.lock', when, when)
    try {
      await readSSE(await callFetch({ model, messages: [{ role: 'user', content: `MEMORY state lock regression ${age}` }] }))
      check(`state writer leaves another live owner's lock intact at age ${age}`, fs.existsSync(bridgeStateFile + '.lock'))
      check(`state writer never saves without acquiring the lock at age ${age}`, fs.readFileSync(bridgeStateFile, 'utf8') === snapshot)
    } finally {
      fs.rmSync(bridgeStateFile + '.lock', { force: true })
    }
  }
}

// Stale-turn regressions use the same ACP/MCP fake and public fetch path above.
{
  const events = []
  const replies = []
  const { Socket } = await import("node:net")
  const end = Socket.prototype.end
  Socket.prototype.end = function (data, ...args) {
    if (String(data).includes("was superseded")) replies.push(JSON.parse(String(data)))
    return end.call(this, data, ...args)
  }
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).startsWith("[agy-bridge] ")) events.push(JSON.parse(String(chunk).slice(13)))
    return write.call(this, chunk, ...args)
  }
  try {
    const first = { model, metadata: { user_id: "lineage-sibling" }, system: "lineage system",
      messages: [{ role: "user", content: "main before recap" }], tools: [echoTool] }
    const base = (await readSSE(await callFetch(first))).events
    const recap = nextTurn(first, base, "PARALLEL recap branch")
    const orphan = (await readSSE(await callFetch(recap))).events
    const old = inits().at(-1)
    for (let attempt = 0; attempt < 20 && logs().filter(event => event.type === "mcpPending" && event.convId === old.convId).length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    await new Promise(resolve => setTimeout(resolve, 20))
    check("lineage fixture leaves concurrent orphan calls pending", toolCalls(orphan).length >= 1 && logs().filter(event => event.type === "mcpPending" && event.convId === old.convId).length === 2)
    const before = inits().length
    const response = await callFetch(nextTurn(first, base, "continue main without recap"))
    const final = response.status === 200 ? (await readSSE(response)).events : []
    if (response.status !== 200) await response.text()
    check("lineage sibling prompt runs independently instead of returning 503", response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
    check("lineage replacement replays only the client's branch", inits().length === before + 1 && lastOf("user").convId !== old.convId && lastOf("user").text.includes("continue main without recap") && !lastOf("user").text.includes("PARALLEL recap branch"))
    const forks = events.filter(event => event.action === "isolated" && event.reason === "lineage_fork")
    check("lineage isolation emits one content-free event", forks.length === 1 && forks[0].layout === "hoisted" && !JSON.stringify(forks).includes("recap branch"))
    check("lineage isolation keeps the old process and its MCP sockets alive", fs.existsSync(old.cwd) && replies.length === 0)
    const resumed = await drive(recap, orphan, "original branch result")
    check("original branch still accepts its live results after a sibling completes", stopOf(resumed.events) === "end_turn" &&
      logs().some(event => event.type === "mcpResult" && event.convId === old.convId && JSON.stringify(event.result).includes("original branch result")))
  } finally { process.stderr.write = write; Socket.prototype.end = end }
}

{
  const timeout = process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS
  process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "30000"
  const { default: isolatedDefault } = await import("./index.mjs?issue-17-isolation")
  process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = timeout
  const isolatedLoader = await (await isolatedDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  const fetchBranch = body => isolatedLoader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
  const first = { model, metadata: { user_id: "issue-17-concurrent-branches" }, system: "branch isolation",
    messages: [{ role: "user", content: "opening shared by main and side requests" }], tools: [echoTool] }
  const base = (await readSSE(await fetchBranch(first))).events
  const requests = Array.from({ length: 5 }, (_, i) => nextTurn(first, base, `BRANCHCALL branch ${i}`))
  const pending = [(await readSSE(await fetchBranch(requests[0]))).events]
  const main = inits().at(-1)
  const before = inits().length
  const responses = await Promise.all([requests[1], requests[1], requests[2], requests[3]].map(fetchBranch))
  check("concurrent side requests and a duplicate claim start exactly three siblings",
    responses.filter(response => response.status === 200).length === 3 &&
    responses.filter(response => response.status === 503).length === 1 && inits().length === before + 3,
    `statuses=${responses.map(response => response.status)} starts=${inits().length - before}`)
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].status === 200) pending[i < 2 ? 1 : i] = (await readSSE(responses[i])).events
    else await responses[i].text()
  }
  const fullCount = inits().length
  const blocked = await fetchBranch(requests[4])
  const blockedText = await blocked.text()
  check("isolated branches count against the four-process limit without evicting live calls",
    blocked.status === 503 && inits().length === fullCount && fs.existsSync(main.cwd),
    `status=${blocked.status} starts=${inits().length - fullCount} main=${fs.existsSync(main.cwd)} body=${blockedText.slice(0, 200)}`)
  const missing = await fetchBranch(nextTurn(requests[3], pending[3], "continue without this branch's result"))
  check("a sibling carrying its pending call cannot evade the missing-result conflict", missing.status === 400)
  await missing.text()
  const finals = []
  const continued = []
  const owners = []
  for (let i = 0; i < 4; i++) {
    continued[i] = continuation(requests[i], pending[i], `result for branch ${i}`)
    // Replay just this isolated owner while the other two siblings still wait.
    if (i === 1) continued[i].messages.at(-1).content.push({ type: "text", text: "queued branch instruction" })
    if (i === 2) continued[i].tools = [echoTool, { ...echoTool, name: "extraBranchTool" }]
    if (i === 3) {
      continued[i].messages.at(-2).content.find(block => block.type === "tool_use").id = "toolu_renamed_isolated_branch"
      continued[i].messages.at(-1).content[0].tool_use_id = "toolu_renamed_isolated_branch"
    }
    const results = await Promise.all(Array.from({ length: i === 1 || i === 2 ? 2 : 1 }, () => fetchBranch(continued[i])))
    const response = results.find(item => item.status === 200) || results[0]
    if (results.length === 2) {
      check(`concurrent ${i === 1 ? "queued replay" : "catalog update continuation"} consumes branch ${i} only once`,
        results.filter(item => item.status === 200).length === 1 && results.some(item => item.status === 503),
        results.map(item => item.status).join(","))
      for (const other of results) if (other !== response) await other.text()
    }
    finals[i] = response.status === 200 ? (await readSSE(response)).events : []
    if (response.status !== 200) await response.text()
    owners[i] = i === 1 ? lastOf("user").convId : logs().find(event =>
      event.type === "mcpResult" && JSON.stringify(event.result).includes(`result for branch ${i}`))?.convId
    check(`branch ${i} accepts its own tool result while siblings remain live`, response.status === 200 && stopOf(finals[i]) === "end_turn")
  }
  check("main result reached the original MCP process", logs().some(event =>
    event.type === "mcpResult" && event.convId === main.convId && JSON.stringify(event.result).includes("result for branch 0")))
  const saved = JSON.parse(fs.readFileSync(bridgeStateFile, "utf8")).entries
  check("main and completed siblings persist under distinct keys", saved.filter(entry =>
    [main.convId, ...owners.slice(1)].includes(entry.sessionId)).length === 4)
  const followup = nextTurn(continued[1], finals[1], "MEMORY continue isolated branch")
  const count = inits().length
  const followed = (await readSSE(await fetchBranch(followup))).events
  check("later prompts reuse an isolated branch by its exact history", inits().length === count &&
    lastOf("user").convId === owners[1] && lastOf("user").text === "MEMORY continue isolated branch")
  const { default: restartedDefault } = await import("./index.mjs?issue-17-branch-restart")
  const restarted = await (await restartedDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  const restartResponse = await restarted.fetch("agy://local/messages", { method: "POST",
    body: JSON.stringify(nextTurn(followup, followed, "MEMORY isolated after restart")) })
  await readSSE(restartResponse)
  check("isolated branch resumes its durable session after bridge restart", restartResponse.status === 200 &&
    inits().at(-1).resumed && inits().at(-1).convId === owners[1] && lastOf("user").text === "MEMORY isolated after restart")
  const retried = await fetchBranch(requests[4])
  const retriedEvents = retried.status === 200 ? (await readSSE(retried)).events : []
  check("a pool-limit failure releases its prompt claim for retry", retried.status === 200 && stopOf(retriedEvents) === "tool_use",
    `status=${retried.status} stop=${stopOf(retriedEvents)}`)
  if (retried.status === 200) await readSSE(await fetchBranch(continuation(requests[4], retriedEvents, "cleanup capacity retry")))
  else await retried.text()
  const sideWorkspace = inits().find(event => event.convId === owners[3]).cwd
  for (let i = 0; i < 4; i++) await readSSE(await fetchBranch({ model,
    messages: [{ role: "user", content: `MEMORY force branch eviction ${i}` }] }))
  check("idle siblings remain reachable by LRU eviction", !fs.existsSync(sideWorkspace))
  const evicted = await fetchBranch(nextTurn(continued[3], finals[3], "MEMORY resume evicted sibling"))
  await readSSE(evicted)
  check("an evicted sibling resumes its own snapshot without replay", evicted.status === 200 &&
    inits().at(-1).resumed && inits().at(-1).convId === owners[3] && lastOf("user").text === "MEMORY resume evicted sibling")
}

{
  const savedEnv = Object.fromEntries(["AGY_BRIDGE_MAX_PROCS", "AGY_BRIDGE_DETACHED_EVICT_MS", "AGY_BRIDGE_TOOL_TIMEOUT_MS"]
    .map(key => [key, process.env[key]]))
  try {
    process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "30000"
    process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "30000"
    const { default: pressureDefault } = await import("./index.mjs?issue-29-pressure")
    const pressureLoader = await (await pressureDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
    const fetchPressure = body => pressureLoader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
    const requests = Array.from({ length: 4 }, (_, i) => ({ model, metadata: { user_id: `issue-29-pressure-${i}` },
      messages: [{ role: "user", content: `ESCCALL pressure wait ${i}` }], tools: [echoTool] }))
    const pending = []
    const owners = []
    const started = Date.now()
    for (const request of requests) {
      pending.push((await readSSE(await fetchPressure(request))).events)
      owners.push(inits().at(-1))
    }
    check("pressure fixture leaves four unfinished tool turns", pending.every(events => stopOf(events) === "tool_use") &&
      new Set(owners.map(owner => owner.convId)).size === 4)
    const admission = { model, metadata: { user_id: "issue-29-pressure-admission" },
      messages: [{ role: "user", content: "new request under process pressure" }] }
    const before = inits().length
    const blocked = await fetchPressure(admission)
    const blockedText = await blocked.text()
    check("pool pressure protects recent detached tool waits", blocked.status === 503 && inits().length === before &&
      owners.every(owner => fs.existsSync(owner.cwd)) &&
      !logs().some(event => event.type === "mcpResult" && owners.some(owner => owner.convId === event.convId)),
      `status=${blocked.status} body=${blockedText.slice(0, 200)}`)

    // The grace is read at admission time, independently of the longer tool deadline.
    process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "100"
    await new Promise(resolve => setTimeout(resolve, 150))
    const admitted = await fetchPressure(admission)
    const admittedEvents = (await readSSE(admitted)).events
    const idle = inits().at(-1)
    check("pressure reclaims the oldest detached tool wait before its normal timeout", admitted.status === 200 &&
      stopOf(admittedEvents) === "end_turn" && Date.now() - started < 30000 &&
      !fs.existsSync(owners[0].cwd) && owners.slice(1).every(owner => fs.existsSync(owner.cwd)),
      `status=${admitted.status} elapsed=${Date.now() - started}`)

    const late = continuation(requests[0], pending[0], "actual result delivered after pressure eviction")
    const replay = await fetchPressure(late)
    const replayEvents = (await readSSE(replay)).events
    const replacement = inits().at(-1)
    const prompt = lastOf("user")
    check("a late valid tool result replays in a fresh replacement session", replay.status === 200 &&
      stopOf(replayEvents) === "end_turn" && replacement.convId !== owners[0].convId && !replacement.resumed &&
      prompt.convId === replacement.convId && prompt.text.includes("<conversation_history>") &&
      prompt.text.includes("ESCCALL pressure wait 0") && prompt.text.includes(toolCall(pending[0])?.id) &&
      prompt.text.includes("actual result delivered after pressure eviction"),
      `status=${replay.status} stop=${stopOf(replayEvents)} prompt=${prompt.text}`)
    check("pressure evicts an idle session before other eligible detached waits", !fs.existsSync(idle.cwd) &&
      owners.slice(1).every(owner => fs.existsSync(owner.cwd)))
    for (let i = 1; i < requests.length; i++) {
      const result = `preserved pressure result ${i}`
      const events = (await readSSE(await fetchPressure(continuation(requests[i], pending[i], result)))).events
      check(`unreclaimed detached turn ${i} still accepts its own result`, stopOf(events) === "end_turn" &&
        logs().some(event => event.type === "mcpResult" && event.convId === owners[i].convId && JSON.stringify(event.result).includes(result)))
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

{
  const savedEnv = Object.fromEntries(["AGY_BRIDGE_MAX_PROCS", "AGY_BRIDGE_DETACHED_EVICT_MS", "AGY_BRIDGE_TOOL_TIMEOUT_MS"]
    .map(key => [key, process.env[key]]))
  try {
    process.env.AGY_BRIDGE_MAX_PROCS = "2"
    process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "30000"
    process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "30000"
    const { default: branchPressureDefault } = await import("./index.mjs?issue-29-branch-pressure")
    const loader = await (await branchPressureDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
    const fetchBranch = (body, headers) => loader.fetch("agy://local/messages", { method: "POST", headers, body: JSON.stringify(body) })
    for (const [label, reclaimRoot, rename, normalizeInputs] of [
      ["original IDs", false, false], ["normalized original IDs", false, false, true],
      ["canonical IDs", false, true], ["root reclaimed", true, true],
    ]) {
      const opening = { model, metadata: { user_id: `pressure-branch-${label}` }, tools: [echoTool],
        messages: [{ role: "user", content: `shared pressure opening ${label}` }] }
      const base = (await readSSE(await fetchBranch(opening))).events
      const root = nextTurn(opening, base, "BRANCHCALL branch 0")
      const rootPending = (await readSSE(await fetchBranch(root))).events
      const rootOwner = inits().at(-1)
      const side = nextTurn(opening, base, "BRANCHCALL branch 1")
      const sidePending = (await readSSE(await fetchBranch(side))).events
      const sideOwner = inits().at(-1)
      const survivor = reclaimRoot ? side : root
      const survivorPending = reclaimRoot ? sidePending : rootPending
      const survivorOwner = reclaimRoot ? sideOwner : rootOwner
      const victim = reclaimRoot ? root : side
      const victimPending = reclaimRoot ? rootPending : sidePending
      const victimOwner = reclaimRoot ? rootOwner : sideOwner
      // Recording the survivor's emitted call refreshes its client clock without
      // supplying a result or ending its live turn.
      await new Promise(resolve => setTimeout(resolve, 20))
      const refresh = await fetchBranch({ ...survivor, messages: [...survivor.messages,
        { role: "assistant", content: assistantBlocks(survivorPending) }, { role: "user", content: "still waiting" }] })
      await refresh.text()
      process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "10"
      await new Promise(resolve => setTimeout(resolve, 30))
      const admitted = await fetchBranch({ model, messages: [{ role: "user", content: `pressure admission ${label}` }] })
      await readSSE(admitted)
      check(`${label}: pressure removes only the older branch`, admitted.status === 200 &&
        !fs.existsSync(victimOwner.cwd) && fs.existsSync(survivorOwner.cwd))

      const late = continuation(victim, victimPending, `late branch result ${label}`)
      if (normalizeInputs) {
        const call = late.messages.at(-2).content.find(block => block.type === "tool_use")
        call.input = { ...call.input, replace_all: false }
      }
      if (rename) {
        for (const block of late.messages.at(-2).content) if (block.type === "tool_use") block.id = `renamed-${block.id}`
        for (const block of late.messages.at(-1).content) block.tool_use_id = `renamed-${block.tool_use_id}`
      }
      if (!reclaimRoot) {
        for (const change of ["history", "tool name", "renamed inputs", "work directory", "incomplete"]) {
          const unrelated = structuredClone(late)
          if (change === "history") unrelated.messages.at(-3).content += " changed historical text"
          if (change === "tool name") unrelated.messages.at(-2).content.find(block => block.type === "tool_use").name = "unrelated_tool"
          if (change === "renamed inputs") {
            for (const block of unrelated.messages.at(-2).content) if (block.type === "tool_use") {
              block.id = `different-${block.id}`
              block.input = { text: "unrelated" }
            }
            for (const block of unrelated.messages.at(-1).content) block.tool_use_id = `different-${block.tool_use_id}`
          }
          if (change === "incomplete") unrelated.messages.at(-1).content.push({ type: "tool_result", tool_use_id: "unknown", content: "unrelated" })
          const rejected = await fetchBranch(unrelated, change === "work directory" ? { "x-magpie-work-dir": stateDir } : undefined)
          check(`${label}: reclaimed routing rejects ${change} mismatch`, rejected.status === 409 && fs.existsSync(survivorOwner.cwd))
          await rejected.text()
        }
      }
      process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "30000"
      process.env.AGY_BRIDGE_MAX_PROCS = "1"
      const blockedReplay = await fetchBranch(late)
      check(`${label}: failed replay admission preserves the surviving branch`, blockedReplay.status === 503 && fs.existsSync(survivorOwner.cwd))
      await blockedReplay.text()
      process.env.AGY_BRIDGE_MAX_PROCS = "2"
      const replay = await fetchBranch(late)
      const replayEvents = replay.status === 200 ? (await readSSE(replay)).events : []
      if (replay.status !== 200) await replay.text()
      const prompt = lastOf("user")
      check(`${label}: complete results alone replay the reclaimed branch`, replay.status === 200 &&
        stopOf(replayEvents) === "end_turn" && prompt.convId !== survivorOwner.convId &&
        prompt.text.includes(`late branch result ${label}`) && fs.existsSync(survivorOwner.cwd) &&
        !logs().some(event => event.type === "mcpResult" && event.convId === survivorOwner.convId),
        `status=${replay.status} stop=${stopOf(replayEvents)}`)
      const result = `surviving branch result ${label}`
      const done = (await readSSE(await fetchBranch(continuation(survivor, survivorPending, result)))).events
      check(`${label}: surviving branch completes in its original process`, stopOf(done) === "end_turn" &&
        logs().some(event => event.type === "mcpResult" && event.convId === survivorOwner.convId && event.result?.content?.[0]?.text === result))
      process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "30000"
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

{
  const keys = ["AGY_BRIDGE_MAX_PROCS", "AGY_BRIDGE_DETACHED_EVICT_MS", "AGY_BRIDGE_TOOL_TIMEOUT_MS",
    "FAKE_AGY_TOOL_LIST_DELAY_MS", "AGY_BRIDGE_TOOL_LIST_WAIT_MS"]
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    process.env.AGY_BRIDGE_MAX_PROCS = "1"
    process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "10"
    process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "30000"
    process.env.FAKE_AGY_TOOL_LIST_DELAY_MS = "500"
    process.env.AGY_BRIDGE_TOOL_LIST_WAIT_MS = "2000"
    const { default: acceptingDefault } = await import("./index.mjs?issue-29-accepting-results")
    const loader = await (await acceptingDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
    const fetchAccepting = body => loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
    const first = { model, tools: [echoTool], messages: [{ role: "user", content: "ESCCALL accepting renamed results" }] }
    const pending = (await readSSE(await fetchAccepting(first))).events
    const owner = inits().at(-1)
    const continued = continuation(first, pending, "accepted result survives catalog wait")
    continued.tools = [echoTool, { name: "delayed_other", input_schema: { type: "object" } }]
    for (const block of continued.messages.at(-2).content) if (block.type === "tool_use") block.id = `renamed-${block.id}`
    for (const block of continued.messages.at(-1).content) block.tool_use_id = `renamed-${block.tool_use_id}`
    const accepting = fetchAccepting(continued)
    for (let attempt = 0; attempt < 100 && !logs().some(event => event.type === "toolsListDelayed" && event.convId === owner.convId); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    const blocked = await fetchAccepting({ model, messages: [{ role: "user", content: "concurrent admission during catalog ACK" }] })
    check("accepted renamed results protect their process while catalog ACK waits", blocked.status === 503 &&
      fs.existsSync(owner.cwd) && logs().some(event => event.type === "toolsListDelayed" && event.convId === owner.convId) &&
      !logs().some(event => event.type === "toolsList" && event.reason === "list_changed" && event.convId === owner.convId))
    await blocked.text()
    const response = await accepting
    const events = response.status === 200 ? (await readSSE(response)).events : []
    if (response.status !== 200) await response.text()
    check("accepted renamed continuation succeeds after delayed catalog ACK", response.status === 200 && stopOf(events) === "end_turn" &&
      logs().some(event => event.type === "mcpResult" && event.convId === owner.convId && event.result?.content?.[0]?.text === "accepted result survives catalog wait"))
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

{
  const savedEnv = Object.fromEntries(["AGY_BRIDGE_MAX_PROCS", "AGY_BRIDGE_DETACHED_EVICT_MS", "AGY_BRIDGE_TOOL_TIMEOUT_MS"]
    .map(key => [key, process.env[key]]))
  try {
    process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "30000"
    process.env.AGY_BRIDGE_DETACHED_EVICT_MS = "30000"
    const { default: capacityDefault } = await import("./index.mjs?issue-29-capacity")
    const capacityLoader = await (await capacityDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
    const fetchCapacity = body => capacityLoader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
    // Change the limit after import to cover dynamic configuration as well.
    delete process.env.AGY_BRIDGE_MAX_PROCS
    const requests = Array.from({ length: 7 }, (_, i) => ({ model, metadata: { user_id: `issue-29-capacity-${i}` },
      messages: [{ role: "user", content: `ESCCALL capacity wait ${i}` }], tools: [echoTool] }))
    const pending = []
    const owners = []
    for (let i = 0; i < 6; i++) {
      if (i === 5) process.env.AGY_BRIDGE_MAX_PROCS = "6"
      const response = await fetchCapacity(requests[i])
      pending.push((await readSSE(response)).events)
      owners.push(inits().at(-1))
      if (i >= 4) check(`${i === 4 ? "default" : "configured"} process capacity accepts ${i + 1} unfinished tool turns`,
        response.status === 200 && pending.every(events => stopOf(events) === "tool_use") &&
        new Set(owners.map(owner => owner.convId)).size === i + 1 && owners.every(owner => fs.existsSync(owner.cwd)) &&
        !logs().some(event => event.type === "mcpResult" && owners.some(owner => owner.convId === event.convId)))
    }
    const before = inits().length
    const blocked = await fetchCapacity(requests[6])
    await blocked.text()
    check("configured capacity still rejects an extra request while all six waits are recent", blocked.status === 503 && inits().length === before)
    for (let i = 0; i < pending.length; i++) {
      const result = `capacity result ${i}`
      const events = (await readSSE(await fetchCapacity(continuation(requests[i], pending[i], result)))).events
      check(`concurrent capacity turn ${i} retains its original tool owner`, stopOf(events) === "end_turn" &&
        logs().some(event => event.type === "mcpResult" && event.convId === owners[i].convId && JSON.stringify(event.result).includes(result)))
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

{
  const first = { model, metadata: { user_id: "issue-17-partial-steering" },
    messages: [{ role: "user", content: "PARALLEL partial results with steering" }], tools: [echoTool] }
  const initial = (await readSSE(await callFetch(first))).events
  // Parallel calls can arrive in separate tool_use responses. Collect the next
  // round first if necessary, then leave at least one visible result unanswered.
  let body = first
  let pending = initial
  if (toolCalls(pending).length < 2) {
    body = continuation(first, pending, "first parallel output")
    pending = (await readSSE(await callFetch(body))).events
  }
  const partial = continuation(body, pending, "partial output")
  partial.messages.at(-1).content.push({ type: "text", text: "queued incomplete instruction" })
  if (toolCalls(initial).length >= 2) partial.messages.at(-1).content.splice(0, 1)
  else partial.messages.at(-2).content.push({ type: "tool_use", id: "toolu_missing_queued_result", name: "echo", input: {} })
  const count = inits().length
  const response = await callFetch(partial)
  await response.text()
  check("queued text cannot replay incomplete results or destroy the live owner", response.status === 400 && inits().length === count)
  const done = await drive(body, pending, "remaining actual output")
  check("a complete batch can continue after rejected partial steering", stopOf(done.events) === "end_turn" && inits().length === count)
}

{
  const hook = "Opening hook context. ".repeat(1600)
  const inline = { model, metadata: { user_id: "layout-flip" }, system: "base system",
    messages: [{ role: "system", content: [{ type: "text", text: hook }] },
      { role: "user", content: "TOOL layout continuation" }], tools: [echoTool], stream: false }
  // Non-streaming fallback hoists exactly the same context with a different separator.
  const hoisted = { ...inline, system: "base system\n" + hook, messages: inline.messages.slice(1) }
  const before = inits().length
  const response = await callFetch(hoisted)
  const message = await response.json()
  const owner = inits().at(-1).convId
  check("layout fixture returns non-streaming tool_use", response.status === 200 && message.stop_reason === "tool_use")
  const followup = { ...inline, stream: true, messages: [...inline.messages,
    { role: "assistant", content: message.content }, { role: "user", content: message.content
      .filter(block => block.type === "tool_use").map(block => ({ type: "tool_result", tool_use_id: block.id, content: "layout result" })) }] }
  const result = await callFetch(followup)
  const final = result.status === 200 ? (await readSSE(result)).events : []
  if (result.status !== 200) await result.text()
  check("inline and hoisted layouts continue the same tool turn", result.status === 200 && stopOf(final) === "end_turn" && inits().length === before + 1 && lastOf("user").convId === owner)
  check("layout flip performs only the original full prompt", logs().filter(event => event.type === "user" && event.convId === owner).length === 1)
}

{
  const orphan = { type: "tool_use", id: "toolu_lost_after_restart", name: "echo", input: { text: "old" } }
  const body = { model, metadata: { user_id: "esc-orphan" }, messages: [
    { role: "user", content: "a previous task" },
    { role: "assistant", content: [orphan] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: orphan.id, content: "orphan result preserved" },
      { type: "text", text: "[Request interrupted by user]" }, { type: "text", text: "continue now" }] },
  ], tools: [echoTool] }
  const response = await callFetch(body)
  const final = response.status === 200 ? (await readSSE(response)).events : []
  if (response.status !== 200) await response.text()
  check("Esc plus an orphan result replays as a fresh prompt instead of 409", response.status === 200 && stopOf(final) === "end_turn")
  check("Esc replay preserves the orphan result and the new instruction", lastOf("user").text.includes("orphan result preserved") && lastOf("user").text.includes("continue now"))
}

{
  const body = { model, metadata: { user_id: "unknown-tool-result" }, messages: [
    { role: "user", content: "incomplete history" },
    { role: "assistant", content: "there was no tool call" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_never_issued", content: "unknown result" }] },
  ] }
  const before = inits().length
  const responses = await Promise.all([callFetch(body), callFetch(body)])
  const payloads = await Promise.all(responses.map(response => response.text()))
  check("permanent orphan conflicts are 400 with x-should-retry false", responses.every(response => response.status === 400 && response.headers.get("x-should-retry") === "false"))
  check("permanent conflict retries return the same structured error", payloads[0] === payloads[1] && JSON.parse(payloads[0]).error?.code === "tool_history_incomplete")
  check("permanent conflicts never start an agy process", inits().length === before)
}

{
  const body = { model, metadata: { user_id: "pending-lineage-conflict" },
    messages: [{ role: "user", content: "TOOL pending ownership" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(body))).events
  const owner = inits().at(-1)
  const before = inits().length
  const partial = continuation(body, pending, "known result")
  partial.messages.at(-1).content.push({ type: "tool_result", tool_use_id: "toolu_partial_unknown", content: "unknown" })
  const retryable = await callFetch(partial)
  check("partial matches retain upstream 409 without a no-retry header", retryable.status === 409 && retryable.headers.get("x-should-retry") === null)
  await retryable.text()
  const unmatched = { ...body, messages: [...body.messages,
    { role: "assistant", content: [{ type: "text", text: "a different recorded response" },
      { type: "tool_use", id: "toolu_unmatched_lineage", name: "echo", input: { text: "different" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_unmatched_lineage", content: "unmatched" }] },
  ] }
  const live = await callFetch(unmatched)
  const sibling = (await readSSE(live)).events
  check("self-consistent unmatched results replay independently of an unexpired owner", live.status === 200 &&
    inits().length === before + 1 && lastOf("user").convId !== owner.convId && fs.existsSync(owner.cwd) &&
    !logs().some(event => event.type === "mcpResult" && event.convId === owner.convId))
  await drive(unmatched, sibling, "finish unmatched sibling")
  const afterSibling = inits().length
  const conflict = nextTurn(body, pending, "no result for this pending call")
  const response = await callFetch(conflict)
  const error = await response.json()
  check("a request carrying the pending call without its result is terminal", response.status === 400 && response.headers.get("x-should-retry") === "false" && error.error?.code === "tool_state_conflict")
  const done = await drive(body, pending, "real result after conflict")
  check("terminal lineage conflicts leave the original tool turn usable", inits().length === afterSibling && stopOf(done.events) === "end_turn")
}

{
  // The existing LONGTOOL fake repeats identical calls until told to stop.
  // Speed up its MCP deadline, keeping the production default repeat cap of 8.
  process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = "25"
  const body = { model, metadata: { user_id: "bounded-self-poll" },
    messages: [{ role: "user", content: "LONGTOOL orphan poll regression" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(body))).events
  const old = inits().at(-1)
  for (let attempt = 0; attempt < 100 && fs.existsSync(old.cwd); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
  const replies = logs().filter(event => event.type === "mcpResult" && event.convId === old.convId)
  const notes = replies.filter(event => /still running/.test(event.result?.content?.[0]?.text || ""))
  check("self polling stops after the default eight still-running replies", notes.length === 8 && !fs.existsSync(old.cwd), `${notes.length} replies`)
  // A real tool's late result can still be replayed after the bounded wait.
  const late = continuation(body, pending, "actual long tool result")
  late.messages.at(-1).content.push({ type: "text", text: "[Request interrupted by user]" })
  const response = await callFetch(late)
  const final = response.status === 200 ? (await readSSE(response)).events : []
  if (response.status !== 200) await response.text()
  check("late real results survive bounded self-poll reclamation", response.status === 200 && lastOf("user").text.includes("actual long tool result"))
  if (stopOf(final) === "tool_use") await drive(late, final, "cleanup late replay")
}

{
  // Advance only the bridge's wall clock; ACP/MCP still uses the upstream fake.
  // Keep its tool deadline above 20 minutes so this exercises the self-poll
  // idle limit, not the independent tool-result timeout.
  const savedToolTimeout = process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS
  process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = String(30 * 60 * 1000)
  process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = "100"
  const { default: idleDefault } = await import("./index.mjs?self-poll-idle")
  process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = savedToolTimeout
  const idleLoader = await (await idleDefault.server({}, {})).auth.loader(async () => ({ key: "agy" }))
  const events = []
  const write = process.stderr.write
  const now = Date.now
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).startsWith("[agy-bridge] ")) events.push(JSON.parse(String(chunk).slice(13)))
    return write.call(this, chunk, ...args)
  }
  try {
    const response = await idleLoader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify({
      model, metadata: { user_id: "self-poll-idle-deadline" }, tools: [echoTool],
      messages: [{ role: "user", content: "LONGTOOL idle deadline" }],
    }) })
    const pending = (await readSSE(response)).events
    const old = inits().at(-1)
    Date.now = () => now() + 20 * 60 * 1000 + 1
    for (let attempt = 0; attempt < 100 && fs.existsSync(old.cwd); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    const cap = events.find(event => event.reason === "self_poll_cap")
    check("twenty minutes of client inactivity beats the self-poll count cap", toolCalls(pending).length === 1 && cap?.self_poll_repeats === 1 && cap.client_idle_ms >= 20 * 60 * 1000 && !fs.existsSync(old.cwd))
    check("agy traffic does not reset the client inactivity clock", cap?.client_idle_ms >= 20 * 60 * 1000)
  } finally {
    Date.now = now
    process.stderr.write = write
    delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
  }
}

// Hermes-style client compaction: the pending tool turn's history is rewritten,
// and a restated user request is merged into the same message as the result.
{
  const first = { model, metadata: { user_id: "hermes-compaction" }, system: "hermes system",
    messages: [{ role: "user", content: "ESCCALL hermes compaction" }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  const old = inits().at(-1)
  const calls = toolCalls(pending)
  const compactedAssistant = { role: "assistant", content: [{ type: "text", text: "[CONTEXT COMPACTION] summary of earlier turns" }, ...calls] }
  const results = calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "compacted result" }))
  const body = { ...first, messages: [first.messages[0], compactedAssistant,
    { role: "user", content: [...results, { type: "text", text: "[STILL IN PROGRESS] restated request" }] }] }
  const response = await callFetch(body)
  const final = response.status === 200 ? (await readSSE(response)).events : []
  if (response.status !== 200) await response.text()
  check("compacted history with merged restated request replays instead of 400", response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  check("compaction replay carries the real result and the restated request",
    lastOf("user").convId !== old.convId && lastOf("user").text.includes("compacted result") && lastOf("user").text.includes("restated request"))
}

// After a failed tool-result request the client moves on with a new prompt whose
// history already holds the pending calls and their results.
for (const compacted of [true, false]) {
  const label = compacted ? "rewritten" : "unchanged"
  const first = { model, metadata: { user_id: `moved-on-${label}` }, system: "hermes system",
    messages: [{ role: "user", content: `ESCCALL moved on ${label}` }], tools: [echoTool] }
  const pending = (await readSSE(await callFetch(first))).events
  const old = inits().at(-1)
  const calls = toolCalls(pending)
  const assistant = compacted
    ? { role: "assistant", content: [{ type: "text", text: "[CONTEXT COMPACTION] summary" }, ...calls] }
    : { role: "assistant", content: assistantBlocks(pending) }
  const body = { ...first, messages: [first.messages[0], assistant,
    { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: `answered ${label}` })) },
    { role: "assistant", content: "This turn did not complete." },
    { role: "user", content: `continue after ${label} history` }] }
  const response = await callFetch(body)
  const final = response.status === 200 ? (await readSSE(response)).events : []
  if (response.status !== 200) await response.text()
  check(`new prompt carrying answered pending calls (${label} history) supersedes instead of wedging`, response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  check(`moved-on replay (${label}) keeps the answered result and the new prompt`,
    lastOf("user").convId !== old.convId && lastOf("user").text.includes(`answered ${label}`) && lastOf("user").text.includes(`continue after ${label} history`))
}

{
  const first = { model, metadata: { user_id: "dropped-calls" }, system: "hermes system",
    messages: [{ role: "user", content: "ESCCALL dropped calls" }], tools: [echoTool] }
  await readSSE(await callFetch(first))
  const body = { ...first, messages: [{ role: "user", content: "ESCCALL dropped calls" },
    { role: "assistant", content: "[CONTEXT COMPACTION] summary, the pending call was summarized away" },
    { role: "user", content: "continue after the call was dropped" }] }
  const response = await callFetch(body)
  if (response.status === 200) await readSSE(response); else await response.text()
  check("a rewritten history that summarized the pending call away goes on", response.status === 200, `got ${response.status}`)
}

{
  const t1 = { model, metadata: { user_id: "gap-rewrite-base" }, system: "hermes system",
    messages: [{ role: "user", content: "first plain question" }], tools: [echoTool] }
  const e1 = (await readSSE(await callFetch(t1))).events
  const t2 = nextTurn(t1, e1, "ESCCALL second turn")
  await readSSE(await callFetch(t2))
  // compaction rewrites the first reply AND drops the pending call
  const body = { ...t1, messages: [t1.messages[0], { role: "assistant", content: "[CONTEXT COMPACTION] summary" },
    { role: "user", content: "continue after compaction" }] }
  const response = await callFetch(body)
  const st = response.status
  if (st === 200) await readSSE(response); else await response.text()
  check("a compaction that rewrote earlier replies and dropped the pending call supersedes instead of 503", st === 200, `got ${st}`)
}

{
  const usageOf = events => events.find(event => event.event === "message_delta")?.data?.usage || {}
  const hasSqlite = await import("node:sqlite").then(() => true, () => import("bun:sqlite").then(() => true, () => false))
  for (const [variant, store] of [["MEASURED", ""], ["MEASURED_LAG", ""], ["MEASURED", "generation"],
    ["MEASURED_LAG", "generation"], ["MEASURED", "both"], ["MEASURED", "empty-generation"]]) {
    process.env.FAKE_AGY_USAGE_STORE = store
    const label = variant + "/" + (store || "steps")
    const first = { model, metadata: { user_id: "measured-" + label }, messages: [{ role: "user", content: variant + " usage" }], tools: [echoTool] }
    const firstEvents = (await readSSE(await callFetch(first))).events
    const lastEvents = (await readSSE(await callFetch(continuation(first, firstEvents, "measured-result")))).events
    const step = usageOf(firstEvents)
    const final = usageOf(lastEvents)
    if (!hasSqlite) {
      // No SQLite in this runtime (Node < 22.5): the estimate still applies.
      check(`${label}: without SQLite the step usage is estimated`,
        stopOf(lastEvents) === "end_turn" && step.input_tokens > 0 && final.input_tokens + final.cache_read_input_tokens > 0)
      continue
    }
    check(`${label}: tool step reports its model call from agy's store`,
      stopOf(firstEvents) === "tool_use" && step.input_tokens === 3000 && step.cache_read_input_tokens === 0 && step.output_tokens === 44,
      JSON.stringify(step))
    check(`${label}: final step reports its own call with the cache hit`,
      stopOf(lastEvents) === "end_turn" && final.input_tokens === 500 && final.cache_read_input_tokens === 3000 && final.output_tokens === 20,
      JSON.stringify(final))
  }
  delete process.env.FAKE_AGY_USAGE_STORE
}

{
  // AGY_BRIDGE_STEP_USAGE=0 must skip the conversation store and keep the
  // estimate, even when the store has real per-call numbers.
  process.env.AGY_BRIDGE_STEP_USAGE = "0"
  try {
    const first = { model, metadata: { user_id: "measured-disabled" }, messages: [{ role: "user", content: "MEASURED disabled" }], tools: [echoTool] }
    const firstEvents = (await readSSE(await callFetch(first))).events
    const lastEvents = (await readSSE(await callFetch(continuation(first, firstEvents, "disabled-result")))).events
    const usageOf = events => events.find(event => event.event === "message_delta")?.data?.usage || {}
    const step = usageOf(firstEvents)
    check("AGY_BRIDGE_STEP_USAGE=0 skips the store and keeps the estimate",
      stopOf(lastEvents) === "end_turn" && step.input_tokens > 0 &&
        !(step.input_tokens === 3000 && step.cache_read_input_tokens === 0 && step.output_tokens === 44),
      JSON.stringify(step))
  } finally {
    delete process.env.AGY_BRIDGE_STEP_USAGE
  }
}

{
  // A store whose per-call prompts cannot be reconciled with ACP's total must
  // not be reported as measured usage.
  const first = { model, metadata: { user_id: "measured-inflated" }, messages: [{ role: "user", content: "MEASURED_INFLATED usage" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const lastEvents = (await readSSE(await callFetch(continuation(first, firstEvents, "inflated-result")))).events
  const usageOf = events => events.find(event => event.event === "message_delta")?.data?.usage || {}
  const final = usageOf(lastEvents)
  check("an over-counted store falls back instead of reporting unreconciled numbers",
    stopOf(lastEvents) === "end_turn" &&
      !(final.input_tokens === 500 && final.cache_read_input_tokens === 3000 && final.output_tokens === 20),
    JSON.stringify(final))
}

{
  const body = { model, metadata: { user_id: "cutoff-once" }, messages: [{ role: "user", content: "CUTOFF write a lot" }] }
  const events = (await readSSE(await callFetch(body))).events
  const prompts = logs().filter(event => event.type === "user" && /Continue exactly where your previous output stopped/.test(event.text))
  check("max_tokens continues in the same response", stopOf(events) === "end_turn" && textOf(events) === "part one, part two", JSON.stringify(textOf(events)))
  check("agy's output-cap notice is not shown", !/cut off|Retries remaining/.test(textOf(events)))
  check("one continuation prompt for one cut", prompts.length === 1, String(prompts.length))
}

{
  const before = logs().filter(event => event.type === "user" && /Continue exactly where your previous output stopped/.test(event.text)).length
  const body = { model, metadata: { user_id: "cutoff-always" }, messages: [{ role: "user", content: "CUTOFF_ALWAYS write a lot" }] }
  const events = (await readSSE(await callFetch(body))).events
  const after = logs().filter(event => event.type === "user" && /Continue exactly where your previous output stopped/.test(event.text)).length
  check("continuations stop after three and report max_tokens", stopOf(events) === "max_tokens" && after - before === 3, `${stopOf(events)} ${after - before}`)
  check("all continued text stays in one response", textOf(events) === "part one,  more more more", JSON.stringify(textOf(events)))
}

// Combined regression: a timed-out replay fork cannot destroy another branch's
// pending tool; plain queued steering must still recover with the real result.
{
  const previous = process.env.AGY_BRIDGE_TURN_TIMEOUT_MS
  const previousToolTimeout = process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS
  process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "250"
  process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "5000"
  const { default: combinedDefault } = await import("./index.mjs?combined-issues")
  process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = previous
  process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = previousToolTimeout
  const combinedPlugin = await combinedDefault.server({ client: null, directory: os.tmpdir() }, {})
  const combinedLoader = await combinedPlugin.auth.loader(async () => ({ key: "agy" }))
  const fetchCombined = body => combinedLoader.fetch("agy://local/messages", {
    method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  const main = { model, metadata: { user_id: "combined-issues" }, tools: [echoTool],
    messages: [{ role: "user", content: "COMBINED_PENDING shared opening" }] }
  const pending = (await readSSE(await fetchCombined(main))).events
  const owner = inits().at(-1)
  const fork = { ...main, messages: [
    ...main.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "historical_combined", name: "echo", input: { text: "old" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "historical_combined", content: "historical combined fact" }] },
    { role: "assistant", content: "Recorded." },
    { role: "user", content: "IDLE_SILENT combined background request" },
  ] }
  const forkResponse = await fetchCombined(fork)
  const forkEvents = (await readSSE(forkResponse)).events
  const forkPrompt = lastOf("user")
  check("combined fork replays delimited historical results", forkPrompt.convId !== owner.convId &&
    forkPrompt.text.includes('<tool_record role="result"') && forkPrompt.text.includes("historical combined fact"))
  check("combined fork emits lifecycle then a terminal inactivity error", forkEvents[0]?.event === "message_start" &&
    forkEvents.at(-1)?.data.error?.code === "upstream_idle_timeout")
  check("background timeout preserves the main branch's pending process", fs.existsSync(owner.cwd))
  const queued = continuation(main, pending, "combined actual result")
  queued.messages.at(-1).content.push({ type: "text", text: "COMBINED_RESUME use the result and finish" })
  const resumedResponse = await fetchCombined(queued)
  const resumed = (await readSSE(resumedResponse)).events
  const replayPrompt = lastOf("user")
  check("main results with same-message steering recover after sibling timeout", resumedResponse.status === 200 &&
    stopOf(resumed) === "end_turn")
  check("combined recovery delivers the result once and preserves queued steering", replayPrompt.convId === owner.convId &&
    logs().filter(event => event.type === "mcpResult" && event.convId === owner.convId &&
      JSON.stringify(event.result).includes("combined actual result")).length === 1 &&
    replayPrompt.text.split("COMBINED_RESUME use the result and finish").length === 2)
  const retry = await fetchCombined(fork)
  check("timed-out fork remains dedup protected after main recovery", retry.status === 409 &&
    (await retry.json()).error?.code === "prompt_outcome_unknown" &&
    logs().filter(event => event.type === "user" && event.text.includes("IDLE_SILENT combined background request")).length === 1)
  const followup = nextTurn(queued, resumed, "Continue after the recovered result")
  const completed = (await readSSE(await fetchCombined(followup))).events
  check("main follow-up reuses its recovered session after sibling failure", stopOf(completed) === "end_turn" &&
    lastOf("user").convId === replayPrompt.convId && !lastOf("user").text.includes("<conversation_history>"))

  for (const [label, steering] of [
    ["results only", null],
    ["interruption marker", "[Request interrupted by user]"],
    ["ordinary queued text", "Use the completed fork result and finish this side request."],
  ]) {
    const opening = { model, metadata: { user_id: `reclaimed-fork-${label}` }, tools: [echoTool],
      messages: [{ role: "user", content: `shared opening for reclaimed fork ${label}` }] }
    const base = (await readSSE(await fetchCombined(opening))).events
    const root = nextTurn(opening, base, "BRANCHCALL branch 0")
    const rootPending = (await readSSE(await fetchCombined(root))).events
    const rootOwner = inits().at(-1)
    const side = nextTurn(opening, base, "LONGTOOL reclaimed side request")
    let sidePending
    let sideOwner
    const previousDeadline = process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
    process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = "25"
    try {
      sidePending = (await readSSE(await fetchCombined(side))).events
      sideOwner = inits().at(-1)
      for (let attempt = 0; attempt < 100 && fs.existsSync(sideOwner.cwd); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    } finally {
      if (previousDeadline === undefined) delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
      else process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS = previousDeadline
    }
    const polls = logs().filter(event => event.type === "mcpResult" && event.convId === sideOwner.convId &&
      /still running/.test(event.result?.content?.[0]?.text || ""))
    check(`${label}: self-poll reclamation removes only the fork`, toolCalls(rootPending).length === 1 &&
      toolCalls(sidePending).length === 1 && sideOwner.convId !== rootOwner.convId && polls.length === 8 &&
      !fs.existsSync(sideOwner.cwd) && fs.existsSync(rootOwner.cwd))

    const actualResult = `actual reclaimed fork result for ${label}`
    const late = continuation(side, sidePending, actualResult)
    const beforeReplay = inits().length
    if (steering) late.messages.at(-1).content.push({ type: "text", text: steering })
    const recovered = await fetchCombined(late)
    let recoveredEvents = recovered.status === 200 ? (await readSSE(recovered)).events : []
    if (recovered.status !== 200) await recovered.text()
    const recoveredPrompt = lastOf("user")
    check(`${label}: fork results replay while the root still waits`, recovered.status === 200 &&
      inits().length === beforeReplay + 1 && recoveredPrompt.convId !== rootOwner.convId &&
      recoveredPrompt.convId !== sideOwner.convId && fs.existsSync(rootOwner.cwd) &&
      !logs().some(event => event.type === "mcpResult" && event.convId === rootOwner.convId))
    check(`${label}: fork replay preserves the real result and steering once`, recovered.status === 200 &&
      recoveredPrompt.text.split(actualResult).length === 2 && (!steering || recoveredPrompt.text.split(steering).length === 2))
    // The LONGTOOL fake asks for a new tool even when its trigger is in replayed
    // history. Complete that round before checking the independent root owner.
    let recoveredBody = late
    for (let round = 0; round < 3 && stopOf(recoveredEvents) === "tool_use"; round++) {
      recoveredBody = continuation(recoveredBody, recoveredEvents, "finish recovered side request")
      recoveredEvents = (await readSSE(await fetchCombined(recoveredBody))).events
    }
    check(`${label}: recovered fork finishes normally`, stopOf(recoveredEvents) === "end_turn")

    const beforeRootResult = inits().length
    const rootResult = `original root result for ${label}`
    const rootDone = (await readSSE(await fetchCombined(continuation(root, rootPending, rootResult)))).events
    check(`${label}: root subsequently completes in its original process`, stopOf(rootDone) === "end_turn" &&
      inits().length === beforeRootResult && logs().some(event => event.type === "mcpResult" &&
        event.convId === rootOwner.convId && event.result?.content?.[0]?.text === rootResult))
  }
}

// Multi-account: named accounts under AGY_BRIDGE_ACCOUNTS_DIR are isolated
// Gemini dirs; model ids gain an "<account>/" prefix that routes per account.
{
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-accounts-"))
  for (const name of ["work", "personal"]) {
    const cliDir = path.join(accountsDir, name, "antigravity-cli")
    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(path.join(cliDir, "antigravity-oauth-token"), `fake-token-${name}`, { mode: 0o600 })
  }
  fs.mkdirSync(path.join(accountsDir, "no-token"), { recursive: true }) // ignored: no file token
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  const { default: multiDefault } = await import("./index.mjs?multi-account")
  const multiPlugin = await multiDefault.server({ client: null, directory: os.tmpdir() }, {})
  const multiModels = await multiPlugin.provider.models()
  check("models lists default plus per-account prefixed ids",
    !!multiModels["gemini-test"] && !!multiModels["work/gemini-test"] && !!multiModels["personal/gemini-test"] &&
    !multiModels["no-token/gemini-test"], Object.keys(multiModels).join(","))
  check("account models carry a label prefix in their display name",
    multiModels["work/gemini-test"]?.name === "[work] Gemini Test" && multiModels["gemini-test"]?.name === "Gemini Test",
    JSON.stringify([multiModels["work/gemini-test"]?.name, multiModels["gemini-test"]?.name]))
  const accountCatalogProbe = logs().filter(event => event.type === "models" &&
    event.geminiDir === path.join(accountsDir, "work")).at(-1)
  const defaultCatalogProbe = logs().filter(event => event.type === "models" && event.geminiDir === null).at(-1)
  check("named account catalog probes force file token storage", accountCatalogProbe?.wslInterop === "1",
    JSON.stringify(accountCatalogProbe))
  check("default account catalog probe keeps the global keyring", defaultCatalogProbe?.wslInterop == null,
    JSON.stringify(defaultCatalogProbe))

  const multiLoader = await multiPlugin.auth.loader(async () => ({ key: "agy" }))
  const fetchMulti = body => multiLoader.fetch("agy://local/messages", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const opening = "ACCOUNT_PROBE shared opening text"
  const workBody = { model: "work/gemini-test", metadata: { user_id: "multi-account" }, tools: [echoTool],
    messages: [{ role: "user", content: opening }] }
  const workEvents = (await readSSE(await fetchMulti(workBody))).events
  check("prefixed account model request succeeds", stopOf(workEvents) === "end_turn", stopOf(workEvents))
  check("account process is pinned to its gemini dir",
    inits().at(-1)?.geminiDir === path.join(accountsDir, "work"), String(inits().at(-1)?.geminiDir))
  check("account process forces file token storage", inits().at(-1)?.wslInterop === "1",
    JSON.stringify(inits().at(-1)))

  const defaultBody = { ...workBody, model: "antigravity-bridge/gemini-test" }
  const defaultEvents = (await readSSE(await fetchMulti(defaultBody))).events
  check("default account request succeeds without --gemini_dir",
    stopOf(defaultEvents) === "end_turn" && inits().at(-1)?.geminiDir === null, `${stopOf(defaultEvents)} ${inits().at(-1)?.geminiDir}`)
  check("default account process keeps the global keyring", inits().at(-1)?.wslInterop == null,
    JSON.stringify(inits().at(-1)))
  check("same user_id on different accounts uses separate sessions",
    inits().at(-2).convId !== inits().at(-1).convId)

  const stateKeys = JSON.parse(fs.readFileSync(bridgeStateFile, "utf8")).entries.map(entry => entry.key)
  check("parked session state is keyed per account",
    stateKeys.some(key => key.startsWith("account:work::")) && stateKeys.some(key => !key.startsWith("account:")),
    stateKeys.join(","))

  const usageBefore = logs().filter(event => event.type === "usage").length
  const usage = await multiPlugin.auth.usage(async () => ({ key: "agy" }), {})
  const names = (usage.windows || []).map(window => window.name)
  check("usage aggregates every account with labels",
    names.includes("[work] Gemini · 7 days") && names.includes("[personal] Gemini · 7 days") &&
    names.includes("Gemini · 7 days"), JSON.stringify(names))
  const usageCalls = logs().filter(event => event.type === "usage").slice(usageBefore)
  check("usage probes each account with its own --gemini_dir",
    usageCalls.length === 3 &&
    usageCalls.filter(call => call.args.includes(`--gemini_dir=${path.join(accountsDir, "work")}`)).length === 1 &&
    usageCalls.filter(call => call.args.includes(`--gemini_dir=${path.join(accountsDir, "personal")}`)).length === 1,
    JSON.stringify(usageCalls.map(call => call.args)))
  const accountUsageCalls = usageCalls.filter(call => call.args.some(arg =>
    arg === `--gemini_dir=${path.join(accountsDir, "work")}` || arg === `--gemini_dir=${path.join(accountsDir, "personal")}`))
  const defaultUsageCalls = usageCalls.filter(call => !accountUsageCalls.includes(call))
  check("named account usage probes force file token storage",
    accountUsageCalls.length === 2 && accountUsageCalls.every(call => call.wslInterop === "1") &&
    defaultUsageCalls.length === 1 && defaultUsageCalls[0].wslInterop == null,
    JSON.stringify(usageCalls.map(call => [call.args, call.wslInterop])))

  // P1: a tool result addressed to another account must never reach the issuing
  // account's process; the issuing account keeps its pending call.
  const toolOpening = { model: "work/gemini-test", metadata: { user_id: "multi-account-tools" }, tools: [echoTool],
    messages: [{ role: "user", content: "TOOL cross-account pending opening" }] }
  const toolEvents = (await readSSE(await fetchMulti(toolOpening))).events
  const pendingCall = toolCalls(toolEvents)[0]
  check("work account leaves a tool call pending", !!pendingCall, JSON.stringify(toolCalls(toolEvents)))
  const workOwner = inits().at(-1)
  const withResult = continuation(toolOpening, toolEvents, "cross-account result")
  const crossResponse = await fetchMulti({ ...withResult, model: "personal/gemini-test" })
  const crossStatus = crossResponse.status
  await crossResponse.text()
  check("cross-account continuation never completes on the work process",
    crossStatus === 409 || (crossStatus === 200 && inits().at(-1).geminiDir === path.join(accountsDir, "personal")),
    `status=${crossStatus} lastInit=${inits().at(-1)?.geminiDir}`)
  check("work process still owns the pending call",
    !logs().some(event => event.type === "mcpResult" && event.convId === workOwner.convId))
  const workDone = (await readSSE(await fetchMulti(withResult))).events
  check("work account completes with its own result exactly once", stopOf(workDone) === "end_turn" &&
    logs().filter(event => event.type === "mcpResult" && event.convId === workOwner.convId).length === 1)

  // P2: a relative AGY_BRIDGE_ACCOUNTS_DIR must resolve to the same absolute dir
  // at request time (agy children launch from a temporary workspace).
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = path.relative(process.cwd(), accountsDir)
  await multiPlugin.provider.models() // refresh re-scans accounts
  const relEvents = (await readSSE(await fetchMulti({ model: "work/gemini-test", metadata: { user_id: "multi-account-relative" },
    messages: [{ role: "user", content: "relative accounts dir probe" }] }))).events
  check("relative accounts dir resolves absolutely for agy children",
    stopOf(relEvents) === "end_turn" && inits().at(-1)?.geminiDir === path.join(accountsDir, "work"),
    `${stopOf(relEvents)} ${inits().at(-1)?.geminiDir}`)

  delete process.env.AGY_BRIDGE_ACCOUNTS_DIR
  fs.rmSync(accountsDir, { recursive: true, force: true })
}

check("all ACP children disable auto update despite the parent false value", inits().length > 0 && inits().every(event => event.update === "true"))
check("child launches never mutate the parent's update setting", process.env.AGY_CLI_DISABLE_AUTO_UPDATE === "false")
if (originalAutoUpdate === undefined) delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE
else process.env.AGY_CLI_DISABLE_AUTO_UPDATE = originalAutoUpdate

try { fs.unlinkSync(fakeAgy) } catch {}
try { fs.unlinkSync(wrapper) } catch {}
try { fs.unlinkSync(logPath) } catch {}
try { fs.rmSync(stateDir, { recursive: true, force: true }) } catch {}

console.log(failures === 0 ? `\nALL OK (${checks} checks)` : `\n${failures} FAILURES (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
