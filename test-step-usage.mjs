import assert from "node:assert/strict"
import test from "node:test"
import { decodeStepUsage, decodeGenerationUsage, lastModelStep, latestGenerationIdx, latestModelStep, modelStepsAfter, modelUsageCursor, modelUsageAfter, sessionDbPath } from "./step-usage.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { OutputLimitFilter } from "./output-limit.mjs"

const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
const usageStats = ({ input, output, write = 0, read, thinking }) => [0x08, ...varint(1418), 0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []), ...(read ? [0x28, ...varint(read)] : []),
    0x30, 24, 0x48, ...varint(thinking), 0x5a, 2, 0x41, 0x42]
const usageBlob = (usage) => {
  const sub = usageStats(usage)
  // Other metadata fields around field 9, as agy writes them.
  return new Uint8Array([0x0a, 2, 0x08, 1, 0x18, 2, 0x4a, ...varint(sub.length), ...sub, 0x58, ...varint(1418)])
}
const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
const generationBlob = (usage, context = 8100) => {
  const stats = usageStats(usage)
  return new Uint8Array(field(1, [
    ...field(4, stats), ...field(9, field(10, [8, ...varint(context)])),
  ]))
}

test("decodes the usage agy records for one model call", () => {
  // Counts from a real agy 1.5.3 session: second call of a tool turn.
  assert.deepEqual(decodeStepUsage(usageBlob({ input: 2205, output: 40, read: 4907, thinking: 7 })),
    { input: 2205, output: 40, write: 0, read: 4907, thinking: 7 })
  assert.equal(decodeStepUsage(new Uint8Array([0x18, 2])), null)
  assert.equal(decodeStepUsage(new Uint8Array([0x4a, 9, 1])), null)
  assert.equal(decodeStepUsage("not bytes"), null)
})

test("a missing or unreadable store gives no measurement", () => {
  assert.equal(lastModelStep("/nonexistent/agy.db"), -1)
  assert.equal(modelStepsAfter("/nonexistent/agy.db", -1), null)
  assert.equal(sessionDbPath("../escape"), null)
  assert.match(sessionDbPath("f6faf504-502b-4184-90da-aa6ff6105eb0", { AGY_BRIDGE_CONVERSATIONS_DIR: "/x" }), /^\/x\/f6faf504/)
})

test("generation records separate billing from the local context estimate", () => {
  const usage = { input: 2205, output: 40, write: 12, read: 4907, thinking: 7 }
  assert.deepEqual(decodeGenerationUsage(generationBlob(usage)), { ...usage, context: 8100 })
  assert.equal(decodeGenerationUsage(new Uint8Array(field(1, field(9, field(10, [8, 100]))))), null)
  assert.equal(decodeGenerationUsage(new Uint8Array([10, 90, 1])), null)
  assert.equal(decodeGenerationUsage(new Uint8Array(field(1, field(4, [16, 128])))), null)
  assert.equal(decodeGenerationUsage("not bytes"), null)
})

const require = createRequire(import.meta.url)
let openDatabase
try {
  const { DatabaseSync } = require("node:sqlite")
  openDatabase = file => {
    const db = new DatabaseSync(file)
    return { run: (sql, ...args) => db.prepare(sql).run(...args), close: () => db.close() }
  }
} catch {
  try {
    const { Database } = require("bun:sqlite")
    openDatabase = file => {
      const db = new Database(file)
      return { run: (sql, ...args) => db.query(sql).run(...args), close: () => db.close() }
    }
  } catch {}
}

test("usage cursors prefer generation billing, pin the source and exclude old calls", { skip: !openDatabase }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-generation-test-"))
  const file = path.join(dir, "session.db")
  const initial = modelUsageCursor(file)
  const db = openDatabase(file)
  const usage = { input: 2205, output: 40, write: 12, read: 4907, thinking: 7 }
  try {
    db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    db.run("INSERT INTO steps VALUES (1, 15, 3, ?)", usageBlob(usage))
    db.run("INSERT INTO gen_metadata VALUES (1, ?)", generationBlob(usage))
    const first = modelUsageAfter(file, initial)
    assert.equal(first.source, "gen_metadata")
    assert.deepEqual(first.steps, [{ idx: 1, ...usage, context: 8100 }])
    const cursor = modelUsageCursor(file)
    assert.deepEqual(modelUsageAfter(file, cursor)?.steps, [])
    db.run("INSERT INTO gen_metadata VALUES (2, ?)", generationBlob({ input: 0, output: 0, read: 0, thinking: 0 }))
    assert.deepEqual(modelUsageAfter(file, cursor)?.steps, [])
    db.run("INSERT INTO gen_metadata VALUES (3, ?)", generationBlob({ ...usage, input: 100 }))
    assert.equal(modelUsageAfter(file, cursor)?.steps[0]?.input, 100)
    // Generation-source turns cannot bill a later legacy row again.
    db.run("INSERT INTO steps VALUES (4, 15, 3, ?)", usageBlob(usage))
    assert.deepEqual(modelUsageAfter(file, { source: "gen_metadata", idx: 3 })?.steps, [])
    // Conversely, a turn already reporting steps must not switch on a late gen row.
    assert.deepEqual(modelUsageAfter(file, { source: "steps", idx: 4 })?.steps, [])
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("stores with an absent or unused generation table retain step billing", { skip: !openDatabase }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-test-"))
  const file = path.join(dir, "session.db")
  const db = openDatabase(file)
  const usage = { input: 22, output: 4, write: 0, read: 0, thinking: 1 }
  try {
    db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
    const legacy = modelUsageCursor(file)
    db.run("INSERT INTO steps VALUES (1, 15, 3, ?)", usageBlob(usage))
    assert.deepEqual(modelUsageAfter(file, legacy), { source: "steps", steps: [{ idx: 1, ...usage }] })
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    const empty = modelUsageCursor(file)
    db.run("INSERT INTO steps VALUES (2, 15, 3, ?)", usageBlob(usage))
    assert.deepEqual(modelUsageAfter(file, empty), { source: "steps", steps: [{ idx: 2, ...usage }] })
    // Unfinished model step (status != 3) advances latestModelStep while lastModelStep stays at 2;
    // tool call steps (step_type = 132) leave latestModelStep unchanged.
    db.run("INSERT INTO steps VALUES (3, 132, 3, ?)", new Uint8Array([0x18, 2]))
    assert.equal(latestModelStep(file), 2)
    assert.equal(latestGenerationIdx(file), -1)
    db.run("INSERT INTO steps VALUES (4, 15, 1, ?)", new Uint8Array([0x18, 1]))
    assert.equal(lastModelStep(file), 2)
    assert.equal(latestModelStep(file), 4)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const run = (chunks) => {
  const filter = new OutputLimitFilter()
  let text = ""
  for (const chunk of chunks) text += filter.push(chunk)
  return { text: text + filter.flush(), dropped: filter.dropped }
}
const NOTICE = "\n⚠ Your previous response was cut off because it exceeded the output token limit\n" +
  "Please continue from where you left off, keeping your response shorter\nRetries remaining: 3\n"

test("drops agy's output-cap notice however it is chunked", () => {
  assert.deepEqual(run(["part one", NOTICE, "part two"]), { text: "part onepart two", dropped: 3 })
  assert.deepEqual(run(["part one", ...NOTICE, "part two"]), { text: "part onepart two", dropped: 3 })
})

test("keeps model text that only resembles the notice", () => {
  for (const text of [
    "Your previous response was great.\nok",
    "line\nPlease continue from where you left off, keeping your response shorter\n",
    "中文\nRetries remaining: 2\n",
    "a\n\nb\nYour",
    "x\n⚠ Agent execution terminated due to error.\n",
  ]) assert.equal(run([text]).text, text)
})

test("flush() ends a notice sequence so a later look-alike line is kept", () => {
  // A partial TAIL-prefix line held at a session/prompt boundary used to leave
  // inNotice set, dropping a legitimate notice-shaped line in the next step.
  const filter = new OutputLimitFilter()
  let text = filter.push("\n⚠ Your previous response was cut off because it exceeded the output token limit\n")
  text += filter.push("Please continue")
  text += filter.flush()
  text += filter.push("\nRetries remaining: 2\n")
  text += filter.flush()
  assert.equal(text, "Please continue\nRetries remaining: 2\n")
  assert.equal(filter.dropped, 1)
})
