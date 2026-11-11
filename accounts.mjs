// Named Antigravity accounts. Each account is a full Gemini CLI directory with
// its own file-based OAuth token (`antigravity-cli/antigravity-oauth-token`);
// the bridge starts one agy process pool per account with --gemini_dir=<dir>.
// Keyring/ADC sign-in is machine-global and cannot be isolated per directory, so
// only accounts with a token file are discovered. The default account (null name)
// always exists and keeps agy's global sign-in untouched.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const PROVIDER_ID = "antigravity-bridge"
export const DEFAULT_ACCOUNT = { name: null, dir: null, key: "default" }

export function accountsRootDir(env = process.env) {
  // Always absolute: agy child processes launch from a temporary workspace, so a
  // relative root would resolve differently at discovery and at request time.
  return path.resolve(env.AGY_BRIDGE_ACCOUNTS_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie-agy-bridge", "accounts"))
}

// The cache is keyed by the resolved accounts root, so a changed
// AGY_BRIDGE_ACCOUNTS_DIR (or a second root in tests) never serves stale accounts.
let cache = null

export function invalidateAccounts() {
  cache = null
}

export function listAccounts(env = process.env, { refresh = false } = {}) {
  const root = accountsRootDir(env)
  if (cache && cache.root === root && !refresh) return cache.accounts
  const accounts = [DEFAULT_ACCOUNT]
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      if (entry.name === PROVIDER_ID) continue // would collide with the provider prefix
      const dir = path.resolve(root, entry.name)
      const token = path.join(dir, "antigravity-cli", "antigravity-oauth-token")
      if (!fs.existsSync(token)) continue
      accounts.push({ name: entry.name, dir, key: `dir:${dir}` })
    }
  } catch {}
  cache = { root, accounts }
  return accounts
}

// Split a requested model id into [accountName|null, modelId]. Magpie may send
// "provider/account/model", "account/model", "provider/model" or plain "model";
// agy model ids never contain "/", so the last segment is always the model.
export function splitModelAccount(rawModel, accounts) {
  const segments = String(rawModel || "").split("/").filter(Boolean)
  if (segments[0] === PROVIDER_ID) segments.shift()
  let name = null
  if (segments.length >= 2 && accounts.some(account => account.name === segments[0])) {
    name = segments.shift()
  }
  return { account: name, model: segments.join("/") }
}
