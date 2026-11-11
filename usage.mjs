import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agySpawnSpec, childEnv, wslDistro } from "./platform.mjs"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 18_000 // Magpie bounds an auth.usage call to 20 seconds.
const MAX_OUTPUT_BYTES = 1024 * 1024
const CLEANUP_TIMEOUT_MS = 1000

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

function usageDisabled(env) {
  return /^(?:0|false|off|no|disabled)$/i.test(String(env?.AGY_BRIDGE_USAGE ?? "").trim())
}

// Keep the CLI's normal sign-in while leaving its global skills, rules, plugins,
// MCP servers and settings behind. Keyring/ADC auth needs no seed. Windows file
// symlinks require privileges; use a private copy there. A hardlink would let a
// CLI token refresh write through to the user's original credential.
async function linkIsolatedAccount(home, geminiDir, platform, fs) {
  const source = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  try {
    await fs.access(source)
  } catch {
    return
  }
  const appDir = path.join(geminiDir, "antigravity-cli")
  await fs.mkdir(appDir, { recursive: true, mode: 0o700 })
  await fs.chmod(appDir, 0o700)
  const destination = path.join(appDir, "antigravity-oauth-token")
  if (platform === "win32") {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
    await fs.chmod(destination, 0o600)
    return
  }
  try {
    await fs.symlink(source, destination)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
}

function stopWindows(child, env, spawnProcess) {
  return new Promise(resolve => {
    let killer
    let settled = false
    const finish = fallback => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fallback) {
        try { child.kill("SIGKILL") } catch {}
      }
      resolve()
    }
    const timer = setTimeout(() => {
      try { killer?.kill("SIGKILL") } catch {}
      finish(true)
    }, CLEANUP_TIMEOUT_MS)
    // Resolve the OS tool independently of PATH (which starts with our shims).
    const root = Object.entries(env).find(([key]) => /^systemroot$/i.test(key))?.[1] || "C:\\Windows"
    try {
      killer = spawnProcess(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        env, windowsHide: true, detached: false, stdio: "ignore",
      })
      killer.once("error", () => finish(true))
      killer.once("close", code => finish(code !== 0))
    } catch {
      finish(true)
    }
  })
}

function run(file, args, { cwd, env, deadline, signal, maxOutputBytes, platform, spawnProcess }) {
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let cleanup
    let bytes = 0
    const stdout = []
    const stderr = []
    let timer
    const stop = () => {
      if (cleanup) return cleanup
      if (!child?.pid) return Promise.resolve()
      if (platform === "win32") return cleanup = stopWindows(child, env, spawnProcess)
      // Only this detached child/group is ours, never an existing user agy.
      try { process.kill(-child.pid, "SIGKILL") } catch {
        try { child.kill("SIGKILL") } catch {}
      }
      return cleanup = Promise.resolve()
    }
    const finish = async (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      // Await tree cleanup before removing files. POSIX groups also retain
      // exited parents' descendants; Windows taskkill requires a live parent.
      await stop()
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new UsageError("agy usage query was cancelled."))
    if (signal?.aborted) return abort()
    if (Date.now() >= deadline) return finish(new UsageError("agy usage query timed out."))
    try {
      const command = agySpawnSpec(file, args, platform, env)
      child = spawnProcess(command.file, command.args, {
        ...command.options, cwd, env, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      })
    } catch {
      finish(new UsageError("agy usage could not start the CLI."))
      return
    }
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
    signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => finish(new UsageError("agy usage query timed out.")), Math.max(1, deadline - Date.now()))
    // Cover cancellation during spawn, after registering error/close handlers.
    if (signal?.aborted) abort()
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
  home = os.homedir(),
  geminiDir: fixedGeminiDir,
  platform = process.platform,
  spawn: spawnProcess = spawn,
  fs: fileSystem = fs,
} = {}) {
  if (wslDistro(env, platform)) throw new UsageError("Quota queries are unavailable in Windows-to-WSL mode; check usage inside the configured distro.")
  if (!agy) throw new UsageError("agy CLI not found. Install it and run `agy` once to sign in.")
  const fs = fileSystem
  const deadline = Date.now() + timeout(timeoutMs)
  // A caller-supplied Gemini dir is a named account profile: use it as-is and
  // never delete it. Otherwise build a private one seeded only with the token.
  const owned = !fixedGeminiDir
  const directory = owned ? await fs.mkdtemp(path.join(tempRoot, "magpie-agy-usage-")) : null
  let workDir = null
  try {
    let geminiDir
    if (fixedGeminiDir) {
      geminiDir = path.resolve(fixedGeminiDir)
    } else {
      await fs.chmod(directory, 0o700)
      // Print mode reloads system slash commands and global skills even when the
      // selected agent opts out. A private Gemini dir keeps that discovery local.
      geminiDir = path.resolve(directory, "gemini")
      await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 })
      await fs.chmod(geminiDir, 0o700)
      await linkIsolatedAccount(home, geminiDir, platform, fs)
    }
    workDir = owned ? directory : await fs.mkdtemp(path.join(tempRoot, "magpie-agy-usage-work-"))
    const agentDir = path.join(workDir, ".agents", "agents", "magpie-usage")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, "agent.md"), [
      "---", "name: magpie-usage", "description: Read CLI usage only", "mainAgent: true", "subagent: false",
      "tools: []", "mcpServers: []",
      "inheritMcp: false", "inheritCustomizations: false", "excludeDefaultComponents: true",
      "---", "Do not run model prompts or tools.", "",
    ].join("\n"), { mode: 0o600 })
    const windows = platform === "win32"
    // AGY's native Windows auth launcher invokes rundll32 directly and ignores
    // BROWSER. Shadow that command as well as the POSIX browser launchers.
    for (const name of windows ? ["open", "xdg-open", "rundll32"] : ["open", "xdg-open"]) {
      await fs.writeFile(path.join(workDir, name + (windows ? ".cmd" : "")), windows ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    }
    const launchEnv = childEnv(env, platform, {})
    // A named account must read its own file token, not the machine-global
    // keyring. WSL detection is agy's file-storage switch.
    if (fixedGeminiDir && !Object.keys(launchEnv).some(key => /^wsl_interop$/i.test(key))) {
      launchEnv.WSL_INTEROP = "1"
    }
    const pathKey = Object.keys(launchEnv).find(key => windows ? /^path$/i.test(key) : key === "PATH") || "PATH"
    launchEnv[pathKey] = workDir + (windows ? ";" : ":") + (launchEnv[pathKey] || (windows ? "" : "/usr/bin:/bin"))
    if (windows) {
      // Go's exec.LookPath uses PATHEXT for bare rundll32. Keep our blocker
      // discoverable even when the host customized its executable extensions.
      const key = Object.keys(launchEnv).find(key => /^pathext$/i.test(key)) || "PATHEXT"
      const extensions = launchEnv[key] || ".COM;.EXE;.BAT;.CMD"
      launchEnv[key] = extensions.split(";").some(value => value.toUpperCase() === ".CMD") ? extensions : extensions + ";.CMD"
    }
    // Merge again to replace a differently-cased Windows BROWSER as well.
    const options = {
      cwd: workDir, env: childEnv({ BROWSER: path.join(workDir, windows ? "open.cmd" : "open") }, platform, launchEnv),
      deadline, signal, maxOutputBytes, platform, spawnProcess,
    }
    // Probe the hidden profile flag within the version call. Older CLIs reject
    // it; only then fall back to the user's real Gemini directory. A fixed
    // account dir must never fall back: that would read the wrong account.
    let version = await run(agy, [`--gemini_dir=${geminiDir}`, "--version"], { ...options, deadline: Math.min(deadline, Date.now() + 3000) })
    let isolated = version.code === 0
    if (!isolated && /flags? provided but not defined|unknown (?:flag|option)|unrecognized/i.test(version.stderr + version.stdout)) {
      if (fixedGeminiDir) throw new UsageError("this agy version does not support --gemini_dir; update the CLI to use named accounts.")
      version = await run(agy, ["--version"], { ...options, deadline: Math.min(deadline, Date.now() + 3000) })
    }
    if (version.code !== 0) throw commandFailure(version.stderr)
    if (!supportedVersion(version.stdout)) throw new UsageError("agy usage reports require a verified agy version 1.1.11 or later. Update the CLI.")
    const args = [
      ...(isolated ? [`--gemini_dir=${geminiDir}`] : []),
      "-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`,
    ]
    const result = await run(agy, args, options)
    if (result.code !== 0) throw commandFailure(result.stderr + "\n" + result.stdout)
    return parseUsageReport(result.stdout)
  } finally {
    const temporary = owned ? directory : workDir
    if (temporary) {
      try {
        // Node retries EBUSY, EPERM and ENOTEMPTY with bounded linear backoff.
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        throw new UsageError("agy usage could not remove its temporary workspace. Check temporary-directory permissions.")
      }
    }
  }
}

// No completed-result cache: sequential refreshes must see account/allowance changes.
// options.resolveAccounts (async (agy) => [{ name, dir }]) enables multi-account:
// every account's quota windows are merged, named accounts prefixed with [name].
export function createUsageReader(resolveAgy, options = {}) {
  const pending = new Map()
  const query = (agy, account) => {
    const key = `${agy}|${account.dir ?? ""}`
    if (!pending.has(key)) {
      const run = fetchUsage(agy, { ...options, geminiDir: account.dir ?? undefined }).finally(() => {
        if (pending.get(key) === run) pending.delete(key)
      })
      pending.set(key, run)
    }
    return pending.get(key)
  }
  return async () => {
    if (usageDisabled(options.env ?? process.env)) return { windows: [], signIn: "kept" }
    try {
      const agy = resolveAgy()
      const accounts = options.resolveAccounts
        ? await options.resolveAccounts(agy)
        : [{ name: null, dir: null }]
      const results = await Promise.all(accounts.map(async account => {
        try {
          return { account, report: await query(agy, account) }
        } catch (error) {
          return { account, error }
        }
      }))
      const windows = []
      const errors = []
      for (const { account, report, error } of results) {
        if (error) {
          errors.push(`${account.name ?? "default"}: ${error instanceof UsageError ? error.message : "agy usage query failed."}`)
          continue
        }
        // Clone per account so callers can never mutate each other's reports.
        for (const window of structuredClone(report).windows) {
          windows.push(account.name ? { ...window, name: `[${account.name}] ${window.name}` } : window)
        }
      }
      if (!windows.length && errors.length) {
        return { windows: [], error: errors.join("; "), signIn: "kept" }
      }
      return { windows, ...(errors.length ? { errors } : {}), signIn: "kept" }
    } catch (error) {
      return { windows: [], error: error instanceof UsageError ? error.message : "agy usage query failed. Check the CLI and temporary-directory permissions.", signIn: "kept" }
    }
  }
}
