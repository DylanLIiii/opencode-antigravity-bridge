import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentNoticeFilter } from "./agent-notice.mjs"

const ERR = "\n⚠ Agent execution terminated due to error.\n"
const INT = "\n⚠ The stream was interrupted. Please continue the task you were working on.\n"
const API = "\n⚠ API error (attempt 2): request failed: Post \"https://x/v1internal:streamGenerateContent?alt=sse\": EOF"
const run = chunks => {
  const f = new AgentNoticeFilter()
  let text = ""
  for (const c of chunks) text += f.push(c)
  text += f.flush()
  return { text, failureCandidate: f.failureCandidate, dropped: f.dropped }
}
const split = s => [...s]

test("standalone retry warnings are dropped however chunked, issue #49 sample", () => {
  for (const chunks of [[INT + API], split(INT + API), ["a", INT, API, "b"]]) {
    const r = run(chunks)
    assert.equal(r.dropped, 2)
    assert.equal(r.text.replace(/[ab]/g, ""), "")
  }
})

test("terminal banner is held until the caller checks the turn outcome", () => {
  for (const chunks of [[ERR], split(ERR)]) {
    const f = new AgentNoticeFilter()
    let text = ""
    for (const c of chunks) text += f.push(c)
    text += f.flush({ holdTerminal: true })
    assert.equal(text, "")
    assert.equal(f.failureCandidate, true)
    assert.equal(f.flush(), ERR)
  }
})

test("quoted banners in prose, inline code and fences are model text (issue #49 follow-up)", () => {
  for (const text of [
    "The marker `⚠ Agent execution terminated due to error.` is matched.",
    "agy printed ⚠ Agent execution terminated due to error. earlier",
    "> ⚠ The stream was interrupted. Please continue the task you were working on.\n",
    "Log:\n```\n⚠ Agent execution terminated due to error.\n⚠ API error (attempt 2): boom\n```\ndone",
    "- ⚠ API error (attempt 2): quoted\n",
  ]) for (const chunks of [[text], split(text)]) {
    const r = run(chunks)
    assert.equal(r.text, text)
  }
})

test("a look-alike held at a step boundary is released unchanged", () => {
  const f = new AgentNoticeFilter()
  let out = f.push("x\n⚠ Agent execution")
  out += f.flush()
  assert.equal(out, "x\n⚠ Agent execution")
})

test("a terminal-looking line followed by normal output does not permanently fail the turn", () => {
  const r = run([ERR, "Normal answer after recovery."])
  assert.equal(r.failureCandidate, false)
  assert.ok(r.text.includes("Normal answer after recovery."))
})

test("a standalone terminal-looking model quotation is preserved without corroboration", () => {
  const r = run([ERR])
  assert.equal(r.failureCandidate, true)
  assert.equal(r.text, ERR)
})

test("a corroborated terminal diagnostic followed by recovery is suppressed", () => {
  for (const chunks of [[ERR, "Recovered."], [ERR + "Recovered."]]) {
    const f = new AgentNoticeFilter(() => true)
    let text = ""
    for (const chunk of chunks) text += f.push(chunk)
    text += f.flush()
    assert.equal(text, "Recovered.")
    assert.equal(f.failureCandidate, false)
  }
})

test("partial warning prefixes use bounded buffering", () => {
  const f = new AgentNoticeFilter()
  const value = "⚠ API error (attempt " + "1".repeat(200000)
  assert.equal(f.push(value) + f.flush(), value)
  assert.ok(f.pending.length < 100)
})

test("terminal candidates survive an unclosed fence until outcome confirmation", () => {
  for (const fence of ["```js", "~~~js"]) for (const chunked of [false, true]) for (const banner of [ERR, ERR.trimEnd()]) {
    const prefix = `Here:\n${fence}\nconst a = 1;\n`
    const f = new AgentNoticeFilter(() => true)
    let text = f.push(prefix)
    for (const chunk of chunked ? split(banner) : [banner]) text += f.push(chunk)
    text += f.flush({ holdTerminal: true })
    assert.equal(f.failureCandidate, true)
    assert.equal(text, prefix)
  }
})

test("unclosed fenced terminal quotations without log evidence retain every byte", () => {
  const text = "Here:\n```js\nconst a = 1;\n" + ERR
  for (const chunks of [[text], split(text)]) assert.equal(run(chunks).text, text)
})

test("whitespace after a terminal banner is not recovery", () => {
  for (const chunks of [[ERR, "\n"], [ERR + "\n"], [ERR, " ", "\t", "\n"]]) {
    const f = new AgentNoticeFilter(() => true)
    let text = ""
    for (const chunk of chunks) text += f.push(chunk)
    text += f.flush({ holdTerminal: true })
    assert.equal(f.failureCandidate, true)
    assert.ok(!text.includes("Agent execution"))
    assert.equal(run(chunks).text, chunks.join(""))
  }
})
