// Optional, explicit, default-off context unlock for the official agy CLI.
//
// agy has no native ACP flag that raises its context window or its 64K per-user-
// message clamp; the only known mechanism is the version/architecture-bound
// machine-code patch in vendor/agy-context-unlock/agy-patch.py (MIT, Copyright
// (c) 2026 lili-luo, pinned commit in PROVENANCE.md). This module NEVER patches
// the installed agy. `unlockContext()` copies it into a bridge-managed directory,
// patches only the copy with the pinned script, re-checks every gate on the copy
// and records source/patcher/patched SHA-256 values in a manifest. The plugin
// selects the copy only while that manifest is enabled and still verifies; any
// mismatch, unknown format or failure leaves the official agy in use.
// Nothing here runs from provider enumerate/auth or downloads anything.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { agyCandidates, agySpawnSpec, childEnv, wslDistro } from "./platform.mjs"

export const PATCHER = {
  path: fileURLToPath(new URL("./vendor/agy-context-unlock/agy-patch.py", import.meta.url)),
  sha256: "6c4edf9e4b86166abae4409d879faabe8f1e28a52d5c97d778b4e48bda46c413",
  commit: "0a90ec37c69430608084e33ebc2f891e328c9e89",
  verifiedAgy: "1.4.12 - 1.5.3 (upstream claim; not re-verified end-to-end here)",
}
// Every one of these gates must be applied and re-checked on the copy.
export const REQUIRED_GATES = ["1", "2", "3A", "3B", "4A", "4B"]
const MANIFEST_VERSION = 1

export class ContextError extends Error {
  constructor(message, code = "unsupported") {
    super(message)
    this.name = "ContextError"
    this.code = code
  }
}

export function contextStateDir(env = process.env) {
  return path.resolve(env.AGY_BRIDGE_CONTEXT_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie-agy-bridge", "context-unlock"))
}

const manifestPath = dir => path.join(dir, "manifest.json")
const exeName = (platform = process.platform) => (platform === "win32" ? "agy.exe" : "agy")

export function sha256File(file) {
  const hash = createHash("sha256")
  const fd = fs.openSync(file, "r")
  try {
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024)
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return hash.digest("hex")
}

// A hash is a full integrity check the first time; afterwards the verified
// file is trusted for as long as its (path, size, mtime, ctime, inode) are unchanged.
const verified = new Map()
function verifiedSha(file) {
  const stat = fs.statSync(file)
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`
  const hit = verified.get(file)
  if (hit?.key === key) return hit.sha
  const sha = sha256File(file)
  verified.set(file, { key, sha })
  return sha
}

export function readContextManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath(dir), "utf8"))
    return manifest?.version === MANIFEST_VERSION ? manifest : null
  } catch { return null }
}

function writeManifest(dir, manifest) {
  const tmp = `${manifestPath(dir)}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, manifestPath(dir))
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

// Locate the official install, never one of our own managed copies.
export function findOfficialAgy(env = process.env, home = os.homedir(), platform = process.platform) {
  if (wslDistro(env, platform)) return null
  const managed = contextStateDir(env) + path.sep
  for (const candidate of agyCandidates(env, home, platform)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (!path.resolve(candidate).startsWith(managed)) return candidate
    } catch {}
  }
  return null
}

// Parse the patcher's report: "[*] [Gate 3A] ..." (change pending/applied) and
// "[=] [Gate 3A] ... already patched".
export function parseGates(output) {
  const gates = new Map()
  for (const match of String(output).matchAll(/^\[([*=])\] \[Gate (\w+)\] (.*)$/gm)) {
    gates.set(match[2], { applied: match[1] === "=" && /already patched/i.test(match[3]), pending: match[1] === "*" })
  }
  return gates
}

function gateReport(output, want) {
  const gates = parseGates(output)
  const missing = REQUIRED_GATES.filter(gate => !gates.has(gate))
  const wrong = REQUIRED_GATES.filter(gate => gates.has(gate) && !gates.get(gate)[want])
  return { ok: missing.length === 0 && wrong.length === 0, missing, wrong, gates }
}

function runCommand(file, args, { env = process.env, timeout = 120_000, agy = false } = {}) {
  const spec = agy ? agySpawnSpec(file, args, process.platform, childEnv(env)) : { file, args, options: {} }
  const result = spawnSync(spec.file, spec.args, {
    encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: agy ? childEnv(env) : env, ...spec.options,
  })
  return { code: result.error ? null : result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error }
}

function findPython(env, run) {
  for (const candidate of [env.AGY_BRIDGE_PYTHON, "python3", "python"].filter(Boolean)) {
    const probe = run(candidate, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"], { env })
    if (probe.code === 0) return candidate
  }
  throw new ContextError("Python 3.8+ is required to apply the pinned patcher (set AGY_BRIDGE_PYTHON); the official agy was left unchanged and the default context is in use")
}

function describeFailure(result) {
  const text = (result.stderr || result.stdout || result.error?.message || "").trim().split("\n").slice(-3).join(" | ")
  return text.slice(0, 300)
}

// Create (or reuse) the managed unlocked copy. The official install is only
// read. Every failure leaves any previous manifest and the official agy as is.
export function unlockContext({ env = process.env, agyPath, run = runCommand, patcher = PATCHER, platform = process.platform } = {}) {
  if (wslDistro(env, platform)) throw new ContextError("Context unlock is unavailable in Windows-to-WSL mode")
  const source = agyPath || findOfficialAgy(env, os.homedir(), platform)
  if (!source) throw new ContextError("official agy CLI not found; install it first (nothing was changed)", "not_found")
  const sourceStat = (() => { try { return fs.statSync(source) } catch { return null } })()
  if (!sourceStat?.isFile()) throw new ContextError(`${source} is not a regular agy executable (wrapper scripts are not supported); nothing was changed`)
  if (!fs.existsSync(patcher.path) || sha256File(patcher.path) !== patcher.sha256) {
    throw new ContextError("the bundled patcher failed its SHA-256 check; reinstall the package (nothing was changed)", "integrity")
  }
  const python = findPython(env, run)
  const dir = contextStateDir(env)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staging = fs.mkdtempSync(path.join(dir, ".unlock-"))
  try {
    const copy = path.join(staging, exeName(platform))
    fs.copyFileSync(source, copy)
    fs.chmodSync(copy, 0o755)
    const sourceSha = sha256File(copy)
    const version = run(copy, ["--version"], { env, agy: true, timeout: 15_000 })
    if (version.code !== 0 || !version.stdout.trim()) throw new ContextError(`the agy copy does not report a version (${describeFailure(version)}); nothing was changed`)
    const patchArgs = flag => [patcher.path, "--binary", copy, flag, "--no-env-fix"]

    const before = run(python, patchArgs("--dry-run"), { env })
    if (before.code !== 0) throw new ContextError(`agy ${version.stdout.trim()} is not supported by the pinned patcher: ${describeFailure(before)}`)
    const pending = gateReport(before.stdout, "pending")
    if (!pending.ok) {
      throw new ContextError(`agy ${version.stdout.trim()} ${pending.missing.length ? `lacks gates ${pending.missing.join(", ")}` : `has gates already modified (${pending.wrong.join(", ")}); it is not an official build`}; unlock refused and nothing was changed`)
    }
    const apply = run(python, [patcher.path, "--binary", copy, "--in-place", "--no-backup", "--no-env-fix"], { env })
    if (apply.code !== 0) throw new ContextError(`patching the copy failed: ${describeFailure(apply)}`, "patch_failed")
    const after = run(python, patchArgs("--dry-run"), { env })
    const applied = gateReport(after.stdout, "applied")
    if (after.code !== 0 || !applied.ok) {
      throw new ContextError(`post-patch check failed for gates ${[...applied.missing, ...applied.wrong].join(", ") || "(unknown)"}; the copy was discarded`, "verify_failed")
    }
    const patchedSha = sha256File(copy)
    if (patchedSha === sourceSha) throw new ContextError("the patch changed nothing; the copy was discarded", "verify_failed")
    const check = run(copy, ["--version"], { env, agy: true, timeout: 15_000 })
    if (check.code !== 0 || check.stdout.trim() !== version.stdout.trim()) {
      throw new ContextError("the patched copy does not start or reports a different version; it was discarded", "verify_failed")
    }

    const finalDir = path.join(dir, patchedSha.slice(0, 16))
    const patchedFile = path.join(finalDir, exeName(platform))
    if (fs.existsSync(finalDir)) {
      // Published binaries are immutable: repeating an unlock must not replace
      // an executable another process may still be using.
      const directory = fs.lstatSync(finalDir)
      const binary = fs.existsSync(patchedFile) ? fs.lstatSync(patchedFile) : null
      if (!directory.isDirectory() || directory.isSymbolicLink() ||
          !binary?.isFile() || binary.isSymbolicLink() || sha256File(patchedFile) !== patchedSha) {
        throw new ContextError("an existing managed copy does not match its hash; disable with --purge before trying again (the previous selection was not changed)", "integrity")
      }
    } else {
      fs.renameSync(staging, finalDir)
    }
    const patchedStat = fs.statSync(patchedFile)
    const sourceNow = fs.statSync(source)
    writeManifest(dir, {
      version: MANIFEST_VERSION,
      enabled: true,
      createdAt: new Date().toISOString(),
      agyVersion: version.stdout.trim(),
      platform, arch: process.arch,
      gates: REQUIRED_GATES,
      source: { path: path.resolve(source), sha256: sourceSha, size: sourceNow.size, mtimeMs: sourceNow.mtimeMs },
      patcher: { sha256: patcher.sha256, commit: patcher.commit, verifiedAgy: patcher.verifiedAgy },
      patched: { file: path.relative(dir, patchedFile), sha256: patchedSha, size: patchedStat.size },
    })
    // Keep previous binaries until an explicit purge: an existing plugin host
    // can still have their paths cached even after this manifest is switched.
    return contextStatus({ env, full: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

// Turn the unlock off and return to the official default. The copy is kept
// (so `unlock` is quick to repeat) unless purge is set.
export function disableContext({ env = process.env, purge = false } = {}) {
  const dir = contextStateDir(env)
  const manifest = readContextManifest(dir)
  if (purge) {
    // Only bridge-owned entries: the manifest and its hash-named directory.
    fs.rmSync(manifestPath(dir), { force: true })
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (/^[0-9a-f]{16}$/.test(entry) || entry.startsWith(".unlock-")) fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
    }
  } else if (manifest?.enabled) {
    writeManifest(dir, { ...manifest, enabled: false, disabledAt: new Date().toISOString() })
  }
  verified.clear()
  return contextStatus({ env })
}

// Describe the current state. `full` bypasses the verified-file hash cache.
export function contextStatus({ env = process.env, official = findOfficialAgy(env), full = false } = {}) {
  if (wslDistro(env)) return { enabled: false, active: false, state: "unsupported", reason: "Context unlock is unavailable in Windows-to-WSL mode" }
  const dir = contextStateDir(env)
  const manifest = readContextManifest(dir)
  const base = { enabled: false, active: false, state: "default", reason: "context unlock is off; the official agy and default context are used", dir }
  if (!manifest) return base
  const info = { ...base, agyVersion: manifest.agyVersion, source: manifest.source?.path, patchedSha256: manifest.patched?.sha256, sourceSha256: manifest.source?.sha256, gates: manifest.gates }
  if (!manifest.enabled) return { ...info, state: "disabled", reason: "context unlock was disabled; the official agy is used" }
  const fail = (state, reason) => ({ ...info, enabled: true, state, reason: `${reason}; falling back to the official agy and default context` })
  if (manifest.patcher?.sha256 !== PATCHER.sha256 || JSON.stringify(manifest.gates) !== JSON.stringify(REQUIRED_GATES)) {
    return fail("stale", "the unlock was made by a different patcher; run `context unlock` again")
  }
  const patched = path.resolve(dir, manifest.patched?.file || "")
  if (!patched.startsWith(dir + path.sep) || !fs.existsSync(patched)) return fail("missing", "the managed agy copy is missing")
  const hashFile = full ? sha256File : verifiedSha
  let sha
  try { sha = hashFile(patched) } catch { return fail("corrupt", "the managed agy copy is unreadable") }
  if (sha !== manifest.patched.sha256) return fail("corrupt", "the managed agy copy does not match its recorded SHA-256")
  if (!official || path.resolve(official) !== manifest.source?.path) return fail("stale", "the official agy path changed")
  try {
    if (hashFile(official) !== manifest.source.sha256) {
      return fail("stale", "the official agy changed since the unlock (for example after `agy update`); run `context unlock` again")
    }
  } catch { return fail("stale", "the official agy is unreadable") }
  return { ...info, enabled: true, active: true, state: "unlocked", path: patched, reason: "using the bridge-managed unlocked agy copy" }
}

// Sync selection used by the plugin: the managed copy only while verified.
export function selectAgy(official, env = process.env) {
  if (!official) return { path: official, unlocked: false }
  try {
    const status = contextStatus({ env, official })
    if (status.active) return { path: status.path, unlocked: true }
  } catch {}
  return { path: official, unlocked: false }
}
