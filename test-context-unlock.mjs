import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ContextError, PATCHER, REQUIRED_GATES, contextStatus, disableContext, parseGates, selectAgy, sha256File, unlockContext } from "./context-unlock.mjs"
import { main } from "./bin/agy-bridge.mjs"

// A fake "agy" file plus an injected runner: no real agy, python or model runs.
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
function setup(content = "OFFICIAL-AGY-v1") {
  const home = tmp("ctx-")
  const agy = path.join(home, "agy")
  fs.writeFileSync(agy, content, { mode: 0o755 })
  const env = { AGY_BRIDGE_CONTEXT_DIR: path.join(home, "state"), PATH: home }
  return { home, agy, env }
}
const gateLines = (mark, text) => REQUIRED_GATES.map(g => `[${mark}] [Gate ${g}] fake: ${text}`).join("\n")
// Behaves like the pinned script: dry-run reports gates; --in-place rewrites.
function fakeRun({ version = "1.5.4", skipGate, officialChanged, failApply } = {}) {
  const calls = []
  const run = (file, args) => {
    calls.push([path.basename(file), ...args.map(a => (a.startsWith("/") ? path.basename(a) : a))])
    if (args[0] === "-c") return { code: 0, stdout: "", stderr: "" }
    if (args.includes("--version")) return { code: 0, stdout: version + "\n", stderr: "" }
    const binary = args[args.indexOf("--binary") + 1]
    const patched = fs.readFileSync(binary, "utf8").endsWith("+PATCHED")
    if (args.includes("--in-place")) {
      if (failApply) return { code: 1, stdout: "", stderr: "error: cannot overwrite" }
      fs.appendFileSync(binary, "+PATCHED")
      return { code: 0, stdout: "", stderr: "" }
    }
    const lines = (patched ? gateLines("=", "already patched") : gateLines("*", "will patch")).split("\n")
      .filter(line => !(skipGate && line.includes(`Gate ${skipGate}]`)))
    return { code: 0, stdout: lines.join("\n"), stderr: "" }
  }
  return { run, calls }
}

test("the bundled patcher is the pinned, unmodified upstream file with its MIT license", () => {
  assert.equal(sha256File(PATCHER.path), PATCHER.sha256)
  assert.equal(PATCHER.commit, "0a90ec37c69430608084e33ebc2f891e328c9e89")
  const dir = path.dirname(PATCHER.path)
  assert.match(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), /MIT License[\s\S]*Copyright \(c\) 2026 lili-luo/)
  assert.match(fs.readFileSync(path.join(dir, "PROVENANCE.md"), "utf8"), /0a90ec37c69430608084e33ebc2f891e328c9e89/)
})

test("default is off and nothing is selected without an unlock", () => {
  const { agy, env } = setup()
  const status = contextStatus({ env, official: agy })
  assert.equal(status.state, "default")
  assert.equal(status.active, false)
  assert.deepEqual(selectAgy(agy, env), { path: agy, unlocked: false })
})

test("unlock patches only a managed copy, records hashes, and leaves the official agy untouched", () => {
  const { agy, env } = setup()
  const officialSha = sha256File(agy)
  const { run, calls } = fakeRun()
  const status = unlockContext({ env, agyPath: agy, run })
  assert.equal(sha256File(agy), officialSha, "official install unchanged")
  assert.equal(status.state, "unlocked")
  assert.ok(status.active)
  const manifest = JSON.parse(fs.readFileSync(path.join(env.AGY_BRIDGE_CONTEXT_DIR, "manifest.json"), "utf8"))
  assert.equal(manifest.enabled, true)
  assert.equal(manifest.source.sha256, officialSha)
  assert.equal(manifest.patcher.sha256, PATCHER.sha256)
  assert.equal(manifest.patched.sha256, sha256File(path.join(env.AGY_BRIDGE_CONTEXT_DIR, manifest.patched.file)))
  assert.notEqual(manifest.patched.sha256, officialSha)
  assert.equal(manifest.agyVersion, "1.5.4")
  assert.deepEqual(manifest.gates, REQUIRED_GATES)
  assert.ok(calls.every(call => !call.includes(agy)), "the official path is never given to the patcher")
  assert.ok(calls.some(call => call.includes("--in-place") && call.includes("--no-backup")))
  assert.ok(calls.filter(call => call.includes("--dry-run")).length >= 2, "gates checked before and after")
  assert.deepEqual(selectAgy(agy, env), { path: status.path, unlocked: true })
  assert.deepEqual(fs.readdirSync(env.AGY_BRIDGE_CONTEXT_DIR).filter(n => n.startsWith(".")), [])
})

test("unsupported builds fail closed and keep the default", () => {
  for (const options of [{ skipGate: "4B" }, { failApply: true }]) {
    const { agy, env } = setup()
    assert.throws(() => unlockContext({ env, agyPath: agy, run: fakeRun(options).run }), ContextError)
    assert.equal(contextStatus({ env, official: agy }).state, "default")
    assert.deepEqual(selectAgy(agy, env), { path: agy, unlocked: false })
    assert.equal(fs.readFileSync(agy, "utf8"), "OFFICIAL-AGY-v1")
    assert.deepEqual(fs.readdirSync(env.AGY_BRIDGE_CONTEXT_DIR).filter(n => n !== "manifest.json"), [], "staging discarded")
  }
  // An already-modified (not official) binary is refused rather than adopted.
  const { agy, env } = setup("ALREADY+PATCHED+PATCHED")
  const { run } = fakeRun()
  const already = (file, args) => args.includes("--dry-run") ? { code: 0, stdout: gateLines("=", "already patched"), stderr: "" } : run(file, args)
  assert.throws(() => unlockContext({ env, agyPath: agy, run: already }), /not an official build/)
  // A wrapper script or missing install is refused too.
  assert.throws(() => unlockContext({ env, agyPath: path.join(os.tmpdir(), "no-such-agy"), run }), ContextError)
})

test("a UI deadline bounds every command and an expired deadline starts no command", () => {
  const { agy, env } = setup()
  const fake = fakeRun()
  const run = (file, args, options) => {
    assert(options.timeout > 0 && options.timeout <= 1000)
    return fake.run(file, args)
  }
  assert.equal(unlockContext({ env, agyPath: agy, run, deadline: Date.now() + 1000,
    taskId: "a8586e3e-3729-4164-9f5f-7ee45d572e8d" }).active, true)
  const expired = fakeRun()
  assert.throws(() => unlockContext({ env, agyPath: agy, run: expired.run, deadline: Date.now() - 1 }), error => error.code === "timeout")
  assert.equal(expired.calls.length, 0)
  assert.equal(fs.readFileSync(agy, "utf8"), "OFFICIAL-AGY-v1")
})

test("a tampered patcher is refused before anything runs", () => {
  const { agy, env } = setup()
  const fake = path.join(tmp("ctx-patcher-"), "agy-patch.py")
  fs.writeFileSync(fake, "print('evil')")
  const { run, calls } = fakeRun()
  assert.throws(() => unlockContext({ env, agyPath: agy, run, patcher: { ...PATCHER, path: fake } }), error => error.code === "integrity")
  assert.equal(calls.length, 0)
})

test("selection falls back when the official agy changes, the copy is corrupted, or the unlock is stale", () => {
  const { agy, env } = setup()
  const status = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  // Corrupt copy -> recorded SHA-256 mismatch is detected (size change forces a re-hash).
  fs.appendFileSync(status.path, "x")
  const corrupt = contextStatus({ env, official: agy })
  assert.equal(corrupt.state, "corrupt")
  assert.equal(corrupt.active, false)
  // Fresh unlock, then an official update (size changes) -> stale, default selected.
  const second = setup()
  const s2 = unlockContext({ env: second.env, agyPath: second.agy, run: fakeRun().run })
  assert.ok(s2.active)
  fs.writeFileSync(second.agy, "OFFICIAL-AGY-v2-longer", { mode: 0o755 })
  const after = contextStatus({ env: second.env, official: second.agy })
  assert.equal(after.state, "stale")
  assert.equal(after.active, false)
  assert.deepEqual(selectAgy(second.agy, second.env), { path: second.agy, unlocked: false })
  // A moved official path is stale as well.
  assert.equal(contextStatus({ env: second.env, official: path.join(second.home, "other-agy") }).active, false)
})

test("a corrupted managed copy is detected by SHA-256 on first use in a fresh process view", () => {
  const { agy, env } = setup()
  const status = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  fs.writeFileSync(status.path, "tampered", { mode: 0o755 })
  const result = contextStatus({ env, official: agy, full: true })
  assert.equal(result.active, false)
  assert.equal(result.state, "corrupt")
})

test("ordinary selection checks the source hash even when its size and mtime are preserved", () => {
  const { agy, env } = setup()
  const stamp = new Date("2026-01-01T00:00:00Z")
  fs.utimesSync(agy, stamp, stamp)
  unlockContext({ env, agyPath: agy, run: fakeRun().run })
  assert.equal(contextStatus({ env, official: agy }).active, true)
  const before = fs.statSync(agy)
  fs.writeFileSync(agy, "OFFICIAL-AGY-v2")
  fs.utimesSync(agy, stamp, stamp)
  assert.equal(fs.statSync(agy).size, before.size)
  assert.equal(fs.statSync(agy).mtimeMs, before.mtimeMs)
  assert.equal(contextStatus({ env, official: agy }).state, "stale")
  assert.deepEqual(selectAgy(agy, env), { path: agy, unlocked: false })
})

test("repeated unlock reuses the published executable without replacing it", () => {
  const { agy, env } = setup()
  const first = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  const before = fs.statSync(first.path)
  const second = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  assert.equal(second.path, first.path)
  assert.equal(second.active, true)
  assert.equal(fs.statSync(second.path).ino, before.ino)
  assert.equal(fs.statSync(second.path).mtimeMs, before.mtimeMs)
})

test("manifest publication failure preserves the previous manifest and executable", () => {
  const { agy, env } = setup()
  const first = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  const manifest = path.join(env.AGY_BRIDGE_CONTEXT_DIR, "manifest.json")
  const previous = fs.readFileSync(manifest, "utf8")
  const inode = fs.statSync(first.path).ino
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === manifest) throw Object.assign(new Error("publication denied"), { code: "EACCES" })
    return rename(from, to)
  }
  try {
    assert.throws(() => unlockContext({ env, agyPath: agy, run: fakeRun().run }), /publication denied/)
  } finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(manifest, "utf8"), previous)
  assert.equal(fs.statSync(first.path).ino, inode)
  assert.equal(contextStatus({ env, official: agy }).active, true)
  assert.deepEqual(fs.readdirSync(env.AGY_BRIDGE_CONTEXT_DIR).filter(name => name.startsWith(".") || name.endsWith(".tmp")), [])
})

test("a new unlock keeps the old binary available until an explicit purge", () => {
  const { agy, env } = setup()
  const first = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  const previous = fs.readFileSync(first.path)
  fs.writeFileSync(agy, "OFFICIAL-AGY-v2")
  const second = unlockContext({ env, agyPath: agy, run: fakeRun().run })
  assert.equal(second.active, true)
  assert.notEqual(second.path, first.path)
  assert.deepEqual(fs.readFileSync(first.path), previous)
})

test("disable returns to the official default; purge removes only bridge-owned entries", () => {
  const { home, agy, env } = setup()
  unlockContext({ env, agyPath: agy, run: fakeRun().run })
  const stranger = path.join(env.AGY_BRIDGE_CONTEXT_DIR, "keep-me.txt")
  fs.writeFileSync(stranger, "user file")
  assert.equal(disableContext({ env }).state, "disabled")
  assert.deepEqual(selectAgy(agy, env), { path: agy, unlocked: false })
  assert.equal(disableContext({ env, purge: true }).state, "default")
  assert.equal(fs.readFileSync(stranger, "utf8"), "user file")
  assert.deepEqual(fs.readdirSync(env.AGY_BRIDGE_CONTEXT_DIR), ["keep-me.txt"])
  assert.equal(fs.readFileSync(agy, "utf8"), "OFFICIAL-AGY-v1")
  assert.ok(fs.existsSync(home))
})

test("an unknown manifest version (old state) is ignored", () => {
  const { agy, env } = setup()
  fs.mkdirSync(env.AGY_BRIDGE_CONTEXT_DIR, { recursive: true })
  fs.writeFileSync(path.join(env.AGY_BRIDGE_CONTEXT_DIR, "manifest.json"), JSON.stringify({ version: 0, enabled: true }))
  assert.equal(contextStatus({ env, official: agy }).state, "default")
  assert.equal(selectAgy(agy, env).unlocked, false)
})

test("gate output parsing distinguishes pending, applied and missing gates", () => {
  const gates = parseGates("[*] [Gate 1] x\n[=] [Gate 2] already patched\n[=] [Gate 3A] nothing\n")
  assert.deepEqual(gates.get("1"), { applied: false, pending: true })
  assert.deepEqual(gates.get("2"), { applied: true, pending: false })
  assert.deepEqual(gates.get("3A"), { applied: false, pending: false })
})

test("the CLI reports status, refuses safely and never touches the default when unsupported", () => {
  const { agy, env } = setup()
  const lines = []
  const out = line => lines.push(line)
  const realError = console.error
  const errors = []
  console.error = line => errors.push(line)
  try {
    assert.equal(main(["context", "status"], { out, env: { ...env, AGY_PATH: agy } }), 0)
    assert.equal(main(["context", "disable"], { out, env }), 0)
    assert.equal(main(["context", "bogus"], { out, env }), 2)
    // No Python on this PATH: unlock must fail closed before touching anything.
    assert.equal(main(["context", "unlock"], { out, env: { ...env, AGY_PATH: agy } }), 1)
  } finally { console.error = realError }
  assert.ok(lines.some(line => /context unlock: default/.test(line)))
  assert.ok(errors.some(line => /Python 3\.8\+ is required.*official agy was left unchanged/.test(line)), errors.join("|"))
  assert.equal(fs.readFileSync(agy, "utf8"), "OFFICIAL-AGY-v1")
})
