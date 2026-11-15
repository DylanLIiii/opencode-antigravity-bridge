import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const PROD_BASE_URL = "https://cloudcode-pa.googleapis.com"
const DAILY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"
const METADATA_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 3500
const KEYCHAIN_TIMEOUT_MS = 1500
const EFFORT_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh|max)$/i

// Reference specs from CloudCode / Antigravity for models whose CLI alias is not
// echoed verbatim by fetchAvailableModels on every account tier.
export const KNOWN_MODEL_LIMITS = Object.freeze({
  "gemini-4-carbon": { context: 1_048_576, output: 262_144, supportsImages: true },
  "gemini-4-argon": { context: 1_048_576, output: 65_536, supportsImages: true },
  "gemini-4-hydrogen": { context: 1_048_576, output: 262_144, supportsImages: true },
  "gemini-pro-orchestrator": { context: 1_048_576, output: 262_144, supportsImages: true },
  "gemini-pro-orchestrator-argon": { context: 1_048_576, output: 65_536, supportsImages: true },
  "gemini-flash-worker-agy": { context: 1_048_576, output: 262_144, supportsImages: true },
  "gemini-3.8-flash": { context: 1_048_576, output: 65_536, supportsImages: true },
  "gemini-3.8-flash-tiered": { context: 1_048_576, output: 65_536, supportsImages: true },
  "gemini-3-flash": { context: 1_048_576, output: 65_536, supportsImages: true },
  "gemini-3.1-flash-image": { context: 65_536, output: 65_536, supportsImages: true },
  "gemini-3.5-flash-lite": { context: 1_048_576, output: 65_535, supportsImages: true },
  "gemini-3.1-flash-lite": { context: 1_048_576, output: 65_535, supportsImages: true },
  "gemini-2.5-flash": { context: 1_048_576, output: 65_535, supportsImages: true },
  "gemini-2.5-flash-thinking": { context: 1_048_576, output: 65_535, supportsImages: true },
  "gemini-2.5-flash-lite": { context: 1_048_576, output: 65_535, supportsImages: true },
  "gemini-2.5-pro": { context: 1_048_576, output: 65_535, supportsImages: true },
  "claude-opus-5-5": { context: 1_000_000, output: 128_000, supportsImages: true },
  "claude-sonnet-5-5": { context: 1_000_000, output: 128_000, supportsImages: true },
  "claude-opus-4-6-thinking": { context: 250_000, output: 64_000, supportsImages: true },
  "claude-sonnet-4-6": { context: 250_000, output: 64_000, supportsImages: true },
  "gpt-oss-120b-medium": { context: 131_072, output: 32_768, supportsImages: false },
})

const cache = new Map()
const inflight = new Map()

function isPathInside(targetPath, parentDir) {
  if (!targetPath || !parentDir) return false
  const resolvedTarget = path.resolve(targetPath)
  const resolvedParent = path.resolve(parentDir)
  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + path.sep)
}

export function isMockAgyPath(agyPath) {
  return !agyPath || isPathInside(agyPath, os.tmpdir())
}

function stripEffortSuffix(id) {
  return String(id || "").replace(EFFORT_SUFFIX_RE, "")
}

function platformEnum() {
  if (process.platform === "darwin") return "DARWIN_ARM64"
  if (process.platform === "win32") return "WINDOWS_AMD64"
  return "LINUX_AMD64"
}

function userAgent() {
  const osPart = process.platform === "win32" ? "windows" : process.platform
  const archPart = process.arch === "x64" ? "amd64" : process.arch
  return `antigravity/1.23.2 ${osPart}/${archPart}`
}

function parseOAuthToken(raw) {
  if (!raw || typeof raw !== "string") return null
  let text = raw.trim()
  if (text.startsWith("go-keyring-base64:")) {
    text = Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8")
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const tokenObj = parsed?.token && typeof parsed.token === "object" ? parsed.token : parsed
  const accessToken = typeof tokenObj?.access_token === "string" ? tokenObj.access_token.trim() : ""
  if (!accessToken) return null
  const expiryRaw = tokenObj?.expiry ?? tokenObj?.expires_at
  const expiryMs = typeof expiryRaw === "number" ? expiryRaw : typeof expiryRaw === "string" ? Date.parse(expiryRaw) : NaN
  // If expired and we cannot refresh here, let callers fall back cleanly.
  if (Number.isFinite(expiryMs) && expiryMs <= Date.now() + 5_000 && !process.env.AGY_BRIDGE_CLOUDCODE_URL) {
    return { accessToken, expired: true }
  }
  return { accessToken, expired: false }
}

async function readAccountToken(account, agyPath) {
  const customEndpoint = Boolean(String(process.env.AGY_BRIDGE_CLOUDCODE_URL || "").trim())
  const allowHostCredentials = customEndpoint || !isMockAgyPath(agyPath)
  const filePath = account?.dir
    ? path.join(account.dir, "antigravity-cli", "antigravity-oauth-token")
    : allowHostCredentials
      ? path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token")
      : ""
  if (filePath) {
    try {
      const parsed = parseOAuthToken(await fs.promises.readFile(filePath, "utf8"))
      if (parsed) return parsed
    } catch {}
  }
  if (!account?.dir && allowHostCredentials && process.platform === "darwin" && !process.env.AGY_BRIDGE_DISABLE_KEYCHAIN) {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
        { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS },
      )
      const parsed = parseOAuthToken(stdout)
      if (parsed) return parsed
    } catch {}
  }
  return null
}

async function postCloudCode(baseUrl, rpcMethod, accessToken, body) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1internal:${rpcMethod}`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return null
  return await response.json().catch(() => null)
}

export async function fetchCloudCodeModels(account, agyPath, refresh = false) {
  const key = account?.key || "__default__"
  const cached = cache.get(key)
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached
  if (inflight.has(key)) return await inflight.get(key)
  const pending = (async () => {
    const token = await readAccountToken(account, agyPath)
    if (!token) return null
    const baseOverride = String(process.env.AGY_BRIDGE_CLOUDCODE_URL || "").trim()
    const prodBase = baseOverride || PROD_BASE_URL
    const dailyBase = baseOverride || DAILY_BASE_URL
    const models = new Map()
    if (!token.expired || baseOverride) {
      try {
        const load = await postCloudCode(prodBase, "loadCodeAssist", token.accessToken, {
          metadata: { ideType: "ANTIGRAVITY", platform: platformEnum(), pluginType: "GEMINI" },
        })
        const project = typeof load?.cloudaicompanionProject === "string"
          ? load.cloudaicompanionProject.trim()
          : typeof load?.cloudaicompanionProject?.id === "string"
            ? load.cloudaicompanionProject.id.trim()
            : ""
        const available = await postCloudCode(
          dailyBase,
          "fetchAvailableModels",
          token.accessToken,
          project ? { project } : {},
        )
        const rawModels = available?.models
        if (rawModels && typeof rawModels === "object") {
          for (const [id, info] of Object.entries(rawModels)) {
            if (!info || typeof info !== "object") continue
            const context = Number(info.maxTokens)
            const output = Number(info.maxOutputTokens)
            models.set(id, {
              ...(Number.isSafeInteger(context) && context > 0 ? { context } : {}),
              ...(Number.isSafeInteger(output) && output > 0 ? { output } : {}),
              ...(typeof info.supportsImages === "boolean" ? { supportsImages: info.supportsImages } : {}),
              ...(typeof info.displayName === "string" && info.displayName.trim() ? { displayName: info.displayName.trim() } : {}),
            })
          }
        }
      } catch {}
    }
    const result = {
      hasCredentials: true,
      models,
      expiresAt: Date.now() + METADATA_TTL_MS,
    }
    cache.set(key, result)
    return result
  })()
  inflight.set(key, pending)
  try { return await pending } finally {
    if (inflight.get(key) === pending) inflight.delete(key)
  }
}

export function getCachedCloudCodeModels(account) {
  return cache.get(account?.key || "__default__") || null
}

export function invalidateModelMetadataCache() {
  cache.clear()
}

function candidateLookupIds(id, variantIds = []) {
  const candidates = new Set()
  const add = value => {
    if (typeof value === "string" && value.trim()) candidates.add(value.trim())
  }
  add(id)
  const base = stripEffortSuffix(id)
  add(base)
  for (const variantId of variantIds) {
    add(variantId)
    add(stripEffortSuffix(variantId))
  }
  if (base === "gemini-3.8-flash") add("gemini-3.8-flash-tiered")
  if (base === "gemini-3.8-flash-tiered") add("gemini-3.8-flash")
  return [...candidates]
}

export function resolveModelMetadata(id, cloudData, variantIds = []) {
  if (!cloudData?.hasCredentials) return null
  const cloudModels = cloudData.models instanceof Map ? cloudData.models : new Map()
  const candidates = candidateLookupIds(id, variantIds)
  const matched = []
  for (const candidate of candidates) {
    const exact = cloudModels.get(candidate)
    if (exact) matched.push(exact)
  }
  if (!matched.length) {
    const base = stripEffortSuffix(id)
    for (const [remoteId, remoteMeta] of cloudModels) {
      if (stripEffortSuffix(remoteId) === base) matched.push(remoteMeta)
    }
  }
  if (matched.length) {
    const contexts = matched.map(item => item.context).filter(value => Number.isSafeInteger(value) && value > 0)
    const outputs = matched.map(item => item.output).filter(value => Number.isSafeInteger(value) && value > 0)
    const imageFlags = matched.map(item => item.supportsImages).filter(value => typeof value === "boolean")
    const known = KNOWN_MODEL_LIMITS[stripEffortSuffix(id)] || KNOWN_MODEL_LIMITS[id] || null
    const context = contexts.length ? Math.min(...contexts) : known?.context
    const output = outputs.length ? Math.min(...outputs) : known?.output
    const supportsImages = imageFlags.length ? imageFlags.every(Boolean) : known?.supportsImages
    if (context || output || typeof supportsImages === "boolean") {
      return {
        ...(context ? { context } : {}),
        ...(output ? { output } : {}),
        ...(typeof supportsImages === "boolean" ? { supportsImages } : {}),
      }
    }
  }
  if (process.env.AGY_BRIDGE_CLOUDCODE_URL && cloudModels.size > 0 && !KNOWN_MODEL_LIMITS[id] && !KNOWN_MODEL_LIMITS[stripEffortSuffix(id)]) {
    return null
  }
  return KNOWN_MODEL_LIMITS[id] || KNOWN_MODEL_LIMITS[stripEffortSuffix(id)] || null
}

export function isReasoningModel(id, variants) {
  return Boolean(variants?.length || /thinking|gemini|pro-agent/i.test(String(id || "")))
}
