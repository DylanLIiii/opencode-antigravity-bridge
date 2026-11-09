import assert from "node:assert/strict"
import test from "node:test"
import { decodeStepUsage, lastModelStep, modelStepsAfter, sessionDbPath } from "./step-usage.mjs"
import { OutputLimitFilter } from "./output-limit.mjs"

const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
const usageBlob = ({ input, output, write = 0, read, thinking }) => {
  const sub = [0x08, ...varint(1418), 0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []), ...(read ? [0x28, ...varint(read)] : []),
    0x30, 24, 0x48, ...varint(thinking), 0x5a, 2, 0x41, 0x42]
  // Other metadata fields around field 9, as agy writes them.
  return new Uint8Array([0x0a, 2, 0x08, 1, 0x18, 2, 0x4a, ...varint(sub.length), ...sub, 0x58, ...varint(1418)])
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
