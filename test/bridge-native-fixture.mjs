import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"

export function nativeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-test-"))
  const accounts = path.join(root, "accounts")
  const source = path.join(root, "source")
  fs.mkdirSync(path.join(source, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(path.join(source, "antigravity-cli/antigravity-oauth-token"), JSON.stringify({ refresh_token: "SYNTHETIC_NATIVE_ACCOUNT_ONLY" }))
  const smoke = fs.readFileSync(new URL("../test-smoke.mjs", import.meta.url), "utf8")
  const marker = "fs.writeFileSync(fakeAgy, "
  const begin = smoke.indexOf(marker + "String.raw`") + marker.length
  const end = smoke.indexOf("\n`)", begin) + 2
  assert(begin >= marker.length && end > begin)
  const fake = path.join(root, "fake.mjs")
  fs.writeFileSync(fake, vm.runInNewContext(smoke.slice(begin, end), {}))
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const agy = path.join(root, "agy")
  fs.writeFileSync(agy, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 })
  const log = path.join(root, "events.jsonl")
  const env = {
    AGY_PATH: agy, AGY_BRIDGE_ACCOUNTS_DIR: accounts, AGY_BRIDGE_STATE_FILE: path.join(root, "state.json"),
    AGY_BRIDGE_CONVERSATIONS_DIR: root, AGY_BRIDGE_CONTEXT_DIR: path.join(root, "context"),
    FAKE_AGY_LOG: log, FAKE_AGY_STATE: root, AGY_BRIDGE_USAGE: "1",
  }
  const logs = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
  return { root, accounts, source, agy, env, logs,
    cleanup() {
      for (const row of logs().filter(e => e.type === "init")) {
        try { process.kill(-row.pid, "SIGKILL") } catch {}
        try { process.kill(row.mcpPid, "SIGKILL") } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
