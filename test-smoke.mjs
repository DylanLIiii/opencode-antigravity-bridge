import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
const suffix = `-${process.pid}`
const fakeAgy = path.join(here, `.tmp-fake-agy${suffix}.mjs`)
const wrapper = path.join(here, `.tmp-agy${suffix}`)
const logPath = path.join(here, `.tmp-fake-agy-log${suffix}`)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-state-"))
process.env.FAKE_AGY_LOG = logPath
process.env.FAKE_AGY_STATE = stateDir
const bridgeStateFile = path.join(stateDir, "bridge-sessions.json")
process.env.AGY_BRIDGE_STATE_FILE = bridgeStateFile
process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "1000"
process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "5000"

// A fake `agy` that speaks ACP on stdio and reaches the client tools the way
// the real one does: by running `nc 127.0.0.1 <--ide-mcp-port>` from PATH.
fs.writeFileSync(fakeAgy, String.raw`
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const argv = process.argv.slice(2)
const log = value => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(value) + "\n")
const send = value => process.stdout.write(JSON.stringify(value) + "\n")

if (argv.includes("--version")) {
  process.stdout.write("1.5.0\n")
  process.exit(0)
}
if (argv.includes("/usage")) {
  log({ type: "usage", cwd: process.cwd(), args: argv })
  send({ status: "SUCCESS", command: { name: "usage", data: { groups: [{
    name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.6, reset_time: "2026-10-27T00:00:00Z" }],
  }] } } })
  process.exit(0)
}
if (argv.includes("models")) {
  process.stdout.write("gemini-test-medium\tGemini Test (Medium)\ngemini-test-high\tGemini Test (High)\ngemini-test-low\tGemini Test (Low)\nclaude-test-medium\tClaude Test (Medium)\n")
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
let mcp = null
let mcpReady = null
let nextMcpId = 0
const mcpPending = new Map()
let cancelWaiter = null

function update(value) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: value } })
}
const chunk = text => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
const thought = text => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } })

function mcpRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextMcpId
    mcpPending.set(id, { resolve, reject })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}

async function listTools(reason) {
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

function finish(reply, extra = {}) {
  log({ type: "result", convId: session.id, prompt: session.prompts, response: reply })
  return {
    stopReason: "end_turn",
    usage: { inputTokens: 10 + (extra.cached || 0), outputTokens: reply.length, cachedReadTokens: extra.cached || 0, cachedWriteTokens: 0, thoughtTokens: extra.thought || 0, totalTokens: 10 + reply.length },
  }
}

async function reply(text) {
  const half = Math.floor(text.length / 2)
  chunk(text.slice(0, half))
  chunk(text.slice(half))
}

async function prompt(params) {
  const text = params.prompt.map(block => block.text || "").join("")
  session.prompts++
  saveState()
  log({ type: "user", convId: session.id, prompt: session.prompts, text, content: params.prompt, model })
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
  if (text.includes("CONFIGRESET")) {
    await reply("configuration updated")
    model = "gemini-test-low"
    update({ sessionUpdate: "config_option_update", configOptions: configOptions() })
    return finish("configuration updated")
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
  const configurable = family === "gemini-test" || family === "gemini-config-only"
  const grouped = process.env.FAKE_AGY_CONFIG === "grouped"
  const models = ["gemini-test", "gemini-config-only", "claude-test-medium"].map(value => ({ value, name: value }))
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
        agentInfo: { name: "Antigravity ACP Server", version: process.env.FAKE_AGY_IMAGES === "omit" ? "1.4.12" : "1.5.0" },
        authMethods: [],
      }
    case "session/new":
    case "session/resume": {
      if (process.env.FAKE_AGY_INIT_MODE === "slow") await new Promise(resolve => setTimeout(resolve, 100))
      if (process.env.FAKE_AGY_INIT_MODE === "early-error") throw { code: -32603, message: "Eligibility check failed: test EOF" }
      let prompts = 0
      if (message.method === "session/resume") {
        if (!fs.existsSync(statePath(params.sessionId))) throw { code: -32602, message: "Conversation Not Found" }
        prompts = JSON.parse(fs.readFileSync(statePath(params.sessionId), "utf8")).prompts
      }
      session = { id: message.method === "session/new" ? "sess-" + Math.random().toString(36).slice(2, 10) : params.sessionId, prompts }
      model = "gemini-test-medium"
      await connectIde()
      log({
        type: "init", pid: process.pid, convId: session.id, resumed: message.method === "session/resume",
        cwd: process.cwd(), addDir, agentConfig, clientInfo, systemAppend: params._meta?.antigravity?.systemPrompt?.append ?? null,
        tools, idePort,
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
    case "session/prompt":
      return prompt(params)
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
}

{
  const models = await plugin.provider.models()
  check("dynamic models accept tab-separated agy output", !!models["gemini-test"])
  check("dynamic models do not fall back to stale list", !models["gemini-3.7-flash-high"])
  check("models declare Anthropic through OpenCode api.npm", models["gemini-test"]?.api?.npm === "@ai-sdk/anthropic")
  check("effort variants collapse into one model", !models["gemini-test-low"] && !models["gemini-test-medium"] && !models["gemini-test-high"])
  check("grouped model has a level-free display name", models["gemini-test"]?.name === "Gemini Test")
  check("grouped model declares sorted variants", Object.keys(models["gemini-test"]?.variants || {}).join(",") === "low,medium,high")
  check("grouped model declares Magpie and OpenCode reasoning", models["gemini-test"]?.capabilities?.reasoning === true && models["gemini-test"]?.reasoning === true)
  check("Gemini and Claude models expose image input to the host", models["gemini-test"]?.capabilities?.input?.image === true && models["claude-test-medium"]?.capabilities?.input?.image === true)
  check("single-effort models stay ungrouped", models["claude-test-medium"]?.name === "Claude Test (Medium)" && !models["claude-test-medium"]?.variants)
}

async function launchedModel(body) {
  const response = await callFetch(body)
  await readSSE(response)
  return lastOf("user")?.model
}

{
  check("grouped model defaults to high", await launchedModel({ model, messages: [{ role: "user", content: "MODEL default effort" }] }) === "gemini-test-high")
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
  const rejected = await callFetch({ model, messages: [{ role: "user", content: "rejected config" }] })
  const error = await rejected.json()
  check("real config errors remain visible before streaming", rejected.status === 400 && error.error?.message.includes("Configuration rejected"))
  check("real config errors do not trigger a legacy fallback", logs().filter(event => event.type === "setModel").length === before)
  delete process.env.FAKE_AGY_CONFIG

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
  check("ACP client identifies as an allowlisted client", init.clientInfo?.name === "zed")
  check("client system prompt is appended to the session instructions", init.systemAppend?.includes("SYSTEM-PROMPT-MARKER"))
  check("fresh prompt carries only the user text", user.text === "hello world", JSON.stringify(user.text))
  check("client tools are served through the ide-tools port", !!init.idePort && !logs().some(event => event.type === "ncExit"))
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
  const { events } = await readSSE(await callFetch(body))
  const error = events.find(event => event.event === "error")?.data?.error
  check("agy's in-band failure becomes an error frame", error?.message?.includes("fake upstream failure"), JSON.stringify(error))
  check("error marker text is not streamed as content", textOf(events) === "partial before failure", JSON.stringify(textOf(events)))
  const retry = (await readSSE(await callFetch(body))).events
  check("retry after an upstream error reuses the session", inits().length === before && lastOf("user").convId === convId && lastOf("user").text === "AGENTERROR upstream" && retry.some(event => event.event === "error"), JSON.stringify({ inits: inits().length - before, user: lastOf("user"), kinds: retry.map(event => event.event) }))
}

{
  const { events } = await readSSE(await callFetch({ model, messages: [{ role: "user", content: "QUOTA exhausted" }] }))
  const error = events.find(event => event.event === "error")?.data?.error
  check("split error marker and quota map to rate_limit_error", error?.type === "rate_limit_error" && error.message.includes("quota exhausted") && textOf(events) === "", JSON.stringify({ error, text: textOf(events) }))
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
  delete process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL extra text" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const invalidBody = continuation(firstBody, firstEvents, "result", { extraText: true })
  invalidBody.messages.at(-1).content.at(-1).text += "\n<task-notification>background completed</task-notification>"
  const beforeResult = continuation(firstBody, firstEvents, "result")
  beforeResult.messages.at(-1).content.unshift({ type: "text", text: "<task-notification>too early</task-notification>" })
  const hookAndUser = continuation(firstBody, firstEvents, "result")
  hookAndUser.messages.at(-1).content.push({ type: "text", text: "PreToolUse:Read hook additional context: hook output\n\nThe user sent a new message while you were working:\nstop now" })
  const systemBeforeResult = continuation(firstBody, firstEvents, "result")
  systemBeforeResult.messages.at(-1).content.unshift({ type: "text", text: "<system-update>too early</system-update>" })
  const systemAndUser = continuation(firstBody, firstEvents, "result")
  systemAndUser.messages.at(-1).content.push({ type: "text", text: "<system-update>catalog changed</system-update>\n\nordinary user instruction" })
  const unclosedSystem = continuation(firstBody, firstEvents, "result")
  unclosedSystem.messages.at(-1).content.push({ type: "text", text: "<system-update>not a complete protocol notice" })
  const rejected = await Promise.all([invalidBody, beforeResult, hookAndUser, systemBeforeResult, systemAndUser, unclosedSystem].map(body => callFetch(body)))
  check("unsupported user text and malformed or pre-result notices return 400", rejected.every(response => response.status === 400), rejected.map(response => response.status).join(","))
  const validBody = continuation(firstBody, firstEvents, "result")
  const validEvents = (await readSSE(await callFetch(validBody))).events
  check("valid result can continue after rejected extra text", stopOf(validEvents) === "end_turn")
}

for (const location of ["inline", "system", "developer", "user"]) {
  const first = { model, messages: [{ role: "user", content: `TOOL task notice ${location}` }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = inits().at(-1).convId
  const second = continuation(first, events, "real tool output")
  const notice = { type: "text", text: "<system-reminder>[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>job-7</task-id><summary>subagent finished</summary></task-notification>\n<task-notification><task-id>job-8</task-id><summary>another subagent finished</summary></task-notification></system-reminder>" }
  second.messages.at(-1).content.push({ type: "text", text: "<total_tokens>12345</total_tokens>" }, { type: "text", text: "PreToolUse:Read hook additional context: hook-only-output" })
  if (location === "inline") second.messages.at(-1).content.push(notice)
  else second.messages.push({ role: location, content: [notice] })
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  check(`${location} task notification continues the live turn`, response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  const delivered = logs().find(event => event.type === "mcpResult" && event.convId === convId)
  const content = delivered?.result?.content?.map(part => part.text).join("\n") || ""
  check(`${location} task notifications reach MCP without hook/token noise`, content.startsWith("real tool output") && content.includes("<system-reminder>") && content.includes("job-7") && content.includes("job-8") && !content.includes("12345") && !content.includes("hook-only-output"), content)
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
}

try { fs.unlinkSync(fakeAgy) } catch {}
try { fs.unlinkSync(wrapper) } catch {}
try { fs.unlinkSync(logPath) } catch {}
try { fs.rmSync(stateDir, { recursive: true, force: true }) } catch {}

console.log(failures === 0 ? `\nALL OK (${checks} checks)` : `\n${failures} FAILURES (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
