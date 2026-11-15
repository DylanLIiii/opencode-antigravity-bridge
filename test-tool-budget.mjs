import assert from "node:assert/strict"
import { test } from "node:test"
import { agyTokens, cut, fitTools, MIN_TEXT, TOOL_TOKEN_BUDGET } from "./tool-budget.mjs"

test("fitTools preserves tools untouched when already within the 18k token budget", () => {
  const tools = [
    {
      name: "read_file",
      description: "Read a file from disk.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path." },
        },
        required: ["path"],
      },
      _meta: { "antigravity/alwaysLoad": true },
    },
  ]
  const fitted = fitTools(tools)
  assert.deepEqual(fitted, tools)
  const total = fitted.reduce((n, tool) => n + agyTokens(JSON.stringify(tool)), 0)
  assert.equal(total <= TOOL_TOKEN_BUDGET, true)
})

test("fitTools shrinks large descriptions below TOOL_TOKEN_BUDGET without dropping tools or schema fields", () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({
    name: `tool_${index}`,
    description: `Top-level description ${index}: ` + "very verbose documentation ".repeat(400),
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["fast", "thorough"],
          description: `Parameter doc ${index}: ` + "extra parameter narrative ".repeat(200),
        },
      },
      required: ["mode"],
    },
    _meta: { "antigravity/alwaysLoad": true },
  }))
  const tokensOf = (list) => list.reduce((n, tool) => n + agyTokens(JSON.stringify(tool)), 0)
  const beforeTokens = tokensOf(tools)
  assert.ok(beforeTokens > TOOL_TOKEN_BUDGET)

  const fitted = fitTools(tools, TOOL_TOKEN_BUDGET)
  const afterTokens = tokensOf(fitted)
  assert.ok(afterTokens <= TOOL_TOKEN_BUDGET, `expected <= ${TOOL_TOKEN_BUDGET}, got ${afterTokens}`)
  assert.equal(fitted.length, tools.length, "must never drop tools")
  for (let i = 0; i < tools.length; i++) {
    assert.equal(fitted[i].name, tools[i].name)
    assert.deepEqual(fitted[i].inputSchema.required, ["mode"])
    assert.deepEqual(fitted[i].inputSchema.properties.mode.enum, ["fast", "thorough"])
    assert.ok(fitted[i].description.length >= MIN_TEXT)
    assert.ok(tools[i].description.length > fitted[i].description.length)
  }
  assert.ok(Buffer.byteLength(cut("a".repeat(50), 10)) <= 10)
})
