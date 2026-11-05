import assert from "node:assert/strict"
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
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock };\n")
const { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
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
