// Adapted from magpie-community/plugins packages/agy-cli 0.1.62 (install.mjs).
// MIT; Copyright (c) 2026 DylanLIiii, gitxm, yce. See NOTICE-upstream-license.txt.
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createGunzip } from "node:zlib"
import { childEnv, ownAgyPath } from "./platform.mjs"

const MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/"
export const AGY_MANUAL = process.platform === "win32"
  ? "irm https://antigravity.google/cli/install.ps1 | iex"
  : "curl -fsSL https://antigravity.google/cli/install.sh | bash"
const KEEP_FIRST_MS = 60_000
const KEEP_EVERY_MS = 6 * 60 * 60 * 1000

function manifestBase(env = process.env) {
  const base = (env.AGY_BRIDGE_INSTALL_BASE || "").trim()
  return base ? base.replace(/\/?$/, "/") : MANIFESTS
}

function muslLinux() {
  for (const lib of ["/lib/libc.musl-x86_64.so.1", "/lib/libc.musl-aarch64.so.1"]) {
    if (fs.existsSync(lib)) return true
  }
  try {
    const header = process.report?.getReport?.()?.header
    if (header && !header.glibcVersionRuntime) return true
  } catch {}
  return false
}

export function agyPlatform(platform = process.platform, arch = process.arch, musl = platform === "linux" && muslLinux()) {
  const cpu = { x64: "amd64", arm64: "arm64" }[arch]
  if (!cpu) return null
  if (platform === "linux") return `linux_${cpu}${musl ? "_musl" : ""}`
  if (platform === "darwin") return `darwin_${cpu}`
  if (platform === "win32") return `windows_${cpu}`
  return null
}

function ownPath() {
  return ownAgyPath(process.env, os.homedir())
}

function versionFile(bin) {
  return bin + ".version"
}

export async function readManifest(platform = agyPlatform(), { signal } = {}) {
  if (!platform) throw new Error(`Antigravity CLI has no build for ${process.platform} ${process.arch}`)
  const url = manifestBase() + platform + ".json"
  let res
  try {
    res = await fetch(url, { signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`couldn't reach Antigravity's release server: ${error?.message || error}`)
  }
  if (!res.ok) throw new Error(`Antigravity's release server answered ${res.status} for ${platform}`)
  const m = await res.json().catch(() => null)
  if (!m || typeof m.url !== "string" || !/^https?:\/\//.test(m.url) || !/^[0-9a-f]{128}$/i.test(String(m.sha512 || ""))) {
    throw new Error("Antigravity's release manifest isn't one")
  }
  return { version: String(m.version || ""), url: m.url, sha512: String(m.sha512).toLowerCase(), platform }
}

// Detach listeners per write wait to avoid hitting MaxListenersExceededWarning on ~260MB downloads.
export function drained(out) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      out.off("drain", done)
      out.off("error", done)
      error ? reject(error) : resolve()
    }
    out.on("drain", done)
    out.on("error", done)
  })
}

async function download(url, file, signal) {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`downloading agy failed: ${res.status}`)
  const hash = createHash("sha512")
  const out = fs.createWriteStream(file, { mode: 0o600 })
  const wrote = new Promise((resolve, reject) => { out.on("finish", resolve); out.on("error", reject) })
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      if (!out.write(chunk)) await drained(out)
    }
  } finally {
    out.end()
  }
  await wrote
  return hash.digest("hex")
}

export async function untarMember(archive, name, file) {
  const gz = fs.createReadStream(archive).pipe(createGunzip())
  const it = gz[Symbol.asyncIterator]()
  let buf = Buffer.alloc(0)
  const fill = async (n) => {
    while (buf.length < n) {
      const r = await it.next()
      if (r.done) return false
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value
    }
    return true
  }
  const pass = async (n, fn) => {
    while (n > 0) {
      if (!buf.length) {
        const r = await it.next()
        if (r.done) throw new Error("the agy download is cut short")
        buf = r.value
      }
      const k = Math.min(n, buf.length)
      await fn(buf.subarray(0, k))
      buf = buf.subarray(k)
      n -= k
    }
  }
  const skip = () => {}
  let longName = null
  try {
    for (;;) {
      if (!(await fill(512))) return false
      const header = buf.subarray(0, 512)
      buf = buf.subarray(512)
      if (header.every((b) => b === 0)) continue
      const field = (at, len) => header.subarray(at, at + len).toString("utf8").replace(/\0.*$/s, "")
      const size = parseInt(field(124, 12).trim() || "0", 8)
      if (!Number.isFinite(size) || size < 0) throw new Error("the agy download isn't a tar archive")
      const pad = (512 - (size % 512)) % 512
      const type = field(156, 1) || "0"
      if (type === "L" || type === "x") {
        if (size > 1 << 20) throw new Error("the agy download isn't a tar archive")
        const parts = []
        await pass(size, (c) => { parts.push(Buffer.from(c)) })
        await pass(pad, skip)
        const text = Buffer.concat(parts).toString("utf8")
        if (type === "L") longName = text.replace(/\0.*$/s, "")
        else {
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
          if (m) longName = m[1]
        }
        continue
      }
      const prefix = field(345, 155)
      const entry = (longName ?? (prefix ? prefix + "/" + field(0, 100) : field(0, 100))).replace(/^\.\//, "")
      longName = null
      if ((type === "0" || type === "7") && entry === name) {
        const out = fs.createWriteStream(file, { mode: 0o755 })
        try {
          await pass(size, async (c) => {
            if (!out.write(c)) await drained(out)
          })
        } finally {
          await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
        }
        return true
      }
      await pass(size + pad, skip)
    }
  } finally {
    gz.destroy()
  }
}

function run(file, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let output = ""
    let child
    try {
      child = spawn(file, args, { env: childEnv(undefined), stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      resolve({ code: -1, output: String(error?.message || error) })
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on("data", (d) => { output += d })
    child.stderr.on("data", (d) => { output += d })
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: String(error?.message || error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}

function lastLine(text) {
  return String(text).trim().split(/\r?\n/).filter(Boolean).pop() || ""
}

export async function installAgy({ signal, bin = ownPath(), platform = agyPlatform(), manifest } = {}) {
  const m = manifest || (await readManifest(platform, { signal }))
  const windows = (platform || "").startsWith("windows_")
  const dir = path.dirname(bin)
  fs.mkdirSync(dir, { recursive: true })
  const tag = randomBytes(6).toString("hex")
  const payload = path.join(dir, `.download-${tag}`)
  const staged = path.join(dir, `.agy-${tag}${windows ? ".exe" : ""}`)
  try {
    const sum = await download(m.url, payload, signal)
    if (sum !== m.sha512) throw new Error("the agy download doesn't match the checksum Antigravity's manifest gives; nothing was installed")
    if (/\.tar\.gz(?:$|\?)/.test(m.url)) {
      if (!(await untarMember(payload, "antigravity", staged))) throw new Error("the agy download has no agy in it")
    } else {
      fs.renameSync(payload, staged)
    }
    if (!windows) fs.chmodSync(staged, 0o755)
    if (signal?.aborted) throw new DOMException("the install was cancelled", "AbortError")
    const check = await run(staged, ["--version"])
    if (check.code !== 0) throw new Error(`the downloaded agy doesn't run here (${lastLine(check.output) || `exit ${check.code}`})`)
    if (windows && fs.existsSync(bin)) {
      try { fs.renameSync(bin, path.join(dir, `.old-${tag}.exe`)) } catch {}
    }
    fs.renameSync(staged, bin)
    try { fs.writeFileSync(versionFile(bin), m.version + "\n") } catch {}
    return m.version
  } finally {
    for (const f of [payload, staged]) {
      try { fs.rmSync(f, { force: true }) } catch {}
    }
    sweepOld(dir)
  }
}

function sweepOld(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^\.old-[0-9a-f]+\.exe$/.test(name)) {
        try { fs.rmSync(path.join(dir, name), { force: true }) } catch {}
      }
    }
  } catch {}
}

export function installedVersion(bin = ownPath()) {
  try {
    return fs.readFileSync(versionFile(bin), "utf8").trim()
  } catch {
    return ""
  }
}

export async function updateOwnAgy({ signal, bin = ownPath(), used, platform = agyPlatform(), env = process.env } = {}) {
  if (Object.keys(env).some((k) => k.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE")) return "off"
  if (!fs.existsSync(bin)) return "none"
  if (used && path.resolve(used) !== path.resolve(bin)) return "not used"
  const m = await readManifest(platform, { signal })
  if (m.version && m.version === installedVersion(bin)) return "current"
  await installAgy({ signal, bin, platform, manifest: m })
  return "updated"
}

let keeping = false
export function keepAgyCurrent(findAgy) {
  if (keeping) return
  keeping = true
  const tick = async () => {
    try {
      const was = await updateOwnAgy({ used: findAgy() })
      if (was === "updated") console.error(`antigravity-bridge: updated its agy to ${installedVersion()}`)
    } catch (error) {
      console.error(`antigravity-bridge: couldn't update its agy: ${error?.message || error}`)
    }
    setTimeout(tick, KEEP_EVERY_MS).unref?.()
  }
  setTimeout(tick, KEEP_FIRST_MS).unref?.()
}
