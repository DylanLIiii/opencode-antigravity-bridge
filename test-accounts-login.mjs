import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { test } from "node:test"
import { createAccountLoginMethod } from "./accounts-login.mjs"
import { listAccounts } from "./accounts.mjs"
import { TOKEN_RELATIVE } from "./accounts-import.mjs"

const SECRET = "SYNTHETIC_LOGIN_SECRET"
const STATE = "synthetic-state"
const redirect = "https://antigravity.google/oauth-callback"
const authURL = "https://accounts.google.com/o/oauth2/auth?" + new URLSearchParams({
  client_id: "synthetic-client", response_type: "code", redirect_uri: redirect,
  state: STATE, code_challenge: "synthetic-challenge", code_challenge_method: "S256",
})
const callbackURL = (code = "4/synthetic-code", state = STATE) => redirect + "?" + new URLSearchParams({ code, state })

// Real pipes/process exits exercise the handoff, without Google or real credentials.
const cli = String.raw`
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
const args = process.argv.slice(2)
const dir = args.find(x => x.startsWith("--gemini_dir="))?.slice(13)
const mode = process.env.FAKE_LOGIN_MODE
fs.appendFileSync(process.env.FAKE_LOGIN_LOG, JSON.stringify({ args, dir, pid: process.pid, cwd: process.cwd(),
  fileStorage: process.env.WSL_INTEROP, update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE, browser: process.env.BROWSER }) + "\n")
if (args.includes("--login")) {
  if (mode === "no-url") { process.stdout.write("SYNTHETIC_LOGIN_SECRET"); setInterval(() => {}, 1000) }
  else if (mode === "oversize") { process.stdout.write("SYNTHETIC_LOGIN_SECRET".repeat(10000)); setInterval(() => {}, 1000) }
  else if (mode === "early-exit") { console.error("SYNTHETIC_LOGIN_SECRET"); process.exit(3) }
  else {
    const link = process.env.FAKE_AUTH_URL
    // A partial chunk must not resolve authorize with a truncated query/state.
    process.stderr.write("\x1b[32mOpen this link:\x1b[0m\n" + link.slice(0, 70))
    setTimeout(() => process.stderr.write(link.slice(70) + "\nThen paste the code or URL:\n"), 5)
    readline.createInterface({ input: process.stdin }).once("line", line => {
      if (mode === "hang-finish") return setInterval(() => {}, 1000)
      if (mode === "login-fail") { console.error("SYNTHETIC_LOGIN_SECRET " + line); process.exit(4) }
      const app = path.join(dir, "antigravity-cli")
      fs.mkdirSync(app, { recursive: true })
      if (mode !== "missing-token") fs.writeFileSync(path.join(app, "antigravity-oauth-token"),
        mode === "bad-token" ? "SYNTHETIC_LOGIN_SECRET" : JSON.stringify({
          access_token: "SYNTHETIC_LOGIN_SECRET_a",
          ...(mode === "no-refresh" ? {} : { refresh_token: "SYNTHETIC_LOGIN_SECRET_r" }),
        }))
      process.exit(0)
    })
  }
} else if (args.includes("models")) {
  if (mode === "hang-probe") setInterval(() => {}, 1000)
  else if (mode === "probe-fail") { console.error("SYNTHETIC_LOGIN_SECRET"); process.exit(5) }
  else { console.log("gemini-test Gemini Test"); process.exit(0) }
} else process.exit(9)
`

function fixture(t, mode = "ok", options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-login-test-"))
  const accounts = path.join(root, "accounts")
  const file = path.join(root, "fake-agy.mjs")
  const log = path.join(root, "calls.jsonl")
  fs.writeFileSync(file, cli)
  let imports = 0
  const env = { ...process.env, AGY_BRIDGE_ACCOUNTS_DIR: accounts, FAKE_LOGIN_MODE: mode, FAKE_AUTH_URL: authURL, FAKE_LOGIN_LOG: log }
  const method = createAccountLoginMethod(() => "synthetic-agy", {
    env, onImport: () => imports++,
    spawnProcess: (_file, args, opts) => spawn(process.execPath, [file, ...args], opts),
    urlTimeoutMs: 2000, finishTimeoutMs: 2000, probeTimeoutMs: 2000, loginTimeoutMs: 5000,
    ...options,
  })
  const controller = new AbortController()
  let ticket
  t.after(async () => {
    controller.abort()
    if (ticket?.callback) await ticket.callback("", { signal: controller.signal })
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    method, root, accounts, env,
    begin: async (name = "work", ctx) => ticket = await method.authorize({ name }, ctx),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
    entries: () => fs.existsSync(accounts) ? fs.readdirSync(accounts) : [],
    imports: () => imports,
  }
}

const failed = (result, pattern) => {
  assert.equal(result.type, "failed")
  assert.ok(!JSON.stringify(result).includes(SECRET), "child output and credentials never reach UI errors")
  if (pattern) assert.match(result.error, pattern)
}

test("native OAuth method asks for a named account and publishes only after callback and validation", async t => {
  const f = fixture(t)
  assert.equal(f.method.type, "oauth")
  assert.match(f.method.label, /Google/)
  assert.match(f.method.label, /[\u4e00-\u9fff]/)
  assert.equal(f.method.prompts[0].key, "name")
  assert.ok(f.method.prompts[0].validate("../bad"))
  assert.equal(f.method.prompts[0].validate("work"), undefined)
  const ticket = await f.begin(" work ")
  assert.equal(ticket.method, "code")
  assert.equal(ticket.url, authURL)
  assert.match(ticket.instructions, /URL/)
  assert.deepEqual(listAccounts(f.env, { refresh: true }).map(a => a.name), [null])
  assert.ok(f.entries().every(name => name.startsWith(".login-")))
  const result = await ticket.callback(callbackURL())
  assert.deepEqual(result, { type: "success", key: "agy" })
  assert.deepEqual(f.entries(), ["work"])
  assert.equal(f.imports(), 1)
  assert.deepEqual(listAccounts(f.env).map(a => a.name), [null, "work"])
  const token = path.join(f.accounts, "work", TOKEN_RELATIVE)
  assert.equal(JSON.parse(fs.readFileSync(token, "utf8")).refresh_token, SECRET + "_r")
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(token).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(token)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.dirname(path.dirname(token))).mode & 0o777, 0o700)
  }
  const calls = f.calls()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args.slice(0, 2), ["acp", "--login"])
  assert.ok(calls[1].args.includes("models"))
  assert.equal(calls[0].dir, calls[1].dir)
  assert.ok(calls.every(c => c.dir.startsWith(path.join(f.accounts, ".login-")) && c.fileStorage && c.update === "true" && c.browser))
  assert.ok(!fs.existsSync(calls[0].dir), "staging is removed after publication")
  failed(await ticket.callback(callbackURL()), /already|over|finished/i)
})

test("raw authorization codes are accepted, and a real WSL interop path is preserved", async t => {
  const f = fixture(t)
  f.env.WSL_INTEROP = "/run/WSL/synthetic_interop"
  const ticket = await f.begin()
  assert.equal((await ticket.callback(" 4/synthetic-code ")).type, "success")
  assert.equal(f.calls()[0].fileStorage, f.env.WSL_INTEROP)
})

test("bad names, missing CLI and existing names fail before spawning", async t => {
  const f = fixture(t)
  failed(await f.begin("../bad"), /name/i)
  assert.equal(f.calls().length, 0)
  fs.mkdirSync(path.join(f.accounts, "WORK"), { recursive: true })
  failed(await f.begin("work"), /already exists/i)
  assert.equal(f.calls().length, 0)
  const method = createAccountLoginMethod(() => null, { env: f.env })
  failed(await method.authorize({ name: "fresh" }), /not found|install/i)
})

for (const [label, value] of [
  ["wrong state", callbackURL("4/synthetic-code", "other")],
  ["missing state", redirect + "?code=synthetic"],
  ["foreign origin", "https://example.test/oauth-callback?code=synthetic&state=" + STATE],
  ["foreign path", "https://antigravity.google/other?code=synthetic&state=" + STATE],
  ["duplicate code", callbackURL() + "&code=other"],
  ["duplicate state", callbackURL() + "&state=" + STATE],
  ["OAuth error", redirect + "?error=" + SECRET + "&state=" + STATE],
  ["newline injection", "synthetic\nother"],
  ["empty code", "  "],
  ["oversized code", "x".repeat(17000)],
]) test(`rejects ${label} without publishing or echoing callback secrets`, async t => {
  const f = fixture(t)
  const ticket = await f.begin()
  failed(await ticket.callback(value))
  assert.deepEqual(f.entries(), [])
  assert.equal(f.imports(), 0)
})

for (const mode of ["login-fail", "missing-token", "bad-token", "no-refresh", "probe-fail"]) {
  test(`${mode} never publishes an account`, async t => {
    const f = fixture(t, mode)
    const ticket = await f.begin()
    failed(await ticket.callback(callbackURL()))
    assert.deepEqual(f.entries(), [])
    assert.equal(f.imports(), 0)
  })
}

for (const mode of ["early-exit", "no-url", "oversize"]) {
  test(`${mode} fails authorize and cleans the hidden profile`, async t => {
    const f = fixture(t, mode, { urlTimeoutMs: 300 })
    failed(await f.begin())
    assert.deepEqual(f.entries(), [])
  })
}

test("an unsupported authorization URL is rejected before returning it to the UI", async t => {
  const f = fixture(t)
  f.env.FAKE_AUTH_URL = authURL.replace("code_challenge_method=S256", "code_challenge_method=plain")
  failed(await f.begin(), /authorization|PKCE/i)
  assert.deepEqual(f.entries(), [])
})

for (const mode of ["hang-finish", "hang-probe"]) {
  test(`${mode} has a bounded completion time and cleanup`, async t => {
    const f = fixture(t, mode, { finishTimeoutMs: 200, probeTimeoutMs: 200 })
    const ticket = await f.begin()
    failed(await ticket.callback(callbackURL()), /timed out|expired/i)
    assert.deepEqual(f.entries(), [])
  })
}

test("cancellation before authorize does not create a profile or spawn a CLI", async t => {
  const f = fixture(t)
  failed(await f.begin("work", { signal: AbortSignal.abort() }), /cancel/i)
  assert.equal(f.calls().length, 0)
  assert.deepEqual(f.entries(), [])
})

test("cancellation while awaiting the authorization URL cleans up", async t => {
  const f = fixture(t, "no-url")
  const abort = new AbortController()
  const promise = f.begin("work", { signal: abort.signal })
  setTimeout(() => abort.abort(), 100)
  failed(await promise, /cancel/i)
  assert.deepEqual(f.entries(), [])
})

test("the authorize RPC ending does not cancel the browser step, but callback cancellation does", async t => {
  const f = fixture(t, "hang-finish")
  const start = new AbortController()
  const ticket = await f.begin("work", { signal: start.signal })
  start.abort() // Magpie ends its authorize RPC as soon as it receives the URL.
  const finish = new AbortController()
  const result = ticket.callback(callbackURL(), { signal: finish.signal })
  setTimeout(() => finish.abort(), 50)
  failed(await result, /cancel/i)
  assert.deepEqual(f.entries(), [])
})

test("a newer login cancels the older child and removes only its staging directory", async t => {
  const f = fixture(t)
  const first = await f.begin("first")
  const second = await f.begin("second")
  failed(await first.callback(callbackURL()))
  assert.equal((await second.callback("synthetic-code")).type, "success")
  assert.deepEqual(f.entries(), ["second"])
})

test("an abandoned browser step expires without publishing", async t => {
  const f = fixture(t, "ok", { loginTimeoutMs: 250 })
  const ticket = await f.begin()
  await new Promise(resolve => setTimeout(resolve, 350))
  failed(await ticket.callback(callbackURL()), /expired|timed out/i)
  assert.deepEqual(f.entries(), [])
})

test("a name created during login is preserved by the import transaction", async t => {
  const f = fixture(t)
  const ticket = await f.begin()
  const token = path.join(f.accounts, "work", TOKEN_RELATIVE)
  fs.mkdirSync(path.dirname(token), { recursive: true })
  fs.writeFileSync(token, "existing account")
  failed(await ticket.callback(callbackURL()), /already exists/i)
  assert.equal(fs.readFileSync(token, "utf8"), "existing account")
  assert.deepEqual(f.entries(), ["work"])
  assert.equal(f.imports(), 0)
})

test("a CLI spawn failure cleans staging without exposing the exception", async t => {
  const f = fixture(t, "ok", { spawnProcess: () => { throw new Error(SECRET) } })
  failed(await f.begin(), /Could not start/)
  assert.deepEqual(f.entries(), [])
})

test("overlapping authorize calls leave only the newest browser step alive", async t => {
  const f = fixture(t)
  const first = f.method.authorize({ name: "first" })
  const second = f.begin("second")
  failed(await first, /cancel|replaced/i)
  assert.equal((await (await second).callback("synthetic-code")).type, "success")
  assert.deepEqual(f.entries(), ["second"])
})

test("a pending login keeps its original account root if the environment changes", async t => {
  const f = fixture(t)
  const ticket = await f.begin()
  const changed = path.join(f.root, "different-accounts")
  f.env.AGY_BRIDGE_ACCOUNTS_DIR = changed
  assert.equal((await ticket.callback(callbackURL())).type, "success")
  assert.ok(fs.existsSync(path.join(f.accounts, "work", TOKEN_RELATIVE)))
  assert.ok(!fs.existsSync(changed))
})

test("Windows login uses escaped batch arguments and one spelling per environment variable", async t => {
  const f = fixture(t)
  const calls = []
  const method = createAccountLoginMethod(() => "C:\\Program Files\\agy.cmd", {
    env: { AGY_BRIDGE_ACCOUNTS_DIR: f.accounts, Path: "C:\\Windows", Pathext: ".EXE;.BAT", wsl_interop: "/run/real-interop", ComSpec: "C:\\Windows\\cmd.exe" },
    platform: "win32",
    spawnProcess: (file, args, options) => {
      calls.push({ file, args, options })
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new Writable({ write: (_chunk, _encoding, complete) => {
        const token = path.join(options.cwd, "profile", TOKEN_RELATIVE)
        fs.mkdirSync(path.dirname(token), { recursive: true })
        fs.writeFileSync(token, JSON.stringify({ refresh_token: SECRET }))
        complete()
        queueMicrotask(() => child.emit("close", 0))
      } })
      queueMicrotask(() => {
        if (calls.length === 1) child.stdout.write(authURL + "\r\n")
        else { child.stdout.write("gemini-test\r\n"); child.emit("close", 0) }
      })
      return child
    },
  })
  const ticket = await method.authorize({ name: "windows" })
  assert.equal((await ticket.callback(callbackURL())).type, "success")
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.file, "C:\\Windows\\cmd.exe")
    assert.ok(call.args.join(" ").includes("agy.cmd"))
    assert.equal(call.options.windowsVerbatimArguments, true)
    assert.equal(call.options.windowsHide, true)
    assert.equal(call.options.detached, false)
    for (const key of ["PATH", "PATHEXT", "WSL_INTEROP"]) {
      assert.equal(Object.keys(call.options.env).filter(name => name.toUpperCase() === key).length, 1)
    }
    assert.equal(call.options.env.WSL_INTEROP, "/run/real-interop")
    assert.match(call.options.env.PATHEXT, /\.CMD$/)
    assert.match(call.options.env.BROWSER, /open\.cmd$/)
  }
})
