import { spawn } from "node:child_process"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROVIDER_ID = "antigravity-bridge"
const MCP_SERVER_NAME = "magpie_bridge"
const MCP_SERVER_PATH = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))
const IDLE_MS = 10 * 60 * 1000
const MAX_PROCS = 4
const DEFAULT_PROC_START_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TURN_TIMEOUT_MS, 5 * 60 * 1000)
const TOOL_RESULT_TIMEOUT_MS = positiveTimeout(process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS, 30 * 60 * 1000)
const STDERR_TAIL = 32 * 1024
const CONTROL_LINE_LIMIT = 16 * 1024 * 1024
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const PING_INTERVAL_MS = 15_000

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
const allProcs = new Set()
const sessions = new Map()
const toolCalls = new Map()
let cachedAgyPath
let controlServer
let controlServerPromise

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

class Turn {
  constructor(proc) {
    this.proc = proc
    this.events = []
    this.waiters = []
    this.calls = []
    this.steps = new Map()
    this.attached = false
    this.done = false
    this.finalized = false
    this.sawTextDelta = false
    this.cleanupTimer = null
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

  complete(result) {
    if (this.done) return
    this.done = true
    this.push({ type: "result", result })
  }

  fail(error) {
    if (this.done || this.finalized) return
    this.done = true
    this.push({ type: "error", error })
    clearTimeout(this.cleanupTimer)
    this.cleanupTimer = setTimeout(() => {
      this.proc.abandonTurn(this)
    }, IDLE_MS)
    this.cleanupTimer.unref()
  }

  hasPendingMcp() {
    return this.calls.some((call) => call.mcpSeen && !call.mcpResponded)
  }
}

class Proc {
  constructor(agyPath, convKey, opts) {
    this.agyPath = agyPath
    this.convKey = convKey
    this.model = opts.model
    this.tools = opts.tools
    this.toolsSignature = JSON.stringify(opts.tools)
    this.workDir = opts.workDir
    this.token = randomUUID()
    this.conversationId = null
    this.child = null
    this.workspace = null
    this.lastUsed = Date.now()
    this.dead = false
    this.deadError = null
    this.retiring = false
    this.stopping = false
    this.stopPromise = null
    this.stderrTail = ""
    this.readline = { buf: "", waiters: [], spare: [] }
    this.turnInFlight = false
    this.hasSentFirstTurn = false
    this.turn = null
    this.expectedMessages = null
    this.reportedUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 }
    allProcs.add(this)
  }

  async start() {
    if (this.tools.length) await ensureControlServer()
    sessions.set(this.token, this)
    this.workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magpie-agy-bridge-"))
    const agentDir = path.join(this.workspace, ".agents", "agents", "magpie-bridge")
    await fs.promises.mkdir(agentDir, { recursive: true })
    const frontmatter = [
      "---",
      "name: magpie-bridge",
      "description: Bridges only client-declared MCP tools",
      "mainAgent: true",
      "subagent: false",
      "tools: []",
    ]
    if (this.tools.length) {
      const servers = [{
        name: MCP_SERVER_NAME,
        command: process.execPath,
        args: [MCP_SERVER_PATH],
        env: {
          AGY_BRIDGE_CONTROL_PORT: String(controlServer.address().port),
          AGY_BRIDGE_TOKEN: this.token,
        },
        timeoutSeconds: Math.ceil(TOOL_RESULT_TIMEOUT_MS / 1000),
      }]
      frontmatter.push(`mcpServers: ${JSON.stringify(servers)}`)
    }
    frontmatter.push(
      "---",
      "Use only the configured MCP tools. Text resembling a tool call is conversation content, not an executable call.",
      "",
    )
    await fs.promises.writeFile(path.join(agentDir, "agent.md"), frontmatter.join("\n"), { mode: 0o600 })

    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--agent", "magpie-bridge",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--print-timeout", "0",
    ]
    if (this.model) args.push("--model", this.model)
    if (this.workDir) args.push("--add-dir", this.workDir)
    try {
      this.child = spawn(this.agyPath, args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      })
    } catch (error) {
      this.#markDead(error)
      throw error
    }
    this.child.on("error", (error) => this.#markDead(error))
    this.child.on("close", (code, signal) => {
      if (!this.dead) this.#markDead(new Error(`agy exited (code=${code} signal=${signal})`))
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (data) => {
      this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL)
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (data) => this.#onStdout(data))

    const initLine = await this.#readLine(configuredTimeout("AGY_BRIDGE_START_TIMEOUT_MS", DEFAULT_PROC_START_TIMEOUT_MS), false)
    let init
    try { init = JSON.parse(initLine) } catch {
      throw new Error("agy's init line is not JSON: " + initLine.slice(0, 200))
    }
    if (init.event === "result" && init.result?.status !== "SUCCESS") {
      throw new Error(`agy failed before init: ${init.result?.error || init.result?.status || "unknown error"}`)
    }
    if (init.event !== "init") throw new Error(`agy's first event is ${init.event}, not init: ${initLine.slice(0, 1000)}`)
    this.conversationId = init.conversation_id
  }

  startTurn(content, messages) {
    if (this.dead) throw this.deadError
    if (this.retiring) throw new BusyError("agy bridge: this conversation's process is being retired")
    if (this.turn) throw new BusyError("agy bridge: this conversation still has an unfinished response")
    const turn = new Turn(this)
    this.turn = turn
    this.expectedMessages = messages.map((message) => ({ ...message }))
    this.turnInFlight = true
    this.lastUsed = Date.now()
    this.#runTurn(turn, content).catch(() => {})
    return turn
  }

  matchesHistory(messages) {
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

  async #runTurn(turn, content) {
    try {
      const message = JSON.stringify({ event: "user", message: { content } }) + "\n"
      if (!this.child?.stdin?.writable) throw new Error("agy's stdin is closed")
      this.child.stdin.write(message)
      for (;;) {
        const line = await this.#readLine(TURN_TIMEOUT_MS, true)
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch {
          throw new Error("agy emitted a non-JSON event: " + line.slice(0, 200))
        }
        if (event.event === "step_update") {
          const step = event.step_update
          if (step?.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
            turn.sawTextDelta = true
            turn.push({ type: "text", text: step.text_delta })
          } else if (step?.step_type === "tool") {
            if (step.state === "ACTIVE") this.#registerToolStep(turn, step)
            if (step.state === "DONE") this.#checkToolStep(turn, step)
          }
          continue
        }
        if (event.event === "result") {
          const result = event.result
          if (result?.status !== "SUCCESS") {
            throw new Error(`agy run ${result?.status ?? "UNKNOWN"}: ${result?.error || "(no error message)"}`)
          }
          this.hasSentFirstTurn = true
          turn.complete(result)
          return
        }
      }
    } catch (error) {
      turn.fail(error)
      dropFromPool(this)
      await this.stop().catch(() => {})
    } finally {
      this.turnInFlight = false
      this.lastUsed = Date.now()
    }
  }

  #registerToolStep(turn, step) {
    const parameters = step.tool_info?.parameters
    if (!parameters || parameters.ServerName !== MCP_SERVER_NAME) {
      throw new Error(`agy bridge: unexpected non-bridge tool ${step.tool_name || "unknown"}`)
    }
    const stepIndex = String(step.step_index)
    let call = turn.steps.get(stepIndex)
    if (!call) {
      const candidates = turn.calls.filter((item) => (
        !item.stepSeen && item.stepIndex == null && item.name === parameters.ToolName &&
        JSON.stringify(item.arguments) === JSON.stringify(parameters.Arguments ?? {})
      ))
      if (candidates.length > 1) {
        throw new Error(`agy bridge: cannot correlate parallel MCP calls for ${parameters.ToolName}`)
      }
      call = candidates[0] || this.#newCall(turn, parameters.ToolName, parameters.Arguments ?? {})
      call.stepIndex = stepIndex
      turn.steps.set(stepIndex, call)
    }
    if (call.name !== parameters.ToolName || JSON.stringify(call.arguments) !== JSON.stringify(parameters.Arguments ?? {})) {
      throw new Error(`agy bridge: MCP call does not match tool step ${stepIndex}`)
    }
    call.stepSeen = true
    this.#pairCall(turn, call)
  }

  #checkToolStep(turn, step) {
    const parameters = step.tool_info?.parameters
    if (!parameters || parameters.ServerName !== MCP_SERVER_NAME) return
    const call = turn.steps.get(String(step.step_index))
    if (!call?.ready) throw new Error(`agy bridge: MCP tool ${parameters.ToolName} finished without a client handoff`)
  }

  acceptMcpCall(message, socket) {
    const turn = this.turn
    if (!turn || turn.done || turn.finalized) throw new Error("agy bridge: no active turn for MCP call")
    const name = message.name
    if (!this.tools.some((tool) => tool.name === name)) throw new Error(`agy bridge: undeclared tool ${name}`)
    const args = message.arguments ?? {}
    const token = message.meta?.progressToken
    const indexed = typeof token === "string" ? /:(\d+)$/.exec(token)?.[1] : null
    let call
    if (indexed != null) {
      call = turn.steps.get(indexed)
      if (call && (
        call.name !== name || call.mcpSeen || JSON.stringify(call.arguments) !== JSON.stringify(args)
      )) {
        throw new Error("agy bridge: duplicate or mismatched MCP call")
      }
    }
    if (!call && indexed == null) {
      const candidates = turn.calls.filter((item) => (
        !item.mcpSeen && item.name === name && JSON.stringify(item.arguments) === JSON.stringify(args)
      ))
      if (candidates.length > 1) throw new Error(`agy bridge: ambiguous MCP call ${name}`)
      call = candidates[0]
    }
    if (!call) {
      call = this.#newCall(turn, name, args)
      if (indexed != null) {
        call.stepIndex = indexed
        turn.steps.set(indexed, call)
      }
    }
    if (call.mcpSeen) throw new Error("agy bridge: duplicate MCP call")
    call.mcpSeen = true
    call.socket = socket
    call.meta = message.meta ?? {}
    this.#refreshReadTimeouts()
    this.#pairCall(turn, call)
    socket.once("close", () => {
      if (!call.mcpResponded && !this.stopping) {
        turn.fail(new Error(`agy bridge: MCP helper disconnected during ${name}`))
        dropFromPool(this)
        this.stop().catch(() => {})
      }
    })
    return call
  }

  #newCall(turn, name, args) {
    const call = {
      id: null,
      name,
      arguments: args,
      stepIndex: null,
      stepSeen: false,
      mcpSeen: false,
      mcpResponded: false,
      ready: false,
      socket: null,
      result: null,
    }
    turn.calls.push(call)
    return call
  }

  #pairCall(turn, call) {
    if (call.ready || !call.stepSeen || !call.mcpSeen || turn.done || turn.finalized) return
    call.ready = true
    call.id = "toolu_" + randomUUID().replace(/-/g, "").slice(0, 24)
    toolCalls.set(call.id, { proc: this, turn, call })
    turn.push({ type: "tool", call })
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
      if (call.mcpResponded || !call.ready || turn.done) continue
      call.result = result
      this.#respondMcp(call, { result })
      this.#refreshReadTimeouts()
    }
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
    for (const waiter of turn.waiters.splice(0)) {
      waiter.reject(new Error("agy bridge: response closed"))
    }
    clearTimeout(turn.cleanupTimer)
    for (const call of turn.calls) {
      if (call.id && toolCalls.get(call.id)?.call === call) toolCalls.delete(call.id)
      if (call.mcpSeen && !call.mcpResponded) {
        this.#respondMcp(call, { error: { code: -32603, message: "agy bridge: response closed before the tool result arrived" } })
      }
    }
    if (this.turn === turn) this.turn = null
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
    for (const waiter of this.readline.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  #onStdout(chunk) {
    this.readline.buf += chunk
    for (;;) {
      const newline = this.readline.buf.indexOf("\n")
      if (newline < 0) return
      const line = this.readline.buf.slice(0, newline)
      this.readline.buf = this.readline.buf.slice(newline + 1)
      const waiter = this.readline.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(line)
      } else {
        this.readline.spare.push(line)
      }
    }
  }

  #readLine(timeoutMs, dynamic) {
    if (this.readline.spare.length) return Promise.resolve(this.readline.spare.shift())
    if (this.dead) return Promise.reject(this.deadError)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timeoutMs, dynamic, timer: null }
      this.readline.waiters.push(waiter)
      this.#armReadWaiter(waiter)
    })
  }

  #armReadWaiter(waiter) {
    clearTimeout(waiter.timer)
    const waitingForTools = waiter.dynamic && this.turn?.hasPendingMcp()
    const timeout = waitingForTools ? TOOL_RESULT_TIMEOUT_MS : waiter.timeoutMs
    waiter.timer = setTimeout(() => {
      const index = this.readline.waiters.indexOf(waiter)
      if (index >= 0) this.readline.waiters.splice(index, 1)
      const what = waitingForTools ? "waiting for a client tool result" : "reading agy output"
      waiter.reject(new Error(
        `agy bridge: timed out ${what} after ${timeout}ms; stderr tail: ${this.stderrTail.trim() || "(empty)"}`,
      ))
    }, timeout)
  }

  #refreshReadTimeouts() {
    for (const waiter of this.readline.waiters) {
      if (waiter.dynamic) this.#armReadWaiter(waiter)
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.#stop()
    return this.stopPromise
  }

  async #stop() {
    this.stopping = true
    this.#markDead(new Error("stopped"))
    this.turn?.fail(new Error("stopped"))
    sessions.delete(this.token)
    if (this.turn) {
      for (const call of this.turn.calls) {
        if (call.mcpSeen && !call.mcpResponded) {
          this.#respondMcp(call, { error: { code: -32603, message: "agy bridge: process stopped" } })
        }
      }
    }
    const child = this.child
    if (child) {
      try { child.stdin?.end() } catch {}
      const alive = () => child.exitCode === null && child.signalCode === null
      if (alive()) {
        const closed = once(child, "close").catch(() => {})
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))])
        if (alive()) {
          try { child.kill("SIGTERM") } catch {}
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))])
          if (alive()) {
            try { child.kill("SIGKILL") } catch {}
            await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))])
          }
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

function dropFromPool(proc) {
  if (pool.get(proc.convKey) === proc) pool.delete(proc.convKey)
}

async function evictIdle() {
  const cutoff = Date.now() - IDLE_MS
  const victims = []
  for (const [key, proc] of pool) {
    if (proc.retiring) continue
    if (proc.dead || (!proc.turn && proc.lastUsed < cutoff)) {
      proc.retiring = true
      victims.push([key, proc])
    }
  }
  for (const [key, proc] of victims) {
    if (pool.get(key) === proc) pool.delete(key)
    await proc.stop().catch(() => {})
  }
}

async function evictLRU() {
  let oldest = null
  for (const [key, proc] of pool) {
    if (proc.turn || proc.retiring) continue
    if (!oldest || proc.lastUsed < oldest.proc.lastUsed) oldest = { key, proc }
  }
  if (!oldest) return false
  oldest.proc.retiring = true
  dropFromPool(oldest.proc)
  await oldest.proc.stop().catch(() => {})
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
    if (existing) {
      if (!existing.dead && existing.turn) {
        throw new BusyError("agy bridge: this conversation still has an unfinished response")
      }
      const compatible = !forceNew && !existing.dead && !existing.retiring &&
        existing.model === opts.model && existing.toolsSignature === JSON.stringify(opts.tools) &&
        existing.workDir === opts.workDir && existing.matchesHistory(opts.history)
      if (compatible && !(isFreshConversation && existing.hasSentFirstTurn)) return existing
      existing.retiring = true
      dropFromPool(existing)
      await existing.stop().catch(() => {})
    }
    while (allProcs.size >= MAX_PROCS) {
      if (!(await evictLRU())) {
        throw new BusyError(`agy bridge: ${MAX_PROCS} agy processes are running and all have unfinished responses`)
      }
    }
    const proc = new Proc(agyPath, convKey, opts)
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

function matchToolResults(body, model, blocks) {
  const direct = blocks.map(block => ({ block, match: toolCalls.get(block.tool_use_id) }))
  if (direct.some(item => item.match)) return direct
  const { history } = trailingMessages(body)
  const calls = lastAssistantCalls(history)
  const byID = new Map(calls.map((call, index) => [call.id, index]))
  if (!calls.length || byID.size !== calls.length || calls.some(call => !call.id) ||
    blocks.some(block => !byID.has(block.tool_use_id))) return direct
  let found = null
  for (const proc of allProcs) {
    if (!proc.turn || proc.turn.finalized || proc.model !== model || !proc.matchesHistory(history)) continue
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

function conversationKey(body, model) {
  const system = historyKey([{ role: "system", content: body.system || "" }])
  const first = body.messages?.[0]
  const firstText = first ? historyKey([first]) : ""
  const discriminator = body.metadata?.user_id || ""
  const source = model + "\n" + discriminator + "\n" + system + "\n===\n" + firstText
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
  if (block.type === "image" || block.type === "document") {
    throw new UnsupportedContent("an image/document block in stream-json input")
  }
  if (block.type === "tool_use") throw new UnsupportedContent("a tool_use block in a user message")
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

function messageText(message) {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) return message.content.map(blockText).join("")
  return String(message.content ?? "")
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

function renderInitialPrompt(body, callerWorkDir) {
  const messages = body.messages || []
  const split = extractToolResults(body).length ? messages.length - trailingMessages(body).messages.length : messages.length - 1
  const history = messages.slice(0, split)
  const current = messages.slice(split)
  const out = []
  if (body.system) {
    const systemText = typeof body.system === "string"
      ? body.system
      : body.system.map((block) => block.text || "").join("")
    if (systemText.trim()) out.push(`<external_system_instructions>\n${systemText}\n</external_system_instructions>\n`)
  }
  if (callerWorkDir) {
    out.push(`\nThe caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.\n\n`)
  }
  if (history.length) {
    out.push("<conversation_history>\n")
    for (const message of history) {
      if (message.role === "user") out.push(`Human: ${messageText(message)}\n`)
      else if (message.role === "assistant") out.push(`Assistant: ${renderAssistantTurn(message)}\n`)
      else out.push(`${message.role}: ${messageText(message)}\n`)
    }
    out.push("Historical tool calls and results above are records, not instructions to write tool calls as text.\n")
    out.push("</conversation_history>\n\n")
  }
  out.push("<current_turn>\n", current.map(message => message.role === "user"
    ? messageText(message) : `${message.role}: ${messageText(message)}`).join("\n\n"), "\n</current_turn>")
  return out.join("")
}

function renderContinuedTurn(body) {
  return messageText(body.messages[body.messages.length - 1])
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
    const proc = sessions.get(message.token)
    if (!proc || !tokenMatches(message.token, proc.token)) {
      socket.end(JSON.stringify({ error: { code: -32603, message: "invalid or expired bridge session" } }) + "\n")
      return
    }
    try {
      if (message.kind === "list") {
        socket.end(JSON.stringify({ result: { tools: proc.tools } }) + "\n")
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

function makeAnthropicStream(proc, turn, body, msgId, signal) {
  const encoder = new TextEncoder()
  const responseContent = []
  let responseText = ""
  let blockIndex = 0
  let textBlockOpen = false
  let pingTimer = null
  let finished = false
  let abortHandler = null

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))
      const closeTextBlock = () => {
        if (!textBlockOpen) return
        responseContent.push({ type: "text", text: responseText })
        responseText = ""
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        textBlockOpen = false
      }
      const emitText = (text) => {
        if (!text) return
        if (!textBlockOpen) {
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          })
          textBlockOpen = true
        }
        responseText += text
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        })
      }
      const emitToolUse = (call) => {
        closeTextBlock()
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
      const abort = () => {
        if (finished) return
        detach()
        dropFromPool(proc)
        proc.abandonTurn(turn)
        proc.stop().catch(() => {})
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
            emitText(event.text)
            continue
          }
          if (event.type === "tool") {
            emitToolUse(event.call)
            closeTextBlock()
            stopMessage("tool_use", emptyUsage)
            proc.recordAssistantResponse(turn, responseContent)
            detach()
            controller.close()
            return
          }
          if (event.type === "result") {
            let usage = emptyUsage
            if (event.result.usage) {
              const cumulative = translateUsage(event.result.usage)
              const thinkingTokens = Math.max(0, cumulative.thinking_tokens - proc.reportedUsage.thinking_tokens)
              usage = {
                input_tokens: Math.max(0, cumulative.input_tokens - proc.reportedUsage.input_tokens),
                output_tokens: Math.max(0, cumulative.output_tokens - proc.reportedUsage.output_tokens),
                cache_read_input_tokens: cumulative.cache_read_input_tokens,
                ...(thinkingTokens > 0 ? { output_tokens_details: { thinking_tokens: thinkingTokens } } : {}),
              }
              proc.reportedUsage = {
                input_tokens: cumulative.input_tokens,
                output_tokens: cumulative.output_tokens,
                thinking_tokens: cumulative.thinking_tokens,
              }
            }
            if (!turn.sawTextDelta && typeof event.result.response === "string") emitText(event.result.response)
            closeTextBlock()
            stopMessage("end_turn", usage)
            proc.recordAssistantResponse(turn, responseContent)
            proc.finalizeTurn(turn)
            detach()
            controller.close()
            return
          }
          if (event.type === "error") {
            closeTextBlock()
            send("error", {
              type: "error",
              error: { type: "api_error", message: String(event.error?.message ?? event.error) },
            })
            dropFromPool(proc)
            await proc.stop().catch(() => {})
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
          closeTextBlock()
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
      finished = true
      turn.detach()
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
      abortHandler = null
      dropFromPool(proc)
      proc.abandonTurn(turn)
      await proc.stop().catch(() => {})
    },
  })
}

function translateUsage(usage) {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    thinking_tokens: usage.thinking_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_tokens ?? 0,
  }
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
  return {
    auth: {
      provider: PROVIDER_ID,
      single: true,
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
            const convKey = conversationKey(body, model)
            const isFresh = body.messages.length <= 1
            const resultBlocks = extractToolResults(body)
            const callerWorkDir = namedWorkDirectory(body, init)
            const workDir = workDirectory(callerWorkDir)

            try {
              const tools = normalizeTools(body)
              if (resultBlocks.length) {
                const matches = matchToolResults(body, model, resultBlocks)
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
                  if (!proc.matchesHistory(trailingMessages(body).history) || proc.model !== model ||
                    proc.toolsSignature !== JSON.stringify(tools) || proc.workDir !== workDir) {
                    // A changed context/configuration needs a new process. Replay
                    // the real results without resolving the old process's calls.
                    dropFromPool(proc)
                    proc.abandonTurn(turn)
                    await proc.stop()
                  } else {
                    if (!proc.dead && !turn.done) {
                      proc.continueWith(results)
                      proc.recordToolResults(turn, body.messages)
                    }
                    return streamResponse(proc, turn, body, init.signal)
                  }
                }
                if (pool.get(convKey)?.turn) {
                  return jsonError(409, "agy bridge: no active MCP call matches these tool results")
                }
              }

              const proc = await acquireProc(
                agy,
                convKey,
                { model, tools, workDir, history: body.messages.slice(0, -1) },
                isFresh,
                resultBlocks.length > 0,
              )
              const content = proc.hasSentFirstTurn ? renderContinuedTurn(body) : renderInitialPrompt(body, callerWorkDir)
              const turn = proc.startTurn(content, body.messages)
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
          out[model.id] = {
            id: model.id,
            name: model.name,
            npm: NPM_ANTHROPIC,
            api: { id: model.id, url: "agy://local", npm: NPM_ANTHROPIC },
            ...(model.variants ? {
              reasoning: true,
              capabilities: { reasoning: true },
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
})

export default { id: PROVIDER_ID, server: AntigravityBridgePlugin }
