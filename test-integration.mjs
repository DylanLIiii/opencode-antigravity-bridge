// Opt in: AGY_BRIDGE_INTEGRATION=1 npm run test:integration
// Uses the signed-in real CLI and consumes a small amount of model quota.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const worker = process.argv.includes("--worker")
if (!worker && process.env.AGY_BRIDGE_INTEGRATION !== "1") {
  console.log("Skipped real agy checks. Set AGY_BRIDGE_INTEGRATION=1 to use the signed-in CLI and model quota.")
  process.exit(0)
}

function blocksFrom(events) {
  const blocks = []
  for (const event of events) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block }
    if (event.type !== "content_block_delta") continue
    const block = blocks[event.index]
    const delta = event.delta
    if (delta.type === "text_delta") block.text += delta.text
    if (delta.type === "thinking_delta") block.thinking += delta.thinking
    if (delta.type === "signature_delta") block.signature = (block.signature || "") + delta.signature
    if (delta.type === "input_json_delta") block.partial = (block.partial || "") + delta.partial_json
  }
  return blocks.filter(Boolean).map(block => {
    if (block.type !== "tool_use") return block
    const { partial, ...result } = block
    return { ...result, input: JSON.parse(partial || "{}") }
  })
}

async function runWorker(body) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
    env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  })
  let stdout = ""
  let stderr = ""
  const stop = () => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL")
      else process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
  const timer = setTimeout(stop, 120_000)
  try {
    child.stdout.setEncoding("utf8").on("data", data => { stdout += data })
    child.stderr.setEncoding("utf8").on("data", data => { stderr = (stderr + data).slice(-4000) })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(body))
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    assert.equal(code, 0, `Real CLI check failed: ${stderr || stdout || "worker exceeded 120 seconds"}`)
    return JSON.parse(stdout)
  } finally {
    clearTimeout(timer)
    stop()
  }
}

if (worker) {
  try {
    let input = ""
    for await (const chunk of process.stdin) input += chunk
    let body = JSON.parse(input)
    const { AntigravityBridgePlugin } = await import("./index.mjs")
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader(async () => ({ key: "agy" }))
    let toolCalls = 0
    let thinking = false
    for (let round = 0; round < 4; round++) {
      const response = await loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
      assert.equal(response.status, 200, await errorDetail(response))
      const raw = await response.text()
      const events = raw.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
      assert(!events.some(event => event.type === "error"), JSON.stringify(events.find(event => event.type === "error")))
      const content = blocksFrom(events)
      thinking ||= content.some(block => block.type === "thinking" && block.thinking)
      const calls = content.filter(block => block.type === "tool_use")
      const end = events.find(event => event.type === "message_delta")
      if (end?.delta?.stop_reason === "end_turn") {
        assert(content.some(block => block.type === "text" && block.text), "Missing final text")
        assert(end.usage?.input_tokens + end.usage?.cache_read_input_tokens > 0, "Missing prompt token usage")
        console.log(JSON.stringify({ body, content, toolCalls, thinking }))
        process.exit(0)
      }
      assert.equal(end?.delta?.stop_reason, "tool_use", "Unexpected stop reason")
      assert(calls.length, "Missing tool calls")
      for (const call of calls) {
        assert.equal(call.name, "bridge_echo")
        assert.equal(call.input.token, "bridge-integration")
      }
      toolCalls += calls.length
      body = { ...body, messages: [...body.messages, { role: "assistant", content }, { role: "user", content: calls.map(call => ({
        type: "tool_result", tool_use_id: call.id, content: "Tool verified. Remember the code ORCHID-731.",
      })) }, { role: "system", content: "PostToolUse hook additional context: Continue with the verified tool result." }] }
    }
    throw new Error("Model did not finish within four tool rounds")
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

async function errorDetail(response) {
  return response.status === 200 ? "" : response.text()
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-bridge-integration-"))
process.env.AGY_BRIDGE_STATE_FILE = path.join(directory, "sessions.json")
process.env.AGY_BRIDGE_START_TIMEOUT_MS = "60000"
process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "90000"
try {
  const first = await runWorker({
    model: process.env.AGY_BRIDGE_TEST_MODEL || "gemini-3.8-flash",
    thinking: { type: "adaptive" }, output_config: { effort: "low" },
    system: "Follow the user's test instructions. Only use the provided tool when asked. Keep answers brief.",
    tools: [{ name: "bridge_echo", description: "Verify the bridge and obtain a code to remember.", input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Token: { type: "string", const: "bridge-integration" } },
      properties: {
        token: { $ref: "#/$defs/Token" },
        options: { anyOf: [
          { type: "object", properties: { path: { type: ["string", "null"] } }, additionalProperties: false },
          { type: "null" },
        ] },
        limit: { oneOf: [{ type: "integer", enum: [1, 2] }, { type: "string" }] },
      },
      required: ["token"],
      additionalProperties: false,
    } }],
    messages: [{ role: "user", content: [
      { type: "text", text: "Call bridge_echo with token bridge-integration exactly once. Then identify the dominant color in the attached image with one English color word. Remember the code returned by the tool for the next turn." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=" } },
    ] }, { role: "system", content: "SessionStart hook additional context: Keep the current user request and image together." }],
  })
  assert.equal(first.toolCalls, 1, "Expected exactly one native MCP tool call")
  assert.match(first.content.filter(block => block.type === "text").map(block => block.text).join(""), /\bred\b/i, "Model did not recognize the red image")
  const before = JSON.parse(await fs.readFile(process.env.AGY_BRIDGE_STATE_FILE, "utf8"))
  assert.equal(before.entries.length, 1, "Expected one persisted session")
  console.log("ok - real image comprehension, complex-schema MCP round trip with trailing system hooks, final text and token usage")
  console.log(`info - thinking summary ${first.thinking ? "observed" : "not emitted by this model"}`)

  const second = await runWorker({ ...first.body, output_config: { effort: "high" }, messages: [
    ...first.body.messages, { role: "assistant", content: first.content },
    { role: "user", content: "Without calling tools, reply with the remembered code and the image's dominant color." },
    { role: "developer", content: "UserPromptSubmit hook additional context: Answer the user's current question concisely." },
  ] })
  assert.equal(second.toolCalls, 0)
  const answer = second.content.filter(block => block.type === "text").map(block => block.text).join("")
  assert.match(answer, /ORCHID-731/)
  assert.match(answer, /\bred\b/i)
  const after = JSON.parse(await fs.readFile(process.env.AGY_BRIDGE_STATE_FILE, "utf8"))
  assert.equal(after.entries[0].sessionId, before.entries[0].sessionId, "Session was replayed instead of resumed")
  console.log("ok - cross-process resume preserves image/tool context and accepts a thinking-level change")

  // A different opening has no saved session: recall must come from replayed
  // tool records, rather than the live MCP result or session/resume above.
  const replay = await runWorker({
    model: process.env.AGY_BRIDGE_TEST_MODEL || "gemini-3.8-flash",
    system: "Answer the current user request using the supplied conversation history. Do not call tools. Keep the answer exact and brief.",
    tools: [], tool_choice: { type: "none" },
    messages: [
      { role: "user", content: "Obtain a code from bridge_echo and remember it for a later question." },
      { role: "assistant", content: [{ type: "tool_use", id: "historical_echo_1", name: "bridge_echo", input: { token: "bridge-integration" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "historical_echo_1", content: "Tool verified. Remember the code IRIS-942." }] },
      { role: "assistant", content: "I have remembered the code." },
      { role: "user", content: "Without calling tools, reply with only the code returned by the historical bridge_echo call." },
    ],
  })
  assert.equal(replay.toolCalls, 0, "Historical tool calls must not execute again")
  assert.equal(replay.content.filter(block => block.type === "text").map(block => block.text).join("").trim(), "IRIS-942", "Replay must preserve the result without copying tool records into the answer")
  const replayState = JSON.parse(await fs.readFile(process.env.AGY_BRIDGE_STATE_FILE, "utf8"))
  assert.equal(new Set(replayState.entries.map(entry => entry.sessionId)).size, 2, "Historical replay must create a separate session")
  console.log("ok - historical tool replay recalls the result without emitting tool records")
  if (process.env.AGY_BRIDGE_TEST_USAGE === "1") {
    const { AntigravityBridgePlugin } = await import("./index.mjs")
    const usage = await (await AntigravityBridgePlugin()).auth.usage()
    assert(usage.windows?.some(window => window.used !== undefined), usage.error || "No quota windows")
    console.log("ok - real quota report parsed")
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
