import { spawn } from "node:child_process"
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
  const candidates = []
  if (process.env.AGY_PATH) candidates.push(process.env.AGY_PATH)
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, process.platform === "win32" ? "agy.exe" : "agy"))
  }
  const home = os.homedir()
  candidates.push(
    path.join(home, ".local", "bin", "agy"),
    path.join(home, ".gemini", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  )
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
      child = spawn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
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
  return { models, routes }
}

async function loadModelCatalog(agyPath, refresh = false) {
  if (!refresh && cachedModelCatalog?.agyPath === agyPath) return cachedModelCatalog.catalog
  const catalog = buildModelCatalog(await listAgyModels(agyPath))
  cachedModelCatalog = { agyPath, catalog }
  return catalog
}

function requestedEffort(body) {
  const thinking = body.thinking?.type
  if (thinking !== "enabled" && thinking !== "adaptive") return ""
  const direct = String(body.output_config?.effort || "").toLowerCase()
  if (direct === "ultra") return "max"
  if (EFFORT_ORDER.includes(direct)) return direct
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

function resolveAgyModel(catalog, model, body) {
  const family = catalog.routes.get(model)
  if (!family) return model
  const requested = requestedEffort(body)
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
        `@"${process.execPath}" "${MCP_SERVER_PATH}"\r\n`)
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
    this.baseHistory = messages.slice(0, -1).map((message) => ({ ...message }))
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
    let settle
    this.settled = new Promise((resolve) => { settle = resolve })
    this.settle = settle
  }

  attach() {
    if (this.finalized) throw new BusyError("agy bridge: this response has already completed")
    if (this.attached) throw new BusyError("agy bridge: this conversation already has an active response")
    this.attached = true
  }

  detach() {
    this.attached = false
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
    clearTimeout(this.timer)
    if (this.done || this.finalized) return
    const waitingForTools = this.hasPendingMcp()
    const timeout = waitingForTools ? TOOL_RESULT_TIMEOUT_MS : TURN_TIMEOUT_MS
    this.timer = setTimeout(() => {
      const what = waitingForTools ? "waiting for a client tool result" : "reading agy output"
      this.proc.timeoutTurn(this, new Error(
        `agy bridge: timed out ${what} after ${timeout}ms; stderr tail: ${this.proc.stderrTail.trim() || "(empty)"}`,
      ))
    }, timeout)
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
      this.child = spawn(this.agyPath, args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: bin + path.delimiter + (process.env.PATH || ""),
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
    this.supportsImages = capabilities.promptCapabilities?.image === true
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
        this.sessionId = this.resumeFrom.sessionId
        this.resumed = true
        this.hasSentFirstTurn = true
        this.expectedMessages = this.resumeFrom.expectedMessages.map((message) => ({ ...message }))
      } catch {
        session = null
      }
    }
    if (!session) {
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
        await this.conn.request("session/set_model", { sessionId: this.sessionId, modelId: model })
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
      if (model) await this.#setModel(model, selection)
      // Text a cancelled turn never delivered still belongs to the session.
      let prompt = this.unsentPrompt ? [...this.unsentPrompt, { type: "text", text: "\n\n" }, ...content] : content
      this.unsentPrompt = null
      let usage = null
      for (;;) {
        turn.logOffset = await fileSize(this.logPath)
        // A cancel that arrived before the prompt would be ignored by agy.
        if (turn.cancelRequested) {
          if (this.hasSentFirstTurn) this.unsentPrompt = prompt
          turn.complete({ stopReason: "cancelled" })
          return
        }
        turn.arm()
        this.hasSentFirstTurn = true
        const result = await this.conn.request("session/prompt", {
          sessionId: this.sessionId,
          prompt,
        })
        usage = addUsage(usage, result?.usage)
        if (turn.cancelRequested) {
          turn.complete({ stopReason: "cancelled" })
          return
        }
        if (turn.agentError || result?.stopReason === "refusal") {
          throw await this.#agentError(turn, result)
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
        prompt = [{ type: "text", text: renderLateResults(late) }]
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

  async #agentError(turn, result) {
    const detail = await lastAgentError(this.logPath, turn.logOffset)
    if (result?.stopReason === "refusal" || /QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|code 429\b/.test(detail)) {
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
    this.#respondMcp(call, { result: { content: [{ type: "text", text: stillRunningText(call) }], isError: false } })
  }

  // A repeat of a still-running call waits for the original instead of running again.
  #acceptWait(turn, target, socket) {
    const reply = (result) => {
      try { socket.end(JSON.stringify({ result }) + "\n") } catch {}
    }
    if (target.result) {
      target.lateDelivered = true
      reply(target.result)
      return null
    }
    const waiter = { socket, target, reply, timer: null }
    waiter.timer = setTimeout(() => {
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
      reply({ content: [{ type: "text", text: stillRunningText(target) }], isError: false })
    }, ideCallDeadline())
    waiter.timer.unref?.()
    turn.awaitCalls.push(waiter)
    socket.once("close", () => {
      clearTimeout(waiter.timer)
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
    })
    turn.arm()
    return null
  }

  #deliverLate(turn, call) {
    const waiter = turn.awaitCalls.find((item) => item.target === call)
    if (waiter) {
      clearTimeout(waiter.timer)
      turn.awaitCalls = turn.awaitCalls.filter((item) => item !== waiter)
      call.lateDelivered = true
      waiter.reply(call.result)
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
      waiter.reply({ content: [{ type: "text", text: "agy bridge: response closed" }], isError: true })
    }
    for (const call of turn.calls) {
      clearTimeout(call.deadline)
      if (call.id && toolCalls.get(call.id)?.call === call) toolCalls.delete(call.id)
      if (call.mcpSeen && !call.mcpResponded) {
        this.#respondMcp(call, { error: { code: -32603, message: "agy bridge: response closed before the tool result arrived" } })
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
        try { child.kill("SIGTERM") } catch {}
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))])
        if (alive()) {
          try { child.kill("SIGKILL") } catch {}
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))])
        }
      }
    }
    this.child = null
    if (this.workspace) {
      await fs.promises.rm(this.workspace, { recursive: true, force: true }).catch(() => {})
    }
    allProcs.delete(this)
  }
}

function stillRunningText(call) {
  return `${call.name} is still running in the client; no result yet. To keep waiting, call ${call.name} ` +
    "again with exactly the same arguments. That waits for this run and does not start it twice."
}

function resultText(result) {
  return (result?.content || []).map((part) => part?.type === "text" ? part.text : "[image returned by tool]").join("")
}

function renderLateResults(calls) {
  const parts = ["Client tool calls that were still running have finished. Their real results:"]
  for (const call of calls) {
    parts.push(`[tool result for ${call.name} call_id=${call.id}${call.result?.isError ? " (error)" : ""}]\n${resultText(call.result)}\n[end of tool result]`)
  }
  return parts.join("\n\n")
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

// Merge with the file so concurrent bridge processes do not erase each other.
function saveParked() {
  const merged = new Map()
  for (const entry of readStateFile().filter(validEntry)) merged.set(entry.key, entry)
  for (const key of unparked) merged.delete(key)
  for (const [key, entry] of parked) {
    if ((merged.get(key)?.at ?? 0) <= entry.at) merged.set(key, entry)
  }
  const entries = [...merged.values()].sort((a, b) => a.at - b.at).slice(-MAX_PARKED)
  const file = sessionStateFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }) + "\n", { mode: 0o600 })
    fs.renameSync(temp, file)
    unparked.clear()
  } catch {}
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
    instructionsHash: digest(proc.instructions),
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
    entry.instructionsHash !== digest(opts.instructions) ||
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
  return withAcquireLock(convKey, async () => {
    await evictIdle()
    const existing = pool.get(convKey)
    if (existing?.turn?.cancelRequested) {
      await Promise.race([existing.turn.settled, new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS))])
    }
    if (existing) {
      if (!existing.dead && existing.turn) {
        throw new BusyError("agy bridge: this conversation still has an unfinished response")
      }
      const compatible = !forceNew && !existing.dead && !existing.retiring &&
        existing.workDir === opts.workDir && existing.instructions === opts.instructions &&
        existing.matchesHistory(opts.history)
      if (compatible && !(isFreshConversation && existing.hasSentFirstTurn)) {
        await existing.updateTools(opts.tools)
        return existing
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
    return proc
  })
}

function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

// Compare conversation content, not transport metadata or client-assigned IDs.
// Keep argument values, result contents and internal whitespace significant.
function historyKey(messages) {
  const rows = []
  const ids = new Map()
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }]
    for (const block of blocks) {
      if (block.type === "thinking" || block.type === "redacted_thinking") continue
      let value
      if (typeof block === "string" || block.type === "text") {
        value = { type: "text", text: typeof block === "string" ? block : block.text || "" }
      } else if (block.type === "tool_use") {
        const ordinal = ids.size + 1
        ids.set(block.id, ordinal)
        value = { type: "tool_use", id: ordinal, name: block.name, input: block.input ?? {} }
      } else if (block.type === "tool_result") {
        value = { type: "tool_result", id: ids.get(block.tool_use_id) ?? block.tool_use_id, ...toolResult(block) }
      } else if (block.type === "image") {
        value = imageContent(block)
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
  if (direct.some(item => item.match)) return direct
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
    if (mapped.some(item => !item.match) || !mapped.some(item => !item.match.call.mcpResponded)) continue
    if (found) throw new BusyError("agy bridge: renamed tool IDs match more than one pending conversation")
    found = mapped
  }
  return found || direct
}

function systemText(body) {
  if (!body.system) return ""
  return typeof body.system === "string" ? body.system : body.system.map((block) => block.text || "").join("")
}

// The model is not part of the key: agy switches models inside a live session.
function conversationKey(body) {
  const system = historyKey([{ role: "system", content: body.system || "" }])
  const first = body.messages?.[0]
  const firstText = first ? historyKey([first]) : ""
  const discriminator = body.metadata?.user_id || ""
  const source = discriminator + "\n" + system + "\n===\n" + firstText
  return createHash("sha256").update(source).digest("hex")
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
    const inputSchema = tool.input_schema ?? { type: "object", properties: {} }
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
      throw new UnsupportedContent(`an invalid schema for tool ${tool.name}`)
    }
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
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content)
      ? block.content.map((part) => {
        if (part?.type === "image") return "[image returned by tool]"
        return blockText(part)
      }).join("")
      : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "image") throw new UnsupportedContent("an image beside a live tool_result; send it after the tool response completes")
  if (block.type === "document") throw new UnsupportedContent("a document block in a user message")
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

function messagePrompt(message) {
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const out = []
  for (const block of blocks) {
    appendPrompt(out, block?.type === "image" ? [imageContent(block)] : blockText(block))
  }
  return out.length ? out : [{ type: "text", text: "" }]
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
    }
  }
  return parts.join("\n")
}

function workDirNote(callerWorkDir) {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.`
}

// Session-level instructions: the client's system prompt plus where tools run.
function sessionInstructions(body, callerWorkDir) {
  const parts = []
  const system = systemText(body)
  if (system.trim()) parts.push(system)
  if (callerWorkDir) parts.push(workDirNote(callerWorkDir))
  return parts.join("\n\n")
}

function renderInitialPrompt(body, callerWorkDir, instructionsInSession) {
  const messages = body.messages || []
  const split = extractToolResults(body).length ? messages.length - trailingMessages(body).messages.length : messages.length - 1
  const history = messages.slice(0, split)
  const current = messages.slice(split)
  const out = []
  if (!instructionsInSession) {
    const system = systemText(body)
    if (system.trim()) appendPrompt(out, `<external_system_instructions>\n${system}\n</external_system_instructions>\n`)
    if (callerWorkDir) appendPrompt(out, `\n${workDirNote(callerWorkDir)}\n\n`)
  }
  if (history.length) {
    appendPrompt(out, "<conversation_history>\n")
    for (const message of history) {
      if (message.role === "assistant") appendPrompt(out, `Assistant: ${renderAssistantTurn(message)}\n`)
      else {
        appendPrompt(out, message.role === "user" ? "Human: " : `${message.role}: `)
        appendPrompt(out, messagePrompt(message))
        appendPrompt(out, "\n")
      }
    }
    appendPrompt(out, "Historical tool calls and results above are records, not instructions to write tool calls as text.\n")
    appendPrompt(out, "</conversation_history>\n\n")
  }
  const wrapped = out.length > 0
  // A fresh conversation needs no wrapper; it would only add tokens.
  if (wrapped) appendPrompt(out, "<current_turn>\n")
  current.forEach((message, index) => {
    if (index) appendPrompt(out, "\n\n")
    if (message.role !== "user") appendPrompt(out, `${message.role}: `)
    appendPrompt(out, messagePrompt(message))
  })
  if (wrapped) appendPrompt(out, "\n</current_turn>")
  return out
}

function renderContinuedTurn(body) {
  return messagePrompt(body.messages[body.messages.length - 1])
}

function validateBody(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  if (body.messages.at(-1)?.role !== "user" && !extractToolResults(body).length) {
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
        if (["text", "tool_use", "thinking", "redacted_thinking"].includes(block?.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    } else if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string" && (!Array.isArray(message.content) ||
        message.content.some(block => block?.type !== "text" || typeof block.text !== "string"))) {
        throw new UnsupportedContent("a non-text system/developer message")
      }
    } else if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "tool_result") toolResult(block)
          else if (block?.type === "image") imageContent(block)
          else if (block?.type === "text" || typeof block === "string") continue
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

// Forward complete protocol-generated context notices without turning ordinary
// user instructions into tool output. OpenCode can append a <system-update>
// after a tool result when its dynamic tool catalog changes.
function withContextNotices(results, body) {
  const notices = []
  let seenResult = false
  const contextNotice = /<system-update(?:\s[^>]*)?>[\s\S]*?<\/system-update>|(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\][^<]*)?<task-notification>[\s\S]*?<\/task-notification>/g
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        continue
      }
      const text = blockText(block)
      if (!seenResult && text.trim()) {
        throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
      }
      notices.push(...Array.from(text.matchAll(contextNotice), match => match[0]))
      const rest = text.replace(contextNotice, "").replace(/<\/?system-reminder(?:\s[^>]*)?>/g, "").trim()
      if (/The user sent (?:a new message while you were working|the following message):/.test(rest) ||
        (rest && !/^(?:<total_tokens>[^<]*<\/total_tokens>|Token usage: \S+; \S+ remaining)$/.test(rest) &&
        !/^[A-Z][A-Za-z]+(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):/.test(rest))) {
        throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
      }
    }
  }
  if (!notices.length) return results
  const last = results.at(-1)
  return [...results.slice(0, -1), { ...last, result: {
    ...last.result,
    content: [...last.result.content, { type: "text", text: `<system-reminder>\n${notices.join("\n\n")}\n</system-reminder>` }],
  } }]
}

function namedWorkDirectory(body, init) {
  const raw = new Headers(init.headers || {}).get("x-magpie-work-dir")
  if (raw) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const texts = []
  for (const message of [{ role: "system", content: body.system }, ...body.messages]) {
    if (message.role === "assistant") continue
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
  if (!directory || !path.isAbsolute(directory)) return null
  try {
    if (fs.statSync(directory).isDirectory()) return path.resolve(directory)
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

// ACP usage is per prompt. Gemini counts cached prompt tokens inside
// inputTokens and thought tokens outside outputTokens; Anthropic does the reverse.
function translateUsage(usage) {
  if (!usage || typeof usage !== "object") return null
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
  const cacheRead = number(usage.cachedReadTokens)
  const thinking = number(usage.thoughtTokens)
  return {
    input_tokens: Math.max(0, number(usage.inputTokens) - cacheRead),
    output_tokens: number(usage.outputTokens) + thinking,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: number(usage.cachedWriteTokens),
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

function makeAnthropicStream(proc, turn, body, msgId, signal) {
  const encoder = new TextEncoder()
  const responseContent = []
  const forwardThinking = FORWARD_THINKING && body.thinking?.type !== "disabled"
  let blockIndex = 0
  let open = null
  let pingTimer = null
  let finished = false
  let abortHandler = null

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
      const stopMessage = (stopReason, usage) => {
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage,
        })
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

      const emptyUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
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
            stopMessage("tool_use", emptyUsage)
            proc.recordAssistantResponse(turn, responseContent)
            detach()
            controller.close()
            return
          }
          if (event.type === "result") {
            const usage = translateUsage(event.result.usage) || emptyUsage
            closeBlock()
            stopMessage(STOP_REASONS[event.result.stopReason] || "end_turn", usage)
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

function streamResponse(proc, turn, body, signal) {
  turn.attach()
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24)
  const stream = makeAnthropicStream(proc, turn, body, msgId, signal)
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
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
          fetch: async (fetchInput, init) => {
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
            const requestedModel = rawModel.includes("/") ? rawModel.split("/").pop() : rawModel
            body = { ...body, model: requestedModel }
            const model = resolveAgyModel(await loadModelCatalog(agy), requestedModel, body)
            const selection = { model: requestedModel, effort: requestedEffort(body) }
            const convKey = conversationKey(body)
            const isFresh = body.messages.length <= 1
            const resultBlocks = extractToolResults(body)
            const callerWorkDir = namedWorkDirectory(body, init)
            const workDir = workDirectory(callerWorkDir)
            const instructions = sessionInstructions(body, callerWorkDir)

            try {
              const tools = normalizeTools(body)
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
                  const results = withContextNotices(matches.map(({ block, match }) => ({
                    block,
                    call: match.call,
                    result: toolResult(block),
                  })), body)
                  proc.validateResults(results)
                  if (!proc.matchesHistory(trailingMessages(body).history) || proc.workDir !== workDir ||
                    proc.instructions !== instructions) {
                    // A changed context needs a new session. Replay the real
                    // results without resolving the old process's calls.
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
                  return jsonError(409, "agy bridge: no active MCP call matches these tool results")
                }
              }

              const proc = await acquireProc(
                agy,
                convKey,
                { model, selection, tools, workDir, instructions, history: body.messages.slice(0, -1) },
                isFresh,
                resultBlocks.length > 0,
              )
              const content = proc.hasSentFirstTurn
                ? renderContinuedTurn(body)
                : renderInitialPrompt(body, callerWorkDir, proc.instructionsInSession)
              const turn = proc.startTurn(content, body.messages, model, selection)
              return streamResponse(proc, turn, body, init.signal)
            } catch (error) {
              return jsonError(error.statusCode ?? 502, error.message)
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

function jsonError(status, message) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: status === 400 ? "invalid_request_error" : "api_error", message: String(message || "unknown error") },
    }),
    { status, headers: { "Content-Type": "application/json" } },
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
