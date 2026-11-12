const MAX_DETAIL_LENGTH = 2000
const MAX_PARSE_LENGTH = 8000
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

const FORBIDDEN_RE = /\bTOS_VIOLATION\b|\bPERMISSION_DENIED\b|\bVALIDATION_REQUIRED\b|\bcode\s*[:=]?\s*403\b|\bstatus(?:code)?\s*[:=]?\s*403\b|\bhttp(?:\/\d(?:\.\d)?)?\s+403\b|\b403\s+Forbidden\b/i
const MODEL_CAPACITY_RE = /\bMODEL_CAPACITY_EXHAUSTED\b/i
const QUOTA_RE = /\bQUOTA_EXHAUSTED\b|\bquota\s+(?:has\s+been\s+)?exhausted\b|\bindividual\s+quota\b|\bquota\s+(?:limit\s+)?exceeded\b|\bexceeded\s+(?:your\s+)?(?:current\s+)?quota\b|\binsufficient\s+quota\b|\bquota[\s_-]*reset/i
const EXPLICIT_RATE_LIMIT_RE = /\bToo\s+Many\s+Requests\b|\brate[\s_-]*limit(?:ed|[\s_-]*exceeded)?\b|\bTPM\b|\bRPM\b|\btokens?\s+per\s+minute\b|\brequests?\s+per\s+minute\b/i
const RESOURCE_EXHAUSTED_RE = /\bRESOURCE_EXHAUSTED\b/i
const HTTP_429_RE = /\bcode\s*[:=]?\s*429\b|\bstatus(?:code)?\s*[:=]?\s*429\b|\bhttp(?:\/\d(?:\.\d)?)?\s+429\b/i
const PROMPT_CONTENT_RE = /["']?\b(?:prompt(?:[\s_-]?text)?|input|contents?|messages?|text)\b["']?\s*[:=]/i
const INVALID_ARGUMENT_RE = /\bINVALID_ARGUMENT\b/i

/**
 * Classify an agy/Antigravity log detail without inspecting or returning prompt content.
 *
 * @param {unknown} detail agy log detail, normally the text after "agent executor error:"
 * @param {{ promptGuardMatched?: boolean, nowMs?: number }} [context]
 * @returns {{ category: "quota_exhausted"|"model_capacity"|"rate_limit"|"prompt_rejected"|"request_rejected"|"forbidden"|"unknown", retryable: boolean, message: string, retryAfterMs: number|null, reasonCode: string }}
 */
export function classifyUpstreamError(detail, context = {}) {
  const text = detail == null ? "" : String(detail)
  const options = context && typeof context === "object" ? context : {}
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const retryAfterMs = parseRetryAfterMs(text, nowMs)
  const generic429 = RESOURCE_EXHAUSTED_RE.test(text) || HTTP_429_RE.test(text)

  if (INVALID_ARGUMENT_RE.test(text)) {
    return result(
      "request_rejected",
      false,
      "Antigravity rejected an invalid request argument; the upstream error may not identify the field and automatic retry is disabled",
      "AGY_ERROR_INVALID_ARGUMENT",
      text,
      null,
    )
  }
  if (FORBIDDEN_RE.test(text)) {
    return result(
      "forbidden",
      false,
      "Antigravity reported that the request is forbidden or requires access validation",
      "AGY_ERROR_FORBIDDEN",
      text,
      retryAfterMs,
    )
  }
  if (MODEL_CAPACITY_RE.test(text)) {
    return result(
      "model_capacity",
      false,
      "Antigravity reported that the selected model's capacity is exhausted; automatic retry is disabled",
      "AGY_ERROR_MODEL_CAPACITY_EXHAUSTED",
      text,
      retryAfterMs,
    )
  }
  if (QUOTA_RE.test(text)) {
    return result(
      "quota_exhausted",
      false,
      "Antigravity reported exhausted quota; automatic retry is disabled",
      "AGY_ERROR_QUOTA_EXHAUSTED",
      text,
      retryAfterMs,
    )
  }
  if (generic429 && options.promptGuardMatched === true) {
    return result(
      "prompt_rejected",
      false,
      "Antigravity rejected the request because the prompt guard matched; automatic retry is disabled",
      "AGY_ERROR_PROMPT_GUARD_MATCHED",
      text,
      retryAfterMs,
    )
  }
  if (EXPLICIT_RATE_LIMIT_RE.test(text)) {
    return result(
      "rate_limit",
      true,
      "Antigravity reported a request or token rate limit; only a limited retry is appropriate",
      "AGY_ERROR_EXPLICIT_RATE_LIMIT",
      text,
      retryAfterMs,
    )
  }
  if (generic429) {
    return result(
      "rate_limit",
      false,
      "Antigravity returned an unspecified resource/rate-limit error; quota exhaustion is not confirmed and automatic retry is disabled",
      RESOURCE_EXHAUSTED_RE.test(text)
        ? "AGY_ERROR_RESOURCE_EXHAUSTED_UNSPECIFIED"
        : "AGY_ERROR_HTTP_429_UNSPECIFIED",
      text,
      retryAfterMs,
    )
  }
  return result(
    "unknown",
    false,
    "agy stopped the turn because of an error",
    "AGY_ERROR_UNKNOWN",
    text,
    retryAfterMs,
  )
}

function result(category, retryable, summary, reasonCode, detail, retryAfterMs) {
  const diagnostic = safeDiagnostic(detail)
  return {
    category,
    retryable,
    message: `agy bridge: ${summary}${diagnostic ? `: ${diagnostic}` : ""}`,
    retryAfterMs,
    reasonCode,
  }
}

function safeDiagnostic(detail) {
  const trimmed = detail.trim()
  if (!trimmed) return ""
  // An upstream diagnostic with a prompt-like field is not safe to echo. The
  // structured category/reason still preserve the actionable classification.
  if (PROMPT_CONTENT_RE.test(trimmed)) return "[upstream diagnostic omitted: possible prompt content]"
  const singleLine = trimmed.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return singleLine.length > MAX_DETAIL_LENGTH
    ? singleLine.slice(0, MAX_DETAIL_LENGTH) + "…"
    : singleLine
}

function parseRetryAfterMs(detail, nowMs) {
  const text = detail.slice(0, MAX_PARSE_LENGTH)
  const numeric = /\bretry[\s_-]*after(?:\s*[:=]\s*|\s+)(\d{1,9})(?:\s*(ms|milliseconds?|s|seconds?|m|minutes?))?(?=$|[\s,;}\])])/i.exec(text)
  if (numeric) {
    const unit = (numeric[2] || "s").toLowerCase()
    const multiplier = unit === "ms" || unit.startsWith("millisecond")
      ? 1
      : unit === "m" || unit.startsWith("minute") ? 60_000 : 1000
    return boundedDelay(Number(numeric[1]) * multiplier)
  }

  const httpDate = /\bretry[\s_-]*after\s*[:=]\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT\b/i.exec(text)
  if (httpDate) {
    const timestamp = parseHttpDate(httpDate)
    return timestamp == null ? null : delayFromTimestamp(timestamp, nowMs)
  }

  const quotaReset = /\bquota[\s_-]*reset(?:s|[\s_-]*time)?\b\s*(?:(?:at|on)\s+|[:=]\s*)?["']?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))["']?/i.exec(text)
  if (quotaReset) {
    const timestamp = parseIsoDate(quotaReset[1])
    return timestamp == null ? null : delayFromTimestamp(timestamp, nowMs)
  }
  return null
}

function parseHttpDate(match) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
  const day = Number(match[1])
  const month = months.indexOf(match[2].toLowerCase())
  const year = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 0 || !validDateParts(year, month + 1, day, hour, minute, second)) return null
  const timestamp = Date.UTC(year, month, day, hour, minute, second)
  const date = new Date(timestamp)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    ? timestamp
    : null
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (!validDateParts(year, month, day, hour, minute, second)) return null
  if (match[7] && (Number(match[8]) > 23 || Number(match[9]) > 59)) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function validDateParts(year, month, day, hour, minute, second) {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

function delayFromTimestamp(timestamp, nowMs) {
  if (!Number.isFinite(nowMs) || timestamp < nowMs) return null
  return boundedDelay(timestamp - nowMs)
}

function boundedDelay(delay) {
  return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_RETRY_AFTER_MS ? delay : null
}
