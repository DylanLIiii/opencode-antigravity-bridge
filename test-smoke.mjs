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
  process.stdout.write("gemini-test-low\tGemini Test (Low)\nclaude-test-medium\tClaude Test (Medium)\n")
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
  log({ type: "init", pid: process.pid, convId, cwd: process.cwd(), tools })
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
  const text = typeof message.message.content === "string" ? message.message.content : ""
  turn++
  log({ type: "user", convId, turn, text })
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

async function callFetch(body) {
  return loader.fetch("agy://local/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
const model = "antigravity-bridge/gemini-test-low"

{
  const models = await plugin.provider.models()
  check("dynamic models accept tab-separated agy output", !!models["gemini-test-low"])
  check("dynamic models do not fall back to stale list", !models["gemini-3.7-flash-high"])
  check("models declare Anthropic through OpenCode api.npm", models["gemini-test-low"]?.api?.npm === "@ai-sdk/anthropic")
}

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "hello world" }] })
  check("single turn returns 200", response.status === 200, `got ${response.status}`)
  const { events } = await readSSE(response)
  const kinds = events.map(event => event.event)
  check("has message_start", kinds.includes("message_start"))
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

{
  const response = await callFetch({ model, messages: [{ role: "user", content: "BUILTIN should be rejected" }] })
  const { events } = await readSSE(response)
  const error = events.find(event => event.event === "error")?.data?.error?.message || ""
  check("unexpected built-in tool fails closed", error.includes("non-bridge tool"), error)
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
  const invalid = await callFetch(invalidBody)
  check("text beside a live tool result returns 400", invalid.status === 400, `got ${invalid.status}`)
  const validBody = continuation(firstBody, firstEvents, "result")
  const validEvents = (await readSSE(await callFetch(validBody))).events
  check("valid result can continue after rejected extra text", stopOf(validEvents) === "end_turn")
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
