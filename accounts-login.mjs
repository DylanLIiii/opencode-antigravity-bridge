// Magpie owns the UI; the official `agy acp --login` owns PKCE, token exchange
// and credential refresh. Only a completed, verified login is imported into the
// named-account store. No Google token is returned to Magpie's auth store.
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { accountsRootDir } from "./accounts.mjs"
import { importAccount, ImportError, TOKEN_RELATIVE, validateAccountName } from "./accounts-import.mjs"
import { agySpawnSpec, childEnv } from "./platform.mjs"
import { ACCOUNT_ACTIONS, ACCOUNT_NAME_PROMPT } from "./account-ui.mjs"

const MAX_OUTPUT_BYTES = 128 * 1024
const MAX_INPUT_BYTES = 16 * 1024
const MAX_TOKEN_BYTES = 1024 * 1024
const CANCELLED = "The agy sign-in was cancelled. Start it again to continue."
class LoginError extends Error {}

const failed = error => ({
  type: "failed",
  // Child output, exception messages, OAuth codes and token errors may contain
  // credentials. Only our own fixed messages and the importer's errors are safe.
  error: error instanceof LoginError || error instanceof ImportError
    ? error.message : "Could not prepare the isolated agy sign-in. Try again.",
})

function systemTaskkill(env) {
  const root = Object.entries(env).find(([key]) => /^systemroot$/i.test(key))?.[1] || "C:\\Windows"
  return path.win32.join(root, "System32", "taskkill.exe")
}

function killGroup(child) {
  try { process.kill(-child.pid, "SIGKILL") } catch {
    try { child.kill("SIGKILL") } catch {}
  }
}

async function stopTree(child, platform, env) {
  if (!child?.pid) return
  if (platform !== "win32") return killGroup(child)
  await new Promise(resolve => {
    let killer
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill("SIGKILL") } catch {}
      resolve()
    }
    const timer = setTimeout(() => {
      try { killer?.kill("SIGKILL") } catch {}
      finish()
    }, 2000)
    try {
      killer = spawn(systemTaskkill(env), ["/PID", String(child.pid), "/T", "/F"], { env, windowsHide: true, stdio: "ignore" })
      killer.once("error", finish)
      killer.once("close", finish)
    } catch { finish() }
  })
}

// Resolve errors as data: the login can exit or time out while the user is in
// their browser, before Magpie calls callback(). There must be no unhandled
// rejection during that gap. Every path reaps our own process tree and pipes.
function startCli(agy, args, { env, cwd, platform, spawnProcess, signal, timeoutMs, phase, output }) {
  let child, settled = false, bytes = 0, text = "", timer, stopping
  let complete
  const done = new Promise(resolve => { complete = resolve })
  const stop = () => stopping ??= stopTree(child, platform, env)
  const finish = async (error, code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    await stop()
    child?.stdin?.destroy()
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    complete({ error, code, stdout: text })
  }
  const abort = () => { void finish(new LoginError(CANCELLED)) }
  if (signal.aborted) abort()
  else {
    try {
      const spec = agySpawnSpec(agy, args, platform, env)
      child = spawnProcess(spec.file, spec.args, {
        ...spec.options, env, cwd, detached: platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      })
      const collect = stdout => chunk => {
        if (settled) return
        bytes += chunk.length
        if (bytes > MAX_OUTPUT_BYTES) return void finish(new LoginError(`agy ${phase} output exceeded the size limit.`))
        if (stdout) text += chunk.toString("utf8")
        try { output?.(chunk.toString("utf8"), stdout) } catch (error) { void finish(error) }
      }
      child.stdout.on("data", collect(true))
      child.stderr.on("data", collect(false))
      child.stdin.on("error", () => { void finish(new LoginError(`agy ${phase} could not accept the authorization code.`)) })
      child.on("error", () => { void finish(new LoginError(`Could not start agy ${phase}. Install a CLI supporting acp --login.`)) })
      child.on("exit", () => { void stop() })
      child.on("close", code => { void finish(null, code) })
      signal.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => { void finish(new LoginError(`agy ${phase} timed out. Start the sign-in again.`)) }, timeoutMs)
      if (signal.aborted) abort()
    } catch { void finish(new LoginError(`Could not start agy ${phase}. Install a CLI supporting acp --login.`)) }
  }
  return {
    done,
    write: value => {
      if (settled) throw new LoginError("The agy login process has already exited. Start the sign-in again.")
      child.stdin.end(value + "\n")
    },
    stopAtExit: () => {
      if (!child?.pid || child.exitCode != null || child.signalCode != null) return
      if (platform !== "win32") killGroup(child)
      else {
        try { spawnSync(systemTaskkill(env), ["/PID", String(child.pid), "/T", "/F"], { env, windowsHide: true, stdio: "ignore", timeout: 2000 }) } catch {}
      }
    },
  }
}

function authorizationURL(text) {
  // Wait for a delimiter: an authorization URL can span multiple pipe chunks.
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  const raw = /https:\/\/accounts\.google\.com\/[^\s"'<>\x1b]+(?=[\s"'<>\x1b])/.exec(clean)?.[0]
  if (!raw) return null
  if (raw.length > MAX_INPUT_BYTES) throw new LoginError("agy returned an oversized authorization URL.")
  const url = new URL(raw)
  const q = url.searchParams
  let redirect
  try { redirect = new URL(q.get("redirect_uri")) } catch {}
  if (!["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) || url.username || url.password || url.hash ||
      q.get("response_type") !== "code" || !q.get("state") || !q.get("code_challenge") || q.get("code_challenge_method") !== "S256" ||
      !redirect || redirect.href !== "https://antigravity.google/oauth-callback") {
    throw new LoginError("agy returned an unsupported authorization URL or PKCE configuration. Update the CLI and try again.")
  }
  return { url: raw, redirect, state: q.get("state") }
}

function authorizationCode(raw, auth) {
  const value = typeof raw === "string" ? raw.trim() : ""
  if (!value || Buffer.byteLength(value) > MAX_INPUT_BYTES || /[\r\n\0]/.test(value)) {
    throw new LoginError("Paste the authorization code or the full callback URL from this sign-in.")
  }
  if (!value.includes("://")) {
    if (!/^[A-Za-z0-9._~+\/-]+$/.test(value)) throw new LoginError("That is not an authorization code or callback URL.")
    return value
  }
  let url
  try { url = new URL(value) } catch { throw new LoginError("That is not a valid callback URL.") }
  if (url.origin !== auth.redirect.origin || url.pathname !== auth.redirect.pathname || url.username || url.password || url.hash ||
      url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== auth.state) {
    throw new LoginError("That callback URL does not belong to this sign-in. Start again and paste its final URL.")
  }
  if (url.searchParams.has("error")) throw new LoginError("Google did not authorize this sign-in. Start again to continue.")
  if (url.searchParams.getAll("code").length !== 1) throw new LoginError("The callback URL must contain one authorization code.")
  const code = url.searchParams.get("code")
  if (!code || !/^[A-Za-z0-9._~+\/-]+$/.test(code)) throw new LoginError("The callback URL contains an invalid authorization code.")
  return code
}

function requireRefreshToken(profile) {
  try {
    const file = path.join(profile, TOKEN_RELATIVE)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_TOKEN_BYTES) throw new Error()
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    const token = parsed?.token ?? parsed
    if (typeof token?.refresh_token !== "string" || !token.refresh_token.trim()) throw new Error()
  } catch {
    throw new LoginError("agy did not save a usable file credential with a refresh token. Start the sign-in again.")
  }
}

function loginEnvironment(stage, inherited, platform) {
  // As in usage.mjs, shadow native launchers too: Windows agy can ignore
  // BROWSER. Magpie opens the link exactly once, on the user's own computer.
  const windows = platform === "win32"
  const launchers = path.join(stage, "launchers")
  fs.mkdirSync(launchers, { mode: 0o700 })
  for (const name of windows ? ["open", "xdg-open", "rundll32"] : ["open", "xdg-open"]) {
    fs.writeFileSync(path.join(launchers, name + (windows ? ".cmd" : "")), windows ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  }
  const value = key => Object.entries(inherited).find(([name]) => windows ? name.toUpperCase() === key : name === key)?.[1]
  const overrides = {
    BROWSER: path.join(launchers, windows ? "open.cmd" : "open"),
    PATH: launchers + (windows ? ";" : ":") + (value("PATH") || ""),
    WSL_INTEROP: value("WSL_INTEROP") || "1",
  }
  if (windows && !(value("PATHEXT") || "").split(";").some(ext => ext.toUpperCase() === ".CMD")) {
    overrides.PATHEXT = (value("PATHEXT") || ".COM;.EXE;.BAT") + ";.CMD"
  }
  return childEnv(overrides, platform, inherited)
}

export function createAccountLoginMethod(findAgy, {
  env = process.env, platform = process.platform, spawnProcess = spawn, onImport = () => {},
  resultForAccount = () => ({ type: "success", key: "agy" }),
  urlTimeoutMs = 45_000, finishTimeoutMs = 120_000, probeTimeoutMs = 15_000, loginTimeoutMs = 10 * 60_000,
} = {}) {
  let pending = null
  let generation = 0
  return {
    type: "oauth",
    ...ACCOUNT_ACTIONS.google,
    prompts: [{
      ...ACCOUNT_NAME_PROMPT,
      validate: value => { try { validateAccountName(String(value ?? "").trim()); return undefined } catch (error) { return error.message } },
    }],
    authorize: async (inputs, { signal } = {}) => {
      const attempt = ++generation
      let session, detach = () => {}
      try {
        await pending?.dispose(new LoginError("A newer agy sign-in replaced this one. Start again to continue."))
        if (attempt !== generation || signal?.aborted) throw new LoginError(CANCELLED)
        const name = validateAccountName(String(inputs?.name ?? "").trim())
        const agy = findAgy()
        if (!agy) throw new LoginError("agy CLI not found. Install Antigravity CLI with acp --login support first.")
        const root = accountsRootDir(env)
        // A plugin can change process.env while the user is in the browser.
        // Publish to the same root this sign-in started with, even then.
        const signInEnv = { ...env, AGY_BRIDGE_ACCOUNTS_DIR: root }
        if (fs.existsSync(root) && fs.readdirSync(root).some(entry => entry.toLowerCase() === name.toLowerCase())) {
          throw new LoginError(`Account "${name}" already exists; choose another name.`)
        }
        fs.mkdirSync(root, { recursive: true, mode: 0o700 })
        const stage = fs.mkdtempSync(path.join(root, ".login-"))
        const controller = new AbortController()
        const children = []
        let closed = null, disposal, expiry, urlTimer
        const atExit = () => {
          for (const child of children) child.stopAtExit()
          try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
        }
        session = {
          dispose: error => {
            if (disposal) return disposal
            closed = error
            clearTimeout(expiry)
            clearTimeout(urlTimer)
            controller.abort()
            disposal = (async () => {
              await Promise.all(children.map(child => child.done))
              process.removeListener("exit", atExit)
              try { fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}
              if (pending === session) pending = null
            })()
            return disposal
          },
        }
        pending = session
        process.once("exit", atExit)
        const check = () => {
          if (closed) throw closed
          if (signal?.aborted || controller.signal.aborted || attempt !== generation) throw new LoginError(CANCELLED)
        }
        const bind = source => {
          const abort = () => { void session.dispose(new LoginError(CANCELLED)) }
          source?.addEventListener("abort", abort, { once: true })
          if (source?.aborted) abort()
          return () => source?.removeEventListener("abort", abort)
        }
        detach = bind(signal)
        check()
        expiry = setTimeout(() => { void session.dispose(new LoginError("The agy sign-in expired. Start it again.")) }, loginTimeoutMs)
        expiry.unref?.()
        const profile = path.join(stage, "profile")
        fs.mkdirSync(profile, { mode: 0o700 })
        const launchEnv = loginEnvironment(stage, signInEnv, platform)
        const opts = { env: launchEnv, cwd: stage, platform, spawnProcess, signal: controller.signal }
        let resolveURL, auth, buffers = ["", ""]
        const urlReady = new Promise(resolve => { resolveURL = resolve })
        const login = startCli(agy, ["acp", "--login", `--gemini_dir=${profile}`], {
          ...opts, timeoutMs: loginTimeoutMs, phase: "login",
          output: (chunk, stdout) => {
            if (auth) return
            const index = stdout ? 0 : 1
            buffers[index] += chunk
            auth = authorizationURL(buffers[index])
            if (auth) { buffers = []; resolveURL({ auth }) }
          },
        })
        children.push(login)
        const noURL = new Promise(resolve => {
          urlTimer = setTimeout(() => resolve({ error: new LoginError("agy did not provide a sign-in URL in time. Update the CLI and try again.") }), urlTimeoutMs)
        })
        const ready = await Promise.race([urlReady, noURL, login.done.then(result => ({ error: result.error || new LoginError("agy exited before providing a sign-in URL. Update the CLI and try again.") }))])
        clearTimeout(urlTimer)
        if (ready.error) throw ready.error
        check()
        // Magpie cancels the authorize RPC after receiving its URL. The browser
        // step has no RPC signal to listen to; its own expiry/new login reaps it.
        detach()
        let consumed = false
        void login.done.then(result => {
          if (!consumed) void session.dispose(result.error || new LoginError("The agy login process exited. Start the sign-in again."))
        })
        return {
          url: auth.url,
          method: "code",
          instructions: "Sign in with Google, then paste the full URL of the final antigravity.google/oauth-callback page (recommended), or its authorization code. / 完成 Google 登录后，粘贴最终回调页面的完整 URL（推荐）或授权码。",
          callback: async (raw, { signal: finishSignal } = {}) => {
            if (consumed) return failed(new LoginError("This agy sign-in has already finished. Start a new sign-in."))
            consumed = true
            let unbind = () => {}, finishTimer
            try {
              // Do not retain the completed authorize RPC's signal here.
              if (closed) throw closed
              if (finishSignal?.aborted || attempt !== generation) throw new LoginError(CANCELLED)
              unbind = bind(finishSignal)
              const code = authorizationCode(raw, auth)
              finishTimer = setTimeout(() => { void session.dispose(new LoginError("agy login timed out. Start the sign-in again.")) }, finishTimeoutMs)
              login.write(code)
              const result = await login.done
              clearTimeout(finishTimer)
              if (closed) throw closed
              if (result.error) throw result.error
              if (result.code !== 0) throw new LoginError("agy could not complete Google sign-in. Start again and use a fresh callback or code.")
              requireRefreshToken(profile)
              const probe = startCli(agy, [`--gemini_dir=${profile}`, "models"], { ...opts, timeoutMs: probeTimeoutMs, phase: "account verification" })
              children.push(probe)
              const verified = await probe.done
              if (closed) throw closed
              if (verified.error) throw verified.error
              if (verified.code !== 0 || !verified.stdout.trim()) throw new LoginError("agy could not verify this account's models. Start the sign-in again.")
              if (finishSignal?.aborted || controller.signal.aborted || attempt !== generation) throw new LoginError(CANCELLED)
              importAccount(name, profile, signInEnv)
              onImport()
              return resultForAccount(name)
            } catch (error) { return failed(error) }
            finally {
              clearTimeout(finishTimer)
              unbind()
              await session.dispose(new LoginError("This agy sign-in is over. Start a new sign-in."))
            }
          },
        }
      } catch (error) {
        await session?.dispose(error instanceof LoginError ? error : new LoginError(CANCELLED))
        return failed(error)
      } finally { detach() }
    },
  }
}
