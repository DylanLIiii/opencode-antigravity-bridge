const NEUTRAL_IDENTITY = "You are an AI coding assistant."
const BILLING_HEADER = /^x-anthropic-billing-header:[ \t]+cc_version=[^;\r\n]+;[ \t]+cc_entrypoint=[^;\r\n]+;$/

const identityRules = [
  {
    ruleId: "claude-agent-sdk-identity",
    phrase: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  },
  {
    ruleId: "claude-code-sdk-identity",
    phrase: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  },
]

function isStandaloneBillingHeader(text) {
  const trimmed = text.trim()
  return !/[\r\n]/.test(trimmed) && BILLING_HEADER.test(trimmed)
}

function additionalRules(options) {
  const phrases = options?.extraSensitivePhrases ?? []
  if (!Array.isArray(phrases)) throw new TypeError("extraSensitivePhrases must be an array")
  return phrases.filter(phrase => phrase !== NEUTRAL_IDENTITY).map(phrase => {
    if (typeof phrase !== "string" || !phrase) throw new TypeError("extraSensitivePhrases must contain non-empty strings")
    return { ruleId: "additional-exact-sensitive-phrase", phrase }
  })
}

function replaceExact(text, rules, diagnostics) {
  let cleaned = text
  for (const rule of rules) {
    const parts = cleaned.split(rule.phrase)
    if (parts.length === 1) continue
    const count = parts.length - 1
    diagnostics.set(rule.ruleId, (diagnostics.get(rule.ruleId) || 0) + count)
    cleaned = parts.join(NEUTRAL_IDENTITY)
  }
  return cleaned
}

/**
 * Sanitize only an Anthropic request's system prompt. The returned system has
 * the same string/array shape; diagnostics contain only rule IDs and counts.
 */
export function sanitizeSystemPrompt(system, options = {}) {
  if (typeof system !== "string" && !Array.isArray(system)) {
    throw new TypeError("system must be a string or an array of blocks")
  }

  const rules = [...identityRules, ...additionalRules(options)]
  const diagnostics = new Map()
  const recordBillingHeader = () => diagnostics.set("standalone-anthropic-billing-header", (diagnostics.get("standalone-anthropic-billing-header") || 0) + 1)

  let cleaned
  if (typeof system === "string") {
    if (isStandaloneBillingHeader(system)) {
      recordBillingHeader()
      cleaned = ""
    } else {
      cleaned = replaceExact(system, rules, diagnostics)
    }
  } else {
    cleaned = []
    for (const block of system) {
      if (block?.type !== "text" || typeof block.text !== "string") {
        cleaned.push(block)
        continue
      }
      if (isStandaloneBillingHeader(block.text)) {
        recordBillingHeader()
        continue
      }
      const text = replaceExact(block.text, rules, diagnostics)
      if (!text) continue
      cleaned.push(text === block.text ? block : { ...block, text })
    }
  }

  return {
    system: cleaned,
    diagnostics: Array.from(diagnostics, ([ruleId, count]) => ({ ruleId, count })),
  }
}
