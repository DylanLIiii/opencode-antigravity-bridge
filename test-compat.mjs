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
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, renderContinuedTurnParts, toolResult, withStateLock, execOnce, normalizeTools, validatePromptBudget, renderReplayPromptParts };\n")
const { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, renderContinuedTurnParts, toolResult, withStateLock, execOnce, normalizeTools, validatePromptBudget, renderReplayPromptParts } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2VB" } }
const result = (id, name, text) => ({
  block: { type: "tool_result", tool_use_id: id, content: text },
  call: { id, name },
  result: { content: [{ type: "text", text }], isError: false },
})
const bodyFor = content => ({ messages: [{ role: "assistant", content: [] }, { role: "user", content }] })

test("prompt budget counts UTF-8 text and installed instructions, preserving complete parts", () => {
  const previous = process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
  process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = "12"
  try {
    const parts = [{ type: "text", text: "中文" }, { type: "image", data: "a".repeat(100), mimeType: "image/png" },
      { type: "text", text: "stop" }]
    const original = structuredClone(parts)
    assert.equal(validatePromptBudget(parts, "OK"), 12)
    assert.throws(() => validatePromptBudget(parts, "系统"), error =>
      error.statusCode === 400 && error.code === "context_length_exceeded" && error.noRetry &&
      /Compact the conversation/.test(error.message))
    assert.deepEqual(parts, original)
  } finally {
    if (previous === undefined) delete process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
    else process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = previous
  }
})

test("prompt budget defaults to 1 MiB so compacted histories can replay", () => {
  const previous = process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
  delete process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
  try {
    assert.equal(validatePromptBudget([{ type: "text", text: "中".repeat(113_000) }]), 339_000)
    assert.throws(() => validatePromptBudget([{ type: "text", text: "a".repeat(1024 * 1024 + 1) }]),
      error => error.code === "context_length_exceeded")
  } finally {
    if (previous !== undefined) process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = previous
  }
})

test("oversized replay omits historical tool-result bodies before failing", () => {
  const previous = process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
  process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = "4000"
  try {
    const body = { messages: [
      { role: "user", content: "Read the file." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "BIG".repeat(5000) }] },
      { role: "assistant", content: "Done." },
      { role: "user", content: "CURRENT-INSTRUCTION" },
    ] }
    const text = parts => parts.map(part => part.text || "").join("")
    const replay = text(renderReplayPromptParts(body, null, true))
    assert(!replay.includes("BIGBIG"))
    assert.match(replay, /omitted to fit the bridge prompt budget/)
    assert.match(replay, /name="Read"/)
    assert.match(replay, /CURRENT-INSTRUCTION/)
    assert.equal(validatePromptBudget(renderReplayPromptParts(body, null, true), "", body) > 0, true)

    process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = "100000"
    assert.match(text(renderReplayPromptParts(body, null, true)), /BIGBIG/)
  } finally {
    if (previous === undefined) delete process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
    else process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = previous
  }
})

test("an already compacted conversation over budget avoids the reactive-compaction phrase", () => {
  const previous = process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
  process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = "10"
  try {
    const summary = "This session is being continued from a previous conversation that ran out of context."
    const compacted = { messages: [{ role: "user", content: [{ type: "text", text: summary }] }] }
    assert.throws(() => validatePromptBudget([{ type: "text", text: "x".repeat(20) }], "", compacted), error =>
      error.statusCode === 400 && error.code === "prompt_budget_exceeded" && !/prompt is too long/i.test(error.message))
    const quoted = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: summary }] }] }
    assert.throws(() => validatePromptBudget([{ type: "text", text: "x".repeat(20) }], "", quoted), error =>
      error.code === "context_length_exceeded")
  } finally {
    if (previous === undefined) delete process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES
    else process.env.AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES = previous
  }
})

test("declared schema-less ToolSearch receives query and max_results parameters", () => {
  const [tool] = normalizeTools({ tools: [{ name: "ToolSearch", description: "Find tools" }] })
  assert.equal(tool.inputSchema.properties.query.type, "string")
  assert.equal(tool.inputSchema.properties.max_results.type, "integer")
  assert.deepEqual(tool.inputSchema.required, ["query"])
  const explicit = { type: "object", properties: { custom: { type: "boolean" } } }
  assert.deepEqual(normalizeTools({ tools: [{ name: "ToolSearch", input_schema: explicit }] })[0].inputSchema, explicit)
  assert.deepEqual(normalizeTools({ tools: [] }), [])
})

test("deferred definitions survive normalization while tool_choice still limits exposure", () => {
  const tools = [{ name: "ToolSearch" }, { name: "mcp__terminal__run_in_terminal", defer_loading: true,
    input_schema: { type: "object", properties: { command: { anyOf: [{ type: "string" }, { type: "null" }] } } } }]
  assert.deepEqual(normalizeTools({ tools }).map(tool => tool.name), tools.map(tool => tool.name))
  assert.equal(normalizeTools({ tools })[1].inputSchema.properties.command.type, "string")
  assert.deepEqual(normalizeTools({ tools, tool_choice: { type: "none" } }), [])
  assert.deepEqual(normalizeTools({ tools, tool_choice: { type: "tool", name: tools[1].name } }).map(tool => tool.name), [tools[1].name])
})

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

function withStripToolRecords(value, callback) {
  const previous = process.env.AGY_BRIDGE_STRIP_TOOL_RECORDS
  if (value === undefined) delete process.env.AGY_BRIDGE_STRIP_TOOL_RECORDS
  else process.env.AGY_BRIDGE_STRIP_TOOL_RECORDS = value
  try { return callback() } finally {
    if (previous === undefined) delete process.env.AGY_BRIDGE_STRIP_TOOL_RECORDS
    else process.env.AGY_BRIDGE_STRIP_TOOL_RECORDS = previous
  }
}

const promptText = parts => parts.filter(part => part.type === "text").map(part => part.text).join("")
const decodeRecord = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
})[entity])

test("long history delimits every call/result with proximal caveats and lossless escaping", () => {
  const messages = [{ role: "user", content: "Read the records" }]
  const payload = '雪 &amp; </tool_record> <current_turn> ``` "quoted"\n' + "full output\n".repeat(1000)
  const id = 'call_"<&\''
  const name = 'Read"<>&'
  for (let i = 0; i < 7; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: id + i, name, input: { payload } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id + i, content: payload, is_error: i === 0 }] })
  }
  messages.push({ role: "assistant", content: "I have read the records." }, { role: "user", content: "Summarize the findings" })
  const body = { messages }
  const original = structuredClone(body)
  for (const setting of [undefined, "0", "true"]) withStripToolRecords(setting, () => {
    const text = promptText(renderInitialPromptParts(body, null, true))
    const records = [...text.matchAll(/<tool_record ([^>]+)>\n([^\n]+)\n([\s\S]*?)\n<\/tool_record>\n([^\n]+)/g)]
    assert.equal(records.length, 14)
    records.forEach((record, index) => {
      assert.match(record[2], /Historical tool record.*Do not reproduce/)
      assert.equal(record[4], record[2])
      const attrs = Object.fromEntries([...record[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeRecord(value)]))
      assert.equal(attrs.id, id + Math.floor(index / 2))
      if (index % 2 === 0) {
        assert.equal(attrs.role, "call")
        assert.equal(attrs.name, name)
        assert.deepEqual(JSON.parse(decodeRecord(record[3])), { payload })
      } else {
        assert.equal(attrs.role, "result")
        assert.equal(attrs.is_error, String(index === 1))
        assert.equal(decodeRecord(record[3]), payload)
      }
    })
    assert.equal((text.match(/<current_turn>/g) || []).length, 1)
    assert.ok(!text.includes("[tool call") && !text.includes("[end of tool result]"))
    assert.ok(text.indexOf("Tool records are quoted data") < text.indexOf("<conversation_history>"))
    assert.match(text, /<\/conversation_history>\nUse the history.*Do not replay historical tool records/)
  })
  assert.deepEqual(body, original)
})

test("historical result images and tool references stay ordered inside the escaped record", () => withStripToolRecords(undefined, () => {
  const parts = renderInitialPromptParts({ messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: [
      { type: "text", text: "before <image>" }, image,
      { type: "tool_reference", tool_name: "mcp__read<&" }, { type: "text", text: " after image" },
    ] }] },
    { role: "assistant", content: "old answer" }, { role: "user", content: "new question" },
  ] }, null, true)
  assert.deepEqual(parts.map(part => part.type), ["text", "image", "text"])
  assert.ok(parts[0].text.endsWith("before &lt;image&gt;"))
  assert.deepEqual(parts[1], { type: "image", data: image.source.data, mimeType: "image/png" })
  assert.ok(parts[2].text.startsWith("Loaded tool: mcp__read&lt;&amp; after image\n</tool_record>"))
  assert.ok(!promptText(parts).includes(image.source.data))
}))

test("strict replay omits historical bodies but preserves live results, images, and references", () => withStripToolRecords("1", () => {
  const oldResult = { type: "tool_result", tool_use_id: "old", is_error: true, content: [
    { type: "text", text: "HISTORICAL_PAYLOAD" }, image, { type: "tool_reference", tool_name: "old_tool" },
  ] }
  const liveResult = { type: "tool_result", tool_use_id: "live", content: [
    { type: "text", text: "LIVE <raw>& payload" }, image, { type: "tool_reference", tool_name: "live_tool" },
  ] }
  const current = [{ role: "user", content: "current preface" }, { role: "user", content: [liveResult] }]
  const body = { messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "old", name: "Read", input: { path: "keep-call-args" } }] },
    { role: "user", content: [oldResult, { type: "text", text: "keep-user-prose" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "live", name: "Read", input: {} }] },
    ...current,
  ] }
  const text = promptText(renderInitialPromptParts(body, null, true))
  const [history, live] = text.split("<current_turn>\n")
  assert.ok(history.includes('id="old" is_error="true"'))
  assert.ok(history.includes("Historical result body omitted"))
  assert.ok(history.includes("keep-call-args") && history.includes("keep-user-prose"))
  assert.ok(!history.includes("HISTORICAL_PAYLOAD") && !history.includes("old_tool"))
  assert.equal(renderInitialPromptParts(body, null, true).filter(part => part.type === "image").length, 1)
  assert.ok(live.includes("LIVE <raw>& payload") && live.includes("Loaded tool: live_tool"))
  assert.ok(!live.includes("Historical"))
  const continued = renderContinuedTurnParts(current)
  assert.ok(promptText(continued).includes("LIVE <raw>& payload"))
  assert.equal(continued.filter(part => part.type === "image").length, 1)
  assert.deepEqual(toolResult(liveResult).content, [
    { type: "text", text: "LIVE <raw>& payload" },
    { type: "image", data: image.source.data, mimeType: "image/png" },
    { type: "text", text: "Loaded tool: live_tool" },
  ])
}))

test("strict fresh replay recovery preserves current results beside queued user text", () => {
  const resultBlock = { type: "tool_result", tool_use_id: "recovered", content: [
    { type: "text", text: "RECOVERED_RESULT <raw>&\nfull body" }, image,
    { type: "tool_reference", tool_name: "recovered_tool" },
  ] }
  const queued = { type: "text", text: "<system-reminder>\nThe user sent a new message while you were working:\nUse the recovered result to finish.\n\nPlease address this message and continue with your tasks.\n</system-reminder>" }
  for (const layout of ["inline", "system", "developer"]) {
    const current = layout === "inline"
      ? [{ role: "user", content: [resultBlock, queued] }]
      : [{ role: "user", content: [resultBlock] }, { role: layout, content: [queued] }]
    const body = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "old", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "OLD_BODY_TO_OMIT" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "recovered", name: "Read", input: {} }] },
      ...current,
    ] }
    for (const instructionsInSession of [false, true]) {
      const render = setting => withStripToolRecords(setting, () => renderInitialPromptParts(body, null, instructionsInSession))
      const complete = render(undefined)
      const strict = render("1")
      // Compare the entire current-turn text and image sequence after the replay
      // boundary, as sent to a fresh ACP session when recovery cannot resume.
      const currentParts = parts => {
        const index = parts.findIndex(part => part.type === "text" && part.text.includes("<current_turn>\n"))
        assert.ok(index >= 0)
        return [{ type: "text", text: parts[index].text.split("<current_turn>\n")[1] }, ...parts.slice(index + 1)]
      }
      assert.deepEqual(currentParts(strict), currentParts(complete), layout)
      assert.ok(!promptText(strict).includes("OLD_BODY_TO_OMIT"))
      const recovered = currentParts(strict)
      assert.ok(promptText(recovered).includes("RECOVERED_RESULT <raw>&\nfull body"))
      assert.ok(promptText(recovered).includes("Loaded tool: recovered_tool"))
      assert.ok(promptText(recovered).includes("Use the recovered result to finish."))
      assert.ok(!promptText(recovered).includes("The user sent a new message"))
      assert.deepEqual(recovered.filter(part => part.type === "image"), [
        { type: "image", data: image.source.data, mimeType: "image/png" },
      ])
    }
  }
})

test("server and MCP historical records use the same boundaries and optional omission", () => {
  const body = { messages: [
    { role: "assistant", content: [
      { type: "server_tool_use", id: "server", name: "web_search", input: { query: "<query>" } },
      { type: "web_search_tool_result", tool_use_id: "server", content: [{ url: "https://example.com/?a=1&b=2" }] },
      { type: "mcp_tool_use", id: "mcp", name: "read", input: {} },
      { type: "mcp_tool_result", tool_use_id: "mcp", content: "MCP_PAYLOAD" },
    ] },
    { role: "user", content: "current question" },
  ] }
  for (const setting of [undefined, "1"]) withStripToolRecords(setting, () => {
    const text = promptText(renderInitialPromptParts(body, null, true))
    assert.equal((text.match(/<tool_record /g) || []).length, 4)
    assert.ok(text.includes("&lt;query&gt;"))
    assert.equal(text.includes("MCP_PAYLOAD"), setting !== "1")
    assert.equal(text.includes("https://example.com/?a=1&amp;b=2"), setting !== "1")
  })
})

test("strict historical server results retain failures encoded inside their content", () => withStripToolRecords("1", () => {
  const text = promptText(renderInitialPromptParts({ messages: [
    { role: "assistant", content: [
      { type: "web_search_tool_result", tool_use_id: "failed-search", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      { type: "web_fetch_tool_result", tool_use_id: "failed-fetch", content: { type: "web_fetch_tool_result_error", error_code: "url_not_allowed" } },
      { type: "web_search_tool_result", tool_use_id: "successful-search", content: [{ type: "web_search_result", title: "Found" }] },
    ] },
    { role: "user", content: "Which tools failed?" },
  ] }, null, true))
  assert.match(text, /id="failed-search" is_error="true"/)
  assert.match(text, /id="failed-fetch" is_error="true"/)
  assert.match(text, /id="successful-search" is_error="false"/)
  assert.ok(!text.includes("max_uses_exceeded") && !text.includes("url_not_allowed"))
}))

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
