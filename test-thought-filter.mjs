import assert from "node:assert/strict"
import test from "node:test"
import { SummaryThoughtFilter } from "./thought-filter.mjs"

// The prefix every leaked chunk carried in issue #39, normalized to 150 chars.
const SUMMARY = "Thinking Process: 1. **Analyze the Request:** * **Goal:** Summarize the provided thoughts in " +
  "the first person (\"I\"). * **Length:** Maximum 50 words for the preview."

test("drops agy's title-summary reasoning", () => {
  const filter = new SummaryThoughtFilter()
  assert.equal(filter.push(SUMMARY), "")
  assert.equal(filter.dropped, 1)
})

test("drops every one of a turn's leaked summary chunks", () => {
  const filter = new SummaryThoughtFilter()
  // Lengths reported in #39: 13 chunks, one distinct 80-character prefix.
  const lengths = [2856, 3427, 4225, 3709, 3059, 3144, 2766, 3190, 3312, 3237, 3018, 4344, 12160]
  for (const length of lengths) {
    const chunk = (SUMMARY + " ").padEnd(length, "x")
    assert.equal(filter.push(chunk), "")
  }
  assert.equal(filter.dropped, lengths.length)
})

test("keeps the primary turn's own reasoning", () => {
  const filter = new SummaryThoughtFilter()
  const reasoning = "User asks: fix the streaming bug. Key insight: chunks are forwarded verbatim."
  assert.equal(filter.push(reasoning), reasoning)
  assert.equal(filter.dropped, 0)
})

test("keeps a user task that legitimately summarizes, without the summarizer header", () => {
  const filter = new SummaryThoughtFilter()
  // The user asked for a title and a first-person preview; this is the model
  // reasoning about that request, not agy's summarizer prompt echo.
  const thought = "Goal: summarize the provided thoughts in the first person (\"I\"). " +
    "Length: maximum 50 words for the preview. Analyze the request first, then write the title."
  assert.equal(filter.push(thought), thought)
  assert.equal(filter.dropped, 0)
})

test("keeps primary reasoning that opens with the header words alone", () => {
  const filter = new SummaryThoughtFilter()
  const thought = "Thinking Process: the user wants the flaky test fixed; the timeout is too short."
  assert.equal(filter.push(thought), thought)
})

test("decides across chunk boundaries without losing ordering", () => {
  const filter = new SummaryThoughtFilter()
  const first = SUMMARY.slice(0, 12)
  const rest = SUMMARY.slice(12)
  // Held while it could still grow into the summarizer header, then dropped.
  assert.equal(filter.push(first), "")
  assert.equal(filter.push(rest), "")
  assert.equal(filter.dropped, 1)
  // The next real thought is unaffected by the held text.
  assert.equal(filter.push("Then answer."), "Then answer.")
})

test("a chunk that cannot start the summary is forwarded immediately", () => {
  const filter = new SummaryThoughtFilter()
  assert.equal(filter.push("Planning: "), "Planning: ")
  assert.equal(filter.push("consider the request."), "consider the request.")
  assert.equal(filter.dropped, 0)
})

test("flush releases a held non-matching prefix instead of swallowing it", () => {
  const filter = new SummaryThoughtFilter()
  assert.equal(filter.push("Think"), "")
  assert.equal(filter.flush(), "Think")
  assert.equal(filter.flush(), "")
})

test("a full window without the summarizer goal is primary reasoning", () => {
  const filter = new SummaryThoughtFilter({ window: 40 })
  const thought = "Thinking Process: " + "compiling the failing test list. ".repeat(5)
  assert.equal(filter.push(thought), thought)
  assert.equal(filter.dropped, 0)
})

test("a summary echo split after its signature keeps suppressing later fields", () => {
  const filter = new SummaryThoughtFilter()
  // Signature completes in the first chunk, but the prompt echo continues.
  assert.equal(filter.push("Thinking Process: 1. **Analyze the Request:** * **Goal:** Summarize the provided " +
    "thoughts in the first person (\"I\")."), "")
  assert.equal(filter.push(" * **Length:** Maximum 50 words for the preview. INTERNAL_SUMMARY_REMAINDER"), "")
  assert.equal(filter.dropped, 2)
})

test("the echo region ends at the next real reasoning chunk", () => {
  const filter = new SummaryThoughtFilter()
  filter.push(SUMMARY)
  // Primary reasoning after the echo is not field-shaped, so it is forwarded.
  const reasoning = "User asks: keep the real reasoning. Key insight: only the echo is dropped."
  assert.equal(filter.push(reasoning), reasoning)
  assert.equal(filter.dropped, 1)
})

test("a new Thinking Process thought after a summary is not assumed to be a summary", () => {
  const filter = new SummaryThoughtFilter()
  filter.push(SUMMARY)
  const reasoning = "Thinking Process: the user wants the flaky test fixed; the timeout is too short."
  assert.equal(filter.push(reasoning), reasoning)
  assert.equal(filter.flush(), "")
})

test("a real thought opening with a Goal field after a summary is forwarded", () => {
  const filter = new SummaryThoughtFilter()
  filter.push(SUMMARY)
  const reasoning = "**Goal:** Fix the requested streaming bug and preserve real thoughts."
  assert.equal(filter.push(reasoning), reasoning)
  assert.equal(filter.flush(), "")
})

test("a second summarizer call restarts the echo region", () => {
  const filter = new SummaryThoughtFilter()
  filter.push(SUMMARY)
  filter.push(" * **Length:** Maximum 50 words for the preview.")
  assert.equal(filter.push(SUMMARY), "")
  assert.equal(filter.push(" * **Length:** Maximum 50 words for the preview."), "")
  assert.equal(filter.dropped, 4)
})

test("the echo region is bounded and can never swallow unlimited output", () => {
  const filter = new SummaryThoughtFilter({ regionMax: SUMMARY.length + 40 })
  filter.push(SUMMARY)
  const fields = []
  for (let n = 0; n < 5; n++) fields.push(filter.push(`* **Length:** Maximum 50 words. chunk ${n}`))
  // One continuation fits the remaining budget; the region then ends.
  assert.equal(fields[0], "")
  assert.ok(fields.at(-1).length > 0, JSON.stringify(fields))
})

test("a mid-token echo continuation is forwarded rather than guessed", () => {
  const filter = new SummaryThoughtFilter()
  filter.push(SUMMARY)
  // Documented limit: a chunk that continues inside a word has no field label.
  assert.equal(filter.push("the preview must stay short"), "the preview must stay short")
})

test("flush ends the echo region at a stream boundary", () => {
  const filter = new SummaryThoughtFilter()
  filter.push(SUMMARY)
  assert.equal(filter.flush(), "")
  // After a boundary, the same field-shaped text is primary output again.
  const text = "* **Length:** Maximum 50 words."
  assert.equal(filter.push(text), text)
})

test("empty chunks pass through without changing state", () => {
  const filter = new SummaryThoughtFilter()
  assert.equal(filter.push(""), "")
  assert.equal(filter.pending, "")
})
