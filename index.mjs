import { agyCandidates, spawnAgy, windowsMcpShim } from "./platform.mjs"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createUsageReader } from "./usage.mjs"

const PROVIDER_ID = "antigravity-bridge"
const AGENT_NAME = "magpie-bridge"
const MCP_SERVER_PATH = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))
// agy exposes tools from the --ide-mcp-port server as direct functions with this prefix.
const IDE_TOOL_PREFIX = "mcp_ide-tools_"
const IDLE_MS = positiveTimeout(process.env.AGY_BRIDGE_IDLE_MS, 10 * 60 * 1000)
const MAX_PROCS = 4
const MAX_PARKED = 32
const DEFAULT_PROC_START_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TURN_TIMEOUT_MS, 5 * 60 * 1000)
const TOOL_RESULT_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS, 30 * 60 * 1000)
const RESUME_TTL_MS = positiveTimeout(process.env.AGY_BRIDGE_RESUME_TTL_MS, 6 * 60 * 60 * 1000)
// agy fails an ide-tools MCP call after a fixed three minutes. Answer before
// that with a "still running" note; an identical repeat call waits for the
// original result instead of reaching the client again.
function ideCallDeadline() {
  return positiveTimeout(process.env.AGY_BRIDGE_IDE_CALL_DEADLINE_MS, 150_000)
}
const CANCEL_SETTLE_MS = 15_000
const RECLAIM_STOP_TIMEOUT_MS = 10_000
const SUPERSEDED_NOTE = "agy bridge: this tool call was superseded because the client conversation continued without it; stop this turn"
const SELF_POLL_IDLE_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_SELF_POLL_IDLE_TIMEOUT_MS, 20 * 60 * 1000)
const SELF_POLL_LIMIT = positiveTimeout(process.env.AGY_BRIDGE_SELF_POLL_LIMIT, 8)
const SELF_POLL_NOTE = "agy bridge: gave up waiting for this tool: the client never returned a result for it; stop this turn"
const TOOL_LIST_WAIT_MS = 5_000
const STDERR_TAIL = 32 * 1024
const CONTROL_LINE_LIMIT = 16 * 1024 * 1024
const ACP_LINE_LIMIT = 64 * 1024 * 1024
const LOG_TAIL_BYTES = 256 * 1024
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const PING_INTERVAL_MS = 15_000
// agy reports an upstream failure as an ordinary message chunk followed by end_turn.
const AGENT_ERROR_MARKER = "\n⚠ Agent execution terminated due to error.\n"
const AGENT_ERROR_CORE = AGENT_ERROR_MARKER.trim()
// Only the minimal agent costs ~500 input tokens; the default agy agent costs ~8,400.
const MINIMAL_AGENT = process.env.AGY_BRIDGE_MINIMAL_AGENT !== "0"
const FORWARD_THINKING = process.env.AGY_BRIDGE_THINKING !== "0"

const FALLBACK_MODELS = [
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", effort: "low" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", effort: "low" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", effort: "high" },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", effort: "medium" },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", effort: "low" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", effort: "high" },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", effort: "medium" },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", effort: "low" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", effort: "medium" },
]

const pool = new Map()
const parked = new Map()
const allProcs = new Set()
const sessions = new Map()
const toolCalls = new Map()
let cachedAgyPath
let controlServer
let controlServerPromise
let shimDir
let shimDirPromise

function positiveTimeout(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function configuredTimeout(name, fallback) {
  return Object.hasOwn(process.env, name)
    ? positiveTimeout(process.env[name], fallback)
    : fallback
}

function findAgy() {
  if (cachedAgyPath) return cachedAgyPath
  const candidates = agyCandidates(process.env, os.homedir())
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      cachedAgyPath = candidate
      return candidate
    } catch {}
  }
  return null
}

function execOnce(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnAgy(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...opts,
      })
    } catch (err) {
      resolve({ err, stdout: "", stderr: "", code: null, timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch {}
    }, opts.timeoutMs ?? 30_000)
    child.stdout.on("data", (data) => { stdout += data })
    child.stderr.on("data", (data) => { stderr += data })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ err, stdout, stderr, code: null, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ err: null, stdout, stderr, code, timedOut })
    })
  })
}

async function listAgyModels(agyPath) {
  const { err, stdout, code } = await execOnce(agyPath, ["models"], { timeoutMs: 15_000 })
  if (err || code !== 0) return FALLBACK_MODELS
  const out = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const id = match[1]
    const name = match[2].trim()
    const effort = /-(high|medium|low|minimal|xhigh|max)$/i.exec(id)?.[1]?.toLowerCase()
    out.push({ id, name, effort })
  }
  return out.length ? out : FALLBACK_MODELS
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
let cachedModelCatalog

function modelFamilyId(model) {
  if (!model.effort) return ""
  return model.id.slice(0, -(model.effort.length + 1))
}

function buildModelCatalog(list) {
  const rawIds = new Set(list.map(model => model.id))
  const families = new Map()
  for (const model of list) {
    const id = modelFamilyId(model)
    if (!id) continue
    if (!families.has(id)) families.set(id, [])
    families.get(id).push(model)
  }
  for (const [id, variants] of families) {
    const efforts = new Set(variants.map(model => model.effort))
    if (variants.length < 2 || efforts.size !== variants.length || rawIds.has(id)) {
      families.delete(id)
    }
  }

  const models = []
  const routes = new Map()
  const added = new Set()
  for (const model of list) {
    const id = modelFamilyId(model)
    const family = families.get(id)
    if (!family) {
      models.push(model)
      continue
    }
    if (added.has(id)) continue
    added.add(id)
    const sorted = [...family].sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort))
    const efforts = sorted.map(variant => variant.effort)
    const byEffort = new Map(sorted.map(variant => [variant.effort, variant.id]))
    const defaultEffort = byEffort.has("high") ? "high" : efforts[efforts.length - 1]
    const defaultModel = sorted.find(variant => variant.effort === defaultEffort)
    const baseName = defaultModel.name.replace(/\s+\((?:minimal|low|medium|high|xhigh|max)\)$/i, "").trim()
    models.push({
      id,
      name: baseName && baseName !== defaultModel.id ? baseName : id,
      variants: efforts,
    })
    routes.set(id, { byEffort, efforts, defaultEffort })
  }
  return { models, routes, rawIds }
}

async function loadModelCatalog(agyPath, refresh = false) {
  if (!refresh && cachedModelCatalog?.agyPath === agyPath) return cachedModelCatalog.catalog
  const catalog = buildModelCatalog(await listAgyModels(agyPath))
  cachedModelCatalog = { agyPath, catalog }
  return catalog
}

function normalizeEffort(value) {
  const direct = String(value || "").trim().toLowerCase()
  if (direct === "ultra") return "max"
  return EFFORT_ORDER.includes(direct) ? direct : ""
}

function requestedEffort(body) {
  const forced = normalizeEffort(process.env.AGY_BRIDGE_EFFORT)
  if (forced) return forced
  const thinking = body.thinking?.type
  if (thinking === "disabled") return ""
  const generic = [body.reasoning_effort, body.reasoningEffort, body.reasoning?.effort,
    body.generationConfig?.thinkingConfig?.thinkingLevel].map(normalizeEffort).find(Boolean)
  if (generic) return generic
  if (thinking !== "enabled" && thinking !== "adaptive") return ""
  const direct = normalizeEffort(body.output_config?.effort)
  if (direct) return direct
  const budget = Number(body.thinking?.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return ""
  if (budget <= 4096) return "low"
  if (budget <= 12000) return "medium"
  if (budget <= 24000) return "high"
  return "xhigh"
}

function closestEffort(effort, efforts) {
  const target = EFFORT_ORDER.indexOf(effort)
  let best = efforts[0]
  for (const candidate of efforts.slice(1)) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target)
    const bestDistance = Math.abs(EFFORT_ORDER.indexOf(best) - target)
    if (distance < bestDistance || distance === bestDistance && EFFORT_ORDER.indexOf(candidate) > EFFORT_ORDER.indexOf(best)) {
      best = candidate
    }
  }
  return best
}

function resolveCatalogAlias(catalog, model) {
  if (!model || catalog.routes.has(model) || catalog.rawIds?.has(model)) {
    return { id: model, inlineEffort: "" }
  }
  const undated = model.replace(/-\d{8}$/, "")
  if (catalog.routes.has(undated) || catalog.rawIds?.has(undated)) {
    return { id: undated, inlineEffort: "" }
  }
  const effortMatch = /^(.*)-(minimal|low|medium|high|xhigh|max)$/i.exec(undated)
  const base = effortMatch ? effortMatch[1] : undated
  const inlineEffort = effortMatch ? effortMatch[2].toLowerCase() : ""
  if (catalog.routes.has(base) || catalog.rawIds?.has(base)) {
    return { id: base, inlineEffort }
  }
  const routeKeys = [...catalog.routes.keys()]
  if (/^(?:gemini-[0-9.]+-flash(?:-lite)?|claude-(?:[0-9.-]+-)?haiku(?:-[0-9.-]+)?)$/i.test(base)) {
    const flashFamily = routeKeys.find((id) => /flash/i.test(id)) ||
      catalog.models.find((item) => /flash/i.test(item.id))?.id
    if (flashFamily) return { id: flashFamily, inlineEffort }
    const fallbackGemini = routeKeys.find((id) => /^gemini-/i.test(id))
    if (fallbackGemini) return { id: fallbackGemini, inlineEffort: inlineEffort || "low" }
  }
  if (/^gemini-[0-9.]+-(?:pro|ultra)(?:-[a-z0-9.]+)?$/i.test(base)) {
    const proFamily = (catalog.routes.has("gemini-4-argon") ? "gemini-4-argon" : null) ||
      routeKeys.find((id) => /^gemini-/i.test(id) && !/flash/i.test(id)) ||
      catalog.models.find((item) => /^gemini-/i.test(item.id) && !/flash/i.test(item.id))?.id
    if (proFamily) return { id: proFamily, inlineEffort }
  }
  if (/^claude-(?:[0-9.-]+-)?sonnet(?:-[0-9.-]+)?$/i.test(base)) {
    const sonnet = routeKeys.find((id) => /^claude-.*sonnet/i.test(id)) ||
      catalog.models.find((item) => /^claude-.*sonnet/i.test(item.id))?.id
    if (sonnet) return { id: sonnet, inlineEffort }
  }
  if (/^claude-(?:[0-9.-]+-)?opus(?:-[0-9.-]+)?(?:-thinking)?$/i.test(base)) {
    const opus = routeKeys.find((id) => /^claude-.*opus/i.test(id)) ||
      catalog.models.find((item) => /^claude-.*opus/i.test(item.id))?.id
    if (opus) return { id: opus, inlineEffort }
  }
  return { id: model, inlineEffort: "" }
}

function resolveAgyModel(catalog, model, body) {
  const { id: resolvedId, inlineEffort } = resolveCatalogAlias(catalog, model)
  const family = catalog.routes.get(resolvedId)
  if (!family) return resolvedId
  const requested = requestedEffort(body) || inlineEffort
  const effort = requested ? closestEffort(requested, family.efforts) : family.defaultEffort
  return family.byEffort.get(effort)
}

function selectValues(options) {
  return (Array.isArray(options) ? options : []).flatMap(option =>
    Array.isArray(option?.options) ? selectValues(option.options)
      : typeof option?.value === "string" ? [option] : [])
}

function configSelect(options, category) {
  return options.find(option => option?.type === "select" && option.category === category)
    || options.find(option => option?.type === "select" && option.id === category)
}

function configModelSelection(options, model, selection) {
  const config = configSelect(options, "model")
  if (!config) return null
  const values = selectValues(config.options)
  const requested = selection?.model || model
  const target = values.find(option => option.value === requested)
    || values.filter(option => model.startsWith(option.value + "-") &&
      EFFORT_ORDER.includes(model.slice(option.value.length + 1)))
      .sort((a, b) => b.value.length - a.value.length)[0]
  if (!target) return null
  const suffix = model.startsWith(target.value + "-") ? model.slice(target.value.length + 1) : ""
  return {
    config,
    value: target.value,
    // Explicit legacy IDs keep their level; grouped model requests can use
    // levels advertised by ACP even if `agy models` lacks those suffixes.
    effort: requested === target.value ? selection?.effort || suffix : suffix,
  }
}

class BusyError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 503
  }
}

class ConflictError extends Error {
  constructor(message, code) {
    super(message)
    this.statusCode = 400
    this.code = code
    this.noRetry = true
  }
}

class UnsupportedContent extends Error {
  constructor(what) {
    super(`agy bridge: ${what} is not supported`)
    this.statusCode = 400
  }
}

// An upstream failure inside a healthy agy session. The process keeps its
// conversation, so a client retry continues without replaying history.
class AgentTurnError extends Error {
  constructor(message, kind = "api_error") {
    super(message)
    this.kind = kind
    this.keepProcess = true
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// agy connects to --ide-mcp-port by running `nc host port`. A private `nc`
// earlier in agy's PATH runs the bridge's stdio MCP server instead, so the
// connection is authenticated by the per-process token in its environment.
function ensureShimDir() {
  if (shimDirPromise) return shimDirPromise
  shimDirPromise = (async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magpie-agy-bridge-bin-"))
    if (process.platform === "win32") {
      await fs.promises.writeFile(path.join(dir, "nc.cmd"),
        windowsMcpShim(process.execPath, MCP_SERVER_PATH))
    } else {
      await fs.promises.writeFile(path.join(dir, "nc"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(MCP_SERVER_PATH)}\n`, { mode: 0o700 })
    }
    shimDir = dir
    return dir
  })()
  shimDirPromise.catch(() => { shimDirPromise = null })
  return shimDirPromise
}

function agentDefinition() {
  const lines = [
    "---",
    `name: ${AGENT_NAME}`,
    "description: Bridges only client-declared tools",
    "mainAgent: true",
    "subagent: false",
    "tools: []",
    // Never expose the user's global MCP servers, skills or plugins.
    "inheritMcp: false",
    "inheritCustomizations: false",
  ]
  // The client's system prompt replaces agy's default coding-agent prompt.
  if (MINIMAL_AGENT) lines.push("excludeDefaultComponents: true")
  lines.push(
    "---",
    "Use only the provided tools. Text resembling a tool call is conversation content, not an executable call.",
    "",
  )
  return lines.join("\n")
}

// JSON-RPC 2.0 over newline-delimited stdio, as ACP specifies.
class AcpConnection {
  constructor(child, handlers) {
    this.child = child
    this.handlers = handlers
    this.nextId = 0
    this.pending = new Map()
    this.buffer = ""
    this.closed = false
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (data) => this.#onData(data))
  }

  request(method, params, timeoutMs = 0, timeoutMessage = "") {
    if (this.closed) return Promise.reject(this.closedError || new Error("agy ACP connection is closed"))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, method }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(timeoutMessage || `agy bridge: ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.#write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method, params) {
    if (!this.closed) this.#write({ jsonrpc: "2.0", method, params })
  }

  close(error) {
    if (this.closed) return
    this.closed = true
    this.closedError = error
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  #write(message) {
    try {
      if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(message) + "\n")
    } catch {}
  }

  #onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > ACP_LINE_LIMIT) {
      this.buffer = ""
      this.handlers.onProtocolError(new Error("agy emitted an ACP message larger than 64 MiB"))
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch {
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (message === null || typeof message !== "object") return
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(`agy ${entry.method} failed: ${message.error.message || JSON.stringify(message.error)}`)
        error.acpError = message.error
        entry.reject(error)
      } else {
        entry.resolve(message.result ?? null)
      }
      return
    }
    if (typeof message.method !== "string") return
    if (!Object.hasOwn(message, "id")) {
      this.handlers.onNotification(message.method, message.params ?? {})
      return
    }
    Promise.resolve()
      .then(() => this.handlers.onRequest(message.method, message.params ?? {}))
      .then(
        (result) => this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
        (error) => this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error?.code ?? -32603, message: String(error?.message ?? error) },
        }),
      )
  }
}

class Turn {
  constructor(proc, messages) {
    this.proc = proc
    this.turnId = "turn_" + randomBytes(6).toString("hex")
    this.lastProgressAt = Date.now()
    this.clientProgressAt = this.lastProgressAt
    this.deadlineAt = null
    this.baseHistory = trailingMessages({ messages }).history.map((message) => ({ ...message }))
    this.events = []
    this.waiters = []
    this.calls = []
    this.awaitCalls = []
    this.lateWaiters = []
    this.attached = false
    this.done = false
    this.finalized = false
    this.cancelRequested = false
    this.agentError = false
    this.heldText = ""
    this.timer = null
    this.cleanupTimer = null
    this.logOffset = 0
    // One session/prompt can cover several HTTP responses (tool round-trips,
    // late tool results) while ACP reports a single accumulated usage for all
    // of them. These fields let each HTTP response settle its own share.
    this.stepInputEstimates = []
    this.responseSteps = []
    this.currentResponse = null
    this.pendingPromptStep = null
    this.promptCount = 0
    this.hasLatePrompt = false
    this.toolResponseCount = 0
    this.emittedOutputTokens = 0
    this.rawUsage = null
    this.accountedPrompts = new Set()
    let settle
    this.settled = new Promise((resolve) => { settle = resolve })
    this.settle = settle
  }

  registerResponse(body) {
    const estimate = estimateInputTokens(body)
    const pending = this.pendingPromptStep
    const step = {
      body,
      inputEstimate: estimate,
      estimateIndex: pending?.estimateIndex ?? this.stepInputEstimates.length,
      promptNumbers: pending?.promptNumbers || [],
      settled: false,
    }
    if (pending) {
      // A late prompt may start before the client attaches its next response.
      // That HTTP request describes the same model step, not another one.
      this.stepInputEstimates[step.estimateIndex] = Math.max(estimate, this.stepInputEstimates[step.estimateIndex])
      this.pendingPromptStep = null
    } else {
      this.stepInputEstimates.push(estimate)
    }
    this.responseSteps.push(step)
    this.currentResponse = step
    return step
  }

  beginPrompt(parts, lateCalls) {
    const number = ++this.promptCount
    const step = this.currentResponse
    if (number > 1) {
      this.hasLatePrompt = true
      const body = step?.body || { messages: this.baseHistory }
      const history = this.proc.expectedMessages || body.messages || this.baseHistory
      const content = step?.contentSnapshot?.() || []
      const results = extractToolResults(body)
      const alreadyInHistory = lateCalls?.length && lateCalls.every((call) =>
        results.some((block) => block.tool_use_id === call.id))
      const estimate = estimateInputTokens({
        ...body,
        messages: [
          ...history,
          ...(content.length ? [{ role: "assistant", content }] : []),
          ...(alreadyInHistory ? [] : [{ role: "user", content: parts }]),
        ],
      })
      if (step && !step.settled && !step.promptNumbers.length) {
        // This late prompt continues the newly registered HTTP step. Replace
        // its denominator entry rather than counting that model step twice.
        this.stepInputEstimates[step.estimateIndex] = estimate
      } else {
        const index = this.stepInputEstimates.push(estimate) - 1
        if (step && !step.settled) step.estimateIndex = index
        else this.pendingPromptStep = { estimateIndex: index, promptNumbers: [number] }
      }
    }
    if (step && !step.settled) step.promptNumbers.push(number)
    return number
  }

  recordPromptUsage(number, usage) {
    if (!this.accountedPrompts.has(number)) {
      this.accountedPrompts.add(number)
      this.rawUsage = addUsage(this.rawUsage, usage)
    }
    return this.rawUsage
  }

  recordResponseUsage(step, usage, final, calibrate = final) {
    if (step.settled) return
    step.settled = true
    step.usage = usage
    this.emittedOutputTokens = tokenCount(this.emittedOutputTokens + usage.output_tokens)
    if (!final) this.toolResponseCount++
    const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    const estimate = this.stepInputEstimates[step.estimateIndex] || step.inputEstimate
    if (calibrate && total > 0) {
      this.proc.inputTokenScale = Math.max(0.5, Math.min(1.5, total / estimate))
      this.proc.lastCacheRatio = Math.max(0, Math.min(1, usage.cache_read_input_tokens / total))
    }
  }

  attach() {
    if (this.finalized) throw new BusyError("agy bridge: this response has already completed")
    if (this.attached) throw new BusyError("agy bridge: this conversation already has an active response")
    this.attached = true
    this.touchClient()
  }

  detach() {
    const wasAttached = this.attached
    this.attached = false
    if (wasAttached) this.touchClient()
  }

  touchClient() {
    this.clientProgressAt = Date.now()
    if (this.timer && !this.done && !this.finalized && this.hasPendingMcp()) this.rearm()
  }

  push(event) {
    if (this.finalized) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
  }

  next() {
    if (this.events.length) return Promise.resolve(this.events.shift())
    if (this.finalized) return Promise.reject(new Error("agy bridge: response is closed"))
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  // Withholds a possible prefix of agy's error marker until it can be classified.
  pushText(chunk) {
    if (this.done || this.agentError) return
    let text = this.heldText + chunk
    this.heldText = ""
    const marker = text.indexOf(AGENT_ERROR_CORE)
    if (marker >= 0) {
      this.agentError = true
      text = text.slice(0, marker).replace(/\n$/, "")
      if (text) this.push({ type: "text", text })
      return
    }
    for (let keep = Math.min(text.length, AGENT_ERROR_MARKER.length - 1); keep > 0; keep--) {
      if (AGENT_ERROR_MARKER.startsWith(text.slice(-keep))) {
        this.heldText = text.slice(-keep)
        text = text.slice(0, -keep)
        break
      }
    }
    if (text) this.push({ type: "text", text })
  }

  flushText() {
    if (!this.heldText || this.agentError) return
    const text = this.heldText
    this.heldText = ""
    this.push({ type: "text", text })
  }

  complete(result) {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.push({ type: "result", result })
  }

  fail(error) {
    if (this.done || this.finalized) return
    this.done = true
    clearTimeout(this.timer)
    for (const waiter of this.lateWaiters.splice(0)) waiter.reject(error)
    this.push({ type: "error", error })
    clearTimeout(this.cleanupTimer)
    this.cleanupTimer = setTimeout(() => {
      this.proc.abandonTurn(this)
    }, IDLE_MS)
    this.cleanupTimer.unref()
  }

  // True while the client still owes a result, including calls agy stopped waiting for.
  hasPendingMcp() {
    return this.calls.some((call) => (call.mcpSeen && !call.mcpResponded) || (call.deferred && !call.result))
  }

  waitLate() {
    if (!this.calls.some((call) => call.deferred && !call.result)) return Promise.resolve()
    return new Promise((resolve, reject) => this.lateWaiters.push({ resolve, reject }))
  }

  notifyLate() {
    if (this.calls.some((call) => call.deferred && !call.result)) return
    for (const waiter of this.lateWaiters.splice(0)) waiter.resolve()
  }

  // Inactivity timeout: agy output, or the client's tool result while one is pending.
  arm() {
    this.lastProgressAt = Date.now()
    this.rearm()
  }

  // Internal agy traffic cannot extend a detached client's tool wait window.
  rearm() {
    clearTimeout(this.timer)
    if (this.done || this.finalized) return
    const waitingForTools = this.hasPendingMcp()
    const timeout = waitingForTools ? TOOL_RESULT_TIMEOUT_MS : TURN_TIMEOUT_MS
    const now = Date.now()
    this.deadlineAt = (waitingForTools && !this.attached ? this.clientProgressAt : now) + timeout
    this.timer = setTimeout(() => {
      const what = waitingForTools ? "waiting for a client tool result" : "reading agy output"
      this.proc.timeoutTurn(this, new Error(
        `agy bridge: timed out ${what} after ${timeout}ms; stderr tail: ${this.proc.stderrTail.trim() || "(empty)"}`,
      ))
    }, Math.max(0, this.deadlineAt - now))
    this.timer.unref?.()
  }
}

class Proc {
  constructor(agyPath, convKey, opts) {
    this.agyPath = agyPath
    this.convKey = convKey
    this.model = opts.model
    this.selection = opts.selection
    this.tools = opts.tools
    this.toolsSignature = JSON.stringify(opts.tools)
    this.workDir = opts.workDir
    this.instructions = opts.instructions || ""
    this.resumeFrom = opts.resume || null
    this.token = randomUUID()
    this.sessionId = null
    this.currentModel = null
    this.agentVersion = null
    this.supportsImages = false
    // Learned from settled single-model-call responses; scales the local input
    // estimate used for tool-step responses that carry no exact usage.
    this.inputTokenScale = 1
    this.lastCacheRatio = 0
    this.configOptions = []
    this.configMethodUnsupported = false
    this.currentSelectionKey = null
    this.instructionsInSession = false
    this.resumed = false
    this.child = null
    this.conn = null
    this.workspace = null
    this.logPath = null
    this.lastUsed = Date.now()
    this.dead = false
    this.deadError = null
    this.retiring = false
    this.stopping = false
    this.stopPromise = null
    this.stderrTail = ""
    this.hasSentFirstTurn = false
    this.historyInvalid = false
    this.unsentPrompt = null
    this.turn = null
    this.expectedMessages = null
    this.toolsVersion = 1
    this.listedVersion = 0
    this.listWaiters = []
    this.watchers = new Set()
    this.deniedPermissions = 0
    allProcs.add(this)
  }

  async start() {
    await ensureControlServer()
    const bin = await ensureShimDir()
    sessions.set(this.token, this)
    this.workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magpie-agy-bridge-"))
    const agentDir = path.join(this.workspace, ".agents", "agents", AGENT_NAME)
    await fs.promises.mkdir(agentDir, { recursive: true })
    await fs.promises.writeFile(path.join(agentDir, "agent.md"), agentDefinition(), { mode: 0o600 })
    this.logPath = path.join(this.workspace, "agy-acp.log")

    const args = [
      "acp",
      "--agent", AGENT_NAME,
      "--log-file", this.logPath,
      "--ide-mcp-port", String(controlServer.address().port),
    ]
    if (this.workDir) args.push("--add-dir", this.workDir)
    try {
      const childEnv = { ...process.env }
      const inheritedPath = process.env.PATH || childEnv.Path || ""
      for (const key of Object.keys(childEnv)) {
        if (/^path$/i.test(key) && key !== "PATH") delete childEnv[key]
      }
      this.child = spawnAgy(this.agyPath, args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...childEnv,
          PATH: bin + path.delimiter + inheritedPath,
          AGY_BRIDGE_CONTROL_PORT: String(controlServer.address().port),
          AGY_BRIDGE_TOKEN: this.token,
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        },
      })
    } catch (error) {
      this.#markDead(error)
      throw error
    }
    this.child.on("error", (error) => this.#markDead(error))
    this.child.on("close", (code, signal) => {
      if (!this.dead) {
        const detail = this.stderrTail.trim()
        this.#markDead(new Error(`agy exited (code=${code} signal=${signal})${detail ? ": " + detail.slice(-1000) : ""}`))
      }
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (data) => {
      this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL)
    })
    this.child.stdin.on("error", () => {})
    this.conn = new AcpConnection(this.child, {
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
      onProtocolError: (error) => this.fail(error),
    })

    const timeoutMs = configuredTimeout("AGY_BRIDGE_START_TIMEOUT_MS", DEFAULT_PROC_START_TIMEOUT_MS)
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `agy bridge: timed out starting agy acp after ${timeoutMs}ms; stderr tail: ${this.stderrTail.trim() || "(empty)"}`,
      )), timeoutMs)
    })
    try {
      await Promise.race([this.#handshake(), timeout])
    } catch (error) {
      if (this.dead && this.deadError && error !== this.deadError && !/timed out starting/.test(error.message)) {
        throw new Error(`agy failed before the ACP session started: ${this.deadError.message}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async #handshake() {
    const init = await this.conn.request("initialize", {
      protocolVersion: 1,
      // agy offers non-Gemini models only to allowlisted ACP clients.
      clientInfo: { name: "zed", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    this.agentVersion = init?.agentInfo?.version ?? null
    const capabilities = init?.agentCapabilities ?? {}
    this.supportsImages = capabilities.promptCapabilities?.image === true ||
      capabilities.prompt_capabilities?.image === true
    const appendable = capabilities._meta?.antigravity?.systemPrompt?.append === true
    const resumable = !!(capabilities.sessionCapabilities?.resume ?? capabilities.session_capabilities?.resume)
    this.instructionsInSession = appendable && !!this.instructions
    const meta = this.instructionsInSession
      ? { _meta: { antigravity: { systemPrompt: { append: this.instructions } } } }
      : {}

    let session = null
    if (this.resumeFrom && resumable) {
      try {
        session = await this.conn.request("session/resume", {
          sessionId: this.resumeFrom.sessionId,
          cwd: this.workspace,
          mcpServers: [],
          ...meta,
        })
        if (!session || typeof session !== "object") throw new Error("empty session/resume result")
        this.sessionId = this.resumeFrom.sessionId
        this.resumed = true
        this.hasSentFirstTurn = true
        this.expectedMessages = this.resumeFrom.expectedMessages.map((message) => ({ ...message }))
      } catch {
        session = null
      }
    }
    if (!this.resumed) {
      session = await this.conn.request("session/new", { cwd: this.workspace, mcpServers: [], ...meta })
      if (!session?.sessionId) throw new Error("agy session/new returned no sessionId")
      this.sessionId = session.sessionId
    }
    // A resumed session reports the account default; always apply the selection.
    this.currentModel = session?.models?.currentModelId ?? null
    this.configOptions = Array.isArray(session?.configOptions) ? session.configOptions : []
    if (this.model) await this.#setModel(this.model, this.selection, this.resumed)
    if (this.tools.length) await this.#waitForToolList(this.toolsVersion)
  }

  async #setConfig(config, value) {
    const result = await this.conn.request("session/set_config_option", {
      sessionId: this.sessionId, configId: config.id, value,
    })
    if (!Array.isArray(result?.configOptions)) throw new Error("agy returned no configOptions after setting a session option")
    this.configOptions = result.configOptions
    const updated = this.configOptions.find(option => option.id === config.id)
    if (updated?.currentValue !== value) throw new Error(`agy did not apply session option ${config.id}`)
  }

  async #setModel(model, selection, force = false) {
    const selectionKey = stableJSON({ model, selection })
    if (!force && this.currentSelectionKey === selectionKey) return
    try {
      let configured = false
      const target = this.configMethodUnsupported ? null : configModelSelection(this.configOptions, model, selection)
      if (target) {
        try {
          if (force || target.config.currentValue !== target.value) await this.#setConfig(target.config, target.value)
          // A model change can replace the thinking options and their values.
          const thought = configSelect(this.configOptions, "thought_level")
          const levels = selectValues(thought?.options).map(option => option.value).filter(value => EFFORT_ORDER.includes(value))
          if (target.effort && levels.length) {
            const level = closestEffort(target.effort, levels)
            if (force || thought.currentValue !== level) await this.#setConfig(thought, level)
            configured = true
          } else {
            // A standalone model is fully selected by its advertised value.
            // A separate legacy level still needs the old model-ID route.
            configured = !target.effort || target.value === model
          }
        } catch (error) {
          if (error.acpError?.code !== -32601) throw error
          this.configMethodUnsupported = true
        }
      }
      if (!configured && (force || model !== this.currentModel || target)) {
        await this.conn.request("session/set_model", { sessionId: this.sessionId, modelId: model }, 30_000)
      }
    } catch (error) {
      const wrapped = new Error(`agy bridge: model ${model} is unavailable to this agy account: ${error.message}`)
      wrapped.statusCode = 400
      throw wrapped
    }
    this.currentModel = model
    this.currentSelectionKey = selectionKey
  }

  #waitForToolList(version) {
    if (this.listedVersion >= version || this.dead) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = { version, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this.listWaiters = this.listWaiters.filter((item) => item !== waiter)
        resolve()
      }, TOOL_LIST_WAIT_MS)
      this.listWaiters.push(waiter)
    })
  }

  listTools() {
    this.listedVersion = Math.max(this.listedVersion, this.toolsVersion)
    for (const waiter of this.listWaiters.filter((item) => item.version <= this.listedVersion)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.listWaiters = this.listWaiters.filter((item) => item.version > this.listedVersion)
    return this.tools
  }

  addWatcher(socket) {
    this.watchers.add(socket)
    socket.once("close", () => this.watchers.delete(socket))
  }

  // Swap the client tool catalog in place; agy re-lists on tools/list_changed.
  async updateTools(tools) {
    const signature = JSON.stringify(tools)
    if (signature === this.toolsSignature) return
    this.tools = tools
    this.toolsSignature = signature
    await this.#announceTools()
  }

  async #announceTools() {
    const version = ++this.toolsVersion
    if (!this.watchers.size) return
    for (const socket of this.watchers) {
      try { socket.write(JSON.stringify({ event: "tools_changed" }) + "\n") } catch {}
    }
    await this.#waitForToolList(version)
  }

  #onRequest(method, params) {
    if (params?.sessionId && params.sessionId !== this.sessionId) {
      throw Object.assign(new Error("unknown session"), { code: -32602 })
    }
    if (method === "session/request_permission") {
      // Client tools arrive through MCP and never ask. Deny anything that would
      // run inside agy itself (shell, file edits, questions, browser).
      this.deniedPermissions++
      const reject = (params?.options || []).find((option) => option?.kind === "reject_once")
        || (params?.options || []).find((option) => option?.kind === "reject_always")
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } }
    }
    throw Object.assign(new Error(`agy bridge does not serve ${method}`), { code: -32601 })
  }

  #onNotification(method, params) {
    if (method !== "session/update" || params?.sessionId !== this.sessionId) return
    if (params.update?.sessionUpdate === "config_option_update" && Array.isArray(params.update.configOptions)) {
      this.configOptions = params.update.configOptions
      this.currentSelectionKey = null
      return
    }
    const turn = this.turn
    if (!turn || turn.done || turn.finalized) return
    const update = params.update ?? {}
    turn.arm()
    if (turn.cancelRequested) return
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.type === "text" ? update.content.text : ""
      if (text) turn.pushText(text)
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      const text = update.content?.type === "text" ? update.content.text : ""
      if (text) turn.push({ type: "thinking", text })
    }
  }

  startTurn(content, messages, model, selection) {
    if (this.dead) throw this.deadError
    if (this.retiring) throw new BusyError("agy bridge: this conversation's process is being retired")
    if (this.turn) throw new BusyError("agy bridge: this conversation still has an unfinished response")
    if (content.some(block => block.type === "image") && !this.supportsImages) {
      throw new UnsupportedContent("image input with this agy ACP server; update to an image-capable agy version")
    }
    const turn = new Turn(this, messages)
    this.turn = turn
    this.expectedMessages = messages.map((message) => ({ ...message }))
    this.historyInvalid = false
    this.lastUsed = Date.now()
    this.#runTurn(turn, content, model, selection).catch(() => {})
    return turn
  }

  matchesHistory(messages) {
    if (this.historyInvalid) return false
    if (this.expectedMessages == null) return !this.turn && !this.hasSentFirstTurn
    return historyKey(this.expectedMessages) === historyKey(messages)
  }

  // Clients such as Claude Code normalize tool_use inputs when recording an
  // assistant message (e.g. filling default replace_all: false on Edit or
  // stripping a redundant cd prefix on Bash). When the pending turn's exact
  // CSPRNG toolu_ IDs and tool names match, allow canonicalized tool_use.input
  // without tearing down the live ACP session.
  matchesPendingTurnHistory(turn, history) {
    if (this.matchesHistory(history)) return true
    if (this.historyInvalid || !turn || this.turn !== turn || !Array.isArray(this.expectedMessages)) return false
    let split = history.length
    while (split > 0 && history[split - 1].role === "assistant") split--
    let expectedSplit = this.expectedMessages.length
    while (expectedSplit > 0 && this.expectedMessages[expectedSplit - 1].role === "assistant") expectedSplit--
    if (historyKey(this.expectedMessages.slice(0, expectedSplit)) !== historyKey(history.slice(0, split))) return false
    const actualAssistant = history.slice(split)
    const expectedAssistant = this.expectedMessages.slice(expectedSplit)
    const actualCalls = lastAssistantCalls(actualAssistant)
    const expectedCalls = lastAssistantCalls(expectedAssistant)
    if (!actualCalls.length || actualCalls.length !== expectedCalls.length) return false
    if (actualCalls.some((call, index) =>
      !call.id || call.id !== expectedCalls[index].id || call.name !== expectedCalls[index].name)) {
      return false
    }
    const stripToolInputs = (messages) => messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((block) => block?.type === "tool_use"
          ? { type: "tool_use", id: block.id, name: block.name, input: {} }
          : block)
        : message.content,
    }))
    return historyKey(stripToolInputs(expectedAssistant)) === historyKey(stripToolInputs(actualAssistant))
  }

  recordToolResults(turn, messages) {
    if (this.turn === turn) this.expectedMessages = messages.map((message) => ({ ...message }))
  }

  recordAssistantResponse(turn, content) {
    if (this.turn === turn && this.expectedMessages) {
      this.expectedMessages.push({ role: "assistant", content })
    }
  }

  async #runTurn(turn, content, model, selection) {
    try {
      turn.arm()
      if (model) await this.#setModel(model, selection)
      // Content a cancelled turn never delivered still belongs to the session.
      let promptParts = mergePromptParts(this.unsentPrompt, toPromptParts(content))
      this.unsentPrompt = null
      let usage = null
      let lateCalls = null
      for (;;) {
        turn.logOffset = await fileSize(this.logPath)
        // A cancel that arrived before the prompt would be ignored by agy.
        if (turn.cancelRequested) {
          if (this.hasSentFirstTurn) this.unsentPrompt = promptParts
          turn.complete({ stopReason: "cancelled" })
          return
        }
        turn.arm()
        unpark(this.convKey)
        this.hasSentFirstTurn = true
        const promptNumber = turn.beginPrompt(promptParts, lateCalls)
        const result = await this.conn.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: promptParts.length ? promptParts : [{ type: "text", text: "" }],
        })
        usage = turn.recordPromptUsage(promptNumber, result?.usage)
        if (turn.cancelRequested) {
          turn.complete({ stopReason: "cancelled" })
          return
        }
        if (turn.agentError) {
          throw await this.#agentError(turn)
        }
        if (result?.stopReason === "refusal") {
          const detail = await lastAgentError(this.logPath, turn.logOffset)
          if (detail) throw this.#formatAgentError(detail)
        }
        turn.flushText()
        // agy ended the turn without waiting for a long-running client tool:
        // deliver its real result in a follow-up prompt of the same response.
        const late = turn.calls.filter((call) => call.deferred && !call.lateDelivered)
        if (!late.length) {
          turn.complete({ ...(result ?? {}), usage })
          return
        }
        turn.arm()
        await turn.waitLate()
        for (const call of late) call.lateDelivered = true
        promptParts = renderLateResultParts(late, this.supportsImages)
        lateCalls = late
      }
    } catch (error) {
      if (turn.cancelRequested && !this.dead) {
        turn.complete({ stopReason: "cancelled" })
        return
      }
      if (error instanceof AgentTurnError && !this.dead && !turn.calls.length) {
        // agy kept the session; a retry of the same request continues in it.
        this.expectedMessages = turn.baseHistory
        turn.fail(error)
        return
      }
      turn.fail(error)
      dropFromPool(this)
      await this.stop().catch(() => {})
    } finally {
      clearTimeout(turn.timer)
      this.lastUsed = Date.now()
      turn.settle()
      if (turn.cancelRequested) this.finalizeTurn(turn)
    }
  }

  async #agentError(turn) {
    const detail = await lastAgentError(this.logPath, turn.logOffset)
    return this.#formatAgentError(detail)
  }

  #formatAgentError(detail) {
    if (/QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|code 429\b/i.test(detail)) {
      return new AgentTurnError(
        `agy bridge: Antigravity quota or rate limit reached${detail ? ": " + detail : ""}`,
        "rate_limit_error",
      )
    }
    return new AgentTurnError(`agy bridge: agy stopped the turn because of an error${detail ? ": " + detail : ""}`)
  }

  // Cancel a turn the client stopped reading. The session stays usable; the
  // partial answer the client saw becomes part of the expected history.
  cancelTurn(turn, partialContent) {
    if (turn.cancelRequested || turn.done || turn.finalized) return false
    if (turn.hasPendingMcp() || this.dead) return false
    turn.cancelRequested = true
    turn.detach()
    if (this.expectedMessages && partialContent.length) {
      this.expectedMessages.push({ role: "assistant", content: partialContent })
    }
    this.conn.notify("session/cancel", { sessionId: this.sessionId })
    const timer = setTimeout(() => {
      if (!turn.finalized) {
        dropFromPool(this)
        this.stop().catch(() => {})
      }
    }, CANCEL_SETTLE_MS)
    timer.unref?.()
    turn.settled.then(() => clearTimeout(timer))
    return true
  }

  timeoutTurn(turn, error) {
    if (this.turn !== turn || turn.done) return
    turn.fail(error)
    dropFromPool(this)
    this.stop().catch(() => {})
  }

  acceptMcpCall(message, socket) {
    const turn = this.turn
    if (!turn || turn.done || turn.finalized || turn.cancelRequested) {
      throw new Error("agy bridge: no active turn for MCP call")
    }
    const name = message.name
    const args = message.arguments ?? {}
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("agy bridge: invalid tool arguments")
    if (!this.tools.some((tool) => tool.name === name)) throw new Error(`agy bridge: undeclared tool ${name}`)
    const signature = stableJSON(args)
    const running = turn.calls.find((call) => call.deferred && !call.lateDelivered &&
      call.name === name && stableJSON(call.arguments) === signature)
    if (running) return this.#acceptWait(turn, running, socket)
    const call = {
      id: "toolu_" + randomUUID().replace(/-/g, "").slice(0, 24),
      name,
      arguments: args,
      mcpSeen: true,
      mcpResponded: false,
      ready: true,
      socket,
      result: null,
      deferred: false,
      lateDelivered: false,
      deadline: null,
      stillRunning: 0,
      clientSeen: false,
    }
    turn.flushText()
    turn.calls.push(call)
    toolCalls.set(call.id, { proc: this, turn, call })
    socket.once("close", () => {
      if (!call.mcpResponded && !this.stopping) {
        turn.fail(new Error(`agy bridge: MCP helper disconnected during ${name}`))
        dropFromPool(this)
        this.stop().catch(() => {})
      }
    })
    call.deadline = setTimeout(() => { this.#deferCall(turn, call).catch(() => {}) }, ideCallDeadline())
    call.deadline.unref?.()
    turn.push({ type: "tool", call })
    turn.arm()
    return call
  }

  // Answer agy before its MCP deadline; the real result follows on a repeat call.
  async #deferCall(turn, call) {
    if (call.mcpResponded || call.result || turn.done || turn.finalized) return
    call.deferred = true
    call.stillRunning++
    this.#respondMcp(call, { result: { content: [{ type: "text", text: stillRunningText(call) }], isError: false } })
  }

  #selfPollCapped(turn, target) {
    return !turn.attached && !turn.calls.some((call) => call.clientSeen) && (
      Date.now() - turn.clientProgressAt >= SELF_POLL_IDLE_TIMEOUT_MS || target.stillRunning >= SELF_POLL_LIMIT
    )
  }

  #capSelfPoll(turn, target, reply) {
    reply({ content: [{ type: "text", text: SELF_POLL_NOTE }], isError: true })
    logBridgeEvent(this, turn, "reclaim", "self_poll_cap", {}, { self_poll_repeats: target.stillRunning })
    reclaimStaleTurn(this, turn, SELF_POLL_NOTE).catch(() => {})
  }

  // A repeat waits for the original result, without renewing the client clock.
  #acceptWait(turn, target, socket) {
    const reply = (result) => {
      try { socket.end(JSON.stringify({ result }) + "\n") } catch {}
    }
    if (target.result) {
      target.lateDelivered = true
      reply(target.result)
      return null
    }
    if (this.#selfPollCapped(turn, target)) {
      this.#capSelfPoll(turn, target, reply)
      return null
    }
    const waiter = { socket, target, reply, timer: null }
    waiter.timer = setTimeout(() => {
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
      target.stillRunning++
      reply({ content: [{ type: "text", text: stillRunningText(target) }], isError: false })
    }, ideCallDeadline())
    waiter.timer.unref?.()
    turn.awaitCalls.push(waiter)
    socket.once("close", () => {
      clearTimeout(waiter.timer)
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
    })
    return null
  }

  #deliverLate(turn, call) {
    const waiters = turn.awaitCalls.filter((item) => item.target === call)
    if (waiters.length) {
      turn.awaitCalls = turn.awaitCalls.filter((item) => item.target !== call)
      call.lateDelivered = true
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reply(call.result)
      }
    }
    turn.notifyLate()
  }

  validateResults(results) {
    const unique = new Map()
    for (const item of results) {
      const id = item.block.tool_use_id
      const serialized = JSON.stringify(item.result)
      const previous = unique.get(id)
      if ((previous && JSON.stringify(previous.result) !== serialized) ||
        (item.call.result && JSON.stringify(item.call.result) !== serialized)) {
        const error = new Error(`agy bridge: conflicting duplicate result for ${id}`)
        error.statusCode = 409
        throw error
      }
      if (!previous) unique.set(id, item)
    }
    return unique
  }

  continueWith(results) {
    const turn = this.turn
    if (!turn || turn.finalized) throw new BusyError("agy bridge: no response is waiting for these tool results")
    turn.touchClient()
    for (const { call, result } of this.validateResults(results).values()) {
      clearTimeout(call.deadline)
      if (call.deferred) {
        if (!call.result) {
          call.result = result
          this.#deliverLate(turn, call)
        }
        continue
      }
      if (call.mcpResponded || !call.ready || turn.done) continue
      call.result = result
      this.#respondMcp(call, { result })
    }
    turn.arm()
    this.lastUsed = Date.now()
  }

  #respondMcp(call, payload) {
    if (call.mcpResponded) return
    call.mcpResponded = true
    if (call.socket?.writable) call.socket.end(JSON.stringify(payload) + "\n")
    else call.socket?.destroy()
  }

  finalizeTurn(turn) {
    if (turn.finalized) return
    turn.finalized = true
    turn.detach()
    clearTimeout(turn.timer)
    for (const waiter of turn.waiters.splice(0)) {
      waiter.reject(new Error("agy bridge: response closed"))
    }
    clearTimeout(turn.cleanupTimer)
    for (const waiter of turn.awaitCalls.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reply({ content: [{ type: "text", text: turn.closeNote || "agy bridge: response closed" }], isError: true })
    }
    for (const call of turn.calls) {
      clearTimeout(call.deadline)
      if (call.id && toolCalls.get(call.id)?.call === call) toolCalls.delete(call.id)
      if (call.mcpSeen && !call.mcpResponded) {
        this.historyInvalid = true
        this.#respondMcp(call, turn.closeNote
          ? { result: { content: [{ type: "text", text: turn.closeNote }], isError: true } }
          : { error: { code: -32603, message: "agy bridge: response closed before the tool result arrived" } })
      }
    }
    if (this.turn === turn) {
      this.turn = null
      if (!this.stopping && !this.retiring) park(this)
    }
  }

  abandonTurn(turn) {
    this.finalizeTurn(turn)
  }

  fail(error) {
    this.turn?.fail(error)
    dropFromPool(this)
    return this.stop()
  }

  #markDead(error) {
    if (this.dead) return
    this.dead = true
    this.deadError = error
    this.conn?.close(error)
    for (const waiter of this.listWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    if (this.turn && !this.turn.done && !this.stopping) this.turn.fail(error)
  }

  canPark() {
    return !!this.sessionId && this.hasSentFirstTurn && !this.historyInvalid && !this.turn &&
      !this.dead && Array.isArray(this.expectedMessages)
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.#stop()
    return this.stopPromise
  }

  async #stop() {
    this.stopping = true
    this.turn?.fail(new Error("stopped"))
    this.#markDead(new Error("stopped"))
    sessions.delete(this.token)
    if (this.turn) {
      for (const call of this.turn.calls) {
        if (call.mcpSeen && !call.mcpResponded) {
          this.#respondMcp(call, { error: { code: -32603, message: "agy bridge: process stopped" } })
        }
      }
    }
    for (const socket of this.watchers) socket.destroy()
    this.watchers.clear()
    const child = this.child
    if (child) {
      try { child.stdin?.end() } catch {}
      const alive = () => child.exitCode === null && child.signalCode === null
      if (alive()) {
        const closed = once(child, "close").catch(() => {})
        if (process.platform === "win32" && child.pid) {
          await execOnce("taskkill", ["/T", "/F", "/PID", String(child.pid)], { timeoutMs: 3_000 })
        } else {
          try { child.kill("SIGTERM") } catch {}
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))])
        }
        if (alive()) {
          try { child.kill("SIGKILL") } catch {}
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))])
        }
      }
    }
    this.child = null
    if (this.workspace) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fs.promises.rm(this.workspace, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt === 3 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) break
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
        }
      }
    }
    allProcs.delete(this)
  }
}

function stillRunningText(call) {
  return `${call.name} is still running in the client; no result yet. To keep waiting, call ${call.name} ` +
    "again with exactly the same arguments. That waits for this run and does not start it twice."
}

function resultText(result) {
  return (result?.content || []).map((part) => part?.type === "text" ? part.text : "[image returned by tool]").join("\n\n")
}

function renderLateResults(calls) {
  const parts = ["Client tool calls that were still running have finished. Their real results:"]
  for (const call of calls) {
    parts.push(`[tool result for ${call.name} call_id=${call.id}${call.result?.isError ? " (error)" : ""}]\n${resultText(call.result)}\n[end of tool result]`)
  }
  return parts.join("\n\n")
}

function renderLateResultParts(calls, includeImages = false) {
  const out = [{ type: "text", text: renderLateResults(calls) }]
  if (includeImages) {
    for (const call of calls) {
      for (const part of call.result?.content || []) {
        if (part?.type === "image" && part.data) {
          out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" })
        }
      }
    }
  }
  return out
}

function toPromptParts(content) {
  if (!content) return []
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const out = []
  for (const part of content) {
    if (!part) continue
    if (part.type === "text") {
      if (!part.text) continue
      if (out.at(-1)?.type === "text") out.at(-1).text += part.text
      else out.push({ type: "text", text: part.text })
    } else if (part.type === "image" && part.data) {
      out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" })
    }
  }
  return out
}

function mergePromptParts(first, second) {
  const a = toPromptParts(first)
  const b = toPromptParts(second)
  if (!a.length) return b
  if (!b.length) return a
  return toPromptParts([...a, { type: "text", text: "\n\n" }, ...b])
}

function promptHasImage(parts) {
  return Array.isArray(parts) && parts.some((part) => part?.type === "image")
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total
  const out = { ...(total || {}) }
  for (const [key, value] of Object.entries(usage)) {
    if (Number.isFinite(Number(value))) out[key] = (Number(out[key]) || 0) + Number(value)
  }
  return out
}

async function fileSize(file) {
  try { return (await fs.promises.stat(file)).size } catch { return 0 }
}

// agy writes the real upstream error only to its log; read what this turn added.
async function lastAgentError(file, offset) {
  let text = ""
  try {
    const handle = await fs.promises.open(file, "r")
    try {
      const size = (await handle.stat()).size
      const start = Math.max(offset || 0, size - LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(Math.max(0, size - start))
      await handle.read(buffer, 0, buffer.length, start)
      text = buffer.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return ""
  }
  let found = ""
  for (const line of text.split("\n")) {
    const match = /\] (?:agent executor error|failed to construct executor): (.+)$/.exec(line)
    if (match) found = match[1]
  }
  if (!found) return ""
  const cut = found.lastIndexOf("generating and executing: ")
  if (cut >= 0) found = found.slice(cut + "generating and executing: ".length)
  return found.trim().slice(0, 1000)
}

function dropFromPool(proc) {
  if (pool.get(proc.convKey) === proc) pool.delete(proc.convKey)
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

// Resumable sessions survive a plugin or Magpie restart: agy keeps the
// conversation on disk, and this file maps a conversation to its agy session.
// It stores only hashes of the history and instructions, never message text.
function sessionStateFile() {
  if (process.env.AGY_BRIDGE_STATE_FILE) return process.env.AGY_BRIDGE_STATE_FILE
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "magpie-agy-bridge", "sessions.json")
}

let parkedLoaded = false
const unparked = new Set()

function readStateFile() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionStateFile(), "utf8"))
    return data?.version === 1 && Array.isArray(data.entries) ? data.entries : []
  } catch {
    return []
  }
}

function validEntry(entry) {
  return entry && typeof entry.key === "string" && typeof entry.sessionId === "string" &&
    typeof entry.historyHash === "string" && typeof entry.instructionsHash === "string" &&
    Number.isFinite(entry.at) && Date.now() - entry.at <= RESUME_TTL_MS
}

function loadParked() {
  if (parkedLoaded) return
  parkedLoaded = true
  for (const entry of readStateFile().filter(validEntry).sort((a, b) => a.at - b.at)) {
    if (!parked.has(entry.key)) parked.set(entry.key, entry)
  }
}

// Hold a short-lived lockfile around read-merge-rename so concurrent bridge
// processes do not overwrite each other's parked session updates.
function withStateLock(file, fn) {
  const lock = `${file}.lock`
  let fd = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const waitBuf = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        fd = fs.openSync(lock, "wx", 0o600)
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
        break
      } catch (error) {
        if (error?.code !== "EEXIST") break
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) {
            const owner = JSON.parse(fs.readFileSync(lock, "utf8"))
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0) } catch (error) {
                if (error.code === "ESRCH") fs.unlinkSync(lock)
              }
            }
          }
        } catch {}
        Atomics.wait(waitBuf, 0, 0, 5)
      }
    }
    if (fd === null) return
    return fn()
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lock) } catch {}
    }
  }
}

// Merge with the file so concurrent bridge processes do not erase each other.
function saveParked() {
  const file = sessionStateFile()
  try {
    withStateLock(file, () => {
      const merged = new Map()
      for (const entry of readStateFile().filter(validEntry)) merged.set(entry.key, entry)
      for (const key of unparked) merged.delete(key)
      for (const [key, entry] of parked) {
        if ((merged.get(key)?.at ?? 0) <= entry.at) merged.set(key, entry)
      }
      const entries = [...merged.values()].sort((a, b) => a.at - b.at).slice(-MAX_PARKED)
      const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }) + "\n", { mode: 0o600 })
      fs.renameSync(temp, file)
      unparked.clear()
    })
  } catch {}
}

function unpark(convKey) {
  loadParked()
  if (!parked.has(convKey) && !readStateFile().some((entry) => entry?.key === convKey)) return
  parked.delete(convKey)
  unparked.add(convKey)
  saveParked()
}

// Remember a session so a later request, or a restarted bridge, resumes it
// instead of replaying history. Called after every completed turn and on retire.
function park(proc) {
  if (!proc.canPark()) return
  loadParked()
  parked.delete(proc.convKey)
  unparked.delete(proc.convKey)
  parked.set(proc.convKey, {
    key: proc.convKey,
    sessionId: proc.sessionId,
    historyHash: digest(historyKey(proc.expectedMessages)),
    instructionsHash: digest(compactIdentity(proc.instructions)),
    workDir: proc.workDir,
    at: Date.now(),
  })
  while (parked.size > MAX_PARKED) parked.delete(parked.keys().next().value)
  saveParked()
}

function takeParked(convKey, opts) {
  loadParked()
  const entry = parked.get(convKey)
  if (!entry) return null
  parked.delete(convKey)
  unparked.add(convKey)
  saveParked()
  if (Date.now() - entry.at > RESUME_TTL_MS || (entry.workDir ?? null) !== (opts.workDir ?? null) ||
    entry.instructionsHash !== digest(compactIdentity(opts.instructions)) ||
    entry.historyHash !== digest(historyKey(opts.history))) return null
  return { sessionId: entry.sessionId, expectedMessages: opts.history }
}

async function retire(key, proc) {
  proc.retiring = true
  park(proc)
  if (pool.get(key) === proc) pool.delete(key)
  await proc.stop().catch(() => {})
}

async function evictIdle() {
  const cutoff = Date.now() - IDLE_MS
  const victims = []
  for (const [key, proc] of pool) {
    if (proc.retiring) continue
    if (proc.dead || (!proc.turn && proc.lastUsed < cutoff)) victims.push([key, proc])
  }
  for (const [key, proc] of victims) await retire(key, proc)
}

async function evictLRU() {
  let oldest = null
  for (const [key, proc] of pool) {
    if (proc.turn || proc.retiring) continue
    if (!oldest || proc.lastUsed < oldest.proc.lastUsed) oldest = { key, proc }
  }
  if (!oldest) return false
  await retire(oldest.key, oldest.proc)
  return true
}

setInterval(() => { evictIdle().catch(() => {}) }, 60_000).unref()

const acquireLocks = new Map()

async function withAcquireLock(key, fn) {
  const previous = acquireLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  acquireLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (acquireLocks.get(key) === current) acquireLocks.delete(key)
  }
}

async function acquireProc(agyPath, convKey, opts, isFreshConversation, forceNew = false) {
  return withAcquireLock(convKey, () => acquireProcLocked(agyPath, convKey, opts, isFreshConversation, forceNew))
}

// Caller holds the conversation lock; recovery must not acquire it recursively.
async function acquireProcLocked(agyPath, convKey, opts, isFreshConversation, forceNew = false) {
  await evictIdle()
  let existing = pool.get(convKey)
  if (existing?.turn?.cancelRequested) {
    await Promise.race([existing.turn.settled, new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS))])
  }
  if (existing && !existing.dead && existing.turn) {
    const lineage = lineageVerdict(existing, existing.turn, opts)
    if (lineage === "fork") {
      const orphan = existing.turn
      logBridgeEvent(existing, orphan, "superseded", "lineage_fork", opts, { superseded_turn_id: orphan.turnId })
      await reclaimStaleTurn(existing, orphan, SUPERSEDED_NOTE)
      existing = null
    } else if (lineage === "conflict") {
      throw new ConflictError("agy bridge: this request carries the pending tool call but no matching result. Stop resending it; send the tool result or continue from the last self-consistent message.", "tool_state_conflict")
    }
  }
  if (existing) {
    if (!existing.dead && existing.turn) {
      throw new BusyError("agy bridge: this conversation still has an unfinished response")
    }
    let matchedHistory = opts.history
    if (!forceNew && !existing.dead && !existing.retiring && existing.unsentPrompt &&
      Array.isArray(opts.messages) && Array.isArray(existing.expectedMessages)) {
      const k = existing.expectedMessages.length
      if (k > matchedHistory.length && k <= opts.messages.length &&
        existing.matchesHistory(opts.messages.slice(0, k))) {
        matchedHistory = opts.messages.slice(0, k)
      }
    }
    const compatible = !forceNew && !existing.dead && !existing.retiring &&
      existing.workDir === opts.workDir && sameInstructions(existing.instructions, opts.instructions) &&
      existing.matchesHistory(matchedHistory)
    if (compatible && !(isFreshConversation && existing.hasSentFirstTurn)) {
      await existing.updateTools(opts.tools)
      return { proc: existing, history: matchedHistory }
    }
    existing.retiring = true
    dropFromPool(existing)
    await existing.stop().catch(() => {})
  }
  while (allProcs.size >= MAX_PROCS) {
    if (!(await evictLRU())) {
      throw new BusyError(`agy bridge: ${MAX_PROCS} agy processes are running and all have unfinished responses`)
    }
  }
  const resume = forceNew || isFreshConversation ? null : takeParked(convKey, opts)
  const proc = new Proc(agyPath, convKey, { ...opts, resume })
  try {
    await proc.start()
  } catch (error) {
    await proc.stop().catch(() => {})
    throw error
  }
  pool.set(convKey, proc)
  return { proc, history: opts.history }
}

// Bounded, content-free events: never log prompts, arguments, results or tool IDs.
const HOST_EPOCH = randomBytes(4).toString("hex")
let eventWindowStart = 0
let eventWindowCount = 0
function logBridgeEvent(proc, turn, action, reason, meta = {}, extra = {}) {
  if (process.env.AGY_BRIDGE_EVENTS === "0") return
  const now = Date.now()
  if (now - eventWindowStart >= 60_000) { eventWindowStart = now; eventWindowCount = 0 }
  if (eventWindowCount++ >= 30) return
  const row = {
    event: "agy_bridge_tool_state", host_epoch: HOST_EPOCH, ts: now,
    conv: digest(proc.convKey).slice(0, 12), turn_id: turn.turnId,
    action, reason, attached: turn.attached, done: turn.done, dead: proc.dead,
    pending: turn.calls.filter((call) => !call.result).length,
    client_idle_ms: Math.max(0, now - (turn.clientProgressAt ?? turn.lastProgressAt)),
    self_poll_repeats: turn.calls.reduce((max, call) => Math.max(max, call.stillRunning || 0), 0),
    ...(meta.layout ? { layout: meta.layout, nonstream: meta.nonstream } : {}), ...extra,
  }
  try { process.stderr.write("[agy-bridge] " + JSON.stringify(row) + "\n") } catch {}
}

function staleTurnVerdict(proc, turn, now = Date.now()) {
  if (!turn || turn.cancelRequested) return { stale: false, reason: "cancelling" }
  if (turn.attached) return { stale: false, reason: "attached" }
  if (turn.finalized || proc.dead || proc.stopping || turn.done) return { stale: true, reason: "finished" }
  if (turn.deadlineAt != null && now >= turn.deadlineAt) return { stale: true, reason: "expired" }
  return { stale: false, reason: "pending_tool" }
}

// A pending tool turn only owns its own line of history, not a sibling request
// that continues its base without carrying any of the emitted tool calls.
function lineageVerdict(proc, turn, opts) {
  if (!turn || turn.attached || turn.cancelRequested || turn.done || turn.finalized) return null
  if (proc.dead || proc.stopping || proc.retiring || !turn.hasPendingMcp()) return null
  const history = opts.history
  const base = turn.baseHistory
  if (!Array.isArray(history) || history.length < base.length ||
    historyKey(history.slice(0, base.length)) !== historyKey(base)) return null
  const ids = new Set(turn.calls.map((call) => call.id))
  const carried = (opts.messages || []).some((message) => Array.isArray(message?.content) &&
    message.content.some((block) => block?.type === "tool_use" && ids.has(block.id)))
  const expected = proc.expectedMessages
  const recorded = Array.isArray(expected) && expected.length > base.length &&
    history.length >= expected.length &&
    historyKey(history.slice(0, expected.length)) === historyKey(expected)
  // A renamed call with edited arguments still belongs to the old response.
  // Keep upstream's 409 and its live owner intact rather than replaying it as
  // a sibling conversation just because its inputs no longer compare equal.
  const withoutInputs = (messages) => messages.map((message) => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map((block) =>
      block?.type === "tool_use" ? { ...block, input: {} } : block) : message.content,
  }))
  if (!carried && !recorded && Array.isArray(expected) && expected.length > base.length &&
    history.length === expected.length &&
    historyKey(withoutInputs(history)) === historyKey(withoutInputs(expected))) return null
  return carried || recorded ? "conflict" : "fork"
}

function replayHistoryProblem(body, resultBlocks) {
  const calls = lastAssistantCalls(trailingMessages(body).history)
  if (!calls.length) return "no_tool_use"
  const ids = new Set()
  for (const call of calls) {
    if (typeof call.id !== "string" || !call.id || ids.has(call.id)) return "bad_tool_use_id"
    ids.add(call.id)
    if (typeof call.name !== "string" || !call.name) return "bad_tool_use_name"
    const input = call.input ?? {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return "bad_tool_use_input"
  }
  const answered = new Set()
  for (const block of resultBlocks) {
    if (!ids.has(block.tool_use_id) || answered.has(block.tool_use_id)) return "unmatched_tool_result"
    answered.add(block.tool_use_id)
  }
  return answered.size === ids.size ? null : "missing_tool_result"
}

async function reclaimStaleTurn(proc, turn, note = "agy bridge: stale tool turn closed") {
  turn.closeNote = note
  proc.retiring = true
  proc.historyInvalid = true
  dropFromPool(proc)
  unpark(proc.convKey)
  turn.fail(new Error(note))
  proc.abandonTurn(turn)
  let timer
  try {
    await Promise.race([proc.stop().catch(() => {}), new Promise((resolve) => {
      timer = setTimeout(resolve, RECLAIM_STOP_TIMEOUT_MS)
      timer.unref?.()
    })])
  } finally { clearTimeout(timer) }
}

// Recheck under the same lock and start at most one replacement turn.
async function recoverStaleTurn(ctx) {
  return withAcquireLock(ctx.convKey, async () => {
    const current = pool.get(ctx.convKey)
    if (current !== ctx.proc || current?.turn !== ctx.turn) {
      throw new ConflictError("agy bridge: this turn was already replaced. Stop resending this request.", "tool_state_conflict")
    }
    const verdict = staleTurnVerdict(current, ctx.turn)
    // As in the local fix, lineage supersession belongs to acquisition of a
    // new prompt. Unmatched results alone must not reclaim an unexpired owner.
    if (!verdict.stale) return null
    const reason = verdict.reason
    logBridgeEvent(current, ctx.turn, "reclaim", reason, ctx.acquireOpts)
    await reclaimStaleTurn(current, ctx.turn)
    if (replayHistoryProblem(ctx.body, ctx.resultBlocks)) {
      throw new ConflictError("agy bridge: incomplete tool history. Stop resending it; continue from the last self-consistent message.", "tool_history_incomplete")
    }
    const { proc, history } = await acquireProcLocked(ctx.agy, ctx.convKey, ctx.acquireOpts, ctx.isFresh, true)
    const turn = await ctx.begin(proc, history)
    logBridgeEvent(proc, turn, "replay_started", reason, ctx.acquireOpts)
    return { proc, turn }
  })
}

function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

function parseUserImage(block) {
  if (block?.type !== "image") return null
  const mediaType = String(block.source?.media_type || "").toLowerCase()
  return imageContent({ ...block, source: { ...block.source, media_type: mediaType === "image/jpg" ? "image/jpeg" : mediaType } })
}

function parseUserDocumentText(block) {
  if (block?.type !== "document") return ""
  const title = typeof block.title === "string" && block.title.trim() ? block.title.trim() : ""
  const src = block.source
  let text = null
  if (src?.type === "text" && typeof src.data === "string") {
    text = src.data
  } else if (src?.type === "content") {
    if (typeof src.content === "string") {
      text = src.content
    } else if (Array.isArray(src.content) && src.content.every((part) => part?.type === "text" && typeof part.text === "string")) {
      text = src.content.map((part) => part.text).join("\n")
    }
  }
  if (text === null) {
    throw new UnsupportedContent("a binary or URL document block in a user message (agy's ACP prompt accepts text and images only)")
  }
  return title ? `[document: ${title}]\n${text}\n[end of document]` : text
}

function parseSearchResultText(block) {
  if (block?.type !== "search_result") return ""
  const header = [block.title, block.source].filter((item) => typeof item === "string" && item.trim()).join(" — ")
  const body = Array.isArray(block.content)
    ? block.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
    : typeof block.content === "string" ? block.content : ""
  return header ? `[search result: ${header}]\n${body}\n[end of search result]` : body
}

const SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "mcp_tool_result",
  "advisor_tool_result",
])

const ASSISTANT_ALLOWED_BLOCK_TYPES = new Set([
  "text",
  "tool_use",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "mcp_tool_use",
  "container_upload",
  ...SERVER_TOOL_RESULT_BLOCK_TYPES,
])

function renderServerAssistantBlock(block) {
  if (!block || typeof block !== "object") return ""
  if (block.type === "server_tool_use" || block.type === "mcp_tool_use") {
    return `[server tool call ${block.name || block.type} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`
  }
  if (block.type === "container_upload") {
    return block.file_id ? `[container upload ${block.file_id}]` : ""
  }
  if (SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
    return `[${block.type}${block.tool_use_id ? " id=" + block.tool_use_id : ""}] ${JSON.stringify(block.content ?? "")}`
  }
  return ""
}

const MAGPIE_PLACEHOLDER_NOTICE = "Values written like {{NAME_ab12cd34}} are placeholders for real values. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs. Don't ask to verify them, and don't replace them with examples."
const MAGPIE_PLACEHOLDER_NOTICE_RE = /(?:^|\n\n)Values written like \{\{NAME_ab12cd34\}\} are placeholders for real values\. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs\. Don't ask to verify them, and don't replace them with examples\.(?=\s|$)/g

function stripMagpiePlaceholderNotice(text) {
  if (typeof text !== "string" || !text.includes("{{NAME_ab12cd34}}")) return text
  return text.replace(MAGPIE_PLACEHOLDER_NOTICE_RE, "")
}

// Compare conversation content, not transport metadata or client-assigned IDs.
// Keep argument values, result contents and internal whitespace significant.
function historyKey(messages) {
  const rows = []
  const ids = new Map()
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }]
    for (const block of blocks) {
      if (!block) continue
      if (block.type === "thinking" || block.type === "redacted_thinking" ||
        block.type === "tool_addition" || block.type === "tool_removal") continue
      let value
      if (typeof block === "string" || block.type === "text") {
        value = { type: "text", text: stripMagpiePlaceholderNotice(typeof block === "string" ? block : block.text || "") }
      } else if (block.type === "document") {
        value = { type: "text", text: parseUserDocumentText(block) }
      } else if (block.type === "search_result") {
        value = { type: "text", text: parseSearchResultText(block) }
      } else if (block.type === "image") {
        const image = parseUserImage(block)
        value = { type: "image", mimeType: image.mimeType, sha256: digest(image.data) }
      } else if (block.type === "tool_use") {
        const ordinal = ids.size + 1
        ids.set(block.id, ordinal)
        value = { type: "tool_use", id: ordinal, name: block.name, input: block.input ?? {} }
      } else if (block.type === "tool_result") {
        value = { type: "tool_result", id: ids.get(block.tool_use_id) ?? block.tool_use_id, ...toolResult(block) }
      } else if (block.type === "server_tool_use" || block.type === "mcp_tool_use" ||
        block.type === "container_upload" || SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
        value = { type: block.type, name: block.name || "", content: renderServerAssistantBlock(block) }
      } else {
        value = block
      }
      let row = rows.at(-1)
      if (!row || row.role !== message.role) {
        row = { role: message.role, content: [] }
        rows.push(row)
      }
      const last = row.content.at(-1)
      if (last?.type === "text" && value.type === "text") last.text += value.text
      else row.content.push(value)
    }
  }
  for (const row of rows) {
    row.content = row.content.filter(block => block.type !== "text" || (block.text = block.text.trim()) !== "")
  }
  return stableJSON(rows.filter(row => row.content.length))
}

function trailingMessages(body) {
  body = canonicalBody(body)
  let start = body.messages.length
  while (start > 0 && body.messages[start - 1].role !== "assistant") start--
  return { history: body.messages.slice(0, start), messages: body.messages.slice(start) }
}

function lastAssistantCalls(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === "assistant") start--
  return messages.slice(start).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_use") : [])
}

function matchToolResults(body, blocks) {
  const direct = blocks.map(block => ({ block, match: toolCalls.get(block.tool_use_id) }))
  if (direct.every(item => item.match)) return direct
  const { history } = trailingMessages(body)
  const calls = lastAssistantCalls(history)
  const byID = new Map(calls.map((call, index) => [call.id, index]))
  if (!calls.length || byID.size !== calls.length || calls.some(call => !call.id) ||
    blocks.some(block => !byID.has(block.tool_use_id))) return direct
  let found = null
  for (const proc of allProcs) {
    if (!proc.turn || proc.turn.finalized || !proc.matchesHistory(history)) continue
    const shown = lastAssistantCalls(proc.expectedMessages)
    if (shown.length !== calls.length || shown.some((call, index) =>
      call.name !== calls[index].name || stableJSON(call.input ?? {}) !== stableJSON(calls[index].input ?? {}))) continue
    const mapped = blocks.map(block => ({ block, match: toolCalls.get(shown[byID.get(block.tool_use_id)].id) }))
    if (mapped.some((item, index) => direct[index].match && item.match !== direct[index].match)) continue
    if (mapped.some(item => !item.match) || !mapped.some(item => !item.match.call.mcpResponded || (item.match.call.deferred && !item.match.call.result))) continue
    if (found) throw new BusyError("agy bridge: renamed tool IDs match more than one pending conversation")
    found = mapped
  }
  return found || direct
}

function systemText(body) {
  if (!body.system) return ""
  return typeof body.system === "string" ? body.system : body.system.map((block) => block.text || "").join("")
}

// Streaming clients may inline the opening system prompt, then hoist it into
// `system` on a non-streaming retry. Trailing system notifications remain turn
// content, as in the existing protocol; only the opening prefix is lifted.
function canonicalBody(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body
  let count = 0
  while (count < messages.length && messages[count]?.role === "system") count++
  if (!count || count === messages.length) return body
  const parts = [systemText(body), ...messages.slice(0, count).map((message) =>
    typeof message.content === "string" ? message.content : (message.content || [])
      .map((block) => typeof block === "string" ? block : block?.type === "text" ? block.text || "" : "").join(""))]
  return { ...body, system: parts.filter((text) => text.trim()).join("\n\n"), messages: messages.slice(count) }
}

function compactIdentity(text) {
  return String(text ?? "").replace(/\s+/g, "")
}

function sameInstructions(a, b) {
  return compactIdentity(a) === compactIdentity(b)
}

// The model is not part of the key: agy switches models inside a live session.
function conversationKey(rawBody) {
  const body = canonicalBody(rawBody)
  const system = historyKey([{ role: "system", content: compactIdentity(systemText(body)) }])
  const first = body.messages?.[0]
  const firstText = first ? historyKey([first]) : ""
  const discriminator = body.metadata?.user_id || ""
  const source = discriminator + "\n" + system + "\n===\n" + firstText
  return createHash("sha256").update(source).digest("hex")
}

function appendSchemaHint(node, hint) {
  if (!hint) return
  if (typeof node.description === "string" && node.description.trim()) {
    if (!node.description.includes(hint)) node.description = `${node.description} (${hint})`
  } else {
    node.description = hint
  }
}

// Sanitize JSON Schema constructs that agy's ACP -> Google Code Assist translator
// converts into invalid Schema protos (e.g. union types leaving stale array/object
// keywords, or non-string/empty enum entries producing `enum[0]: cannot be empty`).
function sanitizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  const out = { ...schema }

  if (Array.isArray(out.type)) {
    const types = out.type.filter((item) => typeof item === "string")
    const nullable = types.includes("null")
    const nonNull = types.filter((item) => item !== "null")
    if (nonNull.length > 1) {
      let chosen = nonNull[0]
      if (nonNull.includes("array") && out.items !== undefined) chosen = "array"
      else if (nonNull.includes("object") && (out.properties !== undefined || out.additionalProperties !== undefined)) {
        chosen = "object"
      }
      out.type = nullable ? [chosen, "null"] : chosen
      appendSchemaHint(out, `Accepts types: ${types.join(" | ")}`)
    } else if (nonNull.length === 1) {
      out.type = nullable ? [nonNull[0], "null"] : nonNull[0]
    }
  }

  const resolvedType = typeof out.type === "string"
    ? out.type
    : Array.isArray(out.type)
      ? out.type.find((item) => item !== "null") || null
      : null

  if (resolvedType && resolvedType !== "array") {
    delete out.items
    delete out.prefixItems
    delete out.minItems
    delete out.maxItems
    delete out.uniqueItems
    delete out.contains
  }
  if (resolvedType && resolvedType !== "object") {
    delete out.properties
    delete out.patternProperties
    delete out.required
    delete out.minProperties
    delete out.maxProperties
    delete out.dependentRequired
  }

  if (Array.isArray(out.enum)) {
    const invalidEnum = out.enum.length === 0 ||
      (resolvedType && resolvedType !== "string") ||
      out.enum.some((item) => typeof item !== "string" || item.length === 0)
    if (invalidEnum) {
      if (out.enum.length) {
        appendSchemaHint(out, `Allowed values: ${out.enum.map((item) => JSON.stringify(item)).join(", ")}`)
      }
      delete out.enum
    }
  }

  if (out.const !== undefined && (typeof out.const !== "string" || out.const.length === 0 || (resolvedType && resolvedType !== "string"))) {
    appendSchemaHint(out, `Must equal: ${JSON.stringify(out.const)}`)
    delete out.const
  }

  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
    if (Array.isArray(out.required)) {
      const filtered = out.required.filter((key) => typeof key === "string" && Object.hasOwn(out.properties, key))
      if (filtered.length) out.required = filtered
      else delete out.required
    }
  }
  if (out.patternProperties && typeof out.patternProperties === "object" && !Array.isArray(out.patternProperties)) {
    out.patternProperties = Object.fromEntries(
      Object.entries(out.patternProperties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  if (out.additionalProperties && typeof out.additionalProperties === "object" && !Array.isArray(out.additionalProperties)) {
    out.additionalProperties = sanitizeInputSchema(out.additionalProperties)
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => sanitizeInputSchema(item))
  } else if (out.items && typeof out.items === "object") {
    out.items = sanitizeInputSchema(out.items)
  }
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = out.prefixItems.map((item) => sanitizeInputSchema(item))
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((item) => sanitizeInputSchema(item))
  }
  if (out.not && typeof out.not === "object" && !Array.isArray(out.not)) {
    out.not = sanitizeInputSchema(out.not)
  }
  for (const defsKey of ["$defs", "definitions"]) {
    if (out[defsKey] && typeof out[defsKey] === "object" && !Array.isArray(out[defsKey])) {
      out[defsKey] = Object.fromEntries(
        Object.entries(out[defsKey]).map(([key, value]) => [key, sanitizeInputSchema(value)]),
      )
    }
  }
  return out
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return []
  const choice = body.tool_choice
  if (choice === "none" || choice?.type === "none") return []
  const selected = choice?.type === "tool" ? choice.name : null
  const seen = new Set()
  const tools = []
  for (const tool of body.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      throw new UnsupportedContent("a tool without a valid name")
    }
    if (seen.has(tool.name)) throw new UnsupportedContent(`duplicate tool ${tool.name}`)
    seen.add(tool.name)
    if (selected && tool.name !== selected) continue
    const rawSchema = tool.input_schema ?? { type: "object", properties: {} }
    if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
      throw new UnsupportedContent(`an invalid schema for tool ${tool.name}`)
    }
    const inputSchema = sanitizeInputSchema(rawSchema)
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
    })
  }
  if (selected && !tools.length) throw new UnsupportedContent(`tool_choice names undeclared tool ${selected}`)
  return tools
}

function blockText(block) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new UnsupportedContent("a non-object content block")
  }
  if (block.type === "text") return typeof block.text === "string" ? block.text : ""
  if (block.type === "tool_addition" || block.type === "tool_removal") return ""
  if (block.type === "tool_reference" && typeof block.tool_name === "string") {
    return `Loaded tool: ${block.tool_name}`
  }
  if (block.type === "document") return parseUserDocumentText(block)
  if (block.type === "search_result") return parseSearchResultText(block)
  if (block.type === "image") {
    parseUserImage(block)
    return "[image]"
  }
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content)
      ? block.content.map((part) => {
        if (part?.type === "image") return "[image returned by tool]"
        return blockText(part)
      }).join("")
      : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "tool_use") throw new UnsupportedContent("a tool_use block in a user message")
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

function messageText(message) {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) return message.content.map(blockText).join("")
  return String(message.content ?? "")
}

function imageContent(block) {
  const source = block.source
  if (source?.type !== "base64") {
    throw new UnsupportedContent("an image source other than base64; provide inline image data instead of a URL")
  }
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)) {
    throw new UnsupportedContent("an image media type other than PNG, JPEG, GIF or WebP")
  }
  if (typeof source.data !== "string" || !source.data ||
    source.data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(source.data.replace(/={1,2}$/, ""))) {
    throw new UnsupportedContent("invalid base64 image data")
  }
  return { type: "image", data: source.data, mimeType: source.media_type }
}

// Keep text adjacent to its images, including when an old conversation has to
// be replayed. Never interpolate image bytes into the text seen by the model.
function appendPrompt(out, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
  for (const block of blocks) {
    const last = out.at(-1)
    if (last?.type === "text" && block.type === "text") last.text += block.text
    else out.push({ ...block })
  }
}

function renderAssistantTurn(message) {
  const parts = []
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content ?? "") }]
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text || "")
    else if (block.type === "tool_use") {
      parts.push(`[tool call ${block.name} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`)
    } else {
      const rendered = renderServerAssistantBlock(block)
      if (rendered) parts.push(rendered)
    }
  }
  return parts.join("\n")
}

function outputFormatReminder(body) {
  const format = body?.output_config?.format || body?.response_format
  if (!format || typeof format !== "object") return []
  if (format.type === "json_schema") {
    const schema = format.schema ?? format.json_schema?.schema
    if (schema && typeof schema === "object") {
      return [{
        type: "text",
        text: `<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON value (no Markdown code fences, no backticks, and no explanatory prose before or after) conforming strictly to this JSON Schema:\n${JSON.stringify(schema)}\n</system-reminder>`,
      }]
    }
  }
  if (format.type === "json_object") {
    return [{
      type: "text",
      text: "<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON object (no Markdown code fences, no backticks, and no explanatory prose before or after).\n</system-reminder>",
    }]
  }
  return []
}

function workDirNote(callerWorkDir) {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.`
}

// Session-level instructions: the client's system prompt plus where tools run.
function sessionInstructions(body, callerWorkDir) {
  const parts = []
  const system = systemText(canonicalBody(body))
  if (system.trim()) parts.push(system)
  if (callerWorkDir) parts.push(workDirNote(callerWorkDir))
  return parts.join("\n\n")
}

const QUEUED_PROMPT_PREFIX_RE = /^(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):\n([\s\S]*)$/
const QUEUED_PROMPT_SUFFIX_RE = /\n\n(?:This is how Claude Code surfaces (?:messages the user sends|prompts [^\r\n]+ submits) mid-turn[\s\S]*|IMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.|Please address this message and continue with your tasks\.)\s*$/

function extractQueuedPrompt(raw) {
  if (typeof raw !== "string") return null
  const cleanedRaw = stripMagpiePlaceholderNotice(raw)
  const hadPlaceholder = cleanedRaw !== raw
  let trimmed = cleanedRaw.trim()
  const reminder = /^<system-reminder(?:\s[^>]*)?>([\s\S]*)<\/system-reminder(?:\s[^>]*)?>$/.exec(trimmed)
  if (reminder) trimmed = reminder[1].trim()
  const match = QUEUED_PROMPT_PREFIX_RE.exec(trimmed)
  if (!match) return null
  const unwrapped = match[1].replace(QUEUED_PROMPT_SUFFIX_RE, "").trim()
  if (!hadPlaceholder) return unwrapped
  const placeholderTag = `<system-reminder>\n${MAGPIE_PLACEHOLDER_NOTICE}\n</system-reminder>`
  return unwrapped ? `${unwrapped}\n\n${placeholderTag}` : placeholderTag
}

function renderTurnMessage(message) {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      const queued = extractQueuedPrompt(message.content)
      return queued !== null ? queued : message.content
    }
    if (Array.isArray(message.content)) {
      const out = []
      let afterToolResult = false
      for (const block of message.content) {
        if (block?.type === "tool_result") {
          out.push(blockText(block))
          afterToolResult = true
          continue
        }
        const raw = blockText(block)
        const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
        const rendered = queued !== null ? queued : raw
        if (rendered && afterToolResult && !rendered.startsWith("\n")) {
          out.push("\n\n" + rendered)
        } else {
          out.push(rendered)
        }
        if (rendered) afterToolResult = false
      }
      return out.join("")
    }
    return messageText(message)
  }
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const reminders = []
  const queuedParts = []
  for (const block of blocks) {
    const raw = blockText(block)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const queued = extractQueuedPrompt(trimmed)
    if (queued !== null) {
      if (queued) queuedParts.push(queued)
    } else {
      reminders.push(raw)
    }
  }
  const out = []
  const joinedReminders = reminders.join("").trim()
  if (joinedReminders) {
    out.push(/^<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder(?:\s[^>]*)?>$/.test(joinedReminders)
      ? joinedReminders
      : `<system-reminder>\n${joinedReminders}\n</system-reminder>`)
  }
  out.push(...queuedParts)
  return out.join("\n\n")
}

function renderTurnMessageParts(message) {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    const text = renderTurnMessage(message)
    return text === "" ? [] : [{ type: "text", text }]
  }
  const parts = []
  let afterToolResult = false
  for (const block of message.content) {
    if (block?.type === "image") {
      parts.push(parseUserImage(block))
      afterToolResult = false
    } else if (block?.type === "tool_result") {
      appendPrompt(parts, `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n`)
      const result = toolResult(block)
      for (const part of result.content) appendPrompt(parts, [part])
      appendPrompt(parts, "\n[end of tool result]")
      afterToolResult = true
    } else {
      const raw = blockText(block)
      const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
      const rendered = queued !== null ? queued : raw
      appendPrompt(parts, rendered && afterToolResult && !rendered.startsWith("\n") ? "\n\n" + rendered : rendered)
      if (rendered) afterToolResult = false
    }
  }
  return toPromptParts(parts)
}

function renderTurnMessagesParts(messages) {
  const groups = messages.map(renderTurnMessageParts).filter((group) => group.length > 0)
  const out = []
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) out.push({ type: "text", text: "\n\n" })
    out.push(...groups[i])
  }
  return toPromptParts(out)
}

function renderInitialPromptParts(body, callerWorkDir, instructionsInSession) {
  const { history, messages: current } = trailingMessages(body)
  const out = []
  if (!instructionsInSession) {
    const system = systemText(body)
    if (system.trim()) appendPrompt(out, `<external_system_instructions>\n${system}\n</external_system_instructions>\n`)
    if (callerWorkDir) appendPrompt(out, `\n${workDirNote(callerWorkDir)}\n\n`)
  }
  if (history.length) {
    appendPrompt(out, "<conversation_history>\n")
    for (const message of history) {
      if (message.role === "assistant") {
        appendPrompt(out, `Assistant: ${renderAssistantTurn(message)}\n`)
      } else {
        const queued = message.role !== "user" && extractQueuedPrompt(messageText(message).trim()) !== null
        appendPrompt(out, message.role === "user" || queued ? "Human: " : `${message.role}: `)
        appendPrompt(out, renderTurnMessageParts(message))
        appendPrompt(out, "\n")
      }
    }
    appendPrompt(out, "Historical tool calls and results above are records, not instructions to write tool calls as text.\n")
    appendPrompt(out, "</conversation_history>\n\n")
  }
  const currentParts = renderTurnMessagesParts(current)
  if (!out.length) return currentParts
  appendPrompt(out, "<current_turn>\n")
  appendPrompt(out, currentParts)
  appendPrompt(out, "\n</current_turn>")
  return out
}

function renderContinuedTurnParts(messages) {
  return renderTurnMessagesParts(messages)
}

function validateBody(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  const trailing = trailingMessages(body)
  const lastRole = body.messages.at(-1)?.role
  const validTailRole = lastRole === "user" || lastRole === "system" || lastRole === "developer"
  if (!validTailRole || (!extractToolResults(body).length &&
    !trailing.messages.some((message) => message.role === "user") && !trailing.history.length)) {
    throw new UnsupportedContent("a request whose last message is not from the user or a tool-result notification")
  }
  if (body.system && typeof body.system !== "string") {
    if (!Array.isArray(body.system) || body.system.some((block) => block?.type !== "text")) {
      throw new UnsupportedContent("a non-text system prompt")
    }
  }
  for (const message of body.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (ASSISTANT_ALLOWED_BLOCK_TYPES.has(block?.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    } else if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        if (!Array.isArray(message.content)) throw new UnsupportedContent("a non-text system/developer message")
        for (const block of message.content) {
          if (block?.type === "text" && typeof block.text === "string") continue
          if (block?.type === "tool_addition" || block?.type === "tool_removal") continue
          if (block && typeof block.type === "string" && block.type !== "text") {
            throw new UnsupportedContent(`a non-text system/developer content block of type ${JSON.stringify(block.type)}`)
          }
          throw new UnsupportedContent("a non-text system/developer message")
        }
      }
    } else if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "tool_result") toolResult(block)
          else if (block?.type === "image") parseUserImage(block)
          else if (block?.type === "text" || typeof block === "string") continue
          else if (block?.type === "image") parseUserImage(block)
          else if (block?.type === "document") parseUserDocumentText(block)
          else if (block?.type === "search_result") parseSearchResultText(block)
          else blockText(block)
        }
      } else if (typeof message.content !== "string") {
        messageText(message)
      }
    }
  }
}

function toolResult(block) {
  if (!block || typeof block.tool_use_id !== "string" || !block.tool_use_id) {
    throw new UnsupportedContent("a tool_result without tool_use_id")
  }
  let content
  if (typeof block.content === "string") {
    content = [{ type: "text", text: block.content }]
  } else if (Array.isArray(block.content)) {
    content = block.content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
      if (part?.type === "tool_reference" && typeof part.tool_name === "string") {
        return { type: "text", text: `Loaded tool: ${part.tool_name}` }
      }
      if (part?.type === "document") return { type: "text", text: parseUserDocumentText(part) }
      if (part?.type === "search_result") return { type: "text", text: parseSearchResultText(part) }
      if (part?.type === "image" && part.source?.type === "base64" && part.source.data) {
        return {
          type: "image",
          data: part.source.data,
          mimeType: part.source.media_type || "application/octet-stream",
        }
      }
      throw new UnsupportedContent("this tool_result content")
    })
  } else if (block.content == null) {
    content = [{ type: "text", text: "" }]
  } else {
    throw new UnsupportedContent("non-text tool_result content")
  }
  return { content, isError: block.is_error === true }
}

function extractToolResults(body) {
  return trailingMessages(body).messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === "tool_result") : [])
}

function isSkillResult(item) {
  if (item.call?.name === "Skill") return true
  const first = item.result?.content?.[0]
  return first?.type === "text" &&
    /^(?:Launching skill|Loaded skill instructions \(read-only\)): /.test(first.text || "")
}

function appendResultPart(results, index, part) {
  if (index < 0 || index >= results.length) {
    throw new UnsupportedContent("text beside a live tool_result; no matching tool companion")
  }
  const target = index
  const targetCall = results[target]?.call
  return results.map((item, i) => (targetCall ? item.call !== targetCall : i !== target) ? item : {
    ...item,
    result: {
      ...item.result,
      content: [...item.result.content, part],
    },
  })
}

function appendResultText(results, index, text) {
  return appendResultPart(results, index, { type: "text", text })
}

function isInterruptedToolTurn(body) {
  let seenResult = false
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) return false
        continue
      }
      const text = stripMagpiePlaceholderNotice(blockText(block))
      if (!seenResult && message.role === "user" && text.trim()) return false
      if (seenResult && message.role === "user" &&
        /^\[Request interrupted by user(?:\s+for tool use)?\]\s*$/.test(text)) {
        return true
      }
    }
  }
  return false
}

const NOTICE_TAG_NAMES = "system-update|teammate-message|agent-message|cross-session-message|coordinator-relay|channel|ide_opened_file|ide_selection|mcp-resource|mcp-resource-update|mcp-polling-update|post-tool-use-hook|user-prompt-submit-hook"
const CONTEXT_NOTICE_RE = new RegExp(
  `<(${NOTICE_TAG_NAMES})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>|(?:\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\][^<]*)?<task-notification>[\\s\\S]*?<\\/task-notification>`,
  "g",
)
const SYSTEM_REMINDER_RE = /<system-reminder(?:\s[^>]*)?>([\s\S]*?)<\/system-reminder(?:\s[^>]*)?>/g
const PROTOCOL_NOTICE_START_RE = new RegExp(
  `^(?:<(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b|\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\])`,
)
const UNCLOSED_NOTICE_RE = new RegExp(
  `<\\/?(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b`,
)

// Forward complete protocol-generated context notices, Claude Code hook outputs,
// and tool-companion blocks without turning arbitrary inline user instructions
// into MCP function_response text. Mid-turn queued_command prompts and follow-up
// user instructions after a rejected/stopped tool call set userSteered so the
// bridge replays them via session/prompt.
function inspectToolTurn(results, body) {
  let out = results
  let userSteered = false
  const notices = []
  let seenResult = false
  let resultIndex = -1
  const stoppedByHookOrUser = out.some((item) => item.result?.isError &&
    /^(?:The user doesn't want to proceed with this tool use\.|User rejected tool use\b|Operation stopped by hook\b|Execution stopped by hook\b|Blocked by PreToolUse hook\b|Hook PreToolUse:\S+ denied\b|API Error: Request was aborted\.|\[Request interrupted by user\b)/.test(resultText(item.result).trim()))
  const userInterruption = /(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):/
  const nonUserSourceNotice = /^\[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT\]\s*\n/
  const skillCompanion = /^\s*(?:Base directory for this skill:|ARGUMENTS:|Skill arguments:) /
  const imageCompanion = /^\[Image(?: source)?: [^\r\n]+\]$/
  const toolLoadedCompanion = /^Tools? loaded\.(?:\n\[id:[^\]\n]+\])*$/
  const loopNotice = /^\[\d+ prior \/loop wakeups? found nothing actionable; loop is healthy\.\]$/
  const tokenNoise = /^(?:<total_tokens>[^<]*<\/total_tokens>|Token usage: \S+; \S+ remaining|USD budget: \$\S+; \$\S+ remaining|Output tokens \u2014 turn: [^\r\n]+)$/
  const hookBoilerplateNoise = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook success:\s*(?:Success)?\s*$/
  const hookOutput = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):/
  const hookStoppedContinuation = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook stopped continuation:/
  const claudeMetaFeedback = /^(?:(?:Stop|SubagentStop|TeammateIdle|TaskCreated|TaskCompleted|PermissionRequest|PermissionDenied|PreCompact|PostCompact|Elicitation|ElicitationResult|ConfigChange|CwdChanged|FileChanged|WorktreeCreate|WorktreeRemove|InstructionsLoaded) hook feedback:\n[\s\S]+|UserPromptSubmit operation blocked by hook:\n[\s\S]+|The PermissionDenied hook indicated you may retry this tool call\.|The turn did not end: a tool call in your last message asked to end it, but another call in that message failed\.[\s\S]*|Your response above was stopped by a safety classifier \u2014 this is not a tool or API error\.[\s\S]*|The previous response failed to produce a valid tool call\. Please retry the tool call now\.|Your tool call was malformed and could not be parsed\. Please retry\.|Output token limit hit[\s\S]*|Your response (?:was cut off|above was cut off)[\s\S]*|\[Your previous response (?:had no visible output|reached the output limit)[\s\S]*\]|\[structured-output-enforce\][\s\S]*|\[projects-reply-gate\][\s\S]*|Linked in your reply but not sent:[\s\S]*|Goal check-in: \u00ab[\s\S]*)$/
  const isNoise = (value) => !value || tokenNoise.test(value) || hookBoilerplateNoise.test(value)
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        resultIndex = out.findIndex(item => item.block?.tool_use_id === block.tool_use_id)
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) {
          throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
        }
        out = appendResultPart(out, resultIndex, parseUserImage(block))
        continue
      }
      const rawText = blockText(block)
      if (!seenResult && message.role === "user" && rawText.trim()) {
        throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
      }
      const text = stripMagpiePlaceholderNotice(rawText)
      if (text !== rawText && !notices.includes(MAGPIE_PLACEHOLDER_NOTICE)) {
        notices.push(MAGPIE_PLACEHOLDER_NOTICE)
      }
      const trimmed = text.trim()
      if (!trimmed) continue
      const preceding = out[resultIndex]
      const skillIndex = preceding && isSkillResult(preceding) ? resultIndex : -1
      const imageIndex = preceding?.result?.content?.some(part => part?.type === "image") ? resultIndex : -1
      const toolSearchIndex = preceding?.call?.name === "ToolSearch" ? resultIndex : -1
      if (message.role === "user" && skillCompanion.test(text)) {
        out = appendResultText(out, skillIndex, text)
        continue
      }
      if (message.role === "user") {
        if (extractQueuedPrompt(trimmed) !== null) {
          userSteered = true
          continue
        }
        if (nonUserSourceNotice.test(trimmed) && !/<task-notification\b/.test(trimmed)) {
          const check = trimmed.replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
          if (UNCLOSED_NOTICE_RE.test(check)) {
            throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
          }
          notices.push(trimmed)
          continue
        }
        if (imageCompanion.test(trimmed)) {
          out = appendResultText(out, imageIndex, trimmed)
          continue
        }
        if (toolLoadedCompanion.test(trimmed)) {
          out = appendResultText(out, toolSearchIndex, trimmed)
          continue
        }
        if (loopNotice.test(trimmed)) {
          notices.push(trimmed)
          continue
        }
        if (skillIndex >= 0 && /^#{1,6}\s+[^\r\n]*\b(?:skill|instructions)\b/i.test(trimmed) &&
          !isNoise(trimmed) && !PROTOCOL_NOTICE_START_RE.test(trimmed) &&
          !userInterruption.test(trimmed) && !hookOutput.test(trimmed) && !claudeMetaFeedback.test(trimmed)) {
          out = appendResultText(out, skillIndex, text)
          continue
        }
      }
      notices.push(...Array.from(text.matchAll(CONTEXT_NOTICE_RE), (match) => match[0]))
      const withoutNotices = text.replace(CONTEXT_NOTICE_RE, "")
      for (const match of withoutNotices.matchAll(SYSTEM_REMINDER_RE)) {
        const inner = match[1].trim()
        if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) {
          userSteered = true
          continue
        }
        if (!isNoise(inner)) notices.push(inner)
      }
      const rest = withoutNotices.replace(SYSTEM_REMINDER_RE, "").trim()
      if (UNCLOSED_NOTICE_RE.test(rest)) {
        throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
      }
      if (message.role === "system" || message.role === "developer") {
        if (extractQueuedPrompt(rest) !== null || userInterruption.test(rest)) {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(rest)
        }
      } else if (!isNoise(rest)) {
        if ((hookOutput.test(rest) || claudeMetaFeedback.test(rest)) && !userInterruption.test(rest)) {
          notices.push(rest)
        } else if (userSteered || stoppedByHookOrUser || notices.some((item) => hookStoppedContinuation.test(item))) {
          userSteered = true
        } else {
          throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
        }
      }
    }
  }
  const finalResults = notices.length
    ? appendResultText(out, out.length - 1, `<system-reminder>\n${notices.join("\n\n")}\n</system-reminder>`)
    : out
  return { results: finalResults, userSteered }
}

function withContextNotices(results, body) {
  return inspectToolTurn(results, body).results
}

// When a previous tool-result HTTP request failed or was aborted before producing
// an assistant message, and the user subsequently enters a new standalone user
// message after the tool_result message, replay in a fresh session instead of
// wedging the conversation with HTTP 400.
function canReplayFollowUpAfterResults(body, rawResults) {
  const { history, messages } = trailingMessages(body)
  let lastResultIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "user" && Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "tool_result")) {
      lastResultIndex = i
    }
  }
  if (lastResultIndex < 0 || lastResultIndex >= messages.length - 1) return false
  const tail = messages.slice(lastResultIndex + 1)
  if (!tail.some((message) => message.role === "user")) return false
  try {
    withContextNotices(rawResults, { ...body, messages: [...history, ...messages.slice(0, lastResultIndex + 1)] })
  } catch {
    return false
  }
  for (const message of tail) {
    const rest = messageText(message).replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
    if (UNCLOSED_NOTICE_RE.test(rest)) return false
  }
  return true
}

function namedWorkDirectory(body, init) {
  const raw = new Headers(init.headers || {}).get("x-magpie-work-dir")
  if (raw) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const firstAssistant = body.messages.findIndex((message) => message.role === "assistant")
  const opening = firstAssistant < 0 ? body.messages : body.messages.slice(0, firstAssistant)
  const texts = []
  for (const message of [{ role: "system", content: body.system }, ...opening]) {
    if (typeof message.content === "string") texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === "text") texts.push(block.text || "")
    }
  }
  let directory = null
  const pattern = /(?:Primary working directory|^\s*(?:-\s*)?Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)<\/cwd>/gm
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[2]).trim().replace(/^[`'"]+|[`'"]+$/g, "")
      if (value) directory = value
    }
  }
  return directory
}

function workDirectory(directory) {
  if (!directory) return null
  let candidate = directory
  if (process.platform === "win32" && candidate.startsWith("/")) {
    const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(candidate)
    if (!wsl) return null
    candidate = `${wsl[1].toUpperCase()}:\\${(wsl[2] || "").replace(/\//g, "\\")}`
  }
  if (!path.isAbsolute(candidate)) return null
  try {
    if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
  } catch {}
  return null
}

function ensureControlServer() {
  if (controlServerPromise) return controlServerPromise
  controlServerPromise = new Promise((resolve, reject) => {
    const server = net.createServer((socket) => handleControlConnection(socket))
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      controlServer = server
      server.unref()
      resolve(server.address().port)
    })
  })
  return controlServerPromise
}

function tokenMatches(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

function handleControlConnection(socket) {
  socket.setEncoding("utf8")
  let buffer = ""
  let handled = false
  socket.on("data", (data) => {
    if (handled) return
    buffer += data
    if (buffer.length > CONTROL_LINE_LIMIT) {
      socket.destroy()
      return
    }
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    handled = true
    let message
    try { message = JSON.parse(buffer.slice(0, newline)) } catch {
      socket.end(JSON.stringify({ error: { code: -32700, message: "invalid control JSON" } }) + "\n")
      return
    }
    const proc = sessions.get(message?.token)
    if (!proc || !tokenMatches(message.token, proc.token)) {
      socket.end(JSON.stringify({ error: { code: -32603, message: "invalid or expired bridge session" } }) + "\n")
      return
    }
    try {
      if (message.kind === "list") {
        socket.end(JSON.stringify({ result: { tools: proc.listTools() } }) + "\n")
        return
      }
      if (message.kind === "watch") {
        proc.addWatcher(socket)
        return
      }
      if (message.kind === "call") {
        proc.acceptMcpCall(message, socket)
        return
      }
      socket.end(JSON.stringify({ error: { code: -32601, message: "unknown control request" } }) + "\n")
    } catch (error) {
      socket.end(JSON.stringify({ error: { code: -32603, message: String(error?.message ?? error) } }) + "\n")
    }
  })
  socket.on("error", () => {})
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const STOP_REASONS = { end_turn: "end_turn", max_tokens: "max_tokens", max_turn_requests: "end_turn", refusal: "refusal" }

function tokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(number))) : 0
}

// ACP usage accumulates the internal model calls of one session/prompt.
// agy 1.5.1 reports inputTokens as the uncached prompt tokens; cached reads and
// writes are separate and totalTokens includes all of them (measured:
// 2133 input + 4899 cache read + 6 output = 7038 total). Some earlier builds
// folded cached reads into inputTokens. totalTokens tells the two shapes apart,
// so both report the same uncached input and cache numbers.
function promptUsage(usage) {
  const rawInput = tokenCount(usage.inputTokens)
  const cacheRead = tokenCount(usage.cachedReadTokens)
  const cacheWrite = tokenCount(usage.cachedWriteTokens)
  const output = tokenCount(usage.outputTokens)
  const thinking = tokenCount(usage.thoughtTokens)
  const total = tokenCount(usage.totalTokens)
  const inclusive = total > 0
    ? Math.abs(total - (rawInput + output + thinking)) <
      Math.abs(total - (rawInput + cacheRead + cacheWrite + output + thinking))
    : cacheRead <= rawInput
  // Prompt input excludes cache creation, which is reported separately.
  const promptInput = inclusive ? rawInput : rawInput + cacheRead
  const read = Math.min(cacheRead, promptInput)
  return {
    input: promptInput - read,
    read,
    write: cacheWrite,
    output: output + thinking,
    thinking,
    promptInput,
  }
}

function translateUsage(usage) {
  if (!usage || typeof usage !== "object") return null
  const parts = promptUsage(usage)
  return {
    input_tokens: parts.input,
    output_tokens: parts.output,
    cache_read_input_tokens: parts.read,
    cache_creation_input_tokens: parts.write,
    ...(parts.thinking > 0 ? { output_tokens_details: { thinking_tokens: parts.thinking } } : {}),
  }
}

function responseOutputEstimate(content) {
  let output = 0
  let thinking = 0
  for (const block of content) {
    if (block.type === "thinking") {
      const tokens = estimateTextTokens(block.thinking)
      thinking += tokens
      output += tokens
    } else if (block.type === "text") {
      output += estimateTextTokens(block.text)
    } else if (block.type === "tool_use") {
      output += estimateTextTokens(JSON.stringify(block))
    }
  }
  return { output: tokenCount(output), thinking: tokenCount(thinking) }
}

// Usage for one HTTP response. ACP reports one accumulated total for a whole
// session/prompt, which may span several HTTP responses (tool round-trips and
// late tool results). Reporting that total on the last response makes clients
// bill the earlier steps again, so each response settles on its own:
//   - a lone model call keeps the exact ACP numbers;
//   - tool-step responses get a non-zero estimate scaled by what earlier
//     responses taught us about this model's tokenizer and cache hit rate;
//   - the final response gets the ACP input total split by this step's share
//     of the estimated input, never above 1.5x its own estimate.
function responseUsage(proc, turn, step, content, result) {
  if (step.settled) return step.usage
  const final = result !== undefined
  const translated = final ? translateUsage(result?.usage) : null
  const single = final && result?.stopReason !== "cancelled" && !turn.calls.length &&
    !turn.toolResponseCount && !turn.hasLatePrompt && turn.promptCount <= 1 && turn.responseSteps.length === 1
  step.usageKind = single && translated ? "exact" : "bounded_step_estimate"
  if (single && translated) return translated

  const estimate = turn.stepInputEstimates[step.estimateIndex] || step.inputEstimate
  const scale = Number.isFinite(proc.inputTokenScale) ? Math.max(0.5, Math.min(1.5, proc.inputTokenScale)) : 1
  let cacheRatio = Number.isFinite(proc.lastCacheRatio) ? Math.max(0, Math.min(1, proc.lastCacheRatio)) : 0
  let input = Math.max(1, tokenCount(estimate * scale))
  let write = 0
  if (final) {
    const sum = turn.stepInputEstimates.reduce((total, value) => total + value, 0)
    const weight = estimate / Math.max(estimate, sum)
    const parts = promptUsage(result?.usage || {})
    const totalInput = parts.promptInput
    const totalWrite = parts.write
    if (totalInput + totalWrite > 0) {
      input = tokenCount(totalInput * weight)
      write = tokenCount(totalWrite * weight)
      cacheRatio = totalInput > 0 ? parts.read / totalInput : 0
    }
    // The bound applies to the full window, including cache creation. Scale
    // both portions together before rounding, then split the exact integer.
    const combined = input + write
    const bounded = Math.min(tokenCount(estimate * 1.5), combined)
    write = combined > 0 ? Math.min(bounded, tokenCount(bounded * (write / combined))) : 0
    input = bounded - write
  }
  const read = Math.min(input, tokenCount(input * cacheRatio))
  const emitted = responseOutputEstimate(content)
  const output = final
    ? Math.max(emitted.output, tokenCount((translated?.output_tokens || 0) - turn.emittedOutputTokens))
    : Math.max(1, emitted.output)
  const thinking = Math.min(output, emitted.thinking)
  return {
    input_tokens: input - read,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    output_tokens: output,
    ...(thinking > 0 ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  }
}

// agy's ACP stream carries thought summaries without the model's own signature.
// Clients keep and replay a thinking block only with a signature, so the bridge
// issues one: an HMAC over the session and text under a per-process key. It is
// not an Anthropic signature; agy keeps its own context and needs none back.
const THINKING_KEY = randomBytes(32)
const THINKING_SIGNATURE_PREFIX = "agyb1."

function thinkingSignature(sessionId, thinking) {
  return THINKING_SIGNATURE_PREFIX +
    createHmac("sha256", THINKING_KEY).update(String(sessionId) + "\n" + thinking).digest("base64url")
}

function makeAnthropicStream(proc, turn, body, msgId, signal, step = turn.registerResponse(body)) {
  const encoder = new TextEncoder()
  const responseContent = []
  const forwardThinking = FORWARD_THINKING && body.thinking?.type !== "disabled"
  let blockIndex = 0
  let open = null
  let pingTimer = null
  let finished = false
  let abortHandler = null
  // What this response has produced so far, for sizing a late prompt's input.
  step.contentSnapshot = () => [
    ...responseContent,
    ...(open ? [open.type === "text"
      ? { type: "text", text: open.text }
      : { type: "thinking", thinking: open.text }] : []),
  ]

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))
      const closeBlock = () => {
        if (!open) return
        if (open.type === "text") {
          responseContent.push({ type: "text", text: open.text })
        } else {
          const signature = thinkingSignature(proc.sessionId, open.text)
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature },
          })
          responseContent.push({ type: "thinking", thinking: open.text, signature })
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        open = null
      }
      const emitDelta = (type, text) => {
        if (!text) return
        if (open?.type !== type) {
          closeBlock()
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
          })
          open = { type, text: "" }
        }
        open.text += text
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: type === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
        })
      }
      const emitToolUse = (call) => {
        closeBlock()
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        })
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        responseContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })
      }
      const detach = () => {
        finished = true
        turn.detach()
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
        abortHandler = null
      }
      const stopMessage = (stopReason, usage, final = false, calibrate = final) => {
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage,
        })
        turn.recordResponseUsage(step, usage, final, calibrate)
        send("message_stop", { type: "message_stop" })
      }
      const partial = () => {
        const content = [...responseContent]
        if (open?.type === "text" && open.text) content.push({ type: "text", text: open.text })
        return content.filter((block) => block.type !== "thinking")
      }
      const abort = () => {
        if (finished) return
        detach()
        if (!proc.cancelTurn(turn, partial())) {
          dropFromPool(proc)
          proc.abandonTurn(turn)
          proc.stop().catch(() => {})
        }
        try { controller.error(signal?.reason || new Error("request aborted")) } catch {}
      }
      abortHandler = abort
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }

      try {
        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
        pingTimer = setInterval(() => {
          try { send("ping", { type: "ping" }) } catch {}
        }, PING_INTERVAL_MS)

        for (;;) {
          const event = await turn.next()
          if (finished) return
          if (event.type === "text") {
            emitDelta("text", event.text)
            continue
          }
          if (event.type === "thinking") {
            if (forwardThinking) emitDelta("thinking", event.text)
            continue
          }
          if (event.type === "tool") {
            emitToolUse(event.call)
            // Calls agy issued together leave in the same response.
            while (turn.events[0]?.type === "tool") emitToolUse(turn.events.shift().call)
            stopMessage("tool_use", responseUsage(proc, turn, step, responseContent))
            proc.recordAssistantResponse(turn, responseContent)
            detach()
            controller.close()
            return
          }
          if (event.type === "result") {
            closeBlock()
            turn.rawUsage = event.result.usage ?? turn.rawUsage
            const usage = responseUsage(proc, turn, step, responseContent, event.result)
            stopMessage(STOP_REASONS[event.result.stopReason] || "end_turn", usage, true, event.result.stopReason !== "cancelled")
            proc.recordAssistantResponse(turn, responseContent)
            proc.finalizeTurn(turn)
            detach()
            controller.close()
            return
          }
          if (event.type === "error") {
            closeBlock()
            send("error", {
              type: "error",
              error: { type: event.error?.kind || "api_error", message: String(event.error?.message ?? event.error) },
            })
            if (!event.error?.keepProcess) {
              dropFromPool(proc)
              await proc.stop().catch(() => {})
            }
            if (finished) return
            proc.finalizeTurn(turn)
            detach()
            controller.close()
            return
          }
        }
      } catch (error) {
        if (finished) return
        turn.fail(error)
        dropFromPool(proc)
        await proc.stop().catch(() => {})
        if (finished) return
        try {
          closeBlock()
          send("error", {
            type: "error",
            error: { type: "api_error", message: String(error?.message ?? error) },
          })
          proc.finalizeTurn(turn)
          detach()
          controller.close()
        } catch {
          proc.finalizeTurn(turn)
          detach()
          try { controller.error(error) } catch {}
        }
      }
    },
    async cancel() {
      if (finished) return
      abortHandler?.()
    },
  })
}

function estimateTextTokens(text) {
  if (!text) return 0
  let ascii = 0
  let nonAsciiBytes = 0
  const buf = Buffer.from(String(text), "utf8")
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) ascii++
    else nonAsciiBytes++
  }
  return Math.ceil(ascii / 4 + nonAsciiBytes / 3)
}

function estimateInputTokens(body) {
  let total = 0
  let images = 0
  const walk = (value) => {
    if (value == null) return
    if (typeof value === "string") {
      total += estimateTextTokens(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === "object") {
      if (value.type === "image" && value.source?.type === "base64") {
        images++
        return
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "cache_control" || key === "signature") continue
        walk(item)
      }
    }
  }
  walk(body.system)
  walk(body.messages)
  if (Array.isArray(body.tools) && body.tools.length) {
    total += estimateTextTokens(JSON.stringify(body.tools))
  }
  return Math.max(1, total + images * 1600)
}

async function jsonResponseFromStream(stream, fallbackModel, fallbackId) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let message = {
    id: fallbackId,
    type: "message",
    role: "assistant",
    model: fallbackModel,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  const blocks = new Map()
  let streamError = null

  const processBlock = (raw) => {
    let eventName = ""
    let dataLine = ""
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim()
    }
    if (!dataLine) return
    let payload
    try { payload = JSON.parse(dataLine) } catch { return }
    if (eventName === "message_start" && payload.message) {
      message = { ...message, ...payload.message, content: [] }
    } else if (eventName === "content_block_start" && payload.content_block) {
      blocks.set(payload.index, { ...payload.content_block, _json: "" })
    } else if (eventName === "content_block_delta" && payload.delta) {
      const current = blocks.get(payload.index)
      if (!current) return
      if (payload.delta.type === "text_delta") current.text = (current.text || "") + (payload.delta.text || "")
      else if (payload.delta.type === "thinking_delta") current.thinking = (current.thinking || "") + (payload.delta.thinking || "")
      else if (payload.delta.type === "signature_delta") current.signature = payload.delta.signature
      else if (payload.delta.type === "input_json_delta") current._json += payload.delta.partial_json || ""
    } else if (eventName === "content_block_stop") {
      const current = blocks.get(payload.index)
      if (!current) return
      blocks.delete(payload.index)
      if (current.type === "tool_use" && current._json) {
        try { current.input = JSON.parse(current._json) } catch {}
      }
      delete current._json
      message.content.push(current)
    } else if (eventName === "message_delta") {
      if (payload.delta?.stop_reason !== undefined) message.stop_reason = payload.delta.stop_reason
      if (payload.delta?.stop_sequence !== undefined) message.stop_sequence = payload.delta.stop_sequence
      if (payload.usage) message.usage = { ...message.usage, ...payload.usage }
    } else if (eventName === "error") {
      streamError = payload.error || { type: "api_error", message: "stream error" }
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      processBlock(frame)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) processBlock(buffer)

  if (streamError) {
    const status = streamError.type === "rate_limit_error" ? 429 : 502
    return new Response(JSON.stringify({ type: "error", error: streamError }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function streamResponse(proc, turn, body, signal) {
  turn.attach()
  const step = turn.registerResponse(body)
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24)
  const stream = makeAnthropicStream(proc, turn, body, msgId, signal, step)
  if (body.stream === false) {
    return jsonResponseFromStream(stream, body.model, msgId)
  }
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}

async function beginTurn(proc, history, body, callerWorkDir, model, selection) {
  const baseParts = proc.hasSentFirstTurn
    ? renderContinuedTurnParts(body.messages.slice(history.length))
    : renderInitialPromptParts(body, callerWorkDir, proc.instructionsInSession)
  const contentParts = mergePromptParts(baseParts, outputFormatReminder(body))
  if (promptHasImage(contentParts) && !proc.supportsImages) {
    if (!proc.hasSentFirstTurn) {
      dropFromPool(proc)
      await proc.stop().catch(() => {})
    }
    throw new UnsupportedContent("image input with this agy ACP server; update to an image-capable agy version")
  }
  return proc.startTurn(contentParts, body.messages, model, selection)
}

export const AntigravityBridgePlugin = async () => {
  const readUsage = createUsageReader(findAgy)
  return {
    auth: {
      provider: PROVIDER_ID,
      single: true,
      // Magpie's usage hook; OpenCode ignores this extension. agy owns auth.
      usage: async () => readUsage(),
      methods: [
        {
          type: "api",
          keyless: true,
          label: "Sign in with the agy CLI",
          authorize: async () => {
            const agy = findAgy()
            if (!agy) {
              return {
                type: "failed",
                error: "agy CLI not found. Install Antigravity CLI first: https://antigravity.google/docs/cli — then run `agy` once to sign in.",
              }
            }
            const probe = await execOnce(agy, ["models"], { timeoutMs: 15_000 })
            if (probe.err || probe.code !== 0 || !probe.stdout.trim()) {
              const why = probe.timedOut
                ? "timed out after 15s"
                : (probe.stderr || probe.stdout || "").trim() || probe.err?.message || "unknown error"
              return {
                type: "failed",
                error: `agy at ${agy} is not signed in (${why}). Run \`agy\` in a terminal once to sign in to your Google account, then try again.`,
              }
            }
            return { type: "success", key: "agy" }
          },
        },
      ],
      loader: async () => {
        return {
          baseURL: "agy://local",
          apiKey: "agy",
          fetch: async (fetchInput, init = {}) => {
            const requestUrl = typeof fetchInput === "string"
              ? fetchInput
              : fetchInput instanceof URL
                ? fetchInput.href
                : fetchInput?.url || ""
            if (/\/count[_-]tokens(?:$|[/?#])/i.test(requestUrl)) {
              try {
                const raw = init.body != null
                  ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
                  : (typeof fetchInput?.text === "function" ? await fetchInput.text() : "")
                const parsed = JSON.parse(raw)
                if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
                  return jsonError(400, "invalid count_tokens request")
                }
                return new Response(JSON.stringify({ input_tokens: estimateInputTokens(parsed) }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                })
              } catch (error) {
                return jsonError(400, error.message)
              }
            }

            const agy = findAgy()
            if (!agy) return jsonError(503, "agy CLI not found on this machine")
            let body
            try {
              const raw = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
              body = JSON.parse(raw)
              validateBody(body)
            } catch (error) {
              return jsonError(error.statusCode ?? 400, error.message)
            }

            const rawModel = body.model || ""
            const requestedModel = (rawModel.includes("/") ? rawModel.split("/").pop() : rawModel).replace(/\[1m\]$/i, "")
            const layout = canonicalBody(body) === body ? "hoisted" : "inline"
            body = { ...canonicalBody(body), model: requestedModel }
            const model = resolveAgyModel(await loadModelCatalog(agy), requestedModel, body)
            const selection = { model: requestedModel, effort: requestedEffort(body) }
            const convKey = conversationKey(body)
            const trailing = trailingMessages(body)
            const isFresh = trailing.history.length === 0
            const resultBlocks = extractToolResults(body)
            const callerWorkDir = namedWorkDirectory(body, init)
            const workDir = workDirectory(callerWorkDir)
            const instructions = sessionInstructions(body, callerWorkDir)

            try {
              const tools = normalizeTools(body)
              for (const message of body.messages) {
                if (message.role !== "assistant" || !Array.isArray(message.content)) continue
                for (const block of message.content) {
                  if (block?.type !== "tool_use") continue
                  const entry = toolCalls.get(block.id)
                  if (!entry || entry.call.clientSeen) continue
                  entry.call.clientSeen = true
                  entry.turn.touchClient()
                }
              }
              const acquireOpts = { model, selection, tools, workDir, instructions, history: trailing.history,
                messages: body.messages, layout, nonstream: body.stream === false }
              const begin = (proc, history) => beginTurn(proc, history, body, callerWorkDir, model, selection)
              if (resultBlocks.length) {
                const matches = matchToolResults(body, resultBlocks)
                const found = matches.filter((item) => item.match)
                if (found.length) {
                  if (found.length !== matches.length) {
                    return jsonError(409, "agy bridge: some tool results do not belong to the active response")
                  }
                  const proc = found[0].match.proc
                  const turn = found[0].match.turn
                  if (found.some((item) => item.match.proc !== proc || item.match.turn !== turn)) {
                    return jsonError(409, "agy bridge: tool results from different conversations cannot be combined")
                  }
                  if (proc.turn !== turn) return jsonError(409, "agy bridge: the tool response has already completed")
                  if (turn.attached) throw new BusyError("agy bridge: this conversation already has an active response")
                  const rawResults = matches.map(({ block, match }) => ({
                    block,
                    call: match.call,
                    result: toolResult(block),
                  }))
                  proc.validateResults(rawResults)
                  let interrupted = isInterruptedToolTurn(body)
                  let results = rawResults
                  if (!interrupted) {
                    try {
                      const inspected = inspectToolTurn(rawResults, body)
                      results = inspected.results
                      if (inspected.userSteered) interrupted = true
                    } catch (error) {
                      if (error instanceof UnsupportedContent && canReplayFollowUpAfterResults(body, rawResults)) {
                        interrupted = true
                      } else {
                        throw error
                      }
                    }
                  }
                  if (!interrupted) proc.validateResults(results)
                  const directIdsMatch = matches.every((item) => item.match?.call?.id === item.block.tool_use_id)
                  const historyMatches = directIdsMatch
                    ? proc.matchesPendingTurnHistory(turn, trailingMessages(body).history)
                    : proc.matchesHistory(trailingMessages(body).history)
                  if (interrupted || !historyMatches ||
                    proc.workDir !== workDir || !sameInstructions(proc.instructions, instructions)) {
                    // A changed context or user-interrupted tool turn needs a new
                    // session. Replay the real results without resolving the old
                    // process's calls.
                    dropFromPool(proc)
                    proc.abandonTurn(turn)
                    await proc.stop()
                  } else {
                    if (!proc.dead && !turn.done) {
                      // A changed tool catalog applies to the rest of this turn;
                      // a model change applies from the next prompt.
                      await proc.updateTools(tools)
                      proc.continueWith(results)
                      proc.recordToolResults(turn, body.messages)
                    }
                    return streamResponse(proc, turn, body, init.signal)
                  }
                }
                if (pool.get(convKey)?.turn && !pool.get(convKey).turn.cancelRequested) {
                  const proc = pool.get(convKey)
                  const recovered = await recoverStaleTurn({ agy, convKey, proc, turn: proc.turn,
                    body, resultBlocks, acquireOpts, isFresh, begin })
                  if (recovered) return streamResponse(recovered.proc, recovered.turn, body, init.signal)
                  return jsonError(409, "agy bridge: no active MCP call matches these tool results")
                }
                if (replayHistoryProblem(body, resultBlocks)) {
                  throw new ConflictError("agy bridge: incomplete tool history. Stop resending it; continue from the last self-consistent message.", "tool_history_incomplete")
                }
              }

              const { proc, history } = await acquireProc(
                agy,
                convKey,
                acquireOpts,
                isFresh,
                resultBlocks.length > 0,
              )
              const turn = await begin(proc, history)
              return streamResponse(proc, turn, body, init.signal)
            } catch (error) {
              return jsonError(error.statusCode ?? 502, error.message, error.code, error.noRetry)
            }
          },
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_ANTHROPIC,
      models: async () => {
        const agy = findAgy()
        const catalog = agy ? await loadModelCatalog(agy, true) : buildModelCatalog(FALLBACK_MODELS)
        const out = {}
        for (const model of catalog.models) {
          const imageModel = /^(?:gemini-|claude-)/.test(model.id)
          out[model.id] = {
            id: model.id,
            name: model.name,
            npm: NPM_ANTHROPIC,
            api: { id: model.id, url: "agy://local", npm: NPM_ANTHROPIC },
            capabilities: {
              ...(imageModel ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
              ...(model.variants ? { reasoning: true } : {}),
            },
            ...(model.variants ? {
              reasoning: true,
              variants: Object.fromEntries(model.variants.map(effort => [effort, {}])),
            } : {}),
          }
        }
        return out
      },
    },
  }
}

// Only permanent tool-history 400s opt out of retries. Magpie header forwarding
// has not been verified; busy responses and existing 409s retain their semantics.
function jsonError(status, message, code, noRetry = false) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: status === 400 ? "invalid_request_error" : "api_error",
        ...(code ? { code } : {}), message: String(message || "unknown error") },
    }),
    { status, headers: { "Content-Type": "application/json",
      ...(status === 400 && noRetry ? { "x-should-retry": "false" } : {}) } },
  )
}

process.once("exit", () => {
  for (const proc of allProcs) {
    try { proc.child?.kill("SIGKILL") } catch {}
    if (proc.workspace) {
      try { fs.rmSync(proc.workspace, { recursive: true, force: true }) } catch {}
    }
  }
  if (shimDir) {
    try { fs.rmSync(shimDir, { recursive: true, force: true }) } catch {}
  }
})

export default { id: PROVIDER_ID, server: AntigravityBridgePlugin }
