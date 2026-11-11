import assert from "node:assert/strict"
import childProcess, { spawnSync } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createUsageReader, fetchUsage, parseUsageReport } from "./usage.mjs"
import { agySpawnSpec } from "./platform.mjs"

const report = groups => ({ status: "SUCCESS", command: { name: "usage", data: { groups } } })
const group = (buckets, name = "Gemini Models") => ({ name, buckets })
const bucket = (overrides = {}) => ({ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.75, ...overrides })

test("maps all groups/cadences to display-only Magpie windows, without invented identity", () => {
  const result = parseUsageReport(report([
    group([bucket(), bucket({ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 })]),
    group([bucket({ id: "3p-5h", remaining_fraction: 0 }), bucket({ id: "3p-weekly", window: "weekly", remaining_fraction: 1 })], "Claude and GPT models"),
    group([bucket({ id: "gemini-argon-weekly", window: "weekly", remaining_fraction: 0.53 })], "Gemini 4 Argon"),
  ]))
  assert.equal(result.windows.length, 5)
  assert.deepEqual(result.windows.map(w => w.name), ["Gemini · 5 hours", "Gemini · 7 days", "Claude & GPT · 5 hours", "Claude & GPT · 7 days", "Gemini 4 Argon · 7 days"])
  assert.deepEqual(result.windows.map(w => w.used), [25, 50, 100, 0, 47])
  assert.deepEqual(result.windows.map(w => w.span), [18000, 604800, 18000, 604800, 604800])
  assert.ok(result.windows.every(w => w.aside === true))
  assert.equal(result.plan, undefined)
  assert.equal(result.user, undefined)
})

test("accepts camel case and nested/oneof fractions plus ISO and epoch-second resets", () => {
  const result = parseUsageReport(JSON.stringify(report([{
    displayName: "Gemini Models",
    buckets: [
      { bucketId: "gemini-5h", displayName: "Session", window: "5h", remaining: { remainingFraction: 0.4 }, resetTime: "2026-10-27T02:00:00+02:00" },
      { bucketId: "gemini-weekly", remaining: { case: "remainingFraction", value: 0.8 }, resetTime: "1793059200" },
    ],
  }])))
  assert.equal(result.windows[0].used, 60)
  assert.equal(result.windows[0].resetsAt, "2026-10-27T00:00:00.000Z")
  assert.equal(result.windows[1].used, 20)
  assert.equal(result.windows[1].resetsAt, "2026-10-27T00:00:00.000Z")
  assert.equal(result.windows[1].span, 604800)
})

test("unknown, invalid and disabled quotas are never reported as zero/full usage", () => {
  const result = parseUsageReport(report([group([
    bucket(),
    ...[null, undefined, "0.5", true, -0.1, 1.1, NaN, Infinity].map((remaining_fraction, i) => bucket({ id: `unknown-${i}`, remaining_fraction, reset_time: "2026-10-27T00:00:00Z" })),
    bucket({ id: "disabled", disabled: true }),
    bucket({ id: "other-oneof", remaining_fraction: undefined, remaining: { case: "unlimited", value: 1 } }),
  ])]))
  assert.equal(result.windows.length, 10)
  assert.ok(result.windows.slice(1).every(w => w.used === undefined && w.display === "Limits not available" && w.aside))
  assert.equal(result.windows[1].resetsAt, "2026-10-27T00:00:00.000Z")
})

test("weekly-only reports stay weekly; explicit unknown cadence never becomes five hours", () => {
  const result = parseUsageReport(report([group([
    bucket({ id: "gemini-weekly", window: undefined, name: "Weekly Limit Remaining" }),
    bucket({ id: "gemini-5h", window: "custom", name: "Special limit", reset_time: "bad" }),
    bucket({ id: "other", window: undefined, name: "Other", reset_time: "2026-10-27T00:00:00Z" }),
  ])]))
  assert.equal(result.windows[0].span, 604800)
  assert.equal(result.windows[1].span, undefined)
  assert.equal(result.windows[1].resetsAt, undefined)
  assert.equal(result.windows[2].span, undefined)
})

test("requires a successful usage command with at least one enabled measured bucket", () => {
  for (const value of [
    "invalid-json", {}, { status: "ERROR", error: "secret@example.com" },
    { ...report([group([bucket()])]), command: { name: "models", data: {} } },
    report([]), report([group([bucket({ disabled: true })])]),
    report([group([bucket({ remaining_fraction: undefined })])]),
    report([group([{ remaining_fraction: 0.5 }])]),
  ]) {
    assert.throws(() => parseUsageReport(value), error => !error.message.includes("secret@example.com"))
  }
})

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  assert.fail(message)
}

function processRunning(pid) {
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
  if (process.platform === "win32") return true
  // A dead orphan can briefly remain a zombie on Linux.
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 })
  if (status.error) throw status.error
  return !!status.stdout.trim() && !status.stdout.trim().startsWith("Z")
}

async function waitForExit(pid) {
  await waitFor(() => !processRunning(pid), `fixture process ${pid} did not exit`, 5000)
}

async function fixture(t, extraEnv = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-test-"))
  const logPath = path.join(directory, "calls.jsonl")
  const logs = async () => {
    try {
      return (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    } catch (error) {
      if (error.code === "ENOENT") return []
      throw error
    }
  }
  const descendantPath = path.join(directory, "descendant")
  const descendantPid = async () => {
    try {
      const pid = Number(await fs.readFile(descendantPath, "utf8"))
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
  }
  t.after(async () => {
    try {
      const pids = new Set([...(await logs()).map(log => log.pid), await descendantPid()])
      for (const pid of pids) {
        if (Number.isSafeInteger(pid) && pid > 0 && processRunning(pid)) {
          if (process.platform === "win32") {
            spawnSync(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
              windowsHide: true, stdio: "ignore", timeout: 3000,
            })
          }
          if (processRunning(pid)) {
            try { process.kill(pid, "SIGKILL") } catch (error) {
              if (error.code !== "ESRCH") throw error
            }
          }
          await waitForExit(pid)
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
  const script = path.join(directory, "fake.mjs")
  const executable = path.join(directory, process.platform === "win32" ? "agy.cmd" : "agy")
  await fs.writeFile(script, `import { agySpawnSpec } from ${JSON.stringify(new URL("./platform.mjs", import.meta.url).href)}\n` + String.raw`
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const version = args.includes("--version")
if (process.env.TEST_GEMINI_DIR === "unsupported" && args.some(arg => arg.startsWith("--gemini_dir="))) {
  fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ args, unsupported: true }) + "\n")
  console.error("flag provided but not defined: -gemini_dir")
  process.exit(2)
}
const geminiArg = args.find(arg => arg.startsWith("--gemini_dir="))
const geminiPath = geminiArg?.slice("--gemini_dir=".length)
let geminiToken = null
if (geminiPath) {
  try { geminiToken = fs.readlinkSync(path.join(geminiPath, "antigravity-cli", "antigravity-oauth-token")) } catch {}
}
const browser = agySpawnSpec(process.env.BROWSER, [], process.platform, process.env)
const guard = spawnSync(browser.file, browser.args, { ...browser.options, windowsHide: true, encoding: "utf8", timeout: 5000 })
let windowsBrowser = null
if (process.platform === "win32") {
  const lookup = spawnSync(path.join(process.env.SystemRoot, "System32", "where.exe"), ["rundll32"], {
    windowsHide: true, encoding: "utf8", timeout: 5000,
  })
  const resolved = lookup.stdout?.trim().split(/\r?\n/)[0]
  const expected = path.join(process.cwd(), "rundll32.cmd")
  windowsBrowser = { resolved, lookupStatus: lookup.status, lookupError: lookup.error?.code ?? null, lookupStderr: lookup.stderr }
  // Never execute the system launcher if lookup bypassed the blocker. Record
  // the lookup so the test reports a useful failure instead of opening a URL.
  if (lookup.status === 0 && fs.realpathSync(resolved).toLowerCase() === fs.realpathSync(expected).toLowerCase()) {
    const command = agySpawnSpec(resolved, ["url.dll,FileProtocolHandler", "https://example.invalid/"], process.platform, process.env)
    const result = spawnSync(command.file, command.args, { ...command.options, windowsHide: true, encoding: "utf8", timeout: 5000 })
    Object.assign(windowsBrowser, { status: result.status, error: result.error?.code ?? null, stderr: result.stderr })
    // Go's exec.Command starts the resolved file directly. A batch blocker
    // must also fail at that boundary, without starting a browser process.
    try {
      const direct = spawnSync(resolved, ["url.dll,FileProtocolHandler", "https://example.invalid/"], { windowsHide: true, timeout: 5000 })
      Object.assign(windowsBrowser, { directError: direct.error?.code ?? null, directPid: direct.pid })
    } catch (error) {
      Object.assign(windowsBrowser, { directError: error.code, directPid: 0 })
    }
  }
}
const record = {
  args, cwd: process.cwd(), pid: process.pid,
  update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  path: process.env.PATH, browser: process.env.BROWSER,
  agent: fs.readFileSync(path.join(process.cwd(), ".agents/agents/magpie-usage/agent.md"), "utf8"),
  mode: fs.statSync(process.cwd()).mode & 0o777,
  guard: guard.status, guardError: guard.error?.code ?? null, guardStderr: guard.stderr, windowsBrowser,
  gemini: geminiPath ? { path: geminiPath, mode: fs.statSync(geminiPath).mode & 0o777, token: geminiToken } : null,
}
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(record) + "\n")
const mode = process.env.TEST_MODE
if (mode === "version-hang" && version || mode === "hang" && !version) setInterval(() => {}, 1000)
else if (version) {
  console.log(process.env.TEST_VERSION || "1.3.5")
} else if (mode === "fail") {
  console.error(process.env.TEST_ERROR || "oops secret@example.com https://secret.invalid/token")
  process.exitCode = 1
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(1024 * 1024 + 1))
} else if (mode === "combined-output") {
  process.stdout.write("x".repeat(600))
  process.stderr.write("y".repeat(600))
} else if (mode === "malformed") {
  console.log("invalid secret@example.com")
} else if (mode === "descendant" || mode === "live-descendant") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", windowsHide: true })
  fs.writeFileSync(process.env.TEST_DESCENDANT, String(child.pid))
  if (mode === "descendant") {
    child.unref()
    console.log(process.env.TEST_REPORT)
  }
} else {
  if (mode === "delay") await new Promise(resolve => setTimeout(resolve, 150))
  console.log(process.env.TEST_REPORT)
}
`)
  await fs.writeFile(executable, process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath.replace(/%/g, "%%")}" "${script.replace(/%/g, "%%")}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 })
  const env = { ...process.env, TEST_LOG: logPath, TEST_REPORT: JSON.stringify(report([group([bucket()])])), TEST_DESCENDANT: descendantPath, ...extraEnv }
  const home = path.join(directory, "home")
  await fs.mkdir(home, { recursive: true })
  return {
    executable, env, descendantPid, logs,
    options: { env, tempRoot: directory, home },
    async assertClean() { assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith("magpie-agy-usage-")), []) },
  }
}

test("queries only the structured command in a private, restricted workspace and cleans up", async t => {
  const f = await fixture(t, { AGY_CLI_DISABLE_AUTO_UPDATE: "false", ...(process.platform === "win32" ? { PATHEXT: ".EXE;.BAT" } : {}) })
  const originalSpawn = childProcess.spawn
  const spawns = []
  let result
  try {
    childProcess.spawn = (file, args, options) => {
      spawns.push({ file, args, options })
      return originalSpawn(file, args, options)
    }
    syncBuiltinESMExports()
    result = await fetchUsage(f.executable, f.options)
  } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs.length, 2)
  const cliSpawns = spawns.filter(call => !/taskkill\.exe$/i.test(call.file))
  assert.equal(cliSpawns.length, 2)
  for (const [index, actual] of cliSpawns.entries()) {
    const expected = agySpawnSpec(f.executable, logs[index].args, process.platform, actual.options.env)
    assert.equal(actual.file, expected.file)
    assert.deepEqual(actual.args, expected.args)
    assert.equal(actual.options.windowsHide, true, "usage must hide both version and report child windows")
    assert.equal(actual.options.detached, process.platform !== "win32")
    assert.deepEqual(actual.options.stdio, ["ignore", "pipe", "pipe"])
    assert.equal(path.basename(actual.options.cwd), path.basename(logs[index].cwd))
    assert.equal(actual.options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true")
    assert.equal(actual.options.env.TEST_LOG, f.env.TEST_LOG)
    assert.notEqual(actual.options.env, f.env)
  }
  assert.match(logs[0].args[0], /^--gemini_dir=/)
  assert.deepEqual(logs[0].args.slice(1), ["--version"])
  assert.match(logs[1].args[0], /^--gemini_dir=/)
  assert.deepEqual(logs[1].args.slice(1, 7), ["-p", "/usage", "--output-format", "json", "--agent", "magpie-usage"])
  assert.equal(logs[1].args[7], "--print-timeout")
  assert.match(logs[1].args[8], /^\d+s$/)
  assert.equal(logs[0].gemini.path, logs[1].gemini.path)
  assert.equal(logs[0].gemini.path, logs[1].args[0].slice("--gemini_dir=".length))
  for (const log of logs) {
    if (process.platform !== "win32") assert.equal(log.mode, 0o700)
    assert.equal(log.update, "true")
    assert.ok(log.agent.includes("tools: []\nmcpServers: []"))
    assert.ok(log.agent.includes("inheritMcp: false\ninheritCustomizations: false\nexcludeDefaultComponents: true"))
    assert.equal(log.guard, 1)
    assert.equal(log.guardError, null)
    assert.equal(log.guardStderr, "")
    if (process.platform === "win32") {
      assert.equal(log.windowsBrowser.lookupStatus, 0, JSON.stringify(log.windowsBrowser))
      assert.equal(path.basename(log.windowsBrowser.resolved), "rundll32.cmd")
      assert.equal(log.windowsBrowser.status, 1, JSON.stringify(log.windowsBrowser))
      assert.equal(log.windowsBrowser.error, null)
      assert.equal(log.windowsBrowser.stderr, "")
      assert.ok(log.windowsBrowser.directError, JSON.stringify(log.windowsBrowser))
      assert.ok(!log.windowsBrowser.directPid, JSON.stringify(log.windowsBrowser))
    }
    if (process.platform !== "win32") assert.equal(log.gemini.mode, 0o700)
    assert.equal(log.gemini.token, null)
    // macOS process.cwd() canonicalizes /var to /private/var.
    assert.equal(path.basename(log.path.split(path.delimiter)[0]), path.basename(log.cwd))
    assert.equal(path.dirname(log.browser), log.path.split(path.delimiter)[0])
    assert.equal(path.basename(log.browser), process.platform === "win32" ? "open.cmd" : "open")
    await assert.rejects(fs.stat(log.cwd), { code: "ENOENT" })
  }
  assert.equal(f.env.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
  await f.assertClean()
})

test("seeds a file-based sign-in into the isolated profile", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-home-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const token = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  await fs.mkdir(path.dirname(token), { recursive: true })
  await fs.writeFile(token, "test-token")
  const f = await fixture(t)
  const result = await fetchUsage(f.executable, { ...f.options, home })
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs[1].gemini.token, process.platform === "win32" ? null : token)
  assert.equal(await fs.readFile(token, "utf8"), "test-token")
  await f.assertClean()
})

test("falls back to the real Gemini dir when the CLI lacks the profile flag", async t => {
  const f = await fixture(t, { TEST_GEMINI_DIR: "unsupported" })
  const result = await fetchUsage(f.executable, f.options)
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs.length, 3)
  assert.equal(logs[0].unsupported, true)
  assert.deepEqual(logs[1].args, ["--version"])
  assert.ok(!logs[2].args.some(arg => arg.startsWith("--gemini_dir=")))
  await f.assertClean()
})

test("AGY_BRIDGE_USAGE=0 skips automatic quota probes entirely", async t => {
  const f = await fixture(t)
  for (const value of ["0", "false", "off", "no", "disabled"]) {
    const read = createUsageReader(() => f.executable, { ...f.options, env: { ...f.env, AGY_BRIDGE_USAGE: value } })
    assert.deepEqual(await read(), { windows: [], signIn: "kept" })
  }
  assert.deepEqual(await f.logs(), [])
  await f.assertClean()
  const read = createUsageReader(() => f.executable, { ...f.options, env: { ...f.env, AGY_BRIDGE_USAGE: "1" } })
  assert.equal((await read()).windows.length, 1)
  assert.equal((await f.logs()).length, 2)
  await f.assertClean()
})

test("rejects old/unverified versions before any possible model prompt", async t => {
  for (const version of ["1.1.10", "0.9.0", "garbage", "1.3", "1.3.5-beta"]) {
    const f = await fixture(t, { TEST_VERSION: version })
    await assert.rejects(fetchUsage(f.executable, f.options), /1\.1\.11 or later/)
    assert.equal((await f.logs()).length, 1)
    await f.assertClean()
  }
  for (const version of ["1.1.11", "1.2.0", "2.0.0"]) {
    const f = await fixture(t, { TEST_VERSION: version })
    assert.equal((await fetchUsage(f.executable, f.options)).windows.length, 1)
    await f.assertClean()
  }
})

test("only concurrent refreshes share work, and callers cannot mutate each other's data", async t => {
  const f = await fixture(t, { TEST_MODE: "delay" })
  const read = createUsageReader(() => f.executable, f.options)
  const results = await Promise.all([read(), read(), read()])
  assert.equal((await f.logs()).length, 2)
  assert.equal(results[0].signIn, "kept")
  results[0].windows[0].used = 99
  assert.equal(results[1].windows[0].used, 25)
  await read()
  assert.equal((await f.logs()).length, 4)
  await f.assertClean()
})

test("reports sanitized failures and preserves the bridge sign-in; failures are retryable", async t => {
  for (const [message, expected] of [
    ["Not logged in secret@example.com https://secret.invalid/token", /sign in again/],
    ["Eligibility check failed: EOF secret@example.com", /eligibility check failed on a network/],
    ["not eligible secret@example.com", /not eligible/],
    ["connection refused: secret@example.com https://secret.invalid", /network or proxy/],
    ["unrecognized secret@example.com", /could not read usage/],
  ]) {
    const f = await fixture(t, { TEST_MODE: "fail", TEST_ERROR: message })
    const read = createUsageReader(() => f.executable, f.options)
    const result = await read()
    assert.deepEqual(result.windows, [])
    assert.equal(result.signIn, "kept")
    assert.match(result.error, expected)
    assert.doesNotMatch(result.error, /secret|https:/)
    f.env.TEST_MODE = ""
    assert.equal((await read()).windows.length, 1)
    await f.assertClean()
  }
})

test("invalid and oversized stdout/stderr reports fail within the output budget", async t => {
  for (const [mode, expected, maxOutputBytes] of [
    ["malformed", /invalid usage report/, undefined],
    ["oversize", /size limit/, undefined],
    ["combined-output", /size limit/, 1000],
  ]) {
    const f = await fixture(t, { TEST_MODE: mode })
    await assert.rejects(fetchUsage(f.executable, { ...f.options, ...(maxOutputBytes ? { maxOutputBytes } : {}) }), expected)
    await f.assertClean()
  }
})

test("version/report hangs time out, terminate the process, and leave no workspace", async t => {
  for (const mode of ["version-hang", "hang"]) {
    const f = await fixture(t, { TEST_MODE: mode })
    await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs: process.platform === "win32" ? 8000 : 1500 }), /timed out/)
    const logs = await f.logs()
    assert.ok(logs.some(log => log.args.includes(mode === "version-hang" ? "--version" : "/usage")), "the intended hanging invocation must start")
    // The runner must actually stop the child, not just stop waiting for it.
    for (const log of logs) await waitForExit(log.pid)
    await f.assertClean()
  }
})

test("cancellation stops a running report and cleans its private workspace", async t => {
  const f = await fixture(t, { TEST_MODE: "hang" })
  const controller = new AbortController()
  const query = fetchUsage(f.executable, { ...f.options, timeoutMs: 18_000, signal: controller.signal })
  query.catch(() => {}) // Observe early rejection while waiting for fixture readiness.
  try {
    const log = await waitFor(async () => (await f.logs()).find(log => log.args.includes("/usage")), "usage report did not start")
    assert.equal(processRunning(log.pid), true)
    controller.abort()
    await assert.rejects(query, /cancelled/)
    await waitForExit(log.pid)
  } finally {
    controller.abort()
    await query.catch(() => {})
  }
  await f.assertClean()
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(fetchUsage(f.executable, { ...f.options, signal: alreadyAborted.signal }), /cancelled/)
  await f.assertClean()
})

test("POSIX terminates owned pipe-inheriting descendants even when the CLI parent already exited", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { TEST_MODE: "descendant" })
  await fetchUsage(f.executable, f.options)
  const pid = await f.descendantPid()
  assert.ok(pid)
  await waitForExit(pid)
  await f.assertClean()
})

test("Windows cancellation terminates inherited-pipe descendants while the parent is alive", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, { TEST_MODE: "live-descendant" })
  const controller = new AbortController()
  const query = fetchUsage(f.executable, { ...f.options, timeoutMs: 18_000, signal: controller.signal })
  query.catch(() => {})
  try {
    const pid = await waitFor(f.descendantPid, "usage descendant PID was not logged")
    const log = (await f.logs()).find(log => log.args.includes("/usage"))
    assert.ok(log, "the report parent must be logged before its descendant")
    assert.equal(processRunning(log.pid), true)
    assert.equal(processRunning(pid), true)
    controller.abort()
    await assert.rejects(query, /cancelled/)
    await waitForExit(log.pid)
    await waitForExit(pid)
  } finally {
    controller.abort()
    await query.catch(() => {})
  }
  await f.assertClean()
})

test("missing executables and filesystem failures do not leak local paths", async t => {
  const f = await fixture(t)
  for (const executable of [null, path.join(f.env.TEST_LOG, "missing")]) {
    const result = await createUsageReader(() => executable, f.options)()
    assert.equal(result.windows.length, 0)
    assert.ok(result.error)
    assert.doesNotMatch(result.error, /agy-usage-test-/)
    await f.assertClean()
  }
  const result = await createUsageReader(() => f.executable, { ...f.options, tempRoot: f.executable })()
  assert.ok(result.error)
  assert.doesNotMatch(result.error, /agy-usage-test-/)
})

// Exercise Windows launch/cleanup on any host. Real files keep profile isolation
// and credential tests meaningful; only the OS process boundary is simulated.
async function windowsFixture(t, { mode = "success", taskkill = "success", cleanupDelay = 10, onLaunch } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-windows-test-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const calls = []
  const kills = []
  const cleanups = []
  const cleanupStarts = []
  let nextPid = 400000
  const spawn = (file, args, options) => {
    const isCleanup = /taskkill\.exe$/i.test(file)
    if (isCleanup) cleanupStarts.push(performance.now())
    if (isCleanup && taskkill === "throw") throw new Error("fixture taskkill launch failure")
    const child = new EventEmitter()
    child.pid = nextPid++
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => { kills.push({ pid: child.pid, signal, at: performance.now() }); return true }
    const call = { file, args, options, child }
    calls.push(call)
    if (isCleanup) {
      if (taskkill === "hang") return child
      setTimeout(() => {
        cleanups.push(Number(args[1]))
        if (taskkill === "error") child.emit("error", new Error("fixture taskkill error"))
        else child.emit("close", taskkill === "nonzero" ? 1 : 0)
      }, cleanupDelay)
      return child
    }
    const version = args.some(arg => arg.includes("--version"))
    Promise.resolve().then(() => onLaunch?.(call, version)).then(() => {
      if (mode === "spawn-error") { child.pid = undefined; child.emit("error", new Error("fixture CLI error")); return }
      if (mode === "version-hang" || !version && mode === "hang") return
      if (!version && mode === "oversize") child.stdout.write(Buffer.alloc(2048, "x"))
      else if (!version && mode === "malformed") child.stdout.write("invalid secret@example.com")
      else if (!version && mode === "fail") child.stderr.write("Not logged in secret@example.com")
      else child.stdout.write(version ? "1.3.5\n" : JSON.stringify(report([group([bucket()])])))
      if (!version && mode === "exit-open-pipes") { child.emit("exit", 0); return }
      child.stdout.end()
      child.stderr.end()
      child.emit("exit", !version && mode === "fail" ? 1 : 0)
      child.emit("close", !version && mode === "fail" ? 1 : 0)
    }).catch(error => child.emit("error", error))
    return child
  }
  const env = Object.freeze({
    Path: "C:\\Program Files\\Tools;D:\\bin", ComSpec: "D:\\Windows\\System32\\cmd.exe", SystemRoot: "D:\\Windows", PathExt: ".EXE;.BAT",
    browser: "old-browser", agy_cli_disable_auto_update: "false", CALLER_ONLY: "kept",
  })
  const home = path.join(directory, "home")
  await fs.mkdir(home)
  return {
    directory, home, calls, kills, cleanups, cleanupStarts, env,
    options: { env, platform: "win32", spawn, tempRoot: directory, home },
    async assertClean() { assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith("magpie-agy-usage-")), []) },
  }
}

for (const extension of ["exe", "cmd", "bat"]) {
  test(`Windows .${extension} usage uses shared spawning, private blockers and awaited tree cleanup`, async t => {
    const blockers = []
    const f = await windowsFixture(t, { onLaunch: async ({ options }) => {
      blockers.push(await fs.readFile(options.env.BROWSER, "utf8"))
      assert.equal(await fs.readFile(path.join(options.cwd, "xdg-open.cmd"), "utf8"), "@echo off\r\nexit /b 1\r\n")
      assert.equal(await fs.readFile(path.join(options.cwd, "rundll32.cmd"), "utf8"), "@echo off\r\nexit /b 1\r\n")
    } })
    const removedAfter = []
    const fileSystem = { ...fs, rm: async (directory, options) => {
      removedAfter.push([...f.cleanups])
      assert.equal(options.maxRetries, 3)
      assert.equal(options.retryDelay, 50)
      return fs.rm(directory, options)
    } }
    const executable = `C:\\Program Files\\Antigravity & Tools\\agy.${extension}`
    const result = await fetchUsage(executable, { ...f.options, fs: fileSystem })
    assert.equal(result.windows[0].used, 25)
    const cli = f.calls.filter(call => !/taskkill\.exe$/i.test(call.file))
    const cleanup = f.calls.filter(call => /taskkill\.exe$/i.test(call.file))
    assert.equal(cli.length, 2)
    assert.equal(cleanup.length, 2)
    assert.deepEqual(removedAfter, [cli.map(call => call.child.pid)], "temporary files must survive until taskkill has finished")
    for (const [index, call] of cli.entries()) {
      const { options } = call
      const args = index === 0
        ? [`--gemini_dir=${path.join(options.cwd, "gemini")}`, "--version"]
        : [`--gemini_dir=${path.join(options.cwd, "gemini")}`, "-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", "15s"]
      // The print timeout is derived from the deadline; don't depend on test speed.
      if (index === 1) {
        const seconds = extension === "exe" ? call.args.at(-1) : /(\d+s)\^""$/.exec(call.args.at(-1))?.[1]
        assert.match(seconds, /^\d+s$/)
        args[args.length - 1] = seconds
      }
      const expected = agySpawnSpec(executable, args, "win32", options.env)
      assert.equal(call.file, expected.file)
      assert.deepEqual(call.args, expected.args)
      assert.equal(options.windowsHide, true)
      assert.equal(options.detached, false)
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"])
      assert.equal(options.windowsVerbatimArguments, expected.options.windowsVerbatimArguments)
      assert.deepEqual(Object.keys(options.env).filter(key => /^path$/i.test(key)), ["Path"])
      assert.equal(options.env.Path, options.cwd + ";" + f.env.Path)
      assert.equal(options.env.PathExt, ".EXE;.BAT;.CMD")
      assert.equal(options.env.PATHEXT, undefined)
      assert.equal(options.env.BROWSER, path.join(options.cwd, "open.cmd"))
      assert.equal(options.env.browser, undefined)
      assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true")
      assert.equal(options.env.agy_cli_disable_auto_update, undefined)
      assert.equal(options.env.CALLER_ONLY, "kept")
      assert.equal(cleanup[index].file, "D:\\Windows\\System32\\taskkill.exe")
      assert.deepEqual(cleanup[index].args, ["/PID", String(call.child.pid), "/T", "/F"])
      assert.equal(cleanup[index].options.windowsHide, true)
      assert.equal(cleanup[index].options.detached, false)
      assert.equal(cleanup[index].options.stdio, "ignore")
    }
    assert.deepEqual(blockers, ["@echo off\r\nexit /b 1\r\n", "@echo off\r\nexit /b 1\r\n"])
    assert.equal(f.env.browser, "old-browser")
    assert.equal(f.env.PathExt, ".EXE;.BAT")
    assert.equal(f.env.agy_cli_disable_auto_update, "false")
    await f.assertClean()
  })
}

test("Windows copies credentials without symlink privileges or hardlink write-through", async t => {
  let source
  let checked = 0
  const f = await windowsFixture(t, { onLaunch: async ({ options }, version) => {
    const token = path.join(options.cwd, "gemini", "antigravity-cli", "antigravity-oauth-token")
    assert.equal((await fs.lstat(token)).isSymbolicLink(), false)
    assert.equal(await fs.readFile(token, "utf8"), version ? "fixture credential" : "private refreshed credential")
    if (version) await fs.writeFile(token, "private refreshed credential")
    assert.equal(await fs.readFile(source, "utf8"), "fixture credential")
    if (process.platform !== "win32") assert.equal((await fs.stat(token)).mode & 0o777, 0o600)
    checked++
  } })
  source = path.join(f.home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, "fixture credential", { mode: 0o640 })
  const before = await fs.stat(source)
  const noLinks = () => { throw Object.assign(new Error("Windows symlink privileges unavailable"), { code: "EPERM" }) }
  const result = await fetchUsage("C:\\agy.exe", { ...f.options, fs: { ...fs, symlink: noLinks, link: noLinks } })
  assert.equal(result.windows[0].used, 25)
  assert.equal(checked, 2)
  assert.equal(await fs.readFile(source, "utf8"), "fixture credential")
  assert.equal((await fs.stat(source)).mode, before.mode, "do not chmod a source credential")
  await f.assertClean()
})

test("Windows fixed account queries preserve the selected profile and remove only the workspace", async t => {
  const f = await windowsFixture(t)
  const account = path.join(f.directory, "named-account")
  await fs.mkdir(account)
  await fs.writeFile(path.join(account, "keep"), "account settings")
  const result = await fetchUsage("C:\\agy.exe", { ...f.options, geminiDir: account })
  assert.equal(result.windows[0].used, 25)
  for (const call of f.calls.filter(call => call.file === "C:\\agy.exe")) assert.equal(call.args[0], `--gemini_dir=${account}`)
  assert.equal(await fs.readFile(path.join(account, "keep"), "utf8"), "account settings")
  await f.assertClean()
})

test("Windows runner attempts taskkill on parent exit even while pipes remain open", async t => {
  const f = await windowsFixture(t, { mode: "exit-open-pipes", taskkill: "nonzero" })
  const controller = new AbortController()
  const query = fetchUsage("C:\\agy.exe", { ...f.options, signal: controller.signal })
  query.catch(() => {})
  try {
    const cleanup = await waitFor(() => {
      const report = f.calls.find(call => call.file === "C:\\agy.exe" && call.args.includes("/usage"))
      return report && f.calls.find(call => /taskkill\.exe$/i.test(call.file) && call.args[1] === String(report.child.pid))
    }, "parent exit did not attempt taskkill")
    assert.deepEqual(cleanup.args.slice(2), ["/T", "/F"])
    // The mock leaves pipes open; it makes no claim that taskkill can find an
    // exited parent's descendants on Windows. Cancel to finish this query.
    controller.abort()
    await assert.rejects(query, /cancelled/)
  } finally {
    controller.abort()
    await query.catch(() => {})
  }
  await f.assertClean()
})

test("Windows cancellation, timeouts and output limits await cleanup before removing files", async t => {
  for (const mode of ["version-hang", "hang", "oversize", "malformed", "fail"]) {
    const f = await windowsFixture(t, { mode })
    const timeoutMs = mode.includes("hang") ? (process.platform === "win32" ? 4000 : 1000) : 15_000
    await assert.rejects(fetchUsage("C:\\agy.exe", { ...f.options, timeoutMs, maxOutputBytes: 1024 }),
      mode.includes("hang") ? /timed out/ : mode === "oversize" ? /size limit/ : mode === "fail" ? /sign in again/ : /invalid usage report/)
    assert.ok(f.calls.some(call => call.file === "C:\\agy.exe" && call.args.includes(mode === "version-hang" ? "--version" : "/usage")), "the intended invocation must start")
    assert.deepEqual(f.cleanups, f.calls.filter(call => call.file === "C:\\agy.exe").map(call => call.child.pid))
    await f.assertClean()
  }
  const controller = new AbortController()
  const f = await windowsFixture(t, { mode: "hang", onLaunch: (_call, version) => { if (!version) controller.abort() } })
  await assert.rejects(fetchUsage("C:\\agy.exe", { ...f.options, signal: controller.signal }), /cancelled/)
  assert.equal(f.cleanups.length, 2)
  await f.assertClean()
  const aborted = new AbortController()
  aborted.abort()
  const unused = await windowsFixture(t)
  await assert.rejects(fetchUsage("C:\\agy.exe", { ...unused.options, signal: aborted.signal }), /cancelled/)
  assert.equal(unused.calls.length, 0)
  await unused.assertClean()
})

test("Windows cancellation during spawn still handles an asynchronous spawn error", async t => {
  const f = await windowsFixture(t, { mode: "spawn-error" })
  const controller = new AbortController()
  const spawn = (...args) => {
    const child = f.options.spawn(...args)
    controller.abort()
    return child
  }
  await assert.rejects(fetchUsage("C:\\agy.exe", { ...f.options, spawn, signal: controller.signal }), /cancelled/)
  await f.assertClean()
})

test("Windows taskkill failures fall back to the owned child and cannot hang the query", async t => {
  for (const taskkill of ["throw", "error", "nonzero", "hang"]) {
    const controller = new AbortController()
    const f = await windowsFixture(t, { taskkill, mode: "version-hang", onLaunch: () => controller.abort() })
    await assert.rejects(fetchUsage("C:\\agy.exe", { ...f.options, signal: controller.signal }), /cancelled/)
    assert.equal(f.cleanupStarts.length, 1)
    const fallback = f.kills.find(kill => kill.pid === f.calls[0].child.pid && kill.signal === "SIGKILL")
    assert.ok(fallback)
    assert.ok(fallback.at - f.cleanupStarts[0] < 3000, "taskkill fallback must be bounded independently of filesystem setup/removal")
    if (taskkill === "hang") assert.ok(f.kills.some(kill => kill.pid === f.calls[1].child.pid))
    await f.assertClean()
  }
  const f = await windowsFixture(t, { mode: "spawn-error" })
  await assert.rejects(fetchUsage("C:\\agy.exe", f.options), /could not start/)
  assert.equal(f.calls.length, 1, "a failed spawn has no owned PID to taskkill")
  await f.assertClean()
})

test("Windows reports exhausted workspace cleanup without disclosing local paths", async t => {
  const f = await windowsFixture(t)
  const result = await createUsageReader(() => "C:\\agy.exe", { ...f.options, fs: {
    ...fs,
    rm: async () => { throw Object.assign(new Error(`EPERM: ${f.directory}`), { code: "EPERM" }) },
  } })()
  assert.deepEqual(result.windows, [])
  assert.equal(result.signIn, "kept")
  assert.match(result.error, /could not remove its temporary workspace/)
  assert.doesNotMatch(result.error, /agy-usage-windows-test-/)
})
