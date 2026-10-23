// Magpie provider plugin: Antigravity subscription bridged through a real
// `agy` CLI subprocess.
//
// Why: magpie's built-in Antigravity provider impersonates the Antigravity
// IDE's User-Agent over HTTPS to Google Code Assist. Google flags that as
// subscription abuse and bans the account. The safe path is the one
// magpie's Claude subscription bridge already uses: run the real vendor
// binary and let IT talk to the vendor. This plugin does that for
// Antigravity by holding one `agy --input-format stream-json
// --output-format stream-json` process per conversation and translating
// between Anthropic Messages and agy's stream-json protocol.
//
// Scope (intentional):
//   - Text-only. agy's stream-json input accepts text blocks alone; a
//     request carrying an image/document/tool_use block is refused with a
//     400 rather than silently dropped.
//   - Single account. agy reads exactly one Google sign-in from
//     ~/.gemini/antigravity-cli (no AGY_HOME env var; see
//     google-antigravity/antigravity-cli#155). Signing in again replaces
//     the previous one. The plugin keeps one process pool.
//   - Client-side tool execution. Client tools are advertised to agy as a
//     textual "TOOL_CALL <name> <json>" convention (agy has no separate
//     tool_use input in stream-json). agy's tool calls come back as
//     Anthropic tool_use blocks for the CLIENT to execute; the client sends
//     tool_result on the next turn, which the plugin renders back into the
//     agy conversation as text. agy itself never runs the client's tools:
//     that would require magpie's internal MCP callback channel, which is
//     private to the built-in Claude bridge.
//
// Process model (mirrors magpie's claudeRoom / subscriptionBridge):
//   - One agy process per conversation, keyed by a stable hash of the
//     system prompt, model, and first user message.
//   - A process is reused across turns of its conversation (via stdio).
//   - A request arriving while the process is busy gets a 503, not a
//     silently broken stream.
//   - A process that errors mid-turn is killed, never reused: agy's stream
//     position is unrecoverable from the bridge's side.
//   - Idle processes are reaped after IDLE_MS; the pool is bounded by
//     MAX_PROCS with LRU eviction.

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "antigravity-bridge"
const IDLE_MS = 10 * 60 * 1000
const MAX_PROCS = 4
const PROC_START_TIMEOUT_MS = 30_000
const TURN_TIMEOUT_MS = 5 * 60 * 1000
const STDERR_TAIL = 32 * 1024
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const PING_INTERVAL_MS = 15_000

// ---------------------------------------------------------------------------
// Fallback model list (used when agy is missing or `agy models` fails)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = [
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", effort: "high" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", effort: "high" },
  { id: "gemini-3.1-pro-medium", name: "Gemini 3.1 Pro (Medium)", effort: "medium" },
]

// ---------------------------------------------------------------------------
// agy discovery (negative result is NOT cached: agy may be installed later)
// ---------------------------------------------------------------------------

let cachedAgyPath // string | undefined; absence of the binary is not cached

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
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      cachedAgyPath = c
      return c
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
      return resolve({ err, stdout: "", stderr: "", code: null, timedOut: false })
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch {}
    }, opts.timeoutMs ?? 30_000)
    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })
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
    const m = /^(\S+)\s{2,}(.+)$/.exec(line)
    if (!m) continue
    const id = m[1]
    const name = m[2].trim()
    const effort = /-(high|medium|low|minimal|xhigh)$/i.exec(id)?.[1]?.toLowerCase()
    out.push({ id, name, effort })
  }
  return out.length ? out : FALLBACK_MODELS
}

// ---------------------------------------------------------------------------
// Process pool
// ---------------------------------------------------------------------------

class Proc {
  constructor(agyPath, convKey, opts) {
    this.agyPath = agyPath
    this.convKey = convKey
    this.model = opts.model
    this.conversationId = null
    this.child = null
    this.lastUsed = Date.now()
    this.dead = false
    this.deadError = null
    this.retiring = false // set synchronously by evictors before any await
    this.stderrTail = ""
    this.readline = { buf: "", waiters: [], spare: [] }
    this.turnInFlight = false
    this.hasSentFirstTurn = false
    this.reportedUsage = { input_tokens: 0, output_tokens: 0 }
  }

  async start() {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout", Math.ceil(TURN_TIMEOUT_MS / 60000) + "m",
    ]
    if (this.model) args.push("--model", this.model)
    try {
      this.child = spawn(this.agyPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      })
    } catch (err) {
      // Synchronous spawn failure (ENOMEM, E2BIG): mark dead and rethrow.
      this.#markDead(err)
      throw err
    }
    this.child.on("error", (err) => this.#markDead(err))
    this.child.on("close", (code, signal) => {
      if (!this.dead) this.#markDead(new Error(`agy exited (code=${code} signal=${signal})`))
    })
    if (this.child.stderr) {
      this.child.stderr.on("data", (d) => {
        this.stderrTail = (this.stderrTail + d.toString()).slice(-STDERR_TAIL)
      })
    }
    if (this.child.stdout) {
      this.child.stdout.on("data", (d) => this.#onStdout(d))
    }

    const initLine = await this.#readLine(PROC_START_TIMEOUT_MS)
    let init
    try { init = JSON.parse(initLine) } catch {
      throw new Error("agy's init line is not JSON: " + initLine.slice(0, 200))
    }
    if (init.event !== "init") {
      throw new Error(`agy's first event is ${init.event}, not init`)
    }
    this.conversationId = init.conversation_id
  }

  #markDead(err) {
    if (this.dead) return
    this.dead = true
    this.deadError = err
    for (const w of this.readline.waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(err)
    }
  }

  #onStdout(chunk) {
    this.readline.buf += chunk.toString()
    for (;;) {
      const nl = this.readline.buf.indexOf("\n")
      if (nl < 0) return
      const line = this.readline.buf.slice(0, nl)
      this.readline.buf = this.readline.buf.slice(nl + 1)
      const w = this.readline.waiters.shift()
      if (w) {
        clearTimeout(w.timer)
        w.resolve(line)
      } else {
        this.readline.spare.push(line)
      }
    }
  }

  #readLine(timeoutMs) {
    if (this.readline.spare.length) return Promise.resolve(this.readline.spare.shift())
    if (this.dead) return Promise.reject(this.deadError)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const i = this.readline.waiters.indexOf(waiter)
        if (i >= 0) this.readline.waiters.splice(i, 1)
        reject(new Error(
          `agy read timeout after ${timeoutMs}ms; stderr tail: ${this.stderrTail.trim() || "(empty)"}`,
        ))
      }, timeoutMs)
      this.readline.waiters.push(waiter)
    })
  }

  // sendUserMessage yields each event of one turn. On ANY error the caller
  // must kill the proc (see makeAnthropicStream's catch): agy's stream
  // position is unrecoverable, and the spare-lines buffer may hold events
  // of the dead turn that a next turn would misread as its own.
  async *sendUserMessage(content) {
    if (this.dead) throw this.deadError
    if (this.retiring) throw new Error("agy bridge: this conversation's process is being retired")
    if (this.turnInFlight) throw new Error("agy bridge: a turn is already in flight on this conversation")
    this.turnInFlight = true
    this.lastUsed = Date.now()
    try {
      const msg = JSON.stringify({ event: "user", message: { content } }) + "\n"
      if (!this.child?.stdin?.writable) throw new Error("agy's stdin is closed")
      this.child.stdin.write(msg)
      for (;;) {
        const line = await this.#readLine(TURN_TIMEOUT_MS)
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.event === "result") {
          yield { type: "result", result: ev.result }
          return
        }
        if (ev.event === "step_update") {
          yield { type: "step", step: ev.step_update }
          continue
        }
      }
    } finally {
      this.turnInFlight = false
      this.lastUsed = Date.now()
    }
  }

  async stop() {
    if (this.dead && this.child == null) return
    this.#markDead(new Error("stopped"))
    if (!this.child) return
    try { this.child.stdin?.end() } catch {}
    const alive = () => this.child.exitCode === null && this.child.signalCode === null
    if (alive()) {
      const closed = once(this.child, "close").catch(() => {})
      await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000))])
      if (alive()) {
        try { this.child.kill("SIGTERM") } catch {}
        await new Promise((r) => setTimeout(r, 2_000))
        if (alive()) {
          try { this.child.kill("SIGKILL") } catch {}
        }
      }
    }
  }
}

// Pool: Map<convKey, Proc> — single Google account (agy owns the sign-in).
const pool = new Map()

function dropFromPool(p) {
  if (pool.get(p.convKey) === p) pool.delete(p.convKey)
}

async function evictIdle() {
  const cutoff = Date.now() - IDLE_MS
  const victims = []
  for (const [k, p] of pool) {
    if (p.retiring) continue
    if (p.dead || (!p.turnInFlight && p.lastUsed < cutoff)) {
      p.retiring = true // synchronous with the check: no await in between
      victims.push([k, p])
    }
  }
  for (const [k, p] of victims) {
    if (pool.get(k) === p) pool.delete(k)
    await p.stop().catch(() => {})
  }
}

async function evictLRU() {
  let oldest = null
  for (const [k, p] of pool) {
    if (p.turnInFlight || p.retiring) continue
    if (!oldest || p.lastUsed < oldest.p.lastUsed) oldest = { k, p }
  }
  if (!oldest) return false
  oldest.p.retiring = true
  if (pool.get(oldest.k) === oldest.p) pool.delete(oldest.k)
  await oldest.p.stop().catch(() => {})
  return true
}

setInterval(() => { evictIdle().catch(() => {}) }, 60_000).unref()

class BusyError extends Error {
  constructor(msg) { super(msg); this.statusCode = 503 }
}

async function acquireProc(agyPath, convKey, opts, isFreshConversation) {
  await evictIdle()
  const existing = pool.get(convKey)
  if (existing && !existing.dead && !existing.retiring) {
    // Model is fixed at spawn; a model switch mid-conversation respawns.
    if (existing.model === opts.model) {
      // A "fresh" conversation (single message) finding a proc that already
      // ran a turn proves a key collision: two different conversations that
      // start alike. Don't join the old one — fall through to a suffix key.
      if (!(isFreshConversation && existing.hasSentFirstTurn)) {
        if (existing.turnInFlight) {
          throw new BusyError("agy bridge: this conversation's agy process is busy with a turn; send the next turn when this one ends")
        }
        return existing
      }
    }
    existing.retiring = true
    dropFromPool(existing)
    await existing.stop().catch(() => {})
  } else if (existing) {
    dropFromPool(existing)
    await existing.stop().catch(() => {})
  }
  while (pool.size >= MAX_PROCS) {
    if (!(await evictLRU())) {
      throw new BusyError(
        `agy bridge: ${MAX_PROCS} agy processes are running and all are busy; try again in a moment`,
      )
    }
  }
  const p = new Proc(agyPath, convKey, opts)
  try {
    await p.start()
  } catch (e) {
    await p.stop().catch(() => {})
    throw e
  }
  pool.set(convKey, p)
  return p
}

// ---------------------------------------------------------------------------
// Conversation key: stable across turns of one conversation, distinct for
// conversations that merely start alike (via the model and, when present,
// the client's metadata user id).
// ---------------------------------------------------------------------------

function conversationKey(body, model) {
  const sys = typeof body.system === "string" ? body.system : JSON.stringify(body.system || "")
  const first = body.messages?.[0]
  const firstText = first ? JSON.stringify(first.content) : ""
  const discrim = body.metadata?.user_id || ""
  const s = model + "\n" + discrim + "\n" + sys + "\n===\n" + firstText
  // FNV-1a over the full string (no truncation).
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// ---------------------------------------------------------------------------
// Anthropic Messages → agy content
// ---------------------------------------------------------------------------

class UnsupportedContent extends Error {
  constructor(what) {
    super(`agy bridge: ${what} is not supported by agy's stream-json input (text only)`)
    this.statusCode = 400
  }
}

function blockText(block) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object") throw new UnsupportedContent("a non-object content block")
  if (block.type === "text") return block.text || ""
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content) ? block.content.map(blockText).join("") : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "image" || block.type === "document") {
    throw new UnsupportedContent(`an image/document block`)
  }
  if (block.type === "tool_use") {
    throw new UnsupportedContent(`a tool_use block in a user message`)
  }
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

function messageText(msg) {
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) return msg.content.map(blockText).join("")
  return String(msg.content ?? "")
}

function renderAssistantTurn(msg) {
  const parts = []
  const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }]
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "tool_use") {
      parts.push(`TOOL_CALL ${block.name} ${JSON.stringify(block.input)}`)
    }
  }
  return parts.join("\n")
}

function renderInitialPrompt(body) {
  const msgs = body.messages || []
  if (msgs.length === 0) throw new Error("agy bridge: request has no messages")
  const last = msgs[msgs.length - 1]
  if (last.role !== "user") throw new Error("agy bridge: last message is not a user message")
  const history = msgs.slice(0, -1)
  const out = []
  if (body.system) {
    const sysText = typeof body.system === "string"
      ? body.system
      : body.system.map((b) => b.text || "").join("")
    if (sysText.trim()) {
      out.push(`<external_system_instructions>\n${sysText}\n</external_system_instructions>\n`)
    }
  }
  if (body.tools?.length) out.push(renderToolPreamble(body.tools))
  if (history.length) {
    out.push("<conversation_history>\n")
    for (const m of history) {
      if (m.role === "user") out.push(`Human: ${messageText(m)}\n`)
      else if (m.role === "assistant") out.push(`Assistant: ${renderAssistantTurn(m)}\n`)
    }
    out.push("</conversation_history>\n\n")
  }
  out.push("<current_turn>\n")
  out.push(messageText(last))
  out.push("\n</current_turn>")
  return out.join("")
}

function renderContinuedTurn(body) {
  const last = body.messages[body.messages.length - 1]
  if (last.role !== "user") throw new Error("agy bridge: last message is not a user message")
  // Re-send the tool preamble every turn: the client's tool list may have
  // changed since the turn the proc started on, and agy keeps no separate
  // tool registry we could update.
  const preamble = body.tools?.length ? renderToolPreamble(body.tools) + "\n" : ""
  return preamble + messageText(last)
}

function renderToolPreamble(tools) {
  const lines = []
  lines.push("You may call these tools by name. To call one, output a single line of the form:")
  lines.push("")
  lines.push("TOOL_CALL <name> <json-arguments>")
  lines.push("")
  lines.push("and nothing else on that line. Available tools:")
  for (const t of tools) {
    const schema = t.input_schema ? ` ${JSON.stringify(t.input_schema)}` : ""
    lines.push(`- ${t.name}: ${t.description || "(no description)"}${schema}`)
  }
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// agy events → Anthropic SSE
// ---------------------------------------------------------------------------

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// Leading whitespace is tolerated (models often indent inside code blocks),
// and a line whose JSON doesn't parse is passed through as text rather than
// turned into a tool call with empty arguments.
const TOOL_CALL_LINE = /^\s*TOOL_CALL\s+(\S+)\s+(\{.*\})\s*$/

function makeAnthropicStream(proc, body, msgId) {
  const encoder = new TextEncoder()
  let blockIndex = 0
  let textBlockOpen = false
  let pendingText = ""
  let anyContentSent = false
  let pingTimer = null

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))

      const openTextBlock = () => {
        if (textBlockOpen) return
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        })
        textBlockOpen = true
        anyContentSent = true
      }
      const flushPendingAsText = () => {
        if (!pendingText) return
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: pendingText },
        })
        pendingText = ""
      }
      const closeTextBlock = () => {
        if (!textBlockOpen) return
        flushPendingAsText()
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        textBlockOpen = false
      }
      const emitToolUse = (name, input) => {
        closeTextBlock()
        const id = "toolu_" + randomUUID().replace(/-/g, "").slice(0, 24)
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id, name, input: {} },
        })
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        anyContentSent = true
      }

      // Refuse a busy proc BEFORE message_start goes out: an error thrown
      // here becomes a clean HTTP error to the caller, not a truncated
      // 200 stream.
      if (proc.dead) { controller.error(proc.deadError); return }
      if (proc.retiring || proc.turnInFlight) {
        controller.error(new BusyError("agy bridge: conversation busy"))
        return
      }

      // Render BEFORE sending message_start: rendering throws
      // UnsupportedContent (400) for images etc., and that must surface as
      // an HTTP error, not a broken stream.
      let userContent
      try {
        userContent = proc.hasSentFirstTurn ? renderContinuedTurn(body) : renderInitialPrompt(body)
      } catch (e) {
        controller.error(e)
        return
      }

      let finalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
      let stopReason = "end_turn"
      let sawToolUse = false

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
        // Keepalive for long time-to-first-token.
        pingTimer = setInterval(() => {
          try { send("ping", { type: "ping" }) } catch {}
        }, PING_INTERVAL_MS)

        for await (const ev of proc.sendUserMessage(userContent)) {
          if (ev.type === "step") {
            const s = ev.step
            if (s.step_type === "agent_response" && typeof s.text_delta === "string") {
              openTextBlock()
              pendingText += s.text_delta
              for (;;) {
                const nl = pendingText.indexOf("\n")
                if (nl < 0) break
                const line = pendingText.slice(0, nl)
                const m = TOOL_CALL_LINE.exec(line)
                let input
                if (m) {
                  try { input = JSON.parse(m[2]) } catch { input = undefined }
                }
                if (m && input !== undefined) {
                  flushPendingAsText()
                  closeTextBlock()
                  emitToolUse(m[1], input)
                  sawToolUse = true
                  pendingText = pendingText.slice(nl + 1)
                } else {
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: line + "\n" },
                  })
                  pendingText = pendingText.slice(nl + 1)
                }
              }
            }
            // step_type "tool" steps are agy's OWN tools; they are not the
            // client's and are deliberately not surfaced in the reply.
            continue
          }
          if (ev.type === "result") {
            const r = ev.result
            if (r.status !== "SUCCESS") {
              throw new Error(`agy run ${r.status}: ${r.error || "(no error message)"}`)
            }
            // agy's result.usage is CUMULATIVE over the session; report only
            // this turn's delta.
            if (r.usage) {
              const cum = translateUsage(r.usage)
              finalUsage = {
                input_tokens: Math.max(0, cum.input_tokens - proc.reportedUsage.input_tokens),
                output_tokens: Math.max(0, cum.output_tokens - proc.reportedUsage.output_tokens),
                cache_read_input_tokens: cum.cache_read_input_tokens,
              }
              proc.reportedUsage = { input_tokens: cum.input_tokens, output_tokens: cum.output_tokens }
            }
            // Fallback: if agy batched the whole turn into result.response
            // (no text_deltas), use it.
            if (!anyContentSent && typeof r.response === "string" && r.response) {
              pendingText = r.response
            }
            if (pendingText || textBlockOpen) {
              openTextBlock()
              flushPendingAsText()
              closeTextBlock()
            }
            if (sawToolUse) stopReason = "tool_use"
          }
        }

        // Mark only after the turn completed without throwing.
        proc.hasSentFirstTurn = true

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: finalUsage.input_tokens,
            output_tokens: finalUsage.output_tokens,
            cache_read_input_tokens: finalUsage.cache_read_input_tokens,
          },
        })
        send("message_stop", { type: "message_stop" })
        controller.close()
      } catch (err) {
        // A failed turn leaves agy's stream position unknown: kill the proc
        // so the next request starts fresh (history is replayed on a new
        // proc's first turn by renderInitialPrompt).
        dropFromPool(proc)
        await proc.stop().catch(() => {})
        // Stop the keepalive BEFORE emitting the terminal error frame, so a
        // ping can't land after it.
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
        // If bytes already went out, the HTTP status is fixed at 200; the
        // only way to signal failure downstream is an explicit SSE error
        // frame, then close. If nothing went out yet, error the stream so
        // the caller gets an HTTP failure.
        try {
          closeTextBlock()
          send("error", {
            type: "error",
            error: { type: "api_error", message: String(err?.message ?? err) },
          })
          controller.close()
        } catch {
          try { controller.error(err) } catch {}
        }
      } finally {
        if (pingTimer) clearInterval(pingTimer)
      }
    },
    async cancel() {
      if (pingTimer) clearInterval(pingTimer)
      dropFromPool(proc)
      await proc.stop().catch(() => {})
    },
  })
}

function translateUsage(u) {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_tokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export const AntigravityBridgePlugin = async (input, options) => {
  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          // keyless tells magpie's UI to skip the API-key field entirely:
          // authorize() supplies the credential, the user just clicks
          // "Sign in". agy owns the real Google sign-in; this method only
          // verifies that agy is installed and signed in.
          keyless: true,
          label: "Sign in with the agy CLI",
          authorize: async () => {
            const agy = findAgy()
            if (!agy) {
              throw new Error(
                "agy CLI not found. Install Antigravity CLI first: https://antigravity.google/docs/cli — then run `agy` once to sign in.",
              )
            }
            // `agy models` fails fast when signed out and costs no quota.
            const probe = await execOnce(agy, ["models"], { timeoutMs: 15_000 })
            if (probe.err || probe.code !== 0 || !probe.stdout.trim()) {
              const why = probe.timedOut
                ? "timed out after 15s"
                : (probe.stderr || probe.stdout || "").trim() || probe.err?.message || "unknown error"
              throw new Error(
                `agy at ${agy} is not signed in (${why}). Run \`agy\` in a terminal once to sign in to your Google account, then try again.`,
              )
            }
            return { type: "api", key: "agy" }
          },
        },
      ],
      loader: async (getAuth) => {
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
            } catch (e) {
              return jsonError(400, "agy bridge: request body is not JSON: " + e.message)
            }

            const rawModel = body.model || ""
            const model = rawModel.includes("/") ? rawModel.split("/").pop() : rawModel

            const convKey = conversationKey(body, model)
            const isFresh = (body.messages?.length ?? 0) <= 1
            let proc
            try {
              proc = await acquireProc(agy, convKey, { model }, isFresh)
            } catch (e) {
              return jsonError(e.statusCode ?? 503, e.message)
            }

            const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24)
            const stream = makeAnthropicStream(proc, { ...body, model }, msgId)
            return new Response(stream, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              },
            })
          },
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      models: async () => {
        const agy = findAgy()
        const list = agy ? await listAgyModels(agy) : FALLBACK_MODELS
        const out = {}
        for (const m of list) {
          out[m.id] = {
            id: m.id,
            name: m.name,
            npm: NPM_ANTHROPIC,
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
      error: { type: status === 400 ? "invalid_request_error" : "api_error", message },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  )
}

export default { id: PROVIDER_ID, server: AntigravityBridgePlugin }
