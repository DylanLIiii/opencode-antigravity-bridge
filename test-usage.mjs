import assert from "node:assert/strict"
import childProcess, { spawnSync } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createUsageReader, fetchUsage, parseUsageReport } from "./usage.mjs"

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

async function fixture(t, extraEnv = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-test-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, "fake.mjs")
  const executable = path.join(directory, "agy")
  const logPath = path.join(directory, "calls.jsonl")
  await fs.writeFile(script, String.raw`
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
const record = {
  args, cwd: process.cwd(), pid: process.pid,
  update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  path: process.env.PATH, browser: process.env.BROWSER,
  agent: fs.readFileSync(path.join(process.cwd(), ".agents/agents/magpie-usage/agent.md"), "utf8"),
  mode: fs.statSync(process.cwd()).mode & 0o777,
  guard: spawnSync(process.env.BROWSER).status,
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
} else if (mode === "descendant") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" })
  fs.writeFileSync(process.env.TEST_DESCENDANT, String(child.pid))
  child.unref()
  console.log(process.env.TEST_REPORT)
} else {
  if (mode === "delay") await new Promise(resolve => setTimeout(resolve, 150))
  console.log(process.env.TEST_REPORT)
}
`)
  await fs.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 })
  const env = { ...process.env, TEST_LOG: logPath, TEST_REPORT: JSON.stringify(report([group([bucket()])])), TEST_DESCENDANT: path.join(directory, "descendant"), ...extraEnv }
  const home = path.join(directory, "home")
  await fs.mkdir(home, { recursive: true })
  return {
    executable, env,
    options: { env, tempRoot: directory, home },
    async logs() {
      try {
        return (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      } catch (error) {
        if (error.code === "ENOENT") return []
        throw error
      }
    },
    async assertClean() { assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith("magpie-agy-usage-")), []) },
  }
}

test("queries only the structured command in a private, restricted workspace and cleans up", async t => {
  const f = await fixture(t, { AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
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
  assert.equal(spawns.length, 2)
  for (const [index, actual] of spawns.entries()) {
    assert.equal(actual.file, f.executable)
    assert.deepEqual(actual.args, logs[index].args)
    assert.equal(actual.options.windowsHide, true, "usage must hide both version and report child windows")
    assert.equal(actual.options.detached, true)
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
    assert.equal(log.mode, 0o700)
    assert.equal(log.update, "true")
    assert.ok(log.agent.includes("tools: []\nmcpServers: []"))
    assert.ok(log.agent.includes("inheritMcp: false\ninheritCustomizations: false\nexcludeDefaultComponents: true"))
    assert.equal(log.guard, 1)
    assert.equal(log.gemini.mode, 0o700)
    assert.equal(log.gemini.token, null)
    // macOS process.cwd() canonicalizes /var to /private/var.
    assert.equal(path.basename(log.path.split(path.delimiter)[0]), path.basename(log.cwd))
    assert.equal(path.dirname(log.browser), log.path.split(path.delimiter)[0])
    assert.equal(path.basename(log.browser), "open")
    await assert.rejects(fs.stat(log.cwd), { code: "ENOENT" })
  }
  assert.equal(f.env.AGY_CLI_DISABLE_AUTO_UPDATE, "false")
  await f.assertClean()
})

test("links a file-based sign-in into the isolated profile without copying it", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-home-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const token = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  await fs.mkdir(path.dirname(token), { recursive: true })
  await fs.writeFile(token, "test-token")
  const f = await fixture(t)
  const result = await fetchUsage(f.executable, { ...f.options, home })
  assert.equal(result.windows[0].used, 25)
  const logs = await f.logs()
  assert.equal(logs[1].gemini.token, token)
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

test("native Windows usage stays unsupported and never starts a CLI", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  const originalSpawn = childProcess.spawn
  let calls = 0
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" })
    childProcess.spawn = () => { calls++; throw new Error("unexpected CLI launch") }
    syncBuiltinESMExports()
    await assert.rejects(fetchUsage("C:\\Program Files\\Antigravity\\agy.exe"), /currently require macOS or Linux/)
    assert.equal(calls, 0)
  } finally {
    Object.defineProperty(process, "platform", descriptor)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
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
    await assert.rejects(fetchUsage(f.executable, { ...f.options, timeoutMs: 600 }), /timed out/)
    // The runner must actually stop the child, not just stop waiting for it.
    for (const log of await f.logs()) {
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.throws(() => process.kill(log.pid, 0), { code: "ESRCH" })
    }
    await f.assertClean()
  }
})

test("cancellation stops a running report and cleans its private workspace", async t => {
  const f = await fixture(t, { TEST_MODE: "hang" })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600)
  try {
    await assert.rejects(fetchUsage(f.executable, { ...f.options, signal: controller.signal }), /cancelled/)
  } finally { clearTimeout(timer) }
  await f.assertClean()
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(fetchUsage(f.executable, { ...f.options, signal: alreadyAborted.signal }), /cancelled/)
  await f.assertClean()
})

test("terminates owned pipe-inheriting descendants even when the CLI parent already exited", async t => {
  const f = await fixture(t, { TEST_MODE: "descendant" })
  await fetchUsage(f.executable, f.options)
  const pid = Number(await fs.readFile(f.env.TEST_DESCENDANT, "utf8"))
  await new Promise(resolve => setTimeout(resolve, 50))
  // A dead orphan can briefly be a zombie on Linux, which has no running code.
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith("Z"))
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
