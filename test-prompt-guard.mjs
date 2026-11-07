import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeSystemPrompt } from "./prompt-guard.mjs"

const billing = "x-anthropic-billing-header: cc_version=1.2.3; cc_entrypoint=cli;"
const agentIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const codeIdentity = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const neutral = "You are an AI coding assistant."

test("string system removes only a standalone billing metadata line", () => {
  for (const system of [billing, ` \t${billing}\n`]) {
    assert.deepEqual(sanitizeSystemPrompt(system), {
      system: "",
      diagnostics: [{ ruleId: "standalone-anthropic-billing-header", count: 1 }],
    })
  }
  const ordinary = "Follow the security instructions."
  assert.deepEqual(sanitizeSystemPrompt(ordinary), { system: ordinary, diagnostics: [] })
})

test("block system removes standalone billing blocks without joining boundaries", () => {
  const before = { type: "text", text: "Before", cache_control: { type: "ephemeral" }, custom: { kept: true } }
  const after = { type: "text", text: "After" }
  const input = [before, { type: "text", text: `  ${billing}  `, cache_control: { type: "ephemeral" } }, after]
  const snapshot = structuredClone(input)
  const result = sanitizeSystemPrompt(input)
  assert.deepEqual(result.system, [before, after])
  assert.equal(result.system[0], before)
  assert.equal(result.system[1], after)
  assert.deepEqual(result.diagnostics, [{ ruleId: "standalone-anthropic-billing-header", count: 1 }])
  assert.deepEqual(input, snapshot)
})

test("multiline, code, quotations and discussions of billing metadata are preserved", () => {
  const protectedTexts = [
    `${billing}\nKeep this explanation.`,
    `${billing}\r\nKeep this explanation.`,
    `${billing} This header can trigger an upstream error.`,
    `The metadata ${billing} is discussed here.`,
    `> ${billing}`,
    `\`${billing}\``,
    `\`\`\`text\n${billing}\n\`\`\``,
  ]
  for (const text of protectedTexts) {
    assert.deepEqual(sanitizeSystemPrompt(text), { system: text, diagnostics: [] })
  }
  const blocks = protectedTexts.map(text => ({ type: "text", text, cache_control: { type: "ephemeral" } }))
  assert.deepEqual(sanitizeSystemPrompt(blocks), { system: blocks, diagnostics: [] })
})

test("both exact Agent SDK identity sentences are replaced inside a larger string", () => {
  const system = `Keep all safety rules.\n${agentIdentity}\n${codeIdentity}\nRepeat: ${agentIdentity}`
  const result = sanitizeSystemPrompt(system)
  assert.equal(result.system, `Keep all safety rules.\n${neutral}\n${neutral}\nRepeat: ${neutral}`)
  assert.deepEqual(result.diagnostics, [
    { ruleId: "claude-agent-sdk-identity", count: 2 },
    { ruleId: "claude-code-sdk-identity", count: 1 },
  ])
})

test("identity replacement retains block boundaries, fields and cache_control", () => {
  const blocks = [
    { type: "text", text: `Before ${agentIdentity} after`, cache_control: { type: "ephemeral", ttl: "1h" }, custom: 42 },
    { type: "text", text: codeIdentity },
  ]
  const snapshot = structuredClone(blocks)
  const result = sanitizeSystemPrompt(blocks)
  assert.deepEqual(result.system, [
    { ...blocks[0], text: `Before ${neutral} after` },
    { type: "text", text: neutral },
  ])
  assert.deepEqual(result.system[0].cache_control, blocks[0].cache_control)
  assert.equal(result.system[0].custom, 42)
  assert.deepEqual(blocks, snapshot)
})

test("vendor names, OpenCode identity, near misses and safety instructions are untouched", () => {
  const system = [
    "You are OpenCode, an interactive general AI agent.",
    "Anthropic, OpenAI and Deepseek may appear in ordinary instructions.",
    "Preserve every security and CTF instruction.",
    agentIdentity.slice(0, -1),
    codeIdentity.replace("official", "unofficial"),
  ].join("\n")
  assert.deepEqual(sanitizeSystemPrompt(system), { system, diagnostics: [] })
})

test("non-text blocks are retained and empty text blocks are removed", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }
  const toolResult = { type: "tool_result", tool_use_id: "fixture", content: agentIdentity }
  const whitespace = { type: "text", text: " \n\t", cache_control: { type: "ephemeral" } }
  const result = sanitizeSystemPrompt([{ type: "text", text: "" }, image, toolResult, whitespace])
  assert.deepEqual(result, { system: [image, toolResult, whitespace], diagnostics: [] })
  assert.equal(result.system[0], image)
  assert.equal(result.system[1], toolResult)
})

test("additional exact sensitive phrases are opt-in and never interpreted as regex", () => {
  const additional = "INTERNAL EXACT IDENTITY."
  const system = `${additional}\nToken: secret\nToken: .+`
  assert.deepEqual(sanitizeSystemPrompt(system), { system, diagnostics: [] })
  const result = sanitizeSystemPrompt(system, { extraSensitivePhrases: [additional, "Token: .+"] })
  assert.deepEqual(result, {
    system: `${neutral}\nToken: secret\n${neutral}`,
    diagnostics: [{ ruleId: "additional-exact-sensitive-phrase", count: 2 }],
  })
})

test("additional exact rules apply only to system text blocks", () => {
  const additional = "INTERNAL EXACT IDENTITY."
  const nonText = { type: "tool_result", content: additional }
  const result = sanitizeSystemPrompt([{ type: "text", text: `Prefix ${additional}` }, nonText], { extraSensitivePhrases: [additional] })
  assert.deepEqual(result.system, [{ type: "text", text: `Prefix ${neutral}` }, nonText])
  assert.deepEqual(result.diagnostics, [{ ruleId: "additional-exact-sensitive-phrase", count: 1 }])
})

test("sanitization is idempotent for strings and block arrays", () => {
  const options = { extraSensitivePhrases: ["INTERNAL EXACT IDENTITY."] }
  for (const system of [
    `${billing}\n${agentIdentity}`,
    [{ type: "text", text: billing }, { type: "text", text: `${codeIdentity}\nINTERNAL EXACT IDENTITY.` }, { type: "text", text: "" }],
  ]) {
    const once = sanitizeSystemPrompt(system, options)
    const twice = sanitizeSystemPrompt(once.system, options)
    assert.deepEqual(twice, { system: once.system, diagnostics: [] })
    assert.deepEqual(sanitizeSystemPrompt(twice.system, options), twice)
  }
})
