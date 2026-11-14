import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeSystemPrompt } from "./prompt-guard.mjs"
import { cloak, hint, outgoing, turnsAway } from "./cloak.mjs"

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

const pathGuidance = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'

test("system rewrites recognize invisible characters and folded whitespace without changing surrounding text", () => {
  const cases = [
    ["built\u200b on\u00ad Anthropic's\u2060 Claude\u200e Agent\ufeff SDK", "built on the Claude Agent SDK by Anthropic"],
    ["You are Codex,\t an\n agent based\u200b on GPT-5", "You are Codex,\t an\n agent built on GPT-5"],
    ["You are Codex, a coding agent based on GPT-5", "You are Codex, a coding agent built on GPT-5"],
    ["Hermes Agent, an intelligent\u00a0AI assistant created\u180e by Nous Research", "Hermes Agent, an intelligent\u00a0AI assistant built by Nous Research"],
    ["RFC 2119\nkeywords: MUST, REQUIRED,\r\nSHOULD, RECOMMENDED, MAY, OPTIONAL.", "RFC 2119\nkey words: MUST, REQUIRED,\r\nSHOULD, RECOMMENDED, MAY, OPTIONAL."],
  ]
  for (const [input, expected] of cases) {
    const wrapped = `İ unchanged\u200b before\n${input}\nafter\u2060 unchanged`
    assert.equal(turnsAway(wrapped), true, input)
    assert.equal(cloak(wrapped), `İ unchanged\u200b before\n${expected}\nafter\u2060 unchanged`)
    assert.equal(turnsAway(cloak(wrapped)), false)
    assert.equal(cloak(cloak(wrapped)), cloak(wrapped))
  }
  assert.match(hint(cases[1][0]), /Codex/)
  assert.match(hint(cases[3][0]), /Hermes/)
  assert.match(hint(cases[4][0]), /oh-my-pi/)
})

test("all documented invisible characters match inside phrases, including long malformed inputs", () => {
  const invisibles = "\u00ad\u180e\u200b\u200c\u200d\u200e\u200f\u2060\u2061\u2062\u2063\u2064\ufeff"
  const obfuscated = [..."You are Codex, an agent based on GPT-5"].join(invisibles)
  assert.equal(turnsAway(obfuscated), true)
  assert.equal(cloak(obfuscated), "You are Codex, an agent built on GPT-5")
  const malformed = `x-anthropic-billing-header: value=${" ".repeat(20000)}\n${"\ufeff".repeat(20000)}no match`
  assert.equal(outgoing(malformed), malformed)
})

test("only standalone billing metadata lines are stripped, including extended and pre-obfuscated lines", () => {
  const extended = "  x-anthropic-bill\u200bing-header: cc_version=1.2; cc_entrypoint=cli; cch=123;"
  assert.deepEqual(sanitizeSystemPrompt(extended), {
    system: "",
    diagnostics: [{ ruleId: "standalone-anthropic-billing-header", count: 1 }],
  })
  assert.equal(turnsAway(`before\r\n${extended}\r\nafter`), true)
  assert.equal(outgoing(`before\r\n${extended}\r\nafter`), "before\r\nafter")
  assert.equal(turnsAway(outgoing(`before\r\n${extended}\r\nafter`)), false)
  assert.equal(outgoing(`before\r${extended}\rafter`), "before\rafter")
  assert.equal(outgoing(`${extended}\n${billing}\nkeep`), "keep")
  assert.equal(outgoing(`You are Codex, an agent\n${extended}\nbased on GPT-5`), "You are Codex, an agent\nbuilt on GPT-5")
  for (const text of [
    `The metadata ${billing} is discussed here.`,
    `${billing} This header can trigger an upstream error.`,
    `> ${billing}`,
    `\`${billing}\``,
    `\`\`\`text\n${billing}\n\`\`\``,
    "x-anthropic-billing-header: this is an instruction, not metadata",
  ]) {
    assert.equal(turnsAway(text), false)
    assert.equal(outgoing(text), text)
  }
})

test("path guidance is reworded to the upstream wording and keeps all path and reading instructions", () => {
  const expected = 'When the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @"...".'
  const rewritten = outgoing(`Before\n${pathGuidance}\n${pathGuidance}\nAfter`)
  assert.equal(rewritten, `Before\n${expected}\n${expected}\nAfter`)
  assert.equal(outgoing("Tokens prefixed with @ are paths. Be brief."), "Tokens prefixed with @ are paths. Be brief.")
  assert.equal(outgoing(rewritten), rewritten)
})

test("near misses and non-string values remain untouched", () => {
  for (const value of [null, undefined, 42, { value: "system" }, "RFC 2119 keywords: MUST,REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.", "You are Codex, an agent based on GPT-4"]) {
    assert.equal(outgoing(value), value)
  }
})
