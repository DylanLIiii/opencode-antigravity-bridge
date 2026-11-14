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

test("issue 66 notices handle chunk boundaries, recovery and quoted text", () => {
  const invalid = "⚠ Model produced invalid output."
  const terminals = ["⚠ There was a network issue connecting to the server, please try again.", "⚠ Your AI credits balance is too low to continue."]
  for (const notice of [invalid, ...terminals]) {
    for (const text of [`\`${notice}\``, `quoted ${notice}\n`, `\`\`\`\n${notice}\n\`\`\`\n`]) {
      for (const chunks of [[text], split(text)]) assert.equal(run(chunks).text, text)
    }
    for (const suffix of ["", "\n", "\r\n", "\n\n", "\r\n \t\r\n"]) for (const chunks of [[notice + suffix], split(notice + suffix)]) {
      const f = new AgentNoticeFilter()
      let output = ""
      for (const chunk of chunks) output += f.push(chunk)
      output += f.flush({ holdTerminal: true })
      assert.equal(output.trim(), "")
      assert.equal(f.failureCandidate, true)
      if (notice !== invalid) assert.equal(f.terminalDetail, notice)
    }
    const recovered = run([notice + "\n", "Recovered."])
    assert.equal(recovered.failureCandidate, false)
    assert.equal(recovered.text, "Recovered.")
  }
})

test("terminal and API evidence survives notice chains but clears on any recovered output", () => {
  const credits = "⚠ Your AI credits balance is too low to continue."
  const network = "⚠ There was a network issue connecting to the server, please try again."
  const api = "⚠ API error (attempt 4): RESOURCE_EXHAUSTED: quota exhausted"
  for (const terminal of [credits, network]) {
    const text = `${api}\r\n${terminal}\r\n\r\n`
    // Every possible split, including inside CRLF and the API detail.
    for (let i = 0; i <= text.length; i++) {
      const f = new AgentNoticeFilter()
      assert.equal((f.push(text.slice(0, i)) + f.push(text.slice(i)) + f.flush({ holdTerminal: true })).trim(), "")
      assert.equal(f.failureCandidate, true)
      assert.equal(f.terminalDetail, terminal)
      assert.equal(f.apiDetail.trimEnd(), api)
      assert.equal(f.push("Answer") + f.flush(), "Answer")
      assert.equal(f.failureCandidate, false)
      assert.equal(f.terminalDetail, "")
      assert.equal(f.apiDetail, "")
    }
  }
  const f = new AgentNoticeFilter()
  f.push(api + "\n")
  f.push("⚠ Model produced invalid output.")
  f.push("\n")
  f.flush({ holdTerminal: true })
  assert.equal(f.apiDetail, api)
  // A look-alike held until flush is ordinary recovered model output.
  assert.equal(f.push("⚠ Model produced") + f.flush(), "⚠ Model produced")
  assert.equal(f.failureCandidate, false)
  assert.equal(f.apiDetail, "")
})

test("API detail buffering is bounded independently of split sizes", () => {
  const f = new AgentNoticeFilter()
  f.push("⚠ API error (attempt 2): ")
  f.push("x".repeat(10_000))
  f.push("y".repeat(10_000) + "\n")
  assert.equal(f.apiDetail.length, 2000)
  f.flush({ holdTerminal: true })
  assert.equal(f.pending, "")
  assert.equal(f.failureCandidate, true)
})

test("terminal evidence suppresses a following legacy banner before failure or recovery", () => {
  for (const notice of [
    "⚠ Your AI credits balance is too low to continue.",
    "⚠ There was a network issue connecting to the server, please try again.",
  ]) for (const recovery of ["\n", "Recovered."]) {
    const text = notice + "\n" + ERR + recovery
    for (const chunks of [[text], split(text), [notice + "\n", ERR, recovery]]) {
      const f = new AgentNoticeFilter()
      let output = ""
      for (const chunk of chunks) output += f.push(chunk)
      output += f.flush({ holdTerminal: true })
      assert.equal(output.trim(), recovery.trim())
      assert.equal(f.failureCandidate, recovery === "\n")
      assert.equal(f.terminalDetail, recovery === "\n" ? notice : "")
    }
  }
})
