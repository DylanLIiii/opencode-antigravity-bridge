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
  return env.AGY_BRIDGE_ACCOUNTS_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie-agy-bridge", "accounts")
}

let cache = null

export function invalidateAccounts() {
  cache = null
}

export function listAccounts(env = process.env, { refresh = false } = {}) {
  if (cache && !refresh) return cache
  const accounts = [DEFAULT_ACCOUNT]
  try {
    const root = accountsRootDir(env)
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      if (entry.name === PROVIDER_ID) continue // would collide with the provider prefix
      const dir = path.join(root, entry.name)
      const token = path.join(dir, "antigravity-cli", "antigravity-oauth-token")
      if (!fs.existsSync(token)) continue
      accounts.push({ name: entry.name, dir, key: `dir:${dir}` })
    }
  } catch {}
  cache = accounts
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
