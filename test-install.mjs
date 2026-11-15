import { after, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { agyPlatform, drained, installAgy, installedVersion, run, untarMember, updateOwnAgy } from "./install.mjs"
import { agyCandidates, ownAgyPath } from "./platform.mjs"

const unix = process.platform !== "win32"

function tar(entries) {
  const blocks = []
  for (const [name, data, type = "0"] of entries) {
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 100), 0)
    header.write("0000755\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124)
    header.write("00000000000\0", 136)
    header.write("        ", 148)
    header.write(type, 156)
    header.write("ustar\0", 257)
    header.write("00", 263)
    let sum = 0
    for (const b of header) sum += b
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const script = (version) => Buffer.from(`#!/bin/sh\necho "agy ${version}"\n`)
const sha = (b) => createHash("sha512").update(b).digest("hex")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const files = new Map()
const createdRoots = []
let manifest = null
let slow = false
let root

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  if (url.pathname.startsWith("/manifests/")) {
    if (!manifest) {
      res.writeHead(404)
      res.end("no")
      return
    }
    const { port } = server.address()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ...manifest, url: `http://127.0.0.1:${port}${manifest.url}` }))
    return
  }
  const body = files.get(url.pathname)
  if (!body) {
    res.writeHead(404)
    res.end("no")
    return
  }
  if (slow) {
    res.writeHead(200)
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(timer)
        return
      }
      res.write(Buffer.alloc(1024))
    }, 50)
    res.on("close", () => clearInterval(timer))
    return
  }
  res.writeHead(200)
  res.end(body)
})

const prevBase = process.env.AGY_BRIDGE_INSTALL_BASE
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
process.env.AGY_BRIDGE_INSTALL_BASE = `http://127.0.0.1:${server.address().port}/manifests/`

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  if (prevBase === undefined) delete process.env.AGY_BRIDGE_INSTALL_BASE
  else process.env.AGY_BRIDGE_INSTALL_BASE = prevBase
  for (const dir of createdRoots) fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-"))
  createdRoots.push(root)
  files.clear()
  manifest = null
  slow = false
})

function release(version, entries) {
  const body = tar(entries ?? [["antigravity", script(version)]])
  files.set(`/r/${version}.tar.gz`, body)
  manifest = { version, url: `/r/${version}.tar.gz`, sha512: sha(body) }
}

test("each machine is named as Antigravity's installer names it", () => {
  assert.equal(agyPlatform("linux", "x64", false), "linux_amd64")
  assert.equal(agyPlatform("linux", "arm64", true), "linux_arm64_musl")
  assert.equal(agyPlatform("darwin", "arm64"), "darwin_arm64")
  assert.equal(agyPlatform("win32", "x64"), "windows_amd64")
  assert.equal(agyPlatform("linux", "ia32", false), null)
  assert.equal(agyPlatform("android", "arm64", false), null)
})

test("the plugin's own agy is in its own data folder, found after the user's", () => {
  assert.equal(ownAgyPath({ XDG_DATA_HOME: "/config/data" }, "/config/home", "linux"), "/config/data/magpie-agy-cli/agy")
  assert.equal(ownAgyPath({}, "/home/u", "linux"), "/home/u/.local/share/magpie-agy-cli/agy")
  assert.equal(ownAgyPath({ XDG_DATA_HOME: "relative" }, "/home/u", "linux"), "/home/u/.local/share/magpie-agy-cli/agy")
  assert.equal(ownAgyPath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u", "win32"), "C:\\Users\\u\\AppData\\Local\\magpie-agy-cli\\agy.exe")
  const c = agyCandidates({ PATH: "/usr/bin", XDG_DATA_HOME: "/config/data" }, "/config/home", "linux")
  assert.equal(c.at(-1), "/config/data/magpie-agy-cli/agy")
  assert.equal(c[0], "/usr/bin/agy")
})

test("agy is taken out of its archive, past a long name and a ./ prefix", async () => {
  const archive = path.join(root, "a.tar.gz")
  const long = "x".repeat(150)
  fs.writeFileSync(archive, tar([
    ["././@LongLink", Buffer.from(long + "\0"), "L"],
    ["short", Buffer.from("not this one")],
    ["README", Buffer.alloc(700, 65)],
    ["./antigravity", Buffer.alloc(5000, 7)],
  ]))
  const out = path.join(root, "agy")
  assert.equal(await untarMember(archive, "antigravity", out), true)
  assert.equal(fs.readFileSync(out).equals(Buffer.alloc(5000, 7)), true)
  assert.equal(await untarMember(archive, "nothere", path.join(root, "none")), false)
  assert.equal(fs.existsSync(path.join(root, "none")), false)
})

test("installs the manifest's agy, checked and runnable, leaving nothing else", { skip: !unix }, async () => {
  release("1.5.9")
  const bin = path.join(root, "data", "magpie-agy-cli", "agy")
  assert.equal(await installAgy({ bin, platform: "linux_amd64" }), "1.5.9")
  assert.notEqual(fs.statSync(bin).mode & 0o111, 0)
  assert.equal(installedVersion(bin), "1.5.9")
  assert.deepEqual(fs.readdirSync(path.dirname(bin)).sort(), ["agy", "agy.version"])
})

test("a download that isn't the manifest's is never installed", { skip: !unix }, async () => {
  release("1.5.9")
  manifest.sha512 = sha(Buffer.from("something else"))
  const bin = path.join(root, "agy")
  await assert.rejects(installAgy({ bin, platform: "linux_amd64" }), /checksum/)
  assert.deepEqual(fs.readdirSync(root), [])
})

test("an agy that doesn't run here isn't put in place of one that does", { skip: !unix }, async () => {
  release("1.5.9")
  const bin = path.join(root, "agy")
  await installAgy({ bin, platform: "linux_amd64" })
  release("1.6.0", [["antigravity", Buffer.from("#!/bin/sh\necho 'cannot execute: required file not found' >&2\nexit 126\n")]])
  await assert.rejects(installAgy({ bin, platform: "linux_amd64" }), /doesn't run here \(cannot execute/)
  assert.equal(installedVersion(bin), "1.5.9")
})

test("a manifest the server won't give says so", { skip: !unix }, async () => {
  await assert.rejects(installAgy({ bin: path.join(root, "agy"), platform: "linux_amd64" }), /answered 404/)
})

test("an install given up stops its download and leaves nothing", { skip: !unix }, async () => {
  release("1.5.9")
  slow = true
  const bin = path.join(root, "agy")
  const ctl = new AbortController()
  const done = installAgy({ bin, platform: "linux_amd64", signal: ctl.signal })
  await sleep(200)
  ctl.abort()
  await assert.rejects(done)
  assert.deepEqual(fs.readdirSync(root), [])
})

test("only the plugin's own copy is kept current, and not when the user turned updates off", { skip: !unix }, async () => {
  const bin = path.join(root, "agy")
  release("1.5.9")
  assert.equal(await updateOwnAgy({ bin, platform: "linux_amd64", env: {} }), "none")
  await installAgy({ bin, platform: "linux_amd64" })
  assert.equal(await updateOwnAgy({ bin, platform: "linux_amd64", env: {} }), "current")
  release("1.6.0")
  assert.equal(await updateOwnAgy({ bin, platform: "linux_amd64", env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } }), "off")
  assert.equal(await updateOwnAgy({ bin, platform: "linux_amd64", env: {}, used: "/usr/local/bin/agy" }), "not used")
  assert.equal(installedVersion(bin), "1.5.9")
  assert.equal(await updateOwnAgy({ bin, platform: "linux_amd64", env: {}, used: bin }), "updated")
  assert.equal(installedVersion(bin), "1.6.0")
})

test("waiting on a full stream leaves no listener behind", async () => {
  const out = new EventEmitter()
  for (let i = 0; i < 20; i++) {
    const wait = drained(out)
    out.emit("drain")
    await wait
  }
  assert.equal(out.listenerCount("error"), 0)
  assert.equal(out.listenerCount("drain"), 0)
  const failed = drained(out)
  out.emit("error", new Error("disk full"))
  await assert.rejects(failed, /disk full/)
  assert.equal(out.listenerCount("drain"), 0)
})

test("an archive that can't be written out rejects instead of crashing the host", async () => {
  const archive = path.join(root, "a.tar.gz")
  fs.writeFileSync(archive, tar([["antigravity", Buffer.alloc(5000, 7)]]))
  let uncaught = null
  const onUncaught = (error) => { uncaught = error }
  process.prependListener("uncaughtException", onUncaught)
  try {
    await assert.rejects(untarMember(archive, "antigravity", path.join(root, "missing", "agy")), { code: "ENOENT" })
    await sleep(20)
  } finally {
    process.off("uncaughtException", onUncaught)
  }
  assert.equal(uncaught, null)
})

test("missing and corrupt archives reject through the extraction promise", async () => {
  await assert.rejects(untarMember(path.join(root, "missing.tar.gz"), "antigravity", path.join(root, "out")), { code: "ENOENT" })
  const bad = path.join(root, "bad.tar.gz")
  fs.writeFileSync(bad, "not a gzip stream")
  await assert.rejects(untarMember(bad, "antigravity", path.join(root, "out")), /header|gzip|data/i)
  assert.equal(fs.existsSync(path.join(root, "out")), false)
})

test("a download that can't be written leaves nothing and doesn't crash", { skip: !unix }, async () => {
  release("1.5.9")
  const bin = path.join(root, "agy")
  const realCreate = fs.createWriteStream
  fs.createWriteStream = (file, opts) => realCreate(path.join(root, "gone", path.basename(String(file))), opts)
  try {
    await assert.rejects(installAgy({ bin, platform: "linux_amd64" }), { code: "ENOENT" })
  } finally {
    fs.createWriteStream = realCreate
  }
  assert.deepEqual(fs.readdirSync(root), [])
})

test("the version check is bounded even when the binary ignores SIGTERM and a child holds its pipes", { skip: !unix }, async () => {
  const exe = path.join(root, "stuck")
  fs.writeFileSync(exe, "#!/bin/sh\ntrap '' TERM\n(sleep 30) &\nsleep 30\n", { mode: 0o755 })
  const started = Date.now()
  const r = await run(exe, ["--version"], { timeoutMs: 200, killGraceMs: 100 })
  assert.ok(Date.now() - started < 5_000, `run took ${Date.now() - started}ms`)
  assert.notEqual(r.code, 0)
  assert.match(r.stopped, /timed out/)
})

test("cancelling during the version check stops it and installs nothing", { skip: !unix }, async () => {
  const bin = path.join(root, "agy")
  release("1.5.9", [["antigravity", Buffer.from("#!/bin/sh\nsleep 30\n")]])
  const ctl = new AbortController()
  const started = Date.now()
  const done = installAgy({ bin, platform: "linux_amd64", signal: ctl.signal })
  for (let i = 0; i < 100 && !fs.readdirSync(root).some((f) => f.startsWith(".agy-")); i++) await sleep(20)
  await sleep(100)
  ctl.abort()
  await assert.rejects(done, { name: "AbortError" })
  assert.ok(Date.now() - started < 10_000)
  assert.deepEqual(fs.readdirSync(root), [])
})

test("on Windows a replacement that fails puts the working agy back", { skip: !unix }, async () => {
  const bin = path.join(root, "agy.exe")
  fs.writeFileSync(bin, "old working agy")
  fs.writeFileSync(bin + ".version", "1.5.9\n")
  release("1.6.0")
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === bin && path.basename(String(from)).startsWith(".agy-")) throw Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" })
    return realRename(from, to)
  }
  try {
    await assert.rejects(installAgy({ bin, platform: "windows_amd64" }), { code: "EBUSY" })
  } finally {
    fs.renameSync = realRename
  }
  assert.equal(fs.readFileSync(bin, "utf8"), "old working agy")
  assert.equal(installedVersion(bin), "1.5.9")
  assert.deepEqual(fs.readdirSync(root).sort(), ["agy.exe", "agy.exe.version"])
})

test("a failed Windows rollback retains the only working binary backup", { skip: !unix }, async () => {
  const bin = path.join(root, "agy.exe")
  fs.writeFileSync(bin, "old working agy")
  release("1.6.0")
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === bin) throw Object.assign(new Error("EBUSY: locked destination"), { code: "EBUSY" })
    return realRename(from, to)
  }
  try {
    await assert.rejects(installAgy({ bin, platform: "windows_amd64" }), { code: "EBUSY" })
  } finally { fs.renameSync = realRename }
  const backups = fs.readdirSync(root).filter(name => name.startsWith(".old-"))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(root, backups[0]), "utf8"), "old working agy")
  manifest.sha512 = sha(Buffer.from("invalid checksum"))
  await assert.rejects(installAgy({ bin, platform: "windows_amd64" }), /checksum/)
  assert.equal(fs.readFileSync(path.join(root, backups[0]), "utf8"), "old working agy")
})
