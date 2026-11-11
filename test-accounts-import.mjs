import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { accountsRootDir, listAccounts } from "./accounts.mjs"
import { importAccount, importAccounts, importManifest, ImportError, TOKEN_RELATIVE, validateAccountName } from "./accounts-import.mjs"
import { main } from "./bin/agy-bridge.mjs"

// Only synthetic credentials: nothing here reads a real agy profile.
const SECRET = "SYNTHETIC_FIXTURE_ONLY"
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const native = { access_token: SECRET + "_a", refresh_token: SECRET + "_r" }
function profile(root, name, payload = native) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(path.join(dir, TOKEN_RELATIVE), typeof payload === "string" ? payload : JSON.stringify(payload))
  return dir
}
function fixture() {
  const sources = tmp("import-src-")
  const root = path.join(tmp("import-root-"), "accounts")
  return { sources, root, env: { AGY_BRIDGE_ACCOUNTS_DIR: root } }
}
const rejects = (fn, code) => assert.throws(fn, error => error instanceof ImportError && error.code === code && !error.message.includes(SECRET), code)

test("imports an agy profile directory and a bare token file with private permissions", () => {
  const { sources, root, env } = fixture()
  const dir = profile(sources, "src")
  const file = path.join(sources, "token.json")
  fs.writeFileSync(file, JSON.stringify(native))
  importAccount("work", dir, env)
  importAccount("file", file, env)
  for (const name of ["work", "file"]) {
    const token = path.join(root, name, TOKEN_RELATIVE)
    assert.deepEqual(JSON.parse(fs.readFileSync(token, "utf8")), native)
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(token).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o700)
    }
  }
  assert.deepEqual(listAccounts(env, { refresh: true }).map(a => a.name).filter(Boolean).sort(), ["file", "work"])
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith(".")), [], "staging is cleaned")
})

test("keyring-wrapped and nested-token sources are written as native JSON agy can read", () => {
  const { sources, root, env } = fixture()
  const wrapped = path.join(sources, "wrapped")
  fs.writeFileSync(wrapped, "go-keyring-base64:" + Buffer.from(JSON.stringify({ refresh_token: SECRET })).toString("base64"))
  importAccount("wrapped", wrapped, env)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "wrapped", TOKEN_RELATIVE), "utf8")), { refresh_token: SECRET })
  const nested = path.join(sources, "nested")
  fs.writeFileSync(nested, JSON.stringify({ id_token_email: "x@example.test", token: { access_token: SECRET } }))
  importAccount("nested", nested, env)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "nested", TOKEN_RELATIVE), "utf8")).token.access_token, SECRET)
  const bad = path.join(sources, "bad")
  for (const content of ["go-keyring-base64:!!!notbase64", "go-keyring-base64:" + Buffer.from("not json").toString("base64"),
    JSON.stringify({ token: { note: SECRET } }), "[]", SECRET]) {
    fs.writeFileSync(bad, content)
    rejects(() => importAccount("bad", bad, env), "invalid_source")
  }
  assert.ok(!fs.existsSync(path.join(root, "bad")))
})

test("existing accounts, case collisions, reserved and traversal names are rejected without changes", () => {
  const { sources, root, env } = fixture()
  const dir = profile(sources, "src")
  importAccount("work", dir, env)
  const before = fs.readFileSync(path.join(root, "work", TOKEN_RELATIVE), "utf8")
  fs.writeFileSync(path.join(dir, TOKEN_RELATIVE), JSON.stringify({ refresh_token: "different" }))
  rejects(() => importAccount("work", dir, env), "name_collision")
  rejects(() => importAccount("WORK", dir, env), "name_collision")
  assert.equal(fs.readFileSync(path.join(root, "work", TOKEN_RELATIVE), "utf8"), before)
  for (const name of ["", "../escape", "a/b", "a\\b", "..", ".hidden", "trail.", "x".repeat(65), "antigravity-bridge", "Default", "new", "a..b", "name\0"]) {
    assert.throws(() => validateAccountName(name), error => error instanceof ImportError, JSON.stringify(name))
    assert.throws(() => importAccount(name, dir, env), ImportError)
  }
  assert.deepEqual(fs.readdirSync(root), ["work"])
  assert.ok(!fs.existsSync(path.join(path.dirname(root), "escape")))
})

test("a symlinked destination is never followed or replaced", { skip: process.platform === "win32" }, () => {
  const { sources, root, env } = fixture()
  const dir = profile(sources, "src")
  const outside = tmp("import-outside-")
  fs.mkdirSync(root, { recursive: true })
  fs.symlinkSync(outside, path.join(root, "linked"))
  rejects(() => importAccount("linked", dir, env), "name_collision")
  assert.deepEqual(fs.readdirSync(outside), [])
  const emptySource = path.join(sources, "empty")
  fs.mkdirSync(emptySource)
  rejects(() => importAccount("e", emptySource, env), "invalid_source")
  // A symlinked *source* is only read.
  const link = path.join(sources, "link")
  fs.symlinkSync(dir, link)
  importAccount("fromlink", link, env)
  assert.ok(fs.existsSync(path.join(root, "fromlink", TOKEN_RELATIVE)))
})

test("batch import validates everything first and is all-or-nothing", () => {
  const { sources, root, env } = fixture()
  const a = profile(sources, "a")
  const b = profile(sources, "b", { refresh_token: SECRET + "b" })
  const manifest = path.join(sources, "m.json")
  fs.writeFileSync(manifest, JSON.stringify({ accounts: [{ name: "one", source: "a" }, { name: "two", source: "b" }] }))
  assert.deepEqual(importManifest(manifest, env).map(i => i.name), ["one", "two"])
  assert.deepEqual(listAccounts(env, { refresh: true }).map(x => x.name).filter(Boolean).sort(), ["one", "two"])

  const cases = [
    [[{ name: "three", source: a }, { name: "one", source: b }], "name_collision"],
    [[{ name: "three", source: a }, { name: "THREE", source: b }], "duplicate_name"],
    [[{ name: "three", source: a }, { name: "four", source: path.join(sources, "missing") }], "invalid_source"],
    [[{ name: "three", source: a }, { name: "../x", source: b }], "invalid_name"],
  ]
  for (const [entries, code] of cases) {
    rejects(() => importAccounts(entries, env), code)
    assert.deepEqual(fs.readdirSync(root).sort(), ["one", "two"], code)
  }
  for (const bad of ["{", "[]", JSON.stringify([{ name: "x" }]), JSON.stringify([1]), JSON.stringify({ accounts: "x" })]) {
    fs.writeFileSync(manifest, bad)
    rejects(() => importManifest(manifest, env), "invalid_manifest")
  }
  rejects(() => importManifest(path.join(sources, "nope.json"), env), "invalid_manifest")
})

test("a write failure mid-batch removes only what this call created", { skip: process.platform === "win32" }, () => {
  const { sources, root, env } = fixture()
  const a = profile(sources, "a")
  const b = profile(sources, "b")
  importAccount("keep", a, env)
  const keepToken = fs.readFileSync(path.join(root, "keep", TOKEN_RELATIVE), "utf8")
  const realRename = fs.renameSync
  let calls = 0
  fs.renameSync = (...args) => { if (++calls === 2) throw Object.assign(new Error("boom " + SECRET), { code: "EIO" }); return realRename(...args) }
  try {
    assert.throws(() => importAccounts([{ name: "x1", source: a }, { name: "x2", source: b }], env),
      error => error instanceof ImportError && error.code === "write_failed" && !error.message.includes(SECRET))
  } finally { fs.renameSync = realRename }
  assert.deepEqual(fs.readdirSync(root), ["keep"])
  assert.equal(fs.readFileSync(path.join(root, "keep", TOKEN_RELATIVE), "utf8"), keepToken)
})

test("the accounts cache is per root and invalidated by an import", () => {
  const one = fixture(), two = fixture()
  const src = profile(one.sources, "s")
  assert.equal(listAccounts(one.env).length, 1)
  importAccount("fresh", src, one.env)
  assert.deepEqual(listAccounts(one.env).map(a => a.name), [null, "fresh"], "visible without refresh")
  assert.deepEqual(listAccounts(two.env).map(a => a.name), [null], "another root is isolated")
  assert.equal(accountsRootDir(one.env), one.root)
})

test("the CLI shares the backend and never prints credentials", () => {
  const { sources, root, env } = fixture()
  const dir = profile(sources, "src")
  const lines = []
  const out = line => lines.push(line)
  const errors = []
  const realError = console.error
  console.error = line => errors.push(line)
  try {
    assert.equal(main(["accounts", "import", "cli", dir], { out, env }), 0)
    assert.equal(main(["accounts", "import", "cli", dir], { out, env }), 1)
    assert.equal(main(["accounts", "import", "bad name", dir], { out, env }), 1)
    assert.equal(main(["accounts", "import"], { out, env }), 2)
    assert.equal(main(["accounts", "list"], { out, env }), 0)
  } finally { console.error = realError }
  assert.ok(fs.existsSync(path.join(root, "cli", TOKEN_RELATIVE)))
  assert.ok(errors.some(line => /already exists/.test(line)))
  assert.ok(![...lines, ...errors].join("\n").includes(SECRET))
  assert.ok(lines.includes("cli"))
})
