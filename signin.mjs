// Adapted from magpie-community/plugins packages/agy-cli 0.1.55 (signin.mjs)
// and extended for antigravity-bridge named profile files.
// MIT; Copyright (c) 2026 DylanLIiii, gitxm, yce. See NOTICE-upstream-license.txt.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const SERVICE = "gemini"
const USER = "antigravity"
const READ_TIMEOUT_MS = 10_000
const CACHE_MS = 30_000
const ENV_SIGN_INS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GENAI_USE_VERTEXAI"]

export const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace MagpieAgy -Name Cred -MemberDefinition @'
[DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", EntryPoint = "CredFree")]
public static extern void CredFree(IntPtr cred);
'@
$p = [IntPtr]::Zero
if (-not [MagpieAgy.Cred]::CredRead('${SERVICE}:${USER}', 1, 0, [ref]$p)) {
  $e = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($e -eq 1168) { 'MISSING' } else { "ERROR $e" }
  exit 0
}
try {
  $ptr = [IntPtr]::Size
  $sizeAt = 8 + 2 * $ptr + 8
  $blobAt = $sizeAt + 4
  if ($blobAt % $ptr) { $blobAt += $ptr - ($blobAt % $ptr) }
  $size = [Runtime.InteropServices.Marshal]::ReadInt32($p, $sizeAt)
  $blob = [Runtime.InteropServices.Marshal]::ReadIntPtr($p, $blobAt)
  $bytes = New-Object byte[] $size
  if ($size -gt 0) { [Runtime.InteropServices.Marshal]::Copy($blob, $bytes, 0, $size) }
  'OK ' + [Convert]::ToBase64String($bytes)
} finally { [MagpieAgy.Cred]::CredFree($p) }
`

function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
        (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout ?? "") }))
    } catch {
      resolve({ code: -1, stdout: "" })
    }
  })
}

export function parseStored(raw, now = Date.now()) {
  let value = String(raw ?? "").trim()
  const fp = createHash("sha256").update(value).digest("hex").slice(0, 32)
  if (value.startsWith("go-keyring-base64:")) {
    value = Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8")
  } else if (value.startsWith("go-keyring-encoded:")) {
    value = Buffer.from(value.slice("go-keyring-encoded:".length), "hex").toString("utf8")
  }
  let stored
  try { stored = JSON.parse(value) } catch { return { state: "unknown" } }
  if (typeof stored?.api_key === "string" && stored.api_key !== "") return { state: "unknown" }
  const token = stored?.token
  if (!token || typeof token !== "object") return { state: "unknown" }
  const canRenew = typeof token.refresh_token === "string" && token.refresh_token !== ""
  const hasAccess = typeof token.access_token === "string" && token.access_token !== ""
  if (!canRenew && !hasAccess) return { state: "missing" }
  const at = Date.parse(token.expiry ?? "")
  const expiresAt = Number.isFinite(at) && at > 0 ? at : 0
  return { state: "present", fp, canRenew, expiresAt, expired: expiresAt > 0 && now >= expiresAt }
}

export async function readAccountSignIn(geminiDir, { now = Date.now(), env = process.env } = {}) {
  if (env.AGY_BRIDGE_STORED_SIGNIN === "skip") return { state: "unknown" }
  if (ENV_SIGN_INS.some((name) => env[name])) return { state: "unknown" }
  if (!geminiDir) return readStoredSignIn({ now, env })
  const file = path.join(geminiDir, "antigravity-cli", "antigravity-oauth-token")
  try {
    const raw = await fs.promises.readFile(file, "utf8")
    return parseStored(raw, now)
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" }
    return { state: "unknown" }
  }
}

export async function readStoredSignIn({ platform = process.platform, exec = run, now = Date.now(), env = process.env } = {}) {
  if (env.AGY_BRIDGE_STORED_SIGNIN === "skip") return { state: "unknown" }
  if (ENV_SIGN_INS.some((name) => env[name])) return { state: "unknown" }
  if (platform === "darwin") {
    const r = await exec("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", USER, "-w"])
    if (r.code === 44) return { state: "missing" }
    if (r.code !== 0) return { state: "unknown" }
    return parseStored(r.stdout, now)
  }
  if (platform === "win32") {
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT])
    const out = r.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
    if (r.code !== 0) return { state: "unknown" }
    if (out === "MISSING") return { state: "missing" }
    if (!out.startsWith("OK ")) return { state: "unknown" }
    return parseStored(Buffer.from(out.slice(3), "base64").toString("utf8"), now)
  }
  return { state: "unknown" }
}

export function cannotSignIn(s) {
  if (s?.state === "missing") return "agy isn't signed in"
  if (s?.state === "present" && !s.canRenew && s.expired) return "agy's sign-in has expired"
  return ""
}

const dead = new Set()

export function noteDead(s) {
  if (s?.state === "present" && s.fp) dead.add(s.fp)
}

export function isDead(s) {
  return s?.state === "present" && dead.has(s.fp)
}

let cached = null
let reading = null

export async function storedSignIn(opts = {}) {
  const { read = readStoredSignIn, fresh = false } = opts
  const custom = read !== readStoredSignIn || Boolean(opts.platform || opts.exec || opts.now !== undefined || opts.env)
  if (!custom && !fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  if (custom) {
    try { return await read(opts) } catch { return { state: "unknown" } }
  }
  if (!reading) {
    const r = Promise.resolve().then(() => read(opts)).catch(() => ({ state: "unknown" })).then((value) => {
      if (reading === r) {
        cached = { at: Date.now(), value }
        reading = null
      }
      return value
    })
    reading = r
  }
  return reading
}

export function storedSignInNow(opts = {}) {
  const { read = readStoredSignIn } = opts
  if (!cached || Date.now() - cached.at >= CACHE_MS) storedSignIn({ ...opts, read }).catch(() => {})
  return cached?.value ?? null
}

export async function backgroundBlocked(opts = {}) {
  if (opts.env && opts.env.AGY_BRIDGE_STORED_SIGNIN === "skip") return ""
  const s = opts.dir
    ? await readAccountSignIn(opts.dir, opts)
    : await storedSignIn(opts)
  return cannotSignIn(s) || (isDead(s) ? "agy's sign-in no longer works" : "")
}

export function forgetStoredSignIn({ dead: clearDead = false } = {}) {
  cached = null
  reading = null
  if (clearDead) dead.clear()
}
