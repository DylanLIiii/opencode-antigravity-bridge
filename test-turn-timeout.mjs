import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import vm from "node:vm"

const file = fileURLToPath(import.meta.url)
const run = promisify(execFile)

// Each scenario imports the production module in its own process. Compress only
// minute-scale timers by 100: the default is never replaced in source or env.
// Protocol startup and short timers keep real time. The fake's 1.3s pause stands
// for 130s, beyond the previous 120s budget; a separate wall-clock reproduction
// verifies the same boundary without acceleration.
async function fixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-turn-timeout-"))
  const nativeTimeout = globalThis.setTimeout
  const delay = ms => new Promise(resolve => nativeTimeout(resolve, ms))
  const logFile = path.join(root, "events.jsonl")
  const logs = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const until = async predicate => {
    for (const end = Date.now() + 4000; !predicate();) {
      assert(Date.now() < end, "fixture condition did not settle")
      await delay(10)
    }
  }
  try {
    // Reuse the exact ACP/MCP fixture already exercised by the smoke suite.
    const smoke = fs.readFileSync(new URL("./test-smoke.mjs", import.meta.url), "utf8")
    const marker = "fs.writeFileSync(fakeAgy, "
    const start = smoke.indexOf(marker + "String.raw`") + marker.length
    const end = smoke.indexOf("\n`)", start) + 2
    assert(start >= marker.length && end > start, "smoke fake ACP source was not found")
    let source = vm.runInNewContext(smoke.slice(start, end), {})
    const insertion = "  if (text.includes(\"NATIVE_FINAL\")) {"
    assert(source.includes(insertion))
    source = source.replace(insertion, `
  if (text.includes("ISSUE49_DELAY_TOOL")) {
    thought("Preparing large arguments.")
    log({ type: "silentGeneration", convId: session.id })
    let timer
    const outcome = await new Promise(resolve => {
      timer = setTimeout(() => resolve("ready"), 1300)
      cancelWaiter = () => resolve("cancelled")
    })
    clearTimeout(timer)
    cancelWaiter = null
    if (outcome === "cancelled") {
      log({ type: "silentCancelled", convId: session.id })
      return { stopReason: "cancelled" }
    }
    await invoke("echo", { text: "x".repeat(40000) })
    return finish("large tool completed")
  }
` + insertion)
    const fake = path.join(root, "fake.mjs")
    fs.writeFileSync(fake, source)
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const wrapper = path.join(root, "agy")
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 })
    Object.assign(process.env, {
      AGY_PATH: wrapper, FAKE_AGY_LOG: logFile, FAKE_AGY_STATE: root,
      AGY_BRIDGE_STATE_FILE: path.join(root, "sessions.json"),
      AGY_BRIDGE_ACCOUNTS_DIR: path.join(root, "accounts"),
      AGY_BRIDGE_CONVERSATIONS_DIR: root, AGY_BRIDGE_PING_INTERVAL_MS: "80",
      AGY_BRIDGE_USAGE: "0",
    })
    delete process.env.AGY_BRIDGE_TURN_TIMEOUT_MS
    delete process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS
    if (mode === "override") process.env.AGY_BRIDGE_TURN_TIMEOUT_MS = "100"
    globalThis.setTimeout = (callback, ms, ...args) => nativeTimeout(callback, ms >= 100000 ? ms / 100 : ms, ...args)
    const { AntigravityBridgePlugin } = await import("./index.mjs")
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    const prompt = mode === "silent" ? "IDLE_SILENT" : mode === "metadata" ? "IDLE_METADATA" : "ISSUE49_DELAY_TOOL"
    const body = { model: "gemini-test-medium", stream: true, messages: [{ role: "user", content: prompt }],
      tools: [{ name: "echo", description: "Write generated content", input_schema: {
        type: "object", properties: { text: { type: "string" } }, required: ["text"],
      } }] }
    const fetchBody = (request = body, signal) => loader.fetch("agy://local/messages", {
      method: "POST", body: JSON.stringify(request), ...(signal ? { signal } : {}),
    })
    const events = raw => raw.split("\n\n").flatMap(block => {
      const name = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (!name || !data) return []
      return [{ event: name, data: JSON.parse(data) }]
    })
    const started = Date.now()
    const aborter = new AbortController()
    const response = await fetchBody(body, aborter.signal)
    const text = response.text()
    if (mode === "cancel") {
      await until(() => logs().some(e => e.type === "silentGeneration"))
      aborter.abort(new Error("cancel during argument generation"))
      await text.catch(() => {})
      await until(() => logs().some(e => e.type === "silentCancelled"))
      assert(Date.now() - started < 4000, "cancellation must not wait for the generation deadline")
      await delay(1400)
      assert.equal(logs().filter(e => e.type === "mcpPending").length, 0)
      assert.equal(logs().filter(e => e.type === "cancel").length, 1)
    } else {
      const list = events(await text)
      const error = list.find(e => e.event === "error")?.data.error
      if (mode === "large") {
        assert.equal(error, undefined)
        const calls = list.filter(e => e.data.content_block?.type === "tool_use")
        assert.equal(calls.length, 1)
        const args = JSON.parse(list.filter(e => e.data.delta?.type === "input_json_delta").map(e => e.data.delta.partial_json).join(""))
        assert.equal(args.text, "x".repeat(40000))
        assert.equal(logs().filter(e => e.type === "mcpPending").length, 1)
        assert.equal(list.find(e => e.event === "message_delta")?.data.delta.stop_reason, "tool_use")
        const continued = { ...body, messages: [...body.messages,
          { role: "assistant", content: [{ ...calls[0].data.content_block, input: args }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].data.content_block.id, content: "saved" }] },
        ] }
        const final = events(await (await fetchBody(continued)).text())
        assert.equal(final.find(e => e.event === "message_delta")?.data.delta.stop_reason, "end_turn")
        assert(!final.some(e => e.event === "error"))
      } else {
        assert.equal(error?.code, "upstream_idle_timeout")
        assert.equal(error.retryable, false)
        assert.match(error.message, mode === "override" ? /after 100ms/ : /after 600000ms/)
        assert.equal(list.at(-1).event, "error")
        assert(!list.some(e => e.event === "message_stop"))
        assert(Date.now() - started < 15000, "metadata or pings must not remove the finite deadline")
        if (mode !== "override") assert(Date.now() - started >= 5500, "default budget ended before its scaled deadline")
        assert(list.some(e => e.event === "ping"), "downstream pings should occur without renewing progress")
        const init = logs().find(e => e.type === "init")
        assert(init && !fs.existsSync(init.cwd) && !alive(init.pid) && !alive(init.mcpPid))
        if (mode === "metadata") assert(logs().filter(e => e.type === "idleMetadata").length > 5)
      }
    }
    assert.equal(logs().filter(e => e.type === "user").length, 1)
    if (mode !== "large") {
      const retry = await fetchBody()
      assert.equal(retry.status, 409)
      assert.equal((await retry.json()).error.code, "prompt_outcome_unknown")
      assert.equal(logs().filter(e => e.type === "user").length, 1)
    }
    console.log("TIMEOUT_CASE_OK " + mode)
  } finally {
    globalThis.setTimeout = nativeTimeout
    for (const row of logs().filter(e => e.type === "init")) {
      try { process.kill(-row.pid, "SIGKILL") } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === "fixture") {
  try { await fixture(process.argv[3]); process.exit(0) }
  catch (error) { console.error(error); process.exit(1) }
} else {
  for (const [mode, name] of [
    ["large", "default budget permits silent large arguments and one completed tool call"],
    ["silent", "default budget still terminates a silent upstream and forbids replay"],
    ["metadata", "default budget ignores metadata and downstream pings"],
    ["override", "explicit short inactivity budget overrides the new default"],
    ["cancel", "cancel during silent generation settles without tools or replay"],
  ]) test(name, { skip: process.platform === "win32", timeout: 30000 }, async () => {
    const { stdout } = await run(process.execPath, [file, "fixture", mode], { timeout: 25000, maxBuffer: 1024 * 1024 })
    assert(stdout.includes("TIMEOUT_CASE_OK " + mode))
  })
}
