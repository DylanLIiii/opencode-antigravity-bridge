import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyUpstreamError } from "./upstream-error.mjs"

const NOW = Date.UTC(2026, 10, 7, 0, 0, 0)
const isoAfter = milliseconds => new Date(NOW + milliseconds).toISOString()

test("INVALID_ARGUMENT is explicit, redacted and never retryable", () => {
  const body = JSON.stringify({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } })
  for (const detail of [body, "INVALID_ARGUMENT (code 400)", body + ' prompt: "SYNTHETIC_PRIVATE_PROMPT"']) {
    const result = classifyUpstreamError(detail)
    assert.equal(result.category, "request_rejected")
    assert.equal(result.reasonCode, "AGY_ERROR_INVALID_ARGUMENT")
    assert.equal(result.retryable, false)
    assert.equal(result.retryAfterMs, null)
    assert.ok(!result.message.includes("SYNTHETIC_PRIVATE_PROMPT"))
  }
  assert.equal(classifyUpstreamError("unrelated failure code 400").category, "unknown")
})

function assertShape(value) {
  assert.deepEqual(Object.keys(value), ["category", "retryable", "message", "retryAfterMs", "reasonCode"])
  assert.equal(typeof value.retryable, "boolean")
  assert.equal(typeof value.message, "string")
  assert.equal(typeof value.reasonCode, "string")
  assert.ok(value.retryAfterMs === null || Number.isSafeInteger(value.retryAfterMs))
}

test("explicit quota evidence is quota_exhausted and never automatically retryable", () => {
  const details = [
    "QUOTA_EXHAUSTED (code 429): request denied",
    "RESOURCE_EXHAUSTED (code 429): quota exhausted.",
    "RESOURCE_EXHAUSTED: individual quota limit exceeded",
    "RESOURCE_EXHAUSTED: quota limit exceeded",
    "RESOURCE_EXHAUSTED: insufficient quota",
    `RESOURCE_EXHAUSTED: quota reset at ${isoAfter(60_000)}`,
  ]
  for (const detail of details) {
    const actual = classifyUpstreamError(detail, { nowMs: NOW })
    assertShape(actual)
    assert.equal(actual.category, "quota_exhausted", detail)
    assert.equal(actual.retryable, false, detail)
    assert.equal(actual.reasonCode, "AGY_ERROR_QUOTA_EXHAUSTED", detail)
    assert.match(actual.message, /reported exhausted quota/)
  }
})

test("MODEL_CAPACITY_EXHAUSTED is distinct from quota and rate limits", () => {
  const actual = classifyUpstreamError("MODEL_CAPACITY_EXHAUSTED (code 429): try another model")
  assert.equal(actual.category, "model_capacity")
  assert.equal(actual.retryable, false)
  assert.equal(actual.retryAfterMs, null)
  assert.equal(actual.reasonCode, "AGY_ERROR_MODEL_CAPACITY_EXHAUSTED")
  assert.match(actual.message, /selected model's capacity/)
})

test("TOS, permission, validation and HTTP 403 failures are forbidden", () => {
  const details = [
    "TOS_VIOLATION (code 403): request blocked",
    "PERMISSION_DENIED: access denied",
    "VALIDATION_REQUIRED (code 403): account validation required",
    "request failed with code: 403",
    "HTTP/1.1 403 Forbidden",
  ]
  for (const detail of details) {
    const actual = classifyUpstreamError(detail)
    assert.equal(actual.category, "forbidden", detail)
    assert.equal(actual.retryable, false, detail)
    assert.equal(actual.reasonCode, "AGY_ERROR_FORBIDDEN", detail)
  }
})

test("forbidden and explicit quota evidence take precedence over promptGuardMatched", () => {
  for (const [detail, category] of [
    ["PERMISSION_DENIED (code 403)", "forbidden"],
    ["QUOTA_EXHAUSTED (code 429): quota exhausted", "quota_exhausted"],
    ["MODEL_CAPACITY_EXHAUSTED (code 429)", "model_capacity"],
  ]) {
    const actual = classifyUpstreamError(detail, { promptGuardMatched: true })
    assert.equal(actual.category, category)
    assert.equal(actual.retryable, false)
  }
})

test("generic RESOURCE_EXHAUSTED does not claim quota or enable retries", () => {
  const actual = classifyUpstreamError("generating and executing: RESOURCE_EXHAUSTED (code 429): upstream rejected request")
  assert.equal(actual.category, "rate_limit")
  assert.equal(actual.retryable, false)
  assert.equal(actual.retryAfterMs, null)
  assert.equal(actual.reasonCode, "AGY_ERROR_RESOURCE_EXHAUSTED_UNSPECIFIED")
  assert.match(actual.message, /quota exhaustion is not confirmed/)
  assert.match(actual.message, /automatic retry is disabled/)
  assert.match(actual.message, /upstream rejected request/)
})

test("bare code/status 429 remains ambiguous and non-retryable", () => {
  for (const detail of ["agy failed: code 429", "statusCode=429", "HTTP 429"]) {
    const actual = classifyUpstreamError(detail)
    assert.equal(actual.category, "rate_limit", detail)
    assert.equal(actual.retryable, false, detail)
    assert.equal(actual.reasonCode, "AGY_ERROR_HTTP_429_UNSPECIFIED", detail)
    assert.match(actual.message, /not confirmed/, detail)
  }
  assert.equal(classifyUpstreamError("unrelated numeric diagnostic 429").category, "unknown")
})

test("only explicit request/token rate limits are retryable", () => {
  const details = [
    "429 Too Many Requests",
    "RATE_LIMIT_EXCEEDED (code 429)",
    "rate limit reached for this project",
    "TPM limit reached",
    "requests per minute limit reached",
    "tokens per minute limit reached",
  ]
  for (const detail of details) {
    const actual = classifyUpstreamError(detail)
    assert.equal(actual.category, "rate_limit", detail)
    assert.equal(actual.retryable, true, detail)
    assert.equal(actual.reasonCode, "AGY_ERROR_EXPLICIT_RATE_LIMIT", detail)
  }
})

test("promptGuardMatched reclassifies only generic 429/resource exhaustion", () => {
  for (const detail of ["RESOURCE_EXHAUSTED (code 429): rejected", "code 429"]) {
    const actual = classifyUpstreamError(detail, { promptGuardMatched: true })
    assert.equal(actual.category, "prompt_rejected", detail)
    assert.equal(actual.retryable, false, detail)
    assert.equal(actual.reasonCode, "AGY_ERROR_PROMPT_GUARD_MATCHED", detail)
    assert.match(actual.message, /prompt guard matched/)
  }
  assert.equal(classifyUpstreamError("RESOURCE_EXHAUSTED", { promptGuardMatched: false }).category, "rate_limit")
  assert.equal(classifyUpstreamError("FAILED_PRECONDITION", { promptGuardMatched: true }).category, "unknown")
  const explicitRate = classifyUpstreamError("429 Too Many Requests", { promptGuardMatched: true })
  assert.equal(explicitRate.category, "rate_limit")
  assert.equal(explicitRate.retryable, true)
})

test("unknown and missing details preserve the existing generic diagnostic", () => {
  for (const detail of [undefined, null, "", "FAILED_PRECONDITION (code 400): fake upstream failure"]) {
    const actual = classifyUpstreamError(detail)
    assertShape(actual)
    assert.equal(actual.category, "unknown")
    assert.equal(actual.retryable, false)
    assert.equal(actual.retryAfterMs, null)
    assert.equal(actual.reasonCode, "AGY_ERROR_UNKNOWN")
    assert.match(actual.message, /agy stopped the turn because of an error/)
  }
  assert.match(classifyUpstreamError("FAILED_PRECONDITION: fake upstream failure").message, /fake upstream failure/)
})

test("Retry-After parses explicit durations with units and zero", () => {
  for (const [suffix, expected] of [
    ["2", 2000],
    ["2s", 2000],
    ["1500ms", 1500],
    ["2 minutes", 120_000],
    ["0", 0],
  ]) {
    const actual = classifyUpstreamError(`Too Many Requests; Retry-After: ${suffix}`, { nowMs: NOW })
    assert.equal(actual.retryable, true, suffix)
    assert.equal(actual.retryAfterMs, expected, suffix)
  }
  assert.equal(classifyUpstreamError("Too Many Requests; retry after = 3 seconds", { nowMs: NOW }).retryAfterMs, 3000)
})

test("Retry-After HTTP dates use the supplied clock", () => {
  const future = classifyUpstreamError("Too Many Requests; Retry-After: Sat, 07 Nov 2026 00:00:10 GMT", { nowMs: NOW })
  assert.equal(future.retryAfterMs, 10_000)
  const present = classifyUpstreamError("Too Many Requests; Retry-After: Sat, 07 Nov 2026 00:00:00 GMT", { nowMs: NOW })
  assert.equal(present.retryAfterMs, 0)
  const past = classifyUpstreamError("Too Many Requests; Retry-After: Fri, 06 Nov 2026 23:59:59 GMT", { nowMs: NOW })
  assert.equal(past.retryAfterMs, null)
})

test("Retry-After rejects malformed, negative, fractional and out-of-range values", () => {
  const invalid = [
    "Retry-After: later",
    "Retry-After: -1",
    "Retry-After: 1.5",
    "Retry-After: 86401",
    "Retry-After: 999999999999999999999999",
    "Retry-After: Mon, 30 Feb 2026 00:00:00 GMT",
    "Retry-After: Sat, 07 Nov 2026 25:00:00 GMT",
    "Retry-After: Sun, 08 Nov 2026 00:00:01 GMT",
  ]
  for (const suffix of invalid) {
    const actual = classifyUpstreamError(`Too Many Requests; ${suffix}`, { nowMs: NOW })
    assert.equal(actual.retryAfterMs, null, suffix)
    assert.equal(actual.retryable, true, suffix)
  }
  assert.equal(classifyUpstreamError("Too Many Requests; Retry-After: 86400", { nowMs: NOW }).retryAfterMs, 86_400_000)
})

test("quota reset timestamps provide a bounded delay without making quota retryable", () => {
  for (const prefix of ["quota reset at", "quota resets at", "quotaResetTime:", "quota_reset_time ="]) {
    const actual = classifyUpstreamError(`RESOURCE_EXHAUSTED: ${prefix} ${isoAfter(60_000)}`, { nowMs: NOW })
    assert.equal(actual.category, "quota_exhausted", prefix)
    assert.equal(actual.retryable, false, prefix)
    assert.equal(actual.retryAfterMs, 60_000, prefix)
  }
  const offset = classifyUpstreamError("RESOURCE_EXHAUSTED: quota reset at 2026-11-07T01:00:00+01:00", { nowMs: NOW })
  assert.equal(offset.retryAfterMs, 0)
})

test("invalid, past, distant or unrelated reset timestamps are ignored", () => {
  const invalid = [
    `quota reset at ${isoAfter(-1)}`,
    `quota reset at ${isoAfter(86_400_001)}`,
    "quota reset at 2026-02-30T00:00:00Z",
    "quota reset at not-a-date",
  ]
  for (const detail of invalid) {
    const actual = classifyUpstreamError(`RESOURCE_EXHAUSTED: ${detail}`, { nowMs: NOW })
    assert.equal(actual.category, "quota_exhausted", detail)
    assert.equal(actual.retryAfterMs, null, detail)
    assert.equal(actual.retryable, false, detail)
  }
  const unrelated = classifyUpstreamError(`FAILED_PRECONDITION: reset at ${isoAfter(60_000)}`, { nowMs: NOW })
  assert.equal(unrelated.category, "unknown")
  assert.equal(unrelated.retryAfterMs, null)
  assert.equal(classifyUpstreamError(`RESOURCE_EXHAUSTED: quota reset at ${isoAfter(86_400_000)}`, { nowMs: NOW }).retryAfterMs, 86_400_000)
})

test("retry hints never make ambiguous, forbidden or unknown errors retryable", () => {
  for (const [detail, category] of [
    ["RESOURCE_EXHAUSTED (code 429); Retry-After: 1", "rate_limit"],
    ["code 429; Retry-After: 1", "rate_limit"],
    ["PERMISSION_DENIED (code 403); Retry-After: 1", "forbidden"],
    ["FAILED_PRECONDITION; Retry-After: 1", "unknown"],
  ]) {
    const actual = classifyUpstreamError(detail, { nowMs: NOW })
    assert.equal(actual.category, category, detail)
    assert.equal(actual.retryAfterMs, 1000, detail)
    assert.equal(actual.retryable, false, detail)
  }
})

test("messages omit prompt-bearing diagnostics and bound echoed detail", () => {
  const secret = "TOP-SECRET-PROMPT-CONTENT"
  for (const detail of [
    `RESOURCE_EXHAUSTED (code 429): prompt: ${secret}`,
    `RESOURCE_EXHAUSTED (code 429): {"prompt":"${secret}"}`,
    `FAILED_PRECONDITION: input=${secret}`,
  ]) {
    const actual = classifyUpstreamError(detail, { prompt: secret })
    assert.ok(!JSON.stringify(actual).includes(secret))
    assert.match(actual.message, /diagnostic omitted/)
  }
  const long = classifyUpstreamError("FAILED_PRECONDITION: " + "x".repeat(3000))
  assert.ok(long.message.length < 2200)
  assert.ok(!long.message.includes("x".repeat(2100)))
})
