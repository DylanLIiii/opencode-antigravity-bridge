import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  backgroundBlocked,
  cannotSignIn,
  emailOf,
  forgetStoredSignIn,
  isDead,
  noteDead,
  parseStored,
  readAccountSignIn,
  readStoredSignIn,
  storedEmail,
} from "./signin.mjs"
import { createUsageReader } from "./usage.mjs"

test("parseStored handles keyring envelopes, missing tokens, expiry, and API keys", () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const past = new Date(Date.now() - 60_000).toISOString()

  assert.equal(parseStored("").state, "unknown")
  assert.equal(parseStored("{}").state, "unknown")
  assert.equal(parseStored(JSON.stringify({ api_key: "sk-test" })).state, "unknown")
  assert.equal(parseStored(JSON.stringify({ token: {} })).state, "missing")

  const rawValid = JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: future } })
  const b64Valid = `go-keyring-base64:${Buffer.from(rawValid).toString("base64")}`
  const parsedValid = parseStored(b64Valid)
  assert.equal(parsedValid.state, "present")
  assert.equal(parsedValid.canRenew, true)
  assert.equal(parsedValid.expired, false)
  assert.equal(cannotSignIn(parsedValid), "")

  const hexNoRenewExpired = `go-keyring-encoded:${Buffer.from(JSON.stringify({ token: { access_token: "a", expiry: past } })).toString("hex")}`
  const parsedExpired = parseStored(hexNoRenewExpired)
  assert.equal(parsedExpired.state, "present")
  assert.equal(parsedExpired.canRenew, false)
  assert.equal(parsedExpired.expired, true)
  assert.match(cannotSignIn(parsedExpired), /expired/)
})

test("readStoredSignIn and readAccountSignIn respect platform keyrings and skip env", async t => {
  forgetStoredSignIn({ dead: true })
  assert.equal((await readStoredSignIn({
    platform: "darwin",
    env: {},
    exec: async () => ({ code: 44, stdout: "", stderr: "" }),
  })).state, "missing")

  const validJson = JSON.stringify({ token: { refresh_token: "r", expiry: new Date(Date.now() + 3600_000).toISOString() } })
  const winParsed = await readStoredSignIn({
    platform: "win32",
    env: {},
    exec: async () => ({ code: 0, stdout: `OK ${Buffer.from(validJson).toString("base64")}\n`, stderr: "" }),
  })
  assert.equal(winParsed.state, "present")
  assert.equal(winParsed.canRenew, true)

  assert.equal((await readStoredSignIn({
    platform: "darwin",
    env: { AGY_BRIDGE_STORED_SIGNIN: "skip" },
    exec: async () => { throw new Error("should not call security") },
  })).state, "unknown")

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-signin-test-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  assert.match(await backgroundBlocked({ dir, env: {} }), /isn't signed in/)

  await fs.mkdir(path.join(dir, "antigravity-cli"), { recursive: true })
  await fs.writeFile(path.join(dir, "antigravity-cli", "antigravity-oauth-token"), validJson)
  assert.equal(await backgroundBlocked({ dir, env: {} }), "")
})

test("createUsageReader avoids spawning agy when expired/dead and latches dead credentials on auth failure", async t => {
  forgetStoredSignIn({ dead: true })
  let spawned = 0
  // Native cmd.exe/Node need the OS environment on Windows, but no real auth
  // settings should reach this synthetic named-account fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:systemroot|windir|comspec|path|pathext|temp|tmp)$/i.test(key)))
  const spawn = () => {
    spawned++
    throw new Error("should not spawn when missing")
  }
  const missingReader = createUsageReader(() => "/fake/agy", {
    env,
    platform: "darwin",
    spawn,
    signIn: async () => ({ state: "missing" }),
  })
  const resMissing = await missingReader()
  assert.equal(resMissing.signIn, "expired")
  assert.match(resMissing.error, /isn't signed in/)
  assert.equal(spawned, 0)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-auth-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const workDir = path.join(dir, "account")
  await fs.mkdir(path.join(workDir, "antigravity-cli"), { recursive: true })
  await fs.writeFile(
    path.join(workDir, "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: new Date(Date.now() + 60_000).toISOString() } }),
  )
  const stored = await readAccountSignIn(workDir, { env })
  assert.equal(stored.state, "present")

  const agy = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy")
  const fakeScript = path.join(dir, "agy.mjs")
  const queried = path.join(dir, "usage-queried")
  await fs.writeFile(fakeScript, `import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("1.5.0"); process.exit(0); }
if (process.argv.includes("/usage")) fs.writeFileSync(${JSON.stringify(queried)}, "queried");
console.error("Not logged in");
process.exit(1);
`)
  if (process.platform === "win32") {
    await fs.writeFile(agy, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`)
  } else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    await fs.writeFile(agy, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeScript)} "$@"\n`, { mode: 0o700 })
  }
  const liveReader = createUsageReader(() => agy, {
    env,
    platform: process.platform,
    tempRoot: dir,
    resolveAccounts: () => [{ name: "work", dir: workDir }],
  })
  const firstFail = await liveReader()
  assert.equal(firstFail.signIn, "expired", JSON.stringify(firstFail))
  assert.match(firstFail.error, /needs authentication/)
  assert.equal(await fs.readFile(queried, "utf8"), "queried", "authentication failed in /usage, after the successful version probe")
  assert.equal(isDead(stored), true)
  noteDead(stored)
  assert.match(await backgroundBlocked({ dir: workDir, env }), /no longer works/)
})

test("emailOf and storedEmail extract id_token_email without leaking missing or skipped states", async () => {
  const raw = JSON.stringify({ token: { access_token: "a" }, id_token_email: "  alice@example.com  " })
  assert.equal(emailOf(`go-keyring-base64:${Buffer.from(raw).toString("base64")}`), "alice@example.com")
  assert.equal(emailOf("not-json"), "")
  assert.equal(await storedEmail({
    platform: "darwin",
    env: {},
    exec: async () => ({ code: 0, stdout: raw, stderr: "" }),
  }), "alice@example.com")
  assert.equal(await storedEmail({
    platform: "darwin",
    env: {},
    exec: async () => ({ code: 44, stdout: "", stderr: "" }),
  }), "")
  assert.equal(await storedEmail({
    platform: "darwin",
    env: { AGY_BRIDGE_STORED_SIGNIN: "skip" },
    exec: async () => { throw new Error("should not call security") },
  }), "")
})

test("stored keyring reads honor AGY_BRIDGE_DISABLE_KEYCHAIN and never touch Windows credentials in WSL mode", async () => {
  let spawned = 0
  const exec = async () => { spawned++; return { code: 0, stdout: "" } }
  assert.deepEqual(await readStoredSignIn({ platform: "darwin", exec, env: { AGY_BRIDGE_DISABLE_KEYCHAIN: "1" } }), { state: "unknown" })
  assert.deepEqual(await readStoredSignIn({ platform: "win32", exec, env: { AGY_BRIDGE_WSL_DISTRO: "Ubuntu" } }), { state: "unknown" })
  assert.equal(spawned, 0)
})
