import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy auth retry-"))
const fakeAgyMjs = path.join(tmpRoot, "fake-agy.mjs")
const fakeAgyBin = path.join(tmpRoot, process.platform === "win32" ? "agy.cmd" : "agy")
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
  log({ type: "fixture-process", pid: process.pid })
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1] }
  const agentLog = flag("--log-file")
  const idePort = flag("--ide-mcp-port")
  let session = null
  let mcp = null
  let nextMcpId = 0
  const mcpPending = new Map()

  let stopping = false
  function shutdown() {
    if (stopping) return
    stopping = true
    if (!mcp) return process.exit(0)
    mcp.once("close", () => process.exit(0))
    mcp.stdin.end()
    setTimeout(() => { mcp.kill(); process.exit(0) }, 1000).unref()
  }
  process.stdin.on("end", shutdown)
  process.on("SIGTERM", shutdown)
  // The parent test asks pooled ACP processes to exit before deleting files.
  setInterval(() => { if (fs.existsSync(stateFile("stop-fixture"))) shutdown() }, 50).unref()

  function mcpReq(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextMcpId
      mcpPending.set(id, { resolve, reject })
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  async function connectIde() {
    if (!idePort || mcp) return
    // --ide-mcp-port is Bridge's private control endpoint, not an MCP socket.
    // Use the real stdio MCP adapter with its inherited control port/token.
    mcp = spawn(process.execPath, [process.env.FAKE_E2E_MCP_SERVER], { stdio: ["pipe", "pipe", "pipe"] })
    log({ type: "fixture-process", pid: mcp.pid })
    const fail = error => {
      for (const waiter of mcpPending.values()) waiter.reject(error)
      mcpPending.clear()
    }
    mcp.on("error", fail)
    mcp.on("close", () => fail(new Error("fixture MCP adapter closed")))
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
    log({ type: "mcp-ready" })
  }

  const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: u } })
  const chunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const msg = JSON.parse(line)
    const p = msg.params || {}
    try {
      if (msg.method === "initialize" && fs.existsSync(stateFile("fail-init-once"))) {
        fs.unlinkSync(stateFile("fail-init-once"))
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "synthetic fresh initialize failure" } })
        return
      }
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
        if (msg.method === "session/resume" && fs.existsSync(stateFile("slow-resume"))) {
          log({ type: "slow-resume-start", pid: process.pid })
          await new Promise((r) => setTimeout(r, 400))
        }
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

        if (text.includes("EMPTY_THEN_401") && session.step === 1) {
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "max_tokens" } })
          return
        }
        if (text.includes("VISIBLE_THEN_401") || (text.toLowerCase().includes("continue") && fs.existsSync(stateFile("continuation-401")))) {
          if (text.includes("VISIBLE_THEN_401")) chunk("Already visible")
          fs.appendFileSync(agentLog, "E1111 22:00:00.000000 100 errorreport.go:224] agent executor error: UNAUTHENTICATED (code 401): token revoked.\n")
          chunk("\n⚠ Agent execution terminated due to error.\n")
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
          return
        }
        if (text.includes('NOTICE66_')) {
          const scenario = /NOTICE66_(\w+)/.exec(text)[1]
          const network = '⚠ There was a network issue connecting to the server, please try again.'
          const credits = '⚠ Your AI credits balance is too low to continue.'
          const invalid = '⚠ Model produced invalid output.'
          const api = '⚠ API error (attempt 3): QUOTA_EXHAUSTED: individual quota exhausted'
          let output
          if (scenario === 'CREDITS') {
            fs.appendFileSync(agentLog, 'E] inference connection failed: transient EOF\n')
            output = '\n' + credits + '\r\n \t\r\n'
          } else if (scenario === 'NETWORK') output = '\n' + network + '\r\n\r\n'
          else if (scenario === 'API_ONLY') output = '\n' + api
          else if (scenario === 'RETRY_LOG') {
            fs.appendFileSync(agentLog, 'E] CallWithRetry: attempt 3 failed (QUOTA_EXHAUSTED), retrying in 1s\n')
            output = '\n⚠ Agent execution terminated due to error.\n'
          } else if (scenario === 'FENCED') output = 'Quoted:\n' + String.fromCharCode(96).repeat(3) + '\n' + network + '\n' + credits + '\n' + invalid + '\n' + String.fromCharCode(96).repeat(3)
          else if (scenario === 'INVALID_ONLY') output = '\n' + invalid
          else {
            fs.appendFileSync(agentLog, 'E] Run: attempt 2 failed (QUOTA_EXHAUSTED), retrying in 1s\n')
            output = '\n' + api + '\r\n' + (scenario === 'INVALID_RECOVER' ? invalid : network) + '\r\nRecovered answer.'
          }
          // Single-character chunks cover prefixes and the CR/LF boundary.
          for (const char of output) chunk(char)
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
          return
        }
        if (text.includes('NOTICE49_')) {
          const fenced = text.includes('FENCE')
          const prefix = fenced ? 'Here:\n' + String.fromCharCode(96).repeat(3) + 'js\nconst a = 1;\n' : ''
          const banner = '\n⚠ Agent execution terminated due to error.\n'
          if (prefix) chunk(prefix)
          if (!text.includes('NO_LOG')) fs.appendFileSync(agentLog, 'E1111 errorreport.go:224] agent executor error: INTERNAL (code 500): backend exploded.\n')
          chunk(banner)
          if (text.includes('WHITESPACE')) { chunk(' '); chunk('\t'); chunk('\n') }
          if (text.includes('RECOVER')) { chunk(' '); chunk('Recovered answer.') }
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
          return
        }
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

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
fs.writeFileSync(fakeAgyBin, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "${fakeAgyMjs}" %*\r\n`
  : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeAgyMjs)} "$@"\n`, { mode: 0o755 })

process.env.AGY_PATH = fakeAgyBin
process.env.FAKE_E2E_LOG = logFile
process.env.FAKE_E2E_STATE = stateDir
process.env.FAKE_E2E_MCP_SERVER = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))
process.env.AGY_BRIDGE_STATE_FILE = path.join(stateDir, "sessions.json")
process.env.AGY_BRIDGE_CONVERSATIONS_DIR = stateDir
process.env.AGY_BRIDGE_ACCOUNTS_DIR = path.join(tmpRoot, "accounts")
process.env.AGY_BRIDGE_CONTEXT_DIR = path.join(tmpRoot, "context")
delete process.env.AGY_BRIDGE_WSL_DISTRO

const readLogs = () => fs.existsSync(logFile)
  ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : []

test.after(async () => {
  fs.writeFileSync(path.join(stateDir, "stop-fixture"), "1")
  const alive = pid => {
    try { process.kill(pid, 0); return true } catch (error) {
      if (error.code === "ESRCH") return false
      throw error
    }
  }
  const pids = [...new Set(readLogs().filter(event => event.type === "fixture-process" && event.pid).map(event => event.pid))]
  const deadline = Date.now() + 5000
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(pids.filter(alive), [], "fixture ACP and MCP processes exited before cleanup")
  assert.ok(readLogs().some(event => event.type === "mcp-ready"), "the production MCP adapter completed a real handshake and tools/list")
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})

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

for (const stream of [false, true]) for (const scenario of [
  'CREDITS', 'NETWORK', 'API_ONLY', 'RETRY_LOG', 'FENCED', 'INVALID_ONLY', 'INVALID_RECOVER', 'NETWORK_RECOVER',
]) {
  test(`issue66 production notice ${scenario}, stream=${stream}`, async () => {
    const res = await loader.fetch('agy://local/messages', { method: 'POST', body: JSON.stringify({
      model: 'gemini-4-carbon', stream, metadata: { user_id: `notice66-${scenario}-${stream}` },
      messages: [{ role: 'user', content: 'NOTICE66_' + scenario }],
    }) })
    const body = await res.text()
    const frames = stream ? body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : []
    const json = stream ? null : JSON.parse(body)
    const error = stream ? frames.find(frame => frame.type === 'error')?.error : json.error
    const output = stream ? frames.filter(frame => frame.delta?.type === 'text_delta').map(frame => frame.delta.text).join('')
      : (json.content || []).map(block => block.text || '').join('')
    if (['CREDITS', 'NETWORK', 'API_ONLY', 'RETRY_LOG'].includes(scenario)) {
      assert.ok(error, body)
      if (scenario === 'NETWORK') {
        assert.equal(res.status, stream ? 200 : 502)
        assert.match(error.message, /network issue/)
      } else {
        assert.equal(res.status, stream ? 200 : 429)
        assert.equal(error.type, 'rate_limit_error')
        assert.equal(error.code, 'AGY_ERROR_QUOTA_EXHAUSTED')
        assert.equal(error.retryable, false)
      }
      assert.ok(!output.includes('⚠'), output)
      if (stream) assert.ok(!frames.some(frame => frame.delta?.stop_reason === 'end_turn'))
    } else {
      assert.equal(res.status, 200, body)
      assert.equal(error, undefined, body)
      if (scenario === 'FENCED') {
        assert.match(output, /⚠ There was a network issue/)
        assert.match(output, /⚠ Your AI credits/)
        assert.match(output, /⚠ Model produced invalid output/)
      } else {
        assert.equal(output.trim(), scenario === 'INVALID_ONLY' ? '' : 'Recovered answer.')
      }
    }
  })
}

for (const scenario of ['FENCE_FAIL', 'WHITESPACE_FAIL', 'FENCE_NO_LOG', 'WHITESPACE_NO_LOG', 'FENCE_RECOVER']) {
  test('notice boundary ' + scenario, async () => {
    const result = await postJson({ messages: [{ role: 'user', content: 'NOTICE49_' + scenario }] })
    if (scenario.endsWith('FAIL')) {
      assert.equal(result.status, 502, JSON.stringify(result))
      assert.match(result.json.error?.message || '', /backend exploded/)
    } else {
      assert.equal(result.status, 200, JSON.stringify(result))
      const text = result.json.content.map(block => block.text || '').join('')
      if (scenario.includes('NO_LOG')) {
        const prefix = scenario.includes('FENCE') ? 'Here:\n' + String.fromCharCode(96).repeat(3) + 'js\nconst a = 1;\n' : ''
        assert.equal(text, prefix + '\n⚠ Agent execution terminated due to error.\n' + (scenario.includes('WHITESPACE') ? ' \t\n' : ''))
      } else {
        assert.ok(text.endsWith('Recovered answer.'))
        assert.ok(!text.includes('Agent execution terminated'))
      }
    }
  })
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
    const t3Prompts = readLogs().filter((e) => e.type === "prompt" && e.text.includes("Brand new conversation with revoked Google login"))
    assert.equal(t3Prompts.length, 2, "a second 401 never triggers a third prompt")
    fs.unlinkSync(path.join(stateDir, "fail-401-always"))

    const beforeVisible = readLogs().length
    const visible = await postJson({ messages: [{ role: "user", content: "VISIBLE_THEN_401" }] })
    assert.equal(visible.status, 502)
    assert.equal(readLogs().slice(beforeVisible).filter((e) => e.type === "prompt").length, 1, "visible output prevents replay")

    fs.writeFileSync(path.join(stateDir, "continuation-401"), "1")
    const beforeContinuation = readLogs().length
    const continuation = await postJson({ messages: [{ role: "user", content: "EMPTY_THEN_401" }] })
    assert.equal(continuation.status, 502)
    assert.equal(readLogs().slice(beforeContinuation).filter((e) => e.type === "prompt").length, 2, "a failed continuation does not replay the initial prompt")

    // A failed fresh-process rebuild must release its new prompt claim.
    fs.unlinkSync(path.join(stateDir, "continuation-401"))
    const initHistory = [{ role: "user", content: "INIT_FAIL_WARM" }]
    const initWarm = await postJson({ messages: initHistory })
    assert.equal(initWarm.status, 200)
    const initBody = [...initHistory, { role: "assistant", content: initWarm.json.content }, { role: "user", content: "INIT_FAIL_RETRY" }]
    fs.writeFileSync(path.join(stateDir, "fail-401-once"), "1")
    fs.writeFileSync(path.join(stateDir, "fail-init-once"), "1")
    const initFailed = await postJson({ messages: initBody })
    assert.equal(initFailed.status, 502)
    assert.match(initFailed.json.error?.message ?? "", /synthetic fresh initialize failure/)
    const initRetry = await postJson({ messages: initBody })
    assert.equal(initRetry.status, 200, `identical retry is not blocked: ${JSON.stringify(initRetry.json)}`)
    fs.writeFileSync(path.join(stateDir, "continuation-401"), "1")

    // Cancel while the fresh process is still being rebuilt after the 401.
    fs.unlinkSync(path.join(stateDir, "continuation-401"))
    const cancelHistory = [
      { role: "user", content: "CANCEL_WARM" },
    ]
    const warm = await postJson({ messages: cancelHistory })
    assert.equal(warm.status, 200)
    fs.writeFileSync(path.join(stateDir, "fail-401-once"), "1")
    fs.writeFileSync(path.join(stateDir, "slow-resume"), "1")
    const ac = new AbortController()
    const cancelBody = [...cancelHistory, { role: "assistant", content: warm.json.content }, { role: "user", content: "CANCEL_DURING_REBUILD" }]
    const beforeCancel = readLogs().length
    const pending = loader.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({ model: "gemini-4-carbon", max_tokens: 1024, stream: false, messages: cancelBody }),
    }).then((r) => r.text(), (e) => `ERR:${e?.name ?? e}`)
    const deadline = Date.now() + 5000
    while (!readLogs().slice(beforeCancel).some((e) => e.type === "slow-resume-start") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(readLogs().slice(beforeCancel).some((e) => e.type === "slow-resume-start"), "fresh process rebuild started")
    ac.abort(new Error("client cancelled"))
    await pending
    await new Promise((r) => setTimeout(r, 900))
    const after = readLogs().slice(beforeCancel)
    assert.equal(after.filter((e) => e.type === "prompt" && e.text.includes("CANCEL_DURING_REBUILD")).length, 1,
      "no prompt is submitted on the fresh process after cancellation")
    fs.unlinkSync(path.join(stateDir, "slow-resume"))
    const followUp = await postJson({ messages: [...cancelBody, { role: "assistant", content: [{ type: "text", text: "x" }] }, { role: "user", content: "after cancel" }] })
    assert.notEqual(followUp.json?.error?.message?.includes("unfinished response"), true, "no attached/unfinished turn left behind")
  } finally {
    try { fs.unlinkSync(path.join(stateDir, "fail-401-always")) } catch {}
  }
})
