// Adapted from magpie-community/plugins agy-cli b829a5541ecc0790b05a63308447bf87e952efbe
// and 5bb4194. MIT; Copyright (c) 2026 DylanLIiii, gitxm, yce.
// See NOTICE-upstream-license.txt.
//
// Antigravity may reject these system prompt phrases regardless of quota.
// Send equivalent wording instead, while keeping the client's original text
// for session identity. Only identified system text is passed through here.
export const TURNED_AWAY = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
  "rfc 2119 keywords: must, required, should, recommended, may, optional.",
]

const INVISIBLE_RE = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g
const invisible = (code) => code === 0x00ad || code === 0x180e ||
  (code >= 0x200b && code <= 0x200f) || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff

// Fold only for matching and retain source offsets. This avoids changing text
// outside a match, Unicode case-folding offset shifts, and backtracking through
// long runs of invisible characters and whitespace.
function matchText(text) {
  const chars = []
  const offsets = []
  let previousSpace = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (invisible(code)) continue
    const char = text[i]
    if (/\s/.test(char)) {
      if (!previousSpace) {
        chars.push(" ")
        offsets.push(i)
      }
      previousSpace = true
    } else {
      chars.push(code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char)
      offsets.push(i)
      previousSpace = false
    }
  }
  return { text: chars.join(""), offsets }
}

export function turnsAway(system) {
  const s = String(system ?? "")
  if (billingLines(s).length) return true
  const normalized = matchText(s).text
  return TURNED_AWAY.slice(1).some((line) => normalized.includes(line))
}

const SAID_AS = [
  null, // Billing is removed only when it is a metadata line, below.
  (line) => line.replace(/^(built\s+on\s+)anthropic's(\s+)(claude\s+agent\s+sdk)$/i, "$1the$2$3 by Anthropic"),
  (line) => line.replace(/based(\s+)on/i, "built$1on"),
  (line) => line.replace(/based(\s+)on/i, "built$1on"),
  (line) => line.replace(/created(\s+)by/i, "built$1by"),
  (line) => line.replace(/(key)(words)/i, "$1 $2"),
]

function isBillingFields(text) {
  const trimmed = text.trim()
  if (!trimmed) return false
  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed
  const fields = body.split(";")
  return fields.length > 0 && fields.every((field) => {
    const equals = field.indexOf("=")
    if (equals < 0) return false
    const name = field.slice(0, equals).trim()
    const value = field.slice(equals + 1).trim()
    return /^[a-z][a-z0-9_-]*$/i.test(name) && value.length > 0 && !/\s/.test(value)
  })
}

// A billing header embedded in prose, a quoted example, or a malformed line
// must not consume the surrounding instructions. Recognize actual metadata
// lines, including additional fields, and leave fenced code examples intact.
function billingLines(system) {
  const matches = []
  let fence = null
  for (let start = 0; start < system.length;) {
    let lineEnd = start
    while (lineEnd < system.length && system[lineEnd] !== "\n" && system[lineEnd] !== "\r") lineEnd++
    const end = lineEnd + (system[lineEnd] === "\r" && system[lineEnd + 1] === "\n" ? 2 : lineEnd < system.length ? 1 : 0)
    const line = system.slice(start, lineEnd)
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) fence = null
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
    } else {
      const clean = line.replace(INVISIBLE_RE, "")
      const header = /^[ \t]*x-anthropic-billing-header:(.*)$/i.exec(clean)
      if (header && isBillingFields(header[1])) {
        matches.push([start, end, null])
      }
    }
    start = end
  }
  return matches
}

export function cloak(system) {
  if (typeof system !== "string" || !system) return system
  // Remove metadata first: it can otherwise separate two halves of a phrase
  // which becomes adjacent when the line is removed.
  const billing = billingLines(system)
  if (billing.length) {
    let cleaned = ""
    let previous = 0
    for (const [from, to] of billing) {
      cleaned += system.slice(previous, from)
      previous = to
    }
    system = cleaned + system.slice(previous)
  }
  const normalized = matchText(system)
  const spans = []
  for (let i = 1; i < TURNED_AWAY.length; i++) {
    const phrase = TURNED_AWAY[i]
    let from = 0
    for (;;) {
      const at = normalized.text.indexOf(phrase, from)
      if (at < 0) break
      spans.push([normalized.offsets[at], normalized.offsets[at + phrase.length - 1] + 1, SAID_AS[i]])
      from = at + phrase.length
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  let result = ""
  let previous = 0
  for (const [from, to, rewrite] of spans) {
    if (from < previous) continue
    result += system.slice(previous, from)
    if (rewrite) result += rewrite(system.slice(from, to).replace(INVISIBLE_RE, ""))
    previous = to
  }
  return result + system.slice(previous)
}

export const REWORDED = [[
  'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.',
  'When the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @"...".',
]]

export function reword(system) {
  if (typeof system !== "string") return system
  for (const [from, to] of REWORDED) system = system.split(from).join(to)
  return system
}

export const outgoing = (system) => reword(cloak(system))

const HINT =
  "Antigravity answers this 429 to the system prompt of Claude Code and the Claude Agent SDK (Claude Desktop's chats) whatever quota is left, so it is not a quota and waiting won't help; use another provider for these chats, or put one after Antigravity in a routing group"

const CODEX_HINT =
  "Antigravity answers this 429 to Codex's own system prompt for GPT-5 models whatever quota is left, so it is not a quota and waiting won't help; a Codex chat begun on a GPT model keeps that prompt after a model switch or a fork, so start a new chat on this model"
const HERMES_HINT =
  "Antigravity answers this 429 to Hermes Agent's earlier default persona (its SOUL.md) whatever quota is left, so it is not a quota and waiting won't help; Hermes' current default persona goes through, so put it in SOUL.md, or use another provider for these chats"

const RFC_HINT =
  "Antigravity answers this 429 to the line \"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\" that starts oh-my-pi (omp)'s system prompt, and to any prompt that has it, whatever quota is left, so it is not a quota and waiting won't help; magpie sends that line as \"RFC 2119 key words: …\", so this one came from a copy of it that was worded another way"

export function hint(system) {
  const normalized = matchText(String(system ?? "")).text
  if (normalized.includes(TURNED_AWAY[5])) return RFC_HINT
  if (normalized.includes(TURNED_AWAY[2]) || normalized.includes(TURNED_AWAY[3])) return CODEX_HINT
  if (normalized.includes(TURNED_AWAY[4])) return HERMES_HINT
  return HINT
}
