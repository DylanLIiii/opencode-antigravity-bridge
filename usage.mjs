import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 18_000 // Magpie bounds an auth.usage call to 20 seconds.
const MAX_OUTPUT_BYTES = 1024 * 1024

class UsageError extends Error {}

const text = value => typeof value === "string" ? value.trim() : ""
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake]

function commandFailure(output) {
  if (/not (?:logged|signed) in|unauthenticated|authentication required|login required|please (?:log|sign) in|sign in again/i.test(output)) {
    return new UsageError("agy usage needs authentication. Run `agy` in a terminal to sign in again.")
  }
  const eligibility = /eligibility check failed|not eligible|unsupported (?:country|region)|does not support google tos/i.test(output)
  const network = /\b(?:eof|timeout|timed out|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|ssl|certificate)\b/i.test(output)
  if (network) return new UsageError(`agy usage ${eligibility ? "eligibility check " : ""}failed on a network request. Check network or proxy settings.`)
  if (eligibility) return new UsageError("agy reports that this account is not eligible for Antigravity.")
  return new UsageError("agy could not read usage. Run `agy` in a terminal to check its status.")
}

function resetTime(value) {
  if (value == null || value === "" || typeof value === "boolean") return undefined
  const raw = String(value)
  let ms
  if (/^\d+(?:\.\d+)?$/.test(raw)) ms = Number(raw) * (Number(raw) < 1e11 ? 1000 : 1)
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) ms = Date.parse(raw)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300799999) return undefined
  return new Date(ms).toISOString()
}

function cadence(bucket, id, name) {
  // An explicit, unfamiliar window must not be overridden by an older ID/label.
  const value = text(bucket.window) || `${id} ${name}`
  if (/^(?:5h|five[_ -]?hours?|five_hour|session)$/i.test(value) || !text(bucket.window) && /(?:5h|five[ _-]hour|session)/i.test(value)) {
    return { name: "5 hours", span: 5 * 60 * 60 }
  }
  if (/^(?:weekly|week|7d|seven[_ -]?days?)$/i.test(value) || !text(bucket.window) && /(?:weekly|week|7d)/i.test(value)) {
    return { name: "7 days", span: 7 * 24 * 60 * 60 }
  }
  return { name: name || id }
}

// agy's command report is not its token-usage object or a model-availability list.
// Unknown quota is not evidence of exhaustion or a full allowance.
export function parseUsageReport(value) {
  let report
  try { report = typeof value === "string" ? JSON.parse(value) : value } catch {
    throw new UsageError("agy returned an invalid usage report.")
  }
  if (report?.status !== "SUCCESS" || report?.command?.name !== "usage") {
    throw commandFailure(`${text(report?.error)} ${text(report?.response)}`)
  }
  const groups = report.command.data?.groups
  const windows = []
  for (const group of Array.isArray(groups) ? groups : []) {
    const pool = (text(field(group, "displayName", "display_name")) || text(group?.name) || "Quota")
      .replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const id = text(field(bucket, "bucketId", "bucket_id")) || text(bucket?.id)
      if (!id || bucket?.disabled === true) continue
      const label = text(field(bucket, "displayName", "display_name")) || text(bucket?.name)
      const period = cadence(bucket, id, label)
      const remaining = bucket.remaining
      const fraction = field(bucket, "remainingFraction", "remaining_fraction")
        ?? field(remaining, "remainingFraction", "remaining_fraction")
        ?? (remaining?.case === "remainingFraction" ? remaining.value : undefined)
      const known = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      const resetsAt = resetTime(field(bucket, "resetTime", "reset_time"))
      windows.push({
        name: `${pool} · ${period.name}`,
        // This feature displays quota only; it must not change model routing.
        aside: true,
        ...(known ? { used: Math.round((1 - fraction) * 1e8) / 1e6 } : { display: "Limits not available" }),
        ...(period.span ? { span: period.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }
  if (!windows.some(w => w.used !== undefined)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.")
  }
  // /usage has no verified account or plan identity. Do not borrow one elsewhere.
  return { windows }
}

function timeout(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
}

function run(file, args, { cwd, env, deadline, signal, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let stopped = false
    let bytes = 0
    const stdout = []
    const stderr = []
    let timer
    const stop = () => {
      if (!child?.pid || stopped) return
      stopped = true
      // Only this detached child/group is ours, never an existing user agy.
      try { process.kill(-child.pid, "SIGKILL") } catch {
        try { child.kill("SIGKILL") } catch {}
      }
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      stop() // Also stop MCP descendants if the parent exited first.
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new UsageError("agy usage query was cancelled."))
    if (signal?.aborted) return abort()
    if (Date.now() >= deadline) return finish(new UsageError("agy usage query timed out."))
    try {
      child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      finish(new UsageError("agy usage could not start the CLI."))
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => finish(new UsageError("agy usage query timed out.")), Math.max(1, deadline - Date.now()))
    const collect = chunks => chunk => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) return finish(new UsageError("agy usage output exceeded the size limit."))
      chunks.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", () => finish(new UsageError("agy usage could not start the CLI.")))
    // exit, not close: a descendant may inherit the pipe and keep it open.
    // Drain the already-written output through close for a normal parent exit.
    child.on("exit", () => stop())
    child.on("close", code => finish(null, {
      code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

function supportedVersion(output) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11)
}

export async function fetchUsage(agy, {
  env = process.env,
  timeoutMs = env.AGY_BRIDGE_USAGE_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  signal,
  tempRoot = os.tmpdir(),
} = {}) {
  if (!agy) throw new UsageError("agy CLI not found. Install it and run `agy` once to sign in.")
  // Browser launcher blocking and owned process-group cleanup are POSIX-specific.
  if (process.platform === "win32") throw new UsageError("agy bridge usage queries currently require macOS or Linux.")
  const deadline = Date.now() + timeout(timeoutMs)
  const directory = await fs.mkdtemp(path.join(tempRoot, "magpie-agy-usage-"))
  try {
    await fs.chmod(directory, 0o700)
    const agentDir = path.join(directory, ".agents", "agents", "magpie-usage")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, "agent.md"), [
      "---", "name: magpie-usage", "description: Read CLI usage only", "mainAgent: true", "subagent: false",
      "tools: []", "mcpServers: []", "---", "Do not run model prompts or tools.", "",
    ].join("\n"), { mode: 0o600 })
    for (const name of ["open", "xdg-open"]) {
      await fs.writeFile(path.join(directory, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    }
    const childEnv = {
      ...env,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      PATH: directory + path.delimiter + (env.PATH || "/usr/bin:/bin"),
      BROWSER: path.join(directory, "open"),
    }
    const options = { cwd: directory, env: childEnv, deadline, signal, maxOutputBytes }
    const version = await run(agy, ["--version"], { ...options, deadline: Math.min(deadline, Date.now() + 3000) })
    if (version.code !== 0) throw commandFailure(version.stderr)
    if (!supportedVersion(version.stdout)) throw new UsageError("agy usage reports require a verified agy version 1.1.11 or later. Update the CLI.")
    const result = await run(agy, ["-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`], options)
    if (result.code !== 0) throw commandFailure(result.stderr + "\n" + result.stdout)
    return parseUsageReport(result.stdout)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

// No completed-result cache: sequential refreshes must see account/allowance changes.
export function createUsageReader(resolveAgy, options = {}) {
  const pending = new Map()
  return async () => {
    try {
      const agy = resolveAgy()
      if (!pending.has(agy)) {
        const query = fetchUsage(agy, options).finally(() => {
          if (pending.get(agy) === query) pending.delete(agy)
        })
        pending.set(agy, query)
      }
      return { ...structuredClone(await pending.get(agy)), signIn: "kept" }
    } catch (error) {
      return { windows: [], error: error instanceof UsageError ? error.message : "agy usage query failed. Check the CLI and temporary-directory permissions.", signIn: "kept" }
    }
  }
}
