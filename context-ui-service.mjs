// Loopback service behind the "Antigravity Bridge context" page in Magpie.
//
// Magpie opens ui/context-page.html (sandboxed, no network), which navigates
// its own frame here: through magpie.service in `magpie web`, or directly to
// 127.0.0.1:<contextPort> in the desktop window. The HTML carries a per-process
// capability; every API call must present it, so only a page that was able to
// *navigate* here (never read it cross-origin) can act. All hashing and patching
// runs in a bounded worker thread (context-ui-task.mjs) so the shared plugin
// host keeps serving model calls. Nothing here selects or freezes the agy binary.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createServer, request as httpRequest } from "node:http"
import { Worker } from "node:worker_threads"
import { contextStateDir } from "./context-unlock.mjs"

export const DEFAULT_CONTEXT_PORT = 47821
export const CAPABILITY_HEADER = "x-bridge-context-capability"
const OP_TIMEOUT_MS = 180_000
const CHECK_TIMEOUT_MS = 60_000
const MAX_BODY = 4096
const APP_URL = new URL("./ui/context-app.html", import.meta.url)
const TASK_URL = new URL("./context-ui-task.mjs", import.meta.url)
export const CONTEXT_LIMITS = { default: 256_000, managed: 512_000, gptOss: 131_072 }

export function contextPort(value) {
  const port = typeof value === "string" ? Number(value.trim()) : value
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CONTEXT_PORT
}

// Errors may quote absolute paths (agy install, state dir); never show them.
export function publicError(error) {
  return String(error?.message || error || "context operation failed")
    .replace(/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s|'"`]*/g, "[path]")
    .slice(0, 400)
}

const STATE_REASONS = new Set(["default", "disabled", "unlocked", "stale", "missing", "corrupt", "unsupported"])
// Only what the page needs: no paths, hashes, accounts or state directory.
function publicCheck(status) {
  if (!status || typeof status !== "object") return null
  return {
    state: STATE_REASONS.has(status.state) ? status.state : "unknown",
    enabled: !!status.enabled,
    active: !!status.active,
    reason: publicError(status.reason || ""),
  }
}

export function runContextTask(action, { env = process.env, timeout = OP_TIMEOUT_MS, taskUrl = TASK_URL, signal } = {}) {
  return new Promise((resolve, reject) => {
    let worker
    const taskId = randomUUID()
    const stateDir = contextStateDir(env)
    const stagingPrefix = `.unlock-${taskId}-`
    const cleanup = async () => {
      if (action !== "unlock") return
      const entries = await fs.promises.readdir(stateDir).catch(error => { if (error.code === "ENOENT") return []; throw error })
      await Promise.all(entries.filter(name => name.startsWith(stagingPrefix)).map(name =>
        fs.promises.rm(path.join(stateDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })))
    }
    try { worker = new Worker(taskUrl, { workerData: { action, env: { ...env }, taskId, deadline: Date.now() + timeout } }) } catch (error) { reject(error); return }
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      // Keep the operation locked until blocking work has actually stopped.
      // A terminated worker cannot run unlockContext's finally block. Remove
      // only this job's staging directory after termination has completed.
      Promise.resolve(worker.terminate()).then(cleanup).then(() => fn(value), () => reject(Object.assign(
        new Error("context task cleanup failed; check the saved mode before retrying"), { code: "cleanup_failed" })))
    }
    const timer = setTimeout(() => finish(reject, Object.assign(
      new Error("the context operation timed out; the official agy was left unchanged"), { code: "timeout" })), timeout)
    const abort = () => finish(reject, Object.assign(new Error("context service closed"), { code: "closed" }))
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
    timer.unref?.()
    worker.unref?.()
    worker.on("message", message => message?.error
      ? finish(reject, Object.assign(new Error(message.value?.message || "context operation failed"), { code: message.value?.code }))
      : finish(resolve, message?.value))
    worker.on("error", error => finish(reject, error))
    worker.on("exit", code => finish(reject, new Error(`context worker stopped unexpectedly (${code})`)))
  })
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""))
  return x.length === y.length && timingSafeEqual(x, y)
}

// options.runTask(action) -> Promise<status>; options.runtimeMode() -> "not-selected" | "default" | "unlocked"
export function createContextService({ env = process.env, runtimeMode = () => "not-selected", unavailableReason = null, runTask, taskUrl, opTimeout, log = () => {} } = {}) {
  const capability = randomBytes(32).toString("base64url")
  const template = fs.readFileSync(APP_URL, "utf8")
  const html = template.replace("__CAPABILITY__", capability)
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""
  const scriptHash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`
  const controller = new AbortController()
  let closed = false
  const execute = runTask || ((action) => runContextTask(action, {
    env, taskUrl, signal: controller.signal, timeout: action === "status" ? CHECK_TIMEOUT_MS : (opTimeout || OP_TIMEOUT_MS),
  }))
  let port = 0
  let server = null
  let operation = null   // { id, action, startedAt }
  let last = null        // { id, action, ok, error?, finishedAt }
  let check = null       // public verified status
  let checking = null    // Promise while a status worker runs

  const runCheck = () => {
    if (closed || checking || operation) return checking
    // The native patcher must never operate on a host install when requests
    // actually use agy inside WSL. Report the limitation without reading state.
    if (unavailableReason) {
      check = { state: "unsupported", enabled: false, active: false, reason: "Managed context unlock is unavailable in WSL mode.", checkedAt: new Date().toISOString() }
      return null
    }
    checking = Promise.resolve().then(() => execute("status"))
      .then(status => { check = { ...publicCheck(status), checkedAt: new Date().toISOString() } },
        error => { check = { state: "unknown", enabled: false, active: false, reason: publicError(error), checkedAt: new Date().toISOString() } })
      .finally(() => { checking = null })
    return checking
  }

  const snapshot = () => {
    const current = String(runtimeMode() || "not-selected")
    const desired = check && check.state !== "unknown" ? (check.enabled ? "unlocked" : "default") : "unknown"
    const effective = check && check.state !== "unknown" ? (check.active ? "unlocked" : "default") : "unknown"
    const override = Number(env.AGY_BRIDGE_CONTEXT_WINDOW)
    const contextOverride = Number.isSafeInteger(override) && override > 0 && override <= 1_048_576 ? override : null
    return {
      desired, effective, current,
      unavailableReason,
      contextOverride,
      declaredContext: contextOverride || (current === "not-selected" ? null : current === "unlocked" ? CONTEXT_LIMITS.managed : CONTEXT_LIMITS.default),
      restartRequired: current !== "not-selected" && effective !== "unknown" && current !== effective,
      check, checking: !!checking,
      operation: operation && { id: operation.id, action: operation.action, startedAt: operation.startedAt },
      last, limits: CONTEXT_LIMITS,
    }
  }

  const startAction = action => {
    if (closed || operation || checking) return null
    operation = { id: randomUUID(), action, startedAt: new Date().toISOString() }
    const mine = operation
    Promise.resolve().then(() => execute(action)).then(status => {
      check = { ...publicCheck(status), checkedAt: new Date().toISOString() }
      last = { id: mine.id, action, ok: true, finishedAt: new Date().toISOString() }
    }, error => {
      last = { id: mine.id, action, ok: false, error: publicError(error), code: typeof error?.code === "string" ? error.code : undefined, finishedAt: new Date().toISOString() }
      log(`context ${action} failed: ${last.error}`)
    }).finally(() => {
      if (operation === mine) operation = null
      if (!last?.ok) runCheck()
    })
    return mine
  }

  const hostOk = req => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`
  const loopbackPeer = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  const base = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Antigravity-Bridge-Context": "1" }
  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { ...base, "Content-Type": "application/json; charset=utf-8", ...extra })
    res.end(JSON.stringify(body))
  }
  const deny = (res, status, message) => {
    res.writeHead(status, { ...base, "Content-Type": "text/plain; charset=utf-8" })
    res.end(message)
  }

  const handler = (req, res) => {
    if (!loopbackPeer(req) || !hostOk(req)) return deny(res, 421, "context service: loopback host only")
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const origin = req.headers.origin
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // A navigation only: a fetch (any mode) or a request that names an
      // Origin could otherwise try to read the capability in the HTML.
      const mode = req.headers["sec-fetch-mode"], dest = req.headers["sec-fetch-dest"]
      if (req.method !== "GET" || origin !== undefined || (mode && mode !== "navigate") || (dest && !["document", "iframe"].includes(dest))) {
        return deny(res, 403, "context service: open it from the Antigravity Bridge page")
      }
      res.writeHead(200, {
        ...base,
        "Content-Type": "text/html; charset=utf-8",
        // Always an opaque origin, as in Magpie's frame. 'self' is not matched
        // from an opaque origin by WebKit, so the loopback source is named too
        // (magpie web adds its proxied root after 'self').
        "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src ${scriptHash}; style-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:${port}; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' wails://localhost http://wails.localhost http://127.0.0.1:* http://localhost:*`,
      })
      return res.end(html)
    }
    if (!url.pathname.startsWith("/api/")) return deny(res, 404, "not found")
    // The page is sandboxed (Origin: null) or proxied same-origin (no Origin).
    if (origin !== undefined && origin !== "null") return deny(res, 403, "context service: origin refused")
    const cors = origin === "null" ? { "Access-Control-Allow-Origin": "null", Vary: "Origin" } : { Vary: "Origin" }
    if (req.method === "OPTIONS") {
      if (origin !== "null") return deny(res, 403, "context service: origin refused")
      res.writeHead(204, {
        ...base, ...cors,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": `content-type, ${CAPABILITY_HEADER}`,
        "Access-Control-Max-Age": "600",
        ...(req.headers["access-control-request-private-network"] === "true" ? { "Access-Control-Allow-Private-Network": "true" } : {}),
      })
      return res.end()
    }
    if (!safeEqual(req.headers[CAPABILITY_HEADER], capability)) return send(res, 403, { error: "forbidden" }, cors)
    if (url.pathname === "/api/status" && req.method === "GET") {
      if (!check && !operation) runCheck()
      else if (url.searchParams.get("refresh") === "1") runCheck()
      return send(res, 200, snapshot(), cors)
    }
    if (url.pathname === "/api/action" && req.method === "POST") {
      if (unavailableReason) return send(res, 409, { error: "Managed context unlock is unavailable in WSL mode; the distro's official agy remains in use." }, cors)
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return send(res, 415, { error: "JSON required" }, cors)
      let raw = ""
      let tooLarge = false
      req.setEncoding("utf8")
      req.on("data", chunk => {
        raw += chunk
        if (raw.length > MAX_BODY && !tooLarge) { tooLarge = true; send(res, 413, { error: "request too large" }, cors); req.destroy() }
      })
      req.on("end", () => {
        if (tooLarge) return
        let body
        try { body = JSON.parse(raw) } catch { return send(res, 400, { error: "invalid JSON" }, cors) }
        const action = body?.action
        if (!["unlock", "disable"].includes(action)) return send(res, 400, { error: "unknown action" }, cors)
        // The page reviews the change first; an unconfirmed request does nothing.
        if (body.confirm !== action) return send(res, 400, { error: "confirmation required" }, cors)
        const started = startAction(action)
        if (!started) return send(res, 409, { error: "another context operation is running", ...snapshot() }, cors)
        return send(res, 202, snapshot(), cors)
      })
      return
    }
    return send(res, 404, { error: "not found" }, cors)
  }

  return {
    capability,
    get port() { return port },
    get busy() { return !!operation || !!checking },
    snapshot,
    handler,
    idle: async () => { while (operation || checking) await new Promise(r => setTimeout(r, 10)) },
    // One bind attempt; failure is reported, never retried.
    listen(requested = DEFAULT_CONTEXT_PORT) {
      return new Promise((resolve, reject) => {
        const s = createServer(handler)
        s.requestTimeout = 30_000
        s.headersTimeout = 10_000
        s.once("error", reject)
        s.listen(requested, "127.0.0.1", () => {
          s.removeListener("error", reject)
          s.on("error", error => log(`context service error: ${publicError(error)}`))
          s.unref()
          server = s
          port = s.address().port
          resolve(port)
        })
      })
    },
    close() {
      closed = true
      controller.abort()
      return new Promise(resolve => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); server = null })
    },
  }
}

// A hot update starts the new host while the old host finishes its calls. Its
// page service can still own this port. Recognize only our service (including
// 0.8.0, before the identity header existed), without running the page's script.
function previousContextService(port) {
  return new Promise(resolve => {
    let req, settled = false
    const finish = value => {
      if (settled) return
      settled = true
      req?.destroy()
      resolve(value)
    }
    try {
      req = httpRequest({ hostname: "127.0.0.1", port, path: "/", method: "GET",
        headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } }, res => {
        if (res.statusCode !== 200) return finish(false)
        if (res.headers["x-antigravity-bridge-context"] === "1") return finish(true)
        let prefix = ""
        res.on("data", chunk => {
          prefix = (prefix + chunk.toString()).slice(0, 1024)
          if (prefix.includes("</title>") || prefix.length >= 1024) finish(prefix.includes("<title>Antigravity Bridge context</title>"))
        })
        res.on("end", () => finish(prefix.includes("<title>Antigravity Bridge context</title>")))
        res.on("error", () => finish(false))
      })
      req.on("error", () => finish(false))
      req.setTimeout(750, () => finish(false))
      req.end()
    } catch { finish(false) }
  })
}

// Started at most once per host; handover waits only in the background. The
// timer is unref'd so an old host's shutdown is never held open by a contender.
let started = null
export function startContextService({ port, ...options } = {}) {
  if (started) return started
  started = (async () => {
    try {
      const service = createContextService(options)
      const target = contextPort(port)
      let unknownOwnerAttempts = 0
      for (;;) {
        try { await service.listen(target); break }
        catch (error) {
          if (error.code !== "EADDRINUSE") throw error
          if (await previousContextService(target)) unknownOwnerAttempts = 0
          else if (++unknownOwnerAttempts >= 3) throw error
          await new Promise(resolve => { const timer = setTimeout(resolve, 250); timer.unref?.() })
        }
      }
      process.once("exit", () => { service.close() })
      return service
    } catch (error) {
      options.log?.(`context settings page unavailable on 127.0.0.1:${contextPort(port)}: ${publicError(error)}`)
      return null
    }
  })().catch(() => null)
  return started
}
