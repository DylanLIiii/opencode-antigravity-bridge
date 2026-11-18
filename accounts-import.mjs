// Shared import backend for named agy accounts. The Magpie sign-in form
// (index.mjs auth.methods) and the packaged CLI (bin/agy-bridge.mjs) both call
// importAccounts(); there is no second code path.
//
// An import copies exactly one file, `antigravity-cli/antigravity-oauth-token`,
// from an existing agy profile directory or a native token file into
// <accounts root>/<name>/. agy keeps refreshing that token itself; the bridge
// never reads, refreshes or prints it beyond a shape check. Existing accounts
// are never overwritten: a name collision is an error and nothing is changed.
import fs from "node:fs"
import path from "node:path"
import { accountsRootDir, invalidateAccounts, PROVIDER_ID } from "./accounts.mjs"

export const TOKEN_RELATIVE = path.join("antigravity-cli", "antigravity-oauth-token")
const MAX_TOKEN_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_BATCH = 100
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RESERVED_NAMES = new Set([PROVIDER_ID, "default", "new", "agy"])
const KEYRING_PREFIX = "go-keyring-base64:"

export class ImportError extends Error {
  constructor(message, code = "import_failed") {
    super(message)
    this.name = "ImportError"
    this.code = code
  }
}

export function validateAccountName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("..") || /[.]$/.test(name)) {
    throw new ImportError(
      `invalid account name ${JSON.stringify(String(name).slice(0, 80))}: use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
      "invalid_name")
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new ImportError(`account name "${name}" is reserved; choose another name`, "reserved_name")
  }
  return name
}

// agy stores its credential as JSON, or (OS keyring) as the go-keyring base64
// wrapper around that JSON. A named profile needs the native JSON file, so a
// wrapped source is unwrapped here. Only the shape is checked (JSON object with
// an access or refresh token, possibly nested under "token"); the returned
// text is the original JSON unchanged and is never logged.
function nativeCredential(text) {
  let raw = text.trim()
  if (raw.startsWith(KEYRING_PREFIX)) {
    try { raw = Buffer.from(raw.slice(KEYRING_PREFIX.length).trim(), "base64").toString("utf8").trim() } catch { return null }
  }
  try {
    const outer = JSON.parse(raw)
    if (!outer || typeof outer !== "object" || Array.isArray(outer)) return null
    const inner = outer.token && typeof outer.token === "object" && !Array.isArray(outer.token) ? outer.token : outer
    return ["access_token", "refresh_token"].some(key => typeof inner[key] === "string" && inner[key].trim()) ? raw : null
  } catch {
    return null
  }
}

// Resolve one source (an agy profile directory or a token file) to its token
// bytes. Sources may be symlinks (they are only read); the result must be a
// regular, bounded, well-formed credential file.
function readSource(source, label) {
  if (typeof source !== "string" || !source.trim()) throw new ImportError(`${label}: source path is empty`, "invalid_source")
  let resolved
  try { resolved = fs.realpathSync(path.resolve(source)) } catch {
    throw new ImportError(`${label}: source not found: ${source}`, "invalid_source")
  }
  let file = resolved
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    file = path.join(resolved, TOKEN_RELATIVE)
    if (!fs.existsSync(file)) {
      throw new ImportError(`${label}: ${source} is not an agy profile (missing ${TOKEN_RELATIVE}); sign in with \`agy --gemini_dir=<dir>\` first`, "invalid_source")
    }
    try { file = fs.realpathSync(file) } catch {
      throw new ImportError(`${label}: cannot read the token inside ${source}`, "invalid_source")
    }
  }
  const fileStat = fs.statSync(file)
  if (!fileStat.isFile()) throw new ImportError(`${label}: ${source} is not a regular file or agy profile directory`, "invalid_source")
  if (fileStat.size === 0 || fileStat.size > MAX_TOKEN_BYTES) {
    throw new ImportError(`${label}: token file has an unsupported size (${fileStat.size} bytes)`, "invalid_source")
  }
  const native = nativeCredential(fs.readFileSync(file, "utf8"))
  if (native === null) {
    throw new ImportError(`${label}: ${source} does not look like an agy OAuth token (expected JSON with an access or refresh token)`, "invalid_source")
  }
  return Buffer.from(native, "utf8")
}

// Parse a batch manifest: [{ name, source }] or { accounts: [...] }. Relative
// source paths resolve against the manifest's own directory.
export function readManifest(manifestPath) {
  let resolved
  try { resolved = fs.realpathSync(path.resolve(manifestPath)) } catch {
    throw new ImportError(`manifest not found: ${manifestPath}`, "invalid_manifest")
  }
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new ImportError("manifest must be a JSON file under 1 MiB", "invalid_manifest")
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) } catch {
    throw new ImportError("manifest is not valid JSON", "invalid_manifest")
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.accounts
  if (!Array.isArray(list) || list.length === 0) throw new ImportError("manifest must be a non-empty array or { \"accounts\": [...] }", "invalid_manifest")
  if (list.length > MAX_BATCH) throw new ImportError(`manifest has more than ${MAX_BATCH} accounts`, "invalid_manifest")
  const base = path.dirname(resolved)
  return list.map((item, index) => {
    if (!item || typeof item !== "object") throw new ImportError(`manifest entry ${index + 1} must be an object`, "invalid_manifest")
    const source = item.source ?? item.profile ?? item.token
    if (typeof item.name !== "string" || typeof source !== "string") {
      throw new ImportError(`manifest entry ${index + 1} needs string "name" and "source" (an agy profile directory or token file)`, "invalid_manifest")
    }
    return { name: item.name, source: path.resolve(base, source) }
  })
}

function existingNames(root) {
  try { return fs.readdirSync(root).map(name => name.toLowerCase()) } catch { return [] }
}

// Import every {name, source} entry, or none. All inputs and collisions are
// checked before the first write; if a later write fails, the accounts this
// call already created are removed again. Nothing pre-existing is touched.
export function importAccounts(entries, env = process.env) {
  if (!Array.isArray(entries) || entries.length === 0) throw new ImportError("nothing to import", "invalid_input")
  const root = accountsRootDir(env)
  const taken = new Set(existingNames(root))
  const seen = new Set()
  const planned = entries.map((entry, index) => {
    const label = entries.length > 1 ? `entry ${index + 1} (${JSON.stringify(String(entry?.name ?? "").slice(0, 64))})` : "account"
    const name = validateAccountName(entry?.name)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new ImportError(`${label}: duplicate account name "${name}" in this import`, "duplicate_name")
    seen.add(key)
    if (taken.has(key)) throw new ImportError(`${label}: account "${name}" already exists; choose another name (existing accounts are never overwritten)`, "name_collision")
    return { name, bytes: readSource(entry.source, label) }
  })

  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const created = []
  const staging = fs.mkdtempSync(path.join(root, ".import-"))
  try {
    for (const item of planned) {
      const dest = path.join(root, item.name)
      // mkdir is the atomic claim: it fails on any existing entry, including a
      // symlink or a racing import under the same name.
      try { fs.mkdirSync(dest, { mode: 0o700 }) } catch (error) {
        if (error.code === "EEXIST") throw new ImportError(`account "${item.name}" already exists; choose another name`, "name_collision")
        throw error
      }
      created.push(dest)
      const stageDir = path.join(staging, item.name, "antigravity-cli")
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 })
      const stagedToken = path.join(stageDir, "antigravity-oauth-token")
      fs.writeFileSync(stagedToken, item.bytes, { mode: 0o600, flag: "wx" })
      fs.chmodSync(stagedToken, 0o600)
      // The token becomes visible to discovery only when this rename lands.
      fs.renameSync(stageDir, path.join(dest, "antigravity-cli"))
    }
  } catch (error) {
    for (const dest of created.reverse()) fs.rmSync(dest, { recursive: true, force: true })
    throw error instanceof ImportError ? error : new ImportError(`import failed and was rolled back: ${error.code || error.message}`, "write_failed")
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  invalidateAccounts()
  return planned.map(item => ({ name: item.name, dir: path.join(root, item.name) }))
}

export function importAccount(name, source, env = process.env) {
  return importAccounts([{ name, source }], env)
}

// The existing account directory whose name matches `name` ignoring case, or
// null. Names are unique case-insensitively, so there is at most one.
function existingAccountDir(root, name) {
  let entries
  try { entries = fs.readdirSync(root) } catch { return null }
  const found = entries.find(entry => entry.toLowerCase() === name.toLowerCase())
  return found === undefined ? null : { name: found, dir: path.join(root, found) }
}

// Sign in again to an existing named account: replace only its credential
// file. Conversations, settings and logs in the profile stay. The new token is
// staged in the account's own antigravity-cli directory and renamed over the
// old one, so a failure at any step leaves the previous credential in place.
// A symlinked or non-directory destination is refused, never followed.
export function replaceAccountCredential(name, source, env = process.env) {
  validateAccountName(name)
  const root = accountsRootDir(env)
  const existing = existingAccountDir(root, name)
  if (!existing) throw new ImportError(`account "${name}" does not exist; add it as a new account`, "not_found")
  const bytes = readSource(source, "account")
  let stat
  try { stat = fs.lstatSync(existing.dir) } catch {
    throw new ImportError(`account "${existing.name}" disappeared; add it as a new account`, "not_found")
  }
  if (!stat.isDirectory()) throw new ImportError(`account "${existing.name}" is not a regular account folder; remove it first`, "invalid_destination")
  const app = path.join(existing.dir, "antigravity-cli")
  try {
    const appStat = fs.lstatSync(app)
    if (!appStat.isDirectory()) throw new ImportError(`account "${existing.name}" has an unexpected credential folder; remove it first`, "invalid_destination")
  } catch (error) {
    if (error instanceof ImportError) throw error
    if (error.code !== "ENOENT") throw new ImportError(`could not read account "${existing.name}": ${error.code || "unexpected error"}`, "write_failed")
    fs.mkdirSync(app, { mode: 0o700 })
  }
  const token = path.join(app, "antigravity-oauth-token")
  try {
    if (fs.lstatSync(token).isSymbolicLink()) throw new ImportError(`account "${existing.name}" has a linked credential; remove it first`, "invalid_destination")
  } catch (error) {
    if (error instanceof ImportError) throw error
    if (error.code !== "ENOENT") throw new ImportError(`could not read account "${existing.name}": ${error.code || "unexpected error"}`, "write_failed")
  }
  const staged = path.join(app, `.antigravity-oauth-token.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(staged, bytes, { mode: 0o600, flag: "wx" })
    fs.chmodSync(staged, 0o600)
    fs.renameSync(staged, token)
  } catch (error) {
    try { fs.rmSync(staged, { force: true }) } catch {}
    throw new ImportError(`could not replace the credential of "${existing.name}": ${error.code || "unexpected error"}`, "write_failed")
  }
  invalidateAccounts()
  return { name: existing.name, dir: existing.dir, replaced: true }
}

// Delete a named account's profile on disk. The host's account row is the
// host's to remove; Magpie does not tell plugins when a row is removed, so
// this is the only way to release the name and the stored credential.
// The directory is renamed to a hidden staging name first, so discovery never
// lists a half-deleted profile. Symlinks are unlinked, never followed.
export function removeAccount(name, env = process.env) {
  validateAccountName(name)
  const root = accountsRootDir(env)
  const existing = existingAccountDir(root, name)
  if (!existing) throw new ImportError(`account "${name}" does not exist`, "not_found")
  let stat
  try { stat = fs.lstatSync(existing.dir) } catch {
    throw new ImportError(`account "${name}" does not exist`, "not_found")
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    // unlink removes the link itself; rmSync would refuse a link to a folder.
    try { fs.unlinkSync(existing.dir) } catch (error) {
      throw new ImportError(`could not remove account "${existing.name}": ${error.code || "unexpected error"}`, "remove_failed")
    }
    invalidateAccounts()
    return { name: existing.name, dir: existing.dir }
  }
  const trash = path.join(root, `.removed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  try { fs.renameSync(existing.dir, trash) } catch (error) {
    throw new ImportError(`could not remove account "${existing.name}": ${error.code || "unexpected error"}`, "remove_failed")
  }
  invalidateAccounts()
  try { fs.rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}
  return { name: existing.name, dir: existing.dir }
}

// Leftovers of interrupted imports, sign-ins and removals. A host that kills
// the plugin mid-sign-in leaves `.login-*`, which may hold a half-finished
// profile. Only entries older than `maxAgeMs` go, so live work is never touched.
const STAGING_PREFIXES = [".login-", ".import-", ".removed-"]
export function sweepStaging(env = process.env, { maxAgeMs = 60 * 60_000, now = Date.now() } = {}) {
  const root = accountsRootDir(env)
  const removed = []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return removed }
  for (const entry of entries) {
    if (!entry.isDirectory() || !STAGING_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue
    const dir = path.join(root, entry.name)
    try {
      if (now - fs.lstatSync(dir).mtimeMs < maxAgeMs) continue
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      removed.push(entry.name)
    } catch {}
  }
  return removed
}

export function importManifest(manifestPath, env = process.env) {
  return importAccounts(readManifest(manifestPath), env)
}
