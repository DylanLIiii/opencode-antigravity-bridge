import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-auth-retry-"))
const fakeAgyMjs = path.join(tmpRoot, "fake-agy.mjs")
const fakeAgyBin = path.join(tmpRoot, "agy")
const logFile = path.join(tmpRoot, "events.jsonl")
const stateDir = path.join(tmpRoot, "state")
fs.mkdirSync(stateDir, { recursive: true })

fs.writeFileSync(fakeAgyMjs, String.raw`
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const argv = process.argv.slice(2)
const log = (v) => fs.appendFileSync(process.env.FAKE_E2E_LOG, JSON.stringify(v) + "\n")
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n")
const stateFile = (name) => path.join(process.env.FAKE_E2E_STATE, name)

if (argv.includes("--version")) {
  process.stdout.write("1.5.1\n")
  process.exit(0)
}

if (argv.includes("models")) {
  if (fs.existsSync(stateFile("not-signed-in"))) {
    process.stderr.write("not signed in\n")
    process.exit(1)
  }
  process.stdout.write("gemini-4-carbon-high\tGemini 4 Carbon (High)\n")
  process.exit(0)
}

if (argv[0] === "acp" && argv.includes("--login")) {
  process.stdout.write("Open this URL to sign in:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=test-e2e\n")
  const rl = readline.createInterface({ input: process.stdin })
  rl.on("line", (line) => {
    if (line.trim() === "VALID_AUTH_CODE") {
      try { fs.unlinkSync(stateFile("not-signed-in")) } catch {}
      process.stdout.write("Successfully logged in!\n")
      process.exit(0)
    }
    process.stderr.write("Invalid authorization code\n")
    process.exit(1)
  })
  setInterval(() => {}, 1000)
} else if (argv[0] === "acp") {
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1] }
  const agentLog = flag("--log-file")
  const idePort = flag("--ide-mcp-port")
  let session = null
  let mcp = null
  let nextMcpId = 0
  const mcpPending = new Map()

  function mcpReq(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextMcpId
      mcpPending.set(id, { resolve, reject })
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  async function connectIde() {
    if (!idePort || mcp) return
    mcp = spawn("nc", ["127.0.0.1", idePort], { stdio: ["pipe", "pipe", "pipe"] })
    readline.createInterface({ input: mcp.stdout }).on("line", (line) => {
      const msg = JSON.parse(line)
      const w = mcpPending.get(msg.id)
      if (!w) return
      mcpPending.delete(msg.id)
      if (msg.error) w.reject(new Error(msg.error.message))
      else w.resolve(msg.result)
    })
    await mcpReq("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agy", version: "1.5.1" } })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")
    await mcpReq("tools/list", {})
  }

  const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: u } })
  const chunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const msg = JSON.parse(line)
    const p = msg.params || {}
    try {
      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0", id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, audio: false, embeddedContext: true },
              sessionCapabilities: { resume: {}, close: {} },
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
            agentInfo: { name: "Antigravity ACP Server", version: "1.5.1" },
            authMethods: [],
          },
        })
        return
      }
      if (msg.method === "session/new" || msg.method === "session/resume") {
        const id = msg.method === "session/new" ? "sess-" + Math.random().toString(36).slice(2, 9) : p.sessionId
        if (msg.method === "session/new") fs.writeFileSync(stateFile(id + ".sess"), "1")
        else if (!fs.existsSync(stateFile(id + ".sess"))) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Conversation Not Found" } })
          return
        }
        session = { id, step: 0 }
        await connectIde()
        log({ type: msg.method, pid: process.pid, sessionId: id, systemAppend: p._meta?.antigravity?.systemPrompt?.append ?? "" })
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: id, models: { currentModelId: "gemini-4-carbon-high", availableModels: [] }, configOptions: [] } })
        return
      }
      if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} })
        return
      }
      if (msg.method === "session/prompt") {
        session.step++
        const text = (p.prompt || []).map((b) => b.text || "").join("")
        log({ type: "prompt", pid: process.pid, sessionId: session.id, text })

        if (fs.existsSync(stateFile("fail-401-once"))) {
          fs.unlinkSync(stateFile("fail-401-once"))
          fs.appendFileSync(agentLog, "E1111 22:00:00.000000 100 errorreport.go:224] agent executor error: generating and executing: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\n")
          chunk("\n⚠ Agent execution terminated due to error.\n")
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
          return
        }

        if (fs.existsSync(stateFile("fail-401-always"))) {
          fs.appendFileSync(agentLog, "E1111 22:00:00.000000 100 errorreport.go:224] agent executor error: generating and executing: UNAUTHENTICATED (code 401): token revoked.\n")
          chunk("\n⚠ Agent execution terminated due to error.\n")
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
          return
        }

        if (text.includes("PREFILL_MAX_TOKENS")) {
          chunk("Alpha-")
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "max_tokens", usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } } })
          return
        }
        if (text.toLowerCase().includes("continue") && session.step >= 2) {
          chunk("Omega!")
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 25, outputTokens: 6, totalTokens: 31 } } })
          return
        }

        if (text.includes("CALL_BIG_TOOL")) {
          const callId = "call_big_1"
          update({ sessionUpdate: "tool_call", toolCallId: callId, name: "mcp_ide-tools_read_big", status: "in_progress", kind: "other", rawInput: {} })
          const res = await mcpReq("tools/call", { name: "read_big", arguments: {} })
          const mcpText = (res.content || []).map((c) => c.text || "").join("")
          log({ type: "mcpReceived", bytes: Buffer.byteLength(mcpText, "utf8"), textSample: mcpText.slice(0, 80), omittedNotice: mcpText.includes("Bridge omitted") })
          chunk("Big tool handled.")
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 30, outputTokens: 17, totalTokens: 47 } } })
          return
        }

        chunk("Reply:" + session.id)
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } })
      }
    } catch (err) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } })
    }
  })
}
`)

fs.writeFileSync(fakeAgyBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeAgyMjs}" "$@"\n`, { mode: 0o755 })

process.env.AGY_PATH = fakeAgyBin
process.env.FAKE_E2E_LOG = logFile
process.env.FAKE_E2E_STATE = stateDir
process.env.AGY_BRIDGE_STATE_FILE = path.join(stateDir, "sessions.json")
process.env.AGY_BRIDGE_CONVERSATIONS_DIR = stateDir

const readLogs = () => fs.existsSync(logFile)
  ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : []

const { default: Bridge } = await import("./index.mjs?auth-retry")
const plugin = await Bridge.server({ client: null, directory: tmpRoot }, {})
const loader = await plugin.auth.loader(async () => ({ key: "agy" }))

const postJson = async (body) => {
  const res = await loader.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-4-carbon", max_tokens: 1024, stream: false, ...body }),
  })
  return { status: res.status, json: await res.json() }
}

test("stale-proc OAuth 401 retires stale proc, re-parks pre-turn history, session/resumes on fresh proc, and returns 502 on double 401", async () => {
  const t1 = await postJson({
    messages: [{ role: "user", content: "Start warm session before OAuth expiry" }],
  })
  assert.equal(t1.status, 200)
  const origSessionId = t1.json.content[0].text.split("Reply:")[1]
  assert.ok(origSessionId.startsWith("sess-"))

  fs.writeFileSync(path.join(stateDir, "fail-401-once"), "1")
  const t2 = await postJson({
    messages: [
      { role: "user", content: "Start warm session before OAuth expiry" },
      { role: "assistant", content: t1.json.content },
      { role: "user", content: "Continue after token refresh" },
    ],
  })
  assert.equal(t2.status, 200)
  assert.equal(t2.json.content[0].text, `Reply:${origSessionId}`, "fresh proc resumed exact same sessionId!")
  const resumes = readLogs().filter((e) => e.type === "session/resume" && e.sessionId === origSessionId)
  assert.equal(resumes.length, 1, "session/resume invoked on fresh proc")

  fs.writeFileSync(path.join(stateDir, "fail-401-always"), "1")
  try {
    const t3 = await postJson({
      messages: [{ role: "user", content: "Brand new conversation with revoked Google login" }],
    })
    assert.equal(t3.status, 502)
    assert.equal(t3.json.error?.code, "upstream_unauthenticated")
  } finally {
    try { fs.unlinkSync(path.join(stateDir, "fail-401-always")) } catch {}
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test.after(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})
