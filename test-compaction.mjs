import assert from "node:assert/strict"
import { test } from "node:test"
import { compactionPrompts, openCodeCompactionStart } from "./compaction.mjs"

const v1 = "Provide a detailed prompt for continuing our conversation above.\n" +
  "The summary that you construct will be used so that another agent can read it and continue the work."
const v2 = "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.\n" +
  "<template>\n## Objective\n## Next Move\n</template>\nDo not continue the task or call tools."
const nudge = "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template."
const user = content => ({ role: "user", content })

test("recognize stock OpenCode compaction tails, including checkpoint updates and a template nudge", () => {
  for (const prompt of [v1, v2, v2.replace(v2.split("\n")[0], "Update the existing checkpoint in the conversation above into one consolidated summary.")]) {
    for (const content of [prompt, [{ type: "text", text: prompt }]]) {
      const messages = [user("conversation"), user(content)]
      assert.equal(openCodeCompactionStart(messages), 1)
      assert.equal(openCodeCompactionStart([...messages, user(nudge)]), 1)
    }
  }
})

test("quoted compaction instructions and ordinary latest requests never enable staging", () => {
  for (const messages of [
    [user(v2)], [user("history"), user("Explain this example:\n" + v2)],
    [user(v2), { role: "assistant", content: "answer" }, user("Continue work")],
    [user("history"), user([{ type: "tool_result", tool_use_id: "t", content: v2 }])],
    [user("history"), user(v2.split("\n")[0])],
    [user("history"), { role: "assistant", content: v2 }],
  ]) assert.equal(openCodeCompactionStart(messages), -1)
})

test("Anthropic-coalesced user blocks retain the compaction boundary", () => {
  for (const content of [
    [{ type: "text", text: "flattened history" }, { type: "text", text: v2 }],
    [{ type: "tool_result", tool_use_id: "t", content: "large result" }, { type: "text", text: v1 }],
    [{ type: "text", text: "history" }, { type: "text", text: v2 }, { type: "text", text: nudge }],
  ]) assert.equal(openCodeCompactionStart([user(content)]), 0)
})

const size = parts => parts.reduce((sum, part) => sum + (part.type === "image" ? 1024 : Buffer.byteLength(part.text)), 0)

test("compaction fragments preserve complete UTF-8 text and ordered images under each budget", () => {
  const text = "begin-" + "😀雪é".repeat(39000) + "-LATEST-INSTRUCTION-END"
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }
  const parts = [{ type: "text", text: text.slice(0, 10002) }, image, { type: "text", text: text.slice(10002) }]
  const prompts = compactionPrompts(parts, 180000)
  assert.ok(prompts.length > 2)
  assert.ok(prompts.every(prompt => size(prompt) <= 180000))
  const payload = prompts.slice(0, -1).flatMap(prompt => prompt.slice(1, -1))
  assert.ok(payload.filter(part => part.type === "text").map(part => part.text).join("") === text, "complete text survived the fragment boundaries")
  assert.equal(payload.filter(part => part.type === "image")[0], image)
  assert.equal(payload.slice(0, payload.indexOf(image)).map(part => part.text).join(""), parts[0].text)
  assert.ok(!payload.some(part => part.text?.includes("\ufffd")))
  assert.match(prompts.at(-1)[0].text, /Produce only the final summary/)
})

test("small compactions stay one prompt; excessive fragment counts reject without a partial plan", () => {
  const parts = [{ type: "text", text: "small" }]
  assert.equal(compactionPrompts(parts, 180000)[0], parts)
  assert.throws(() => compactionPrompts([{ type: "text", text: "x".repeat(100000) }], 2000), error =>
    error.code === "prompt_budget_exceeded" && error.noRetry && error.statusCode === 400)
  assert.throws(() => compactionPrompts([{ type: "text", text: "x".repeat(1000) }], 100), /fragment budget/)
})
