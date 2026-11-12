// Magpie stores one local profile reference per native account row. Google
// credentials remain in agy's keychain/profile and never enter the host store.
import { createHash } from "node:crypto"
import { DEFAULT_ACCOUNT, listAccounts } from "./accounts.mjs"
import { validateAccountName } from "./accounts-import.mjs"

export class NativeAccountError extends Error {
  constructor(message, code = "bridge_account_unavailable", statusCode = 503) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.noRetry = true
  }
}

export function nativeAccountResult(name) {
  if (name == null) return { type: "success", key: "agy" }
  validateAccountName(name)
  return { type: "success", key: `agy:${encodeURIComponent(name)}`, metadata: { email: name } }
}

export function nativeAccountSlot(name) {
  validateAccountName(name)
  return `antigravity-bridge#profile-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`
}

export function nativeAccount(auth, { allowMissing = false, env = process.env } = {}) {
  if (auth == null && allowMissing) return DEFAULT_ACCOUNT
  if (auth?.type !== "api" || typeof auth.key !== "string") {
    throw new NativeAccountError("No Bridge account is selected. Sign in or select a saved Bridge account.", "bridge_account_required", 401)
  }
  if (auth.key === "agy") return DEFAULT_ACCOUNT
  let name
  try {
    if (!auth.key.startsWith("agy:")) throw new Error()
    name = decodeURIComponent(auth.key.slice(4))
    validateAccountName(name)
    if (auth.key !== `agy:${encodeURIComponent(name)}`) throw new Error()
  } catch {
    throw new NativeAccountError("The selected Bridge account reference is invalid. Register the saved account again.", "bridge_account_invalid", 400)
  }
  // Always rescan the filesystem: a removed profile must never keep using a
  // cached directory or silently fall back to the machine's default login.
  const account = listAccounts(env, { refresh: true }).find(item => item.name === name)
  if (!account) throw new NativeAccountError(`Saved Bridge account "${name}" is unavailable. Restore its profile or sign in again.`)
  return account
}

export function nativeModelId(raw, account) {
  const parts = String(raw || "").split("/").filter(Boolean)
  if (parts[0] === "antigravity-bridge") parts.shift()
  if (parts.length <= 1) return parts[0] || ""
  // Old account-prefixed IDs are accepted only for the account already chosen
  // by Magpie. A model ID cannot switch to another profile behind the router.
  if (parts.length === 2 && account.name && parts[0] === account.name) return parts[1]
  throw new NativeAccountError("This legacy model prefix does not match the selected Bridge account. Select the unprefixed model and choose the account in Magpie.", "bridge_account_model_mismatch", 409)
}
