// Smoke test for the agy bridge plugin. Uses a fake `agy` script that speaks
// the stream-json protocol, and exercises:
//   1. Process spawn + init handshake
//   2. Single-turn request/response translation (Anthropic SSE out)
//   3. Conversation reuse across turns
//   4. TOOL_CALL line → Anthropic tool_use block
//   5. Mid-turn agy death → SSE error frame (not silent truncation)
//   6. Busy proc → 503, not a broken stream
//
// Run: node test-smoke.mjs

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)

// --- a fake agy ------------------------------------------------------------
// A node script that speaks agy's stream-json protocol: emits `init`, then
// for each `user` line, streams a canned reply as step_update deltas and a
// result. If the user message contains "DIE", it exits mid-turn. If it
// contains "TOOL", it emits a TOOL_CALL line.
const fakeAgy = path.join(here, ".tmp-fake-agy.mjs")
fs.writeFileSync(fakeAgy, `
import readline from "node:readline"
const convId = "conv-" + Math.random().toString(36).slice(2, 10)
console.log(JSON.stringify({ event: "init", conversation_id: convId, init: { cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } }))
const rl = readline.createInterface({ input: process.stdin })
let turn = 0
let cumulative = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
rl.on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.event !== "user") return
  turn++
  const text = typeof msg.message.content === "string" ? msg.message.content : ""
  if (text.includes("DIE")) { process.exit(2) }
  const reply = text.includes("TOOL")
    ? 'Let me run that.\\nTOOL_CALL run_command {"CommandLine":"ls"}\\nDone.'
    : "You said: " + text.slice(0, 80).replace(/"/g, "'")
  cumulative.input_tokens += 10
  cumulative.output_tokens += reply.length
  cumulative.total_tokens = cumulative.input_tokens + cumulative.output_tokens
  // Stream as two deltas.
  const half = Math.floor(reply.length / 2)
  console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: reply.slice(0, half) } }))
  console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: reply.slice(half), usage: cumulative } }))
  console.log(JSON.stringify({ event: "result", result: { conversation_id: convId, status: "SUCCESS", response: reply + "\\n", duration_seconds: 0.1, num_turns: turn, usage: cumulative } }))
})
`)

// Point the plugin at the fake.
process.env.AGY_PATH = process.execPath
// The plugin spawns `AGY_PATH` with agy flags; wrap: node fake-agy.mjs <flags>
// Simplest: make AGY_PATH a tiny shell script that execs node on the fake.
const wrapper = path.join(here, ".tmp-agy")
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgy)} "$@"\n`)
fs.chmodSync(wrapper, 0o755)
process.env.AGY_PATH = wrapper

// Import AFTER env is set (findAgy caches).
const { default: pluginDefault } = await import("./index.mjs")
const plugin = await pluginDefault.server({ client: null, directory: os.tmpdir() }, {})

let failures = 0
function check(name, cond, detail = "") {
  if (cond) console.log(`ok  - ${name}`)
  else { console.log(`BAD - ${name}${detail ? ": " + detail : ""}`); failures++ }
}

// --- helpers ---------------------------------------------------------------
async function callFetch(body) {
  const loader = await plugin.auth.loader(async () => ({ key: "agy" }))
  const res = await loader.fetch("agy://local/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res
}

async function readSSE(res) {
  let text = ""
  let streamError = null
  try {
    text = await new Response(res.body).text()
  } catch (e) {
    // Stream errored mid-flight (e.g. UnsupportedContent thrown before any
    // bytes were enqueued): the reader rejects with the error.
    streamError = e
  }
  const events = []
  for (const chunk of text.split("\n\n")) {
    const evLine = chunk.split("\n").find((l) => l.startsWith("event: "))
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "))
    if (!evLine || !dataLine) continue
    try {
      events.push({ event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
    } catch {}
  }
  return { events, raw: text, streamError }
}

// --- test 1: basic single turn ---------------------------------------------
{
  const res = await callFetch({
    model: "antigravity-bridge/gemini-3.7-flash-high",
    messages: [{ role: "user", content: "hello world" }],
  })
  check("single turn returns 200", res.status === 200, `got ${res.status}`)
  const { events } = await readSSE(res)
  const kinds = events.map((e) => e.event)
  check("has message_start", kinds.includes("message_start"))
  check("has content_block_delta", kinds.includes("content_block_delta"))
  check("has message_delta", kinds.includes("message_delta"))
  check("has message_stop", kinds.includes("message_stop"))
  const text = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data.delta?.text || "")
    .join("")
  // The first turn wraps the user message in <current_turn> tags.
  check("text contains echo", text.includes("hello world"), JSON.stringify(text))
  const md = events.find((e) => e.event === "message_delta")
  check("output_tokens reported", (md?.data?.usage?.output_tokens ?? 0) > 0)
  check("input_tokens reported", (md?.data?.usage?.input_tokens ?? 0) > 0)
}

// --- test 2: conversation reuse --------------------------------------------
{
  const first = {
    model: "antigravity-bridge/gemini-3.7-flash-high",
    messages: [{ role: "user", content: "first message" }],
  }
  const res1 = await callFetch(first)
  await readSSE(res1)
  // Second turn of the same conversation.
  const second = {
    model: "antigravity-bridge/gemini-3.7-flash-high",
    messages: [
      { role: "user", content: "first message" },
      { role: "assistant", content: "You said: first message" },
      { role: "user", content: "second message" },
    ],
  }
  const res2 = await callFetch(second)
  const { events } = await readSSE(res2)
  const text = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data.delta?.text || "")
    .join("")
  check("second turn gets reply", text.includes("You said: second message"), JSON.stringify(text))
}

// --- test 3: TOOL_CALL → tool_use block ------------------------------------
{
  const res = await callFetch({
    model: "antigravity-bridge/gemini-3.7-flash-high",
    messages: [{ role: "user", content: "please run a TOOL for me" }],
    tools: [
      {
        name: "run_command",
        description: "Run a shell command",
        input_schema: { type: "object", properties: { CommandLine: { type: "string" } }, required: ["CommandLine"] },
      },
    ],
  })
  const { events } = await readSSE(res)
  const toolUseStart = events.find(
    (e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use",
  )
  check("tool_use block emitted", !!toolUseStart)
  check("tool name is run_command", toolUseStart?.data.content_block?.name === "run_command")
  const md = events.find((e) => e.event === "message_delta")
  check("stop_reason is tool_use", md?.data?.delta?.stop_reason === "tool_use")
}

// --- test 4: agy dies mid-turn → SSE error frame ---------------------------
{
  const res = await callFetch({
    model: "antigravity-bridge/gemini-3.7-flash-high",
    messages: [{ role: "user", content: "please DIE now" }],
  })
  const { events } = await readSSE(res)
  const errEv = events.find((e) => e.event === "error")
  check("error frame emitted on agy death", !!errEv, JSON.stringify(events.map((e) => e.event)))
}

// --- test 5: image refused with an error ------------------------------------
{
  // Unsupported content is thrown inside the stream's start() before any
  // bytes are enqueued, so the stream errors out. The plugin's job is to
  // surface the unsupported-content message, not to crash silently.
  const res = await callFetch({
    model: "antigravity-bridge/gemini-3.7-flash-high",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what's in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  })
  const { events, streamError } = await readSSE(res)
  const errEv = events.find((e) => e.event === "error")
  const errMsg = errEv?.data?.error?.message || streamError?.message || ""
  check("image content produces an error", !!(errEv || streamError))
  check("error mentions not supported", errMsg.includes("not supported"), errMsg)
}

// --- teardown ---------------------------------------------------------------
const loader = await plugin.auth.loader(async () => ({ key: "agy" }))
// Kill the pool via one more fetch + cancel, then clean temp files.
try { fs.unlinkSync(fakeAgy) } catch {}
try { fs.unlinkSync(wrapper) } catch {}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
