#!/usr/bin/env node
// agy-bridge: account import and optional context unlock for the Magpie bridge.
import { accountsRootDir, listAccounts } from "../accounts.mjs"
import { ImportError, importAccount, importManifest } from "../accounts-import.mjs"
import { ContextError, contextStatus, disableContext, unlockContext } from "../context-unlock.mjs"

import { wslDistro } from "../platform.mjs"

const USAGE = `Usage:
  agy-bridge accounts list
  agy-bridge accounts import <name> <agy-profile-dir | antigravity-oauth-token file>
  agy-bridge accounts import --manifest <manifest.json>
  agy-bridge context status
  agy-bridge context unlock      copy official agy, patch only the copy (default off)
  agy-bridge context disable [--purge]

Existing accounts are never overwritten. Paths are on this machine.
Restart Magpie after a context change; running sessions keep their current agy.`

function printStatus(status, out) {
  out(`context unlock: ${status.state}${status.active ? " (active)" : ""}`)
  out(status.reason)
  if (status.agyVersion) out(`agy version: ${status.agyVersion}`)
  if (status.source) out(`source: ${status.source}  sha256 ${status.sourceSha256}`)
  if (status.patchedSha256) out(`patched sha256: ${status.patchedSha256}`)
}

export function main(argv, { out = console.log, env = process.env } = {}) {
  const [area, action, ...rest] = argv
  try {
    if (wslDistro(env) && ["accounts", "context"].includes(area)) {
      out("Windows-to-WSL mode supports only the distro default account; host account import/list and context unlock are unavailable. Run agy inside the configured distro.")
      return 1
    }
    if (area === "accounts" && action === "list") {
      out(`accounts root: ${accountsRootDir(env)}`)
      for (const account of listAccounts(env, { refresh: true })) out(account.name ?? "(default: agy global sign-in)")
      return 0
    }
    if (area === "accounts" && action === "import") {
      const created = rest[0] === "--manifest" && rest.length === 2
        ? importManifest(rest[1], env)
        : rest.length === 2 && !rest[0].startsWith("-") ? importAccount(rest[0], rest[1], env) : null
      if (!created) { out(USAGE); return 2 }
      for (const item of created) out(`imported ${item.name} -> ${item.dir}`)
      out("Refresh Magpie's model list to see the new account(s).")
      return 0
    }
    if (area === "context" && action === "status" && rest.length === 0) { printStatus(contextStatus({ env, full: true }), out); return 0 }
    if (area === "context" && action === "unlock" && rest.length === 0) {
      printStatus(unlockContext({ env }), out)
      out("Restart Magpie to use it. Verified upstream only up to agy 1.5.3; no end-to-end long-context run was performed by this tool.")
      return 0
    }
    if (area === "context" && action === "disable" && rest.every(arg => arg === "--purge")) {
      printStatus(disableContext({ env, purge: rest.includes("--purge") }), out)
      out("Restart Magpie to return to the official agy.")
      return 0
    }
    out(USAGE)
    return area === "--help" || area === "-h" || area === "help" ? 0 : 2
  } catch (error) {
    if (!(error instanceof ImportError || error instanceof ContextError)) throw error
    console.error(`error: ${error.message}`)
    return 1
  }
}

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
