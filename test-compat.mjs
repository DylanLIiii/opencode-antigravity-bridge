import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
// The smoke suite covers the fetch/ACP/MCP path; these cases cover batched
// client payloads that the sequential fake ACP server cannot emit itself.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compat-test-"))
const entry = new URL("./index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock, execOnce };\n")
const { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock, execOnce } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2VB" } }
const result = (id, name, text) => ({
  block: { type: "tool_result", tool_use_id: id, content: text },
  call: { id, name },
  result: { content: [{ type: "text", text }], isError: false },
})
const bodyFor = content => ({ messages: [{ role: "assistant", content: [] }, { role: "user", content }] })

test("images and dimension notes belong to their preceding result in a batch", () => {
  const a = result("call_a", "Read", "first")
  const b = result("call_b", "Read", "second")
  const body = bodyFor([a.block, image, { type: "text", text: "[Image: first screenshot]" }, b.block])
  const { results } = inspectToolTurn([a, b], body)
  assert.deepEqual(results[0].result.content.map(part => part.type), ["text", "image", "text"])
  assert.equal(results[0].result.content[1].data, image.source.data)
  assert.deepEqual(results[1].result.content, [{ type: "text", text: "second" }])
})

test("a companion cannot attach to a different preceding tool", () => {
  const skill = result("call_skill", "Skill", "Launching skill: review")
  const read = result("call_read", "Read", "file text")
  for (const text of ["ARGUMENTS: review", "Tool loaded.", "[Image: screenshot]"]) {
    assert.throws(() => inspectToolTurn([skill, read], bodyFor([skill.block, read.block, { type: "text", text }])), /text beside a live tool_result/)
  }
})

test("a partial ID rename maps by full history without discarding the live ID anchor", () => {
  const original = [
    { type: "tool_use", id: "original_a", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "original_b", name: "Read", input: { path: "b" } },
  ]
  const expectedMessages = [{ role: "user", content: "read both" }, { role: "assistant", content: original }]
  const history = structuredClone(expectedMessages)
  history[1].content[1].id = "renamed_b"
  const turn = { finalized: false }
  const proc = { turn, expectedMessages, matchesHistory: value => historyKey(value) === historyKey(expectedMessages) }
  const calls = original.map(call => ({ ...call, mcpResponded: false }))
  allProcs.add(proc)
  calls.forEach(call => toolCalls.set(call.id, { proc, turn, call }))
  try {
    const blocks = ["original_a", "renamed_b"].map(id => ({ type: "tool_result", tool_use_id: id, content: "done" }))
    const matched = matchToolResults({ messages: [...history, { role: "user", content: blocks }] }, blocks)
    assert.deepEqual(matched.map(item => item.match?.call?.id), ["original_a", "original_b"])
  } finally {
    allProcs.delete(proc)
    calls.forEach(call => toolCalls.delete(call.id))
  }
})

test("history replay keeps image bytes between their original surrounding text", () => {
  const parts = renderInitialPromptParts({ messages: [
    { role: "user", content: [{ type: "text", text: "before first image" }, image, { type: "text", text: "after first image" }] },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "current question" },
  ] }, null, true)
  assert.deepEqual(parts.map(part => part.type), ["text", "image", "text"])
  assert.ok(parts[0].text.endsWith("Human: before first image"))
  assert.ok(parts[2].text.startsWith("after first image\nAssistant: old reply"))
  assert.ok(parts[2].text.endsWith("<current_turn>\ncurrent question\n</current_turn>"))
})

test("state lock recovers a stale lock only after its owning process has exited", () => {
  const file = path.join(workspace, "dead-owner-state.json")
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: 2147483647 }))
  const old = new Date(Date.now() - 10_000)
  fs.utimesSync(file + ".lock", old, old)
  let wrote = false
  withStateLock(file, () => { wrote = true })
  assert.equal(wrote, true)
  assert.equal(fs.existsSync(file + ".lock"), false)
})

async function captureExec(callback, mode = "close") {
  const originalSpawn = childProcess.spawn
  const originalEnv = process.env
  const originalSetTimeout = globalThis.setTimeout
  const calls = []
  const delays = []
  const inherited = { PATH: "parent-path", AGY_CLI_DISABLE_AUTO_UPDATE: "false" }
  try {
    process.env = inherited
    globalThis.setTimeout = (callback, delay, ...args) => {
      delays.push(delay)
      return originalSetTimeout(callback, mode === "timeout" ? 0 : delay, ...args)
    }
    childProcess.spawn = (file, args, options) => {
      calls.push({ file, args, options })
      if (mode === "throw") throw new Error("fixture spawn failure")
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = signal => {
        calls.at(-1).signal = signal
        queueMicrotask(() => child.emit("close", null))
      }
      queueMicrotask(() => {
        child.stdout.write("fixture output")
        child.stderr.write("fixture error output")
        if (mode === "close") child.emit("close", 7)
        if (mode === "error") child.emit("error", new Error("fixture async failure"))
      })
      return child
    }
    syncBuiltinESMExports()
    await callback(calls, delays, inherited)
    assert.equal(inherited.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
  } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
    process.env = originalEnv
    globalThis.setTimeout = originalSetTimeout
  }
}

test("execOnce agy branch forces hidden windows and disables updates without mutating options", async () => {
  await captureExec(async (calls, delays) => {
    const env = Object.freeze({ CALLER_ONLY: "kept", AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
    const opts = Object.freeze({ env, windowsHide: false, cwd: "workspace", timeoutMs: 1234 })
    const args = Object.freeze(["models"])
    const result = await execOnce("agy", args, opts)
    assert.deepEqual(result, { err: null, stdout: "fixture output", stderr: "fixture error output", code: 7, timedOut: false })
    assert.equal(calls[0].file, "agy")
    assert.equal(calls[0].args, args)
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(calls[0].options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true")
    assert.equal(calls[0].options.env.CALLER_ONLY, "kept")
    assert.equal(calls[0].options.env.PATH, "parent-path")
    assert.equal(calls[0].options.cwd, "workspace")
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"])
    assert.deepEqual(delays, [1234])
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
    assert.equal(opts.windowsHide, false)
  })
})

test("execOnce taskkill uses generic spawn, keeps caller env and cannot expose a window", async () => {
  await captureExec(async (calls, delays) => {
    const args = Object.freeze(["/T", "/F", "/PID", "12345"])
    for (const env of [Object.freeze({ CALLER_ONLY: "kept" }), Object.freeze({ AGY_CLI_DISABLE_AUTO_UPDATE: "false" })]) {
      const opts = Object.freeze({ env, windowsHide: false, timeoutMs: 3000 })
      const result = await execOnce("taskkill", args, opts)
      const actual = calls.at(-1)
      assert.equal(actual.file, "taskkill")
      assert.equal(actual.args, args)
      assert.equal(actual.options.windowsHide, true, "taskkill must remain hidden after caller overrides")
      assert.equal(actual.options.env, env, "taskkill must use generic spawn without agy env injection")
      assert.deepEqual(actual.options.env, env)
      assert.equal(opts.windowsHide, false)
      assert.equal(result.code, 7)
      assert.equal(result.stdout, "fixture output")
      assert.equal(result.stderr, "fixture error output")
      assert.equal(result.timedOut, false)
    }
    await execOnce("taskkill", args)
    assert.equal(calls.at(-1).options.env, undefined, "taskkill without caller env must inherit the parent environment")
    assert.deepEqual(delays, [3000, 3000, 30000])
  })
})

test("execOnce taskkill retains its three-second deadline and kills only its child", async () => {
  await captureExec(async (calls, delays) => {
    const result = await execOnce("taskkill", ["/T", "/F", "/PID", "12345"], { timeoutMs: 3000 })
    assert.deepEqual(delays, [3000])
    assert.equal(calls[0].signal, "SIGKILL")
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.equal(result.stdout, "fixture output")
  }, "timeout")
})

test("execOnce still collects synchronous and asynchronous spawn failures", async () => {
  for (const mode of ["throw", "error"]) {
    await captureExec(async () => {
      const result = await execOnce("taskkill", [])
      assert.match(result.err.message, /fixture/)
      assert.equal(result.code, null)
      assert.equal(result.timedOut, false)
    }, mode)
  }
})
