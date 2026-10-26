import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
const suffix = `-${process.pid}`
const fakeAgy = path.join(here, `.tmp-fake-agy${suffix}.mjs`)
const wrapper = path.join(here, `.tmp-agy${suffix}`)
const logPath = path.join(here, `.tmp-fake-agy-log${suffix}`)
process.env.FAKE_AGY_LOG = logPath
process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS = "1000"
process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "5000"

fs.writeFileSync(fakeAgy, String.raw`
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const convId = "conv-" + Math.random().toString(36).slice(2, 10)
const log = value => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(value) + "\n")
const send = value => process.stdout.write(JSON.stringify(value) + "\n")
const step = value => send({ event: "step_update", step_update: { conversation_id: convId, ...value } })
let mcp = null
let mcpError = ""
let nextId = 0
let stepIndex = 0
let turn = 0
let cumulative = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
const pending = new Map()

if (process.argv.includes("models")) {
  process.stdout.write("gemini-test-medium\tGemini Test (Medium)\ngemini-test-high\tGemini Test (High)\ngemini-test-low\tGemini Test (Low)\nclaude-test-medium\tClaude Test (Medium)\n")
  process.exit(0)
}

function mcpRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}

async function setup() {
  const agentPath = path.join(process.cwd(), ".agents", "agents", "magpie-bridge", "agent.md")
  const agent = fs.readFileSync(agentPath, "utf8")
  const configLine = agent.split("\n").find(line => line.startsWith("mcpServers: "))
  let tools = []
  if (configLine) {
    const config = JSON.parse(configLine.slice("mcpServers: ".length))[0]
    mcp = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    mcp.stderr.on("data", data => { mcpError = (mcpError + data).slice(-4000) })
    const rl = readline.createInterface({ input: mcp.stdout })
    rl.on("line", line => {
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }
    await mcpRequest("server/discover", meta)
    const listed = await mcpRequest("tools/list", meta)
    tools = listed.tools
  }
  const modelFlag = process.argv.indexOf("--model")
  const addDirFlag = process.argv.indexOf("--add-dir")
  if (process.env.FAKE_AGY_INIT_MODE === "slow") await new Promise(resolve => setTimeout(resolve, 100))
  if (process.env.FAKE_AGY_INIT_MODE === "early-error") {
    send({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "Eligibility check failed: test EOF" } })
    process.exit(1)
  }
  log({ type: "init", pid: process.pid, convId, cwd: process.cwd(), addDir: addDirFlag < 0 ? null : process.argv[addDirFlag + 1], model: modelFlag < 0 ? "" : process.argv[modelFlag + 1], tools })
  send({ event: "init", conversation_id: convId, init: { cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } })
}

function usage(reply) {
  cumulative.input_tokens += 10
  cumulative.output_tokens += reply.length
  cumulative.total_tokens = cumulative.input_tokens + cumulative.output_tokens
}

function finish(reply) {
  usage(reply)
  log({ type: "result", convId, turn, response: reply })
  send({ event: "result", result: { conversation_id: convId, status: "SUCCESS", response: reply, duration_seconds: 0.1, num_turns: turn, usage: cumulative } })
}

async function invoke(call, early = false) {
  const index = ++stepIndex
  const parameters = { ServerName: "magpie_bridge", ToolName: call.name, Arguments: call.arguments }
  const start = () => mcpRequest("tools/call", {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", progressToken: convId + ":" + index },
    name: call.name,
    arguments: call.arguments,
  })
  log({ type: "mcpPending", convId, name: call.name, arguments: call.arguments })
  const pendingRequest = early ? start() : null
  step({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters } })
  let result
  try {
    result = await (pendingRequest || start())
  } catch (error) {
    result = { content: [{ type: "text", text: error.message }], isError: true }
  }
  log({ type: "mcpResult", convId, result })
  const output = result.content?.map(part => part.text || "").join("") || "tool error"
  step({ step_index: index, state: "DONE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters, output } })
  return result
}

async function handleUser(message) {
  const prompt = typeof message.message.content === "string" ? message.message.content : ""
  const text = prompt.includes("<current_turn>\n") ? prompt.split("<current_turn>\n").at(-1).replace(/\n<\/current_turn>$/, "") : prompt
  turn++
  log({ type: "user", convId, turn, text: prompt })
  if (text.includes("DIE")) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: "before death" })
    process.exit(2)
  }
  if (text.includes("SLOW")) return
  if (text.includes("BUILTIN")) {
    const parameters = { CommandLine: "printf SHOULD_NOT_RUN" }
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters } })
    finish("built-in tool ran")
    return
  }
  if (text.includes("PARALLEL")) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: "Before parallel.\n" })
    await Promise.all([
      invoke({ name: "echo", arguments: { text: "same" } }),
      invoke({ name: "echo", arguments: { text: "same" } }, true),
    ])
    step({ step_index: ++stepIndex, state: "DONE", step_type: "agent_response", text_delta: "After parallel.\n" })
    finish("Before parallel.\nAfter parallel.\n")
    return
  }
  if (text.includes("TWOSTEP")) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: "Before two-step.\n" })
    await invoke({ name: "echo", arguments: { text: "first" } })
    await invoke({ name: "echo", arguments: { text: "second" } })
    step({ step_index: ++stepIndex, state: "DONE", step_type: "agent_response", text_delta: "After two-step.\n" })
    finish("Before two-step.\nAfter two-step.\n")
    return
  }
  if (text.includes("TOOL")) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: "Before tool.\n" })
    await invoke({ name: "echo", arguments: { text: "probe" } })
    step({ step_index: ++stepIndex, state: "DONE", step_type: "agent_response", text_delta: "After tools.\n" })
    finish("Before tool.\nAfter tools.\n")
    return
  }
  if (text.includes("UNICODE")) {
    const reply = "中文😀"
    const event = { event: "step_update", step_update: { conversation_id: convId, step_index: ++stepIndex, state: "DONE", step_type: "agent_response", text_delta: reply } }
    const wire = Buffer.from(JSON.stringify(event) + "\n")
    const cut = wire.indexOf(Buffer.from("😀")) + 1
    process.stdout.write(wire.subarray(0, cut))
    await new Promise(resolve => setImmediate(() => {
      process.stdout.write(wire.subarray(cut))
      resolve()
    }))
    finish(reply)
    return
  }
  const prefix = text.includes("SAME") ? "You said [" + convId + "]: " : "You said: "
  const reply = prefix + text.slice(0, 120).replace(/"/g, "'")
  const half = Math.floor(reply.length / 2)
  step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: reply.slice(0, half) })
  step({ step_index: stepIndex, state: "DONE", step_type: "agent_response", text_delta: reply.slice(half), usage: cumulative })
  finish(reply)
}

await setup()
const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on("line", line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.event !== "user") return
  chain = chain.then(() => handleUser(message)).catch(error => {
    process.stderr.write((error?.stack || error) + "\n" + mcpError)
    process.exit(3)
  })
})
rl.on("close", () => {
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

async function callFetch(body, headers = {}) {
  return loader.fetch("agy://local/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
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
      if (block.type === "tool_use") {
        blocks.set(index, { type: "tool_use", id: block.id, name: block.name, input: {}, partial: "" })
      }
    }
    if (event.event === "content_block_delta") {
      const block = blocks.get(event.data.index)
      if (!block) continue
      if (event.data.delta?.type === "text_delta") block.text += event.data.delta.text
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

function toolCall(events) {
  return assistantBlocks(events).find(block => block.type === "tool_use")
}

function continuation(previous, events, resultText, options = {}) {
  const call = toolCall(events)
  const result = {
    type: "tool_result",
    tool_use_id: call.id,
    content: resultText,
  }
  if (options.isError) result.is_error = true
  const content = [result]
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
  const models = await plugin.provider.models()
  check("dynamic models accept tab-separated agy output", !!models["gemini-test"])
  check("dynamic models do not fall back to stale list", !models["gemini-3.7-flash-high"])
  check("models declare Anthropic through OpenCode api.npm", models["gemini-test"]?.api?.npm === "@ai-sdk/anthropic")
  check("effort variants collapse into one model", !models["gemini-test-low"] && !models["gemini-test-medium"] && !models["gemini-test-high"])
  check("grouped model has a level-free display name", models["gemini-test"]?.name === "Gemini Test")
  check("grouped model declares sorted variants", Object.keys(models["gemini-test"]?.variants || {}).join(",") === "low,medium,high")
  check("grouped model declares Magpie and OpenCode reasoning", models["gemini-test"]?.capabilities?.reasoning === true && models["gemini-test"]?.reasoning === true)
  check("single-effort models stay ungrouped", models["claude-test-medium"]?.name === "Claude Test (Medium)" && !models["claude-test-medium"]?.variants)
}

async function launchedModel(body) {
  const response = await callFetch(body)
  await readSSE(response)
  return logs().filter(event => event.type === "init").at(-1)?.model
}

{
  check("grouped model defaults to high", await launchedModel({ model, messages: [{ role: "user", content: "MODEL default effort" }] }) === "gemini-test-high")
  check("thinking budget selects the matching agy model", await launchedModel({ model, thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: "MODEL low effort" }] }) === "gemini-test-low")
  check("output effort selects the matching agy model", await launchedModel({ model, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, messages: [{ role: "user", content: "MODEL medium effort" }] }) === "gemini-test-medium")
  check("high thinking budget selects high", await launchedModel({ model, thinking: { type: "enabled", budget_tokens: 24000 }, messages: [{ role: "user", content: "MODEL high effort" }] }) === "gemini-test-high")
  check("output effort without thinking keeps the default", await launchedModel({ model, output_config: { effort: "low" }, messages: [{ role: "user", content: "MODEL title request" }] }) === "gemini-test-high")
  check("legacy effort ids pass through unchanged", await launchedModel({ model: legacyModel, thinking: { type: "enabled", budget_tokens: 10000 }, messages: [{ role: "user", content: "MODEL legacy id" }] }) === "gemini-test-low")
  check("single-effort model requests pass through unchanged", await launchedModel({ model: "antigravity-bridge/claude-test-medium", thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: "MODEL singleton" }] }) === "claude-test-medium")
}

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "hello world" }] })
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
}

{
  const initialInits = logs().filter(event => event.type === "init").length
  const first = { model, messages: [{ role: "user", content: "first message" }] }
  const firstEvents = (await readSSE(await callFetch(first))).events
  const second = {
    ...first,
    messages: [
      ...first.messages,
      { role: "assistant", content: assistantBlocks(firstEvents) },
      { role: "user", content: "second message" },
    ],
  }
  const { events } = await readSSE(await callFetch(second))
  check("second turn gets reply", textOf(events).includes("second message"), textOf(events))
  check("conversation reuses one process", logs().filter(event => event.type === "init").length === initialInits + 1)
}

{
  const before = logs().filter(event => event.type === "init").length
  const shared = { model, messages: [{ role: "user", content: "SAME opening" }] }
  const firstA = (await readSSE(await callFetch(shared))).events
  const convA = logs().filter(event => event.type === "init").at(-1).convId
  await readSSE(await callFetch(shared))
  const convB = logs().filter(event => event.type === "init").at(-1).convId
  const secondA = {
    ...shared,
    messages: [
      ...shared.messages,
      { role: "assistant", content: assistantBlocks(firstA) },
      { role: "user", content: "second turn for A" },
    ],
  }
  await readSSE(await callFetch(secondA))
  const replay = logs().filter(event => event.type === "user").at(-1).text
  check("same-opening conversations replay their own history", replay.includes("<conversation_history>") && replay.includes(convA) && !replay.includes(convB), replay)
  check("same-opening conversations do not share a live process", logs().filter(event => event.type === "init").length === before + 3)
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
  const init = logs().filter(event => event.type === "init").at(-1)
  const prompt = logs().filter(event => event.type === "user").at(-1).text
  check(`${name} uses only an available absolute add-dir`, stopOf(final) === "end_turn" && init.addDir === expectedDir)
  check(`${name} identifies where client tools run`, prompt.includes(JSON.stringify(named)) && prompt.includes("where every tool runs"))
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
  nativeConv = logs().filter(event => event.type === "init").at(-1)?.convId
  check("MCP stays pending after first response", !logs().some(event => event.type === "mcpResult" && event.convId === nativeConv))
  check("agy has not finished its turn", !logs().some(event => event.type === "result" && event.convId === nativeConv))
  const listed = logs().filter(event => event.type === "init").at(-1)?.tools?.[0]
  check("tools/list preserves JSON schema", listed?.inputSchema?.required?.[0] === "text" && listed?.inputSchema?.additionalProperties === false)
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
  check("continuation sends no new agy user turn", logs().filter(event => event.type === "user" && event.convId === nativeConv).length === 1)
  check("native tool reuses the same agy conversation", logs().filter(event => event.type === "init" && event.convId === nativeConv).length === 1)
}

{
  const first = { model, messages: [{ role: "user", content: "TWOSTEP formatted history" }], tools: [echoTool] }
  const before = logs().filter(event => event.type === "init").length
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
  check("formatting-only changes keep the live process", logs().filter(event => event.type === "init").length === before + 1)
}

{
  const first = { model, messages: [{ role: "user", content: "TWOSTEP renamed calls" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = logs().filter(event => event.type === "init").at(-1).convId
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
    const cleanup = continuation(first, events, "cleanup")
    const next = (await readSSE(await callFetch(cleanup))).events
    if (toolCall(next)) await readSSE(await callFetch(continuation(cleanup, next, "cleanup-two")))
  }
}

{
  const first = { model, messages: [{ role: "user", content: "TOOL before compaction" }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const old = logs().filter(event => event.type === "init").at(-1)
  const second = continuation(first, events, "already-executed-result")
  second.messages[0].content = "Compacted summary of the conversation"
  const response = await callFetch(second)
  const final = (await readSSE(response)).events
  check("edited history replays instead of returning 409", response.status === 200 && stopOf(final) === "end_turn", `got ${response.status}`)
  const replay = logs().filter(event => event.type === "user").at(-1)
  check("replay includes current history and the real result", replay.convId !== old.convId && replay.text.includes("Compacted summary") && replay.text.includes("already-executed-result") && !replay.text.includes("TOOL before compaction"))
  check("replaced pending process is cleaned up", !fs.existsSync(old.cwd))
  if (response.status !== 200) await readSSE(await callFetch(continuation(first, events, "cleanup")))
}

{
  const firstBody = { model, messages: [{ role: "user", content: "PARALLEL native" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const firstCall = toolCall(firstEvents)
  const secondBody = continuation(firstBody, firstEvents, "parallel-one")
  const secondEvents = (await readSSE(await callFetch(secondBody))).events
  const secondCall = toolCall(secondEvents)
  check("parallel call is delivered on continuation", !!secondCall && secondCall.id !== firstCall.id && stopOf(secondEvents) === "tool_use")
  const thirdBody = continuation(secondBody, secondEvents, "parallel-two")
  const thirdEvents = (await readSSE(await callFetch(thirdBody))).events
  check("parallel calls finish after both real results", stopOf(thirdEvents) === "end_turn" && textOf(thirdEvents).includes("After parallel"))
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
  const delivered = logs().filter(event => event.type === "mcpResult").at(-1)
  check("tool execution failure maps to MCP isError", delivered?.result?.isError === true)
  check("tool execution failure still completes natively", stopOf(secondEvents) === "end_turn")
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL atomic duplicates" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const convId = logs().filter(event => event.type === "init").at(-1).convId
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
  const before = logs().filter(event => event.type === "init").length
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
  check("concurrent conversations use independent processes", logs().filter(event => event.type === "init").length === before + 2)
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
  const response = await callFetch({
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    }],
  })
  const payload = await response.json()
  check("image content returns actual HTTP 400", response.status === 400, `got ${response.status}`)
  check("image HTTP error explains unsupported content", payload.error?.message?.includes("not supported"), payload.error?.message)
}

{
  const before = logs().filter(event => event.type === "init").length
  const firstBody = { model, messages: [{ role: "user", content: "stable tools" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const secondBody = {
    ...firstBody,
    tools: [echoTool, { name: "other", description: "Other", input_schema: { type: "object" } }],
    messages: [
      ...firstBody.messages,
      { role: "assistant", content: assistantBlocks(firstEvents) },
      { role: "user", content: "still stable" },
    ],
  }
  const secondEvents = (await readSSE(await callFetch(secondBody))).events
  check("changed tool definitions restart the process", logs().filter(event => event.type === "init").length === before + 2)
  check("replayed conversation answers after tool change", stopOf(secondEvents) === "end_turn")
}

for (const change of ["tools", "model"]) {
  const first = { model, messages: [{ role: "user", content: `TOOL live configuration ${change}` }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const old = logs().filter(event => event.type === "init").at(-1)
  const second = continuation(first, events, "completed-before-change")
  if (change === "tools") {
    second.tools = [...second.tools, { name: "other", input_schema: { type: "object" } }]
    second.messages.push({ role: "user", content: [{ type: "text", text: "<system-update>tool catalog changed</system-update>" }] })
  } else second.model = legacyModel
  const final = (await readSSE(await callFetch(second))).events
  const init = logs().filter(event => event.type === "init").at(-1)
  check(`live ${change} change replays the completed result`, stopOf(final) === "end_turn" && init.convId !== old.convId && logs().filter(event => event.type === "user").at(-1).text.includes("completed-before-change"))
  check(`live ${change} change reaches the new process`, change === "tools" ? init.tools.some(tool => tool.name === "other") : init.model === "gemini-test-low")
  if (change === "tools") check("system update survives a configuration replay", logs().filter(event => event.type === "user").at(-1).text.includes("tool catalog changed"))
}

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "BUILTIN should be rejected" }] })
  const { events } = await readSSE(response)
  const error = events.find(event => event.event === "error")?.data?.error?.message || ""
  check("unexpected built-in tool fails closed", error.includes("non-bridge tool"), error)
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
  check("pre-init result reports the actual agy error", response.status === 502 && payload.error?.message?.includes("failed before init: Eligibility check failed: test EOF"), `got ${response.status}: ${payload.error?.message}`)
  delete process.env.FAKE_AGY_INIT_MODE
}

{
  const firstBody = { model, messages: [{ role: "user", content: "TOOL timeout" }], tools: [echoTool] }
  const firstEvents = (await readSSE(await callFetch(firstBody))).events
  const init = logs().filter(event => event.type === "init").at(-1)
  await new Promise(resolve => setTimeout(resolve, 1200))
  const secondBody = continuation(firstBody, firstEvents, "too late")
  const { events } = await readSSE(await callFetch(secondBody))
  const error = events.find(event => event.event === "error")?.data?.error?.message || ""
  check("missing client result times out explicitly", error.includes("timed out waiting for a client tool result"), error)
  check("timed-out process workspace is removed", !fs.existsSync(init.cwd), init.cwd)
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
  const convId = logs().filter(event => event.type === "init").at(-1).convId
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
  check(`${location} task notification does not add an agy user turn`, logs().filter(event => event.type === "user" && event.convId === convId).length === 1)
  if (response.status !== 200) await readSSE(await callFetch(continuation(first, events, "cleanup")))
}

for (const location of ["inline", "system", "developer", "user"]) {
  const first = { model, messages: [{ role: "user", content: `TOOL system update ${location}` }], tools: [echoTool] }
  const events = (await readSSE(await callFetch(first))).events
  const convId = logs().filter(event => event.type === "init").at(-1).convId
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
  check(`${location} system update does not add an agy user turn`, logs().filter(event => event.type === "user" && event.convId === convId).length === 1)
  if (response.status !== 200) await readSSE(await callFetch(continuation(first, events, "cleanup")))
}

{
  const before = logs().filter(event => event.type === "init").length
  const body = { model, messages: [{ role: "user", content: "SLOW cancellation" }] }
  const responses = await Promise.all([callFetch(body), callFetch(body)])
  const response = responses.find(item => item.status === 200)
  check("simultaneous startup allows only one live response", responses.filter(item => item.status === 200).length === 1 && responses.some(item => item.status === 503), responses.map(item => item.status).join(","))
  check("simultaneous startup cannot overwrite the pool", logs().filter(event => event.type === "init").length === before + 1)
  const init = logs().filter(event => event.type === "init").at(-1)
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  check("cancellation removes the process workspace", !fs.existsSync(init.cwd), init.cwd)
}

try { fs.unlinkSync(fakeAgy) } catch {}
try { fs.unlinkSync(wrapper) } catch {}
try { fs.unlinkSync(logPath) } catch {}

console.log(failures === 0 ? `\nALL OK (${checks} checks)` : `\n${failures} FAILURES (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
