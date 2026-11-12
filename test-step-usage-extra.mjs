import assert from "node:assert/strict"
import test from "node:test"
import { decodeStepUsage, decodeGenerationUsage, lastModelStep, modelStepsAfter, modelUsageCursor, modelUsageAfter, sessionDbPath } from "./step-usage.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return out }
const usageStats = ({ input, output, write = 0, read, thinking }) => [0x08, ...varint(1418), 0x10, ...varint(input), 0x18, ...varint(output),
    ...(write ? [0x20, ...varint(write)] : []), ...(read ? [0x28, ...varint(read)] : []),
    0x30, 24, 0x48, ...varint(thinking), 0x5a, 2, 0x41, 0x42]
const usageBlob = (usage) => {
  const sub = usageStats(usage)
  // Other metadata fields around field 9, as agy writes them.
  return new Uint8Array([0x0a, 2, 0x08, 1, 0x18, 2, 0x4a, ...varint(sub.length), ...sub, 0x58, ...varint(1418)])
}
const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
const generationBlob = (usage, context = 8100) => {
  const stats = usageStats(usage)
  return new Uint8Array(field(1, [
    ...field(4, stats), ...field(9, field(10, [8, ...varint(context)])),
  ]))
}

test("decodes the usage agy records for one model call", () => {
  // Counts from a real agy 1.5.3 session: second call of a tool turn.
  assert.deepEqual(decodeStepUsage(usageBlob({ input: 2205, output: 40, read: 4907, thinking: 7 })),
    { input: 2205, output: 40, write: 0, read: 4907, thinking: 7 })
  assert.equal(decodeStepUsage(new Uint8Array([0x18, 2])), null)
  assert.equal(decodeStepUsage(new Uint8Array([0x4a, 9, 1])), null)
  assert.equal(decodeStepUsage("not bytes"), null)
})

test("a missing or unreadable store gives no measurement", () => {
  const missing = path.join(os.tmpdir(), "agy-nonexistent-dir-983", "agy.db")
  assert.equal(lastModelStep(missing), -1)
  assert.equal(modelStepsAfter(missing, -1), null)
  assert.equal(sessionDbPath("../escape"), null)
  const customDir = path.join(os.tmpdir(), "agy-custom-convs")
  assert.equal(
    sessionDbPath("f6faf504-502b-4184-90da-aa6ff6105eb0", { AGY_BRIDGE_CONVERSATIONS_DIR: customDir }),
    path.join(customDir, "f6faf504-502b-4184-90da-aa6ff6105eb0.db"),
  )
})

test("generation records separate billing from the local context estimate", () => {
  const usage = { input: 2205, output: 40, write: 12, read: 4907, thinking: 7 }
  assert.deepEqual(decodeGenerationUsage(generationBlob(usage)), { ...usage, context: 8100 })
  assert.equal(decodeGenerationUsage(new Uint8Array(field(1, field(9, field(10, [8, 100]))))), null)
  assert.equal(decodeGenerationUsage(new Uint8Array([10, 90, 1])), null)
  assert.equal(decodeGenerationUsage(new Uint8Array(field(1, field(4, [16, 128])))), null)
  assert.equal(decodeGenerationUsage("not bytes"), null)
})

const require = createRequire(import.meta.url)
let openDatabase
try {
  const { Database } = require("bun:sqlite")
  openDatabase = (file) => {
    const db = new Database(file)
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, ...args) => {
        const stmt = db.prepare(sql)
        try {
          return stmt.run(...args)
        } finally {
          stmt.finalize()
        }
      },
      close: () => db.close(),
    }
  }
} catch {
  try {
    const { DatabaseSync } = require("node:sqlite")
    openDatabase = (file) => {
      const db = new DatabaseSync(file)
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...args) => db.prepare(sql).run(...args),
        close: () => db.close(),
      }
    }
  } catch {}
}

test("usage cursors prefer generation billing, pin the source, mark pending rows and release handles immediately", { skip: !openDatabase }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-generation-test-"))
  const file = path.join(dir, "session.db")
  const initial = modelUsageCursor(file)
  const db = openDatabase(file)
  let closed = false
  const usage = { input: 2205, output: 40, write: 12, read: 4907, thinking: 7 }
  try {
    db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    db.run("INSERT INTO steps VALUES (1, 15, 3, ?)", usageBlob(usage))
    db.run("INSERT INTO gen_metadata VALUES (1, ?)", generationBlob(usage))
    const first = modelUsageAfter(file, initial)
    assert.equal(first.source, "gen_metadata")
    assert.deepEqual(first.steps, [{ idx: 1, ...usage, context: 8100 }])
    const cursor = modelUsageCursor(file)
    assert.deepEqual(modelUsageAfter(file, cursor)?.steps, [])
    // Pre-send estimate row carries 0 billing counters -> pending: true.
    db.run("INSERT INTO gen_metadata VALUES (2, ?)", generationBlob({ input: 0, output: 0, read: 0, thinking: 0 }))
    const pendingBatch = modelUsageAfter(file, cursor)
    assert.deepEqual(pendingBatch, { source: "gen_metadata", steps: [], pending: true })
    db.run("INSERT INTO gen_metadata VALUES (3, ?)", generationBlob({ ...usage, input: 100 }))
    const completedBatch = modelUsageAfter(file, cursor)
    assert.equal(completedBatch?.pending, undefined)
    assert.equal(completedBatch?.steps[0]?.input, 100)
    // Generation-source turns cannot bill a later legacy row again.
    db.run("INSERT INTO steps VALUES (4, 15, 3, ?)", usageBlob(usage))
    assert.deepEqual(modelUsageAfter(file, { source: "gen_metadata", idx: 3 })?.steps, [])
    // Conversely, a turn already reporting steps must not switch on a late gen row.
    assert.deepEqual(modelUsageAfter(file, { source: "steps", idx: 4 })?.steps, [])
    db.close()
    closed = true
    // Strict recursive remove (without `force: true`) verifies no handle leaked on Windows.
    fs.rmSync(dir, { recursive: true })
  } finally {
    if (!closed) {
      try { db.close() } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("stores with an absent or unused generation table retain step billing", { skip: !openDatabase }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-test-"))
  const file = path.join(dir, "session.db")
  const db = openDatabase(file)
  const usage = { input: 22, output: 4, write: 0, read: 0, thinking: 1 }
  try {
    db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
    const legacy = modelUsageCursor(file)
    db.run("INSERT INTO steps VALUES (1, 15, 3, ?)", usageBlob(usage))
    assert.deepEqual(modelUsageAfter(file, legacy), { source: "steps", steps: [{ idx: 1, ...usage }] })
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    const empty = modelUsageCursor(file)
    db.run("INSERT INTO steps VALUES (2, 15, 3, ?)", usageBlob(usage))
    assert.deepEqual(modelUsageAfter(file, empty), { source: "steps", steps: [{ idx: 2, ...usage }] })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("checkpointed WAL stores without -wal/-shm read cleanly without creating sidecar files", { skip: !openDatabase }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wal-clean-"))
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wal-src-"))
  const src = path.join(srcDir, "writer.db")
  const file = path.join(dir, "session.db")
  const usage = { input: 31609, output: 1255, write: 0, read: 22528, thinking: 850 }
  try {
    const db = openDatabase(src)
    db.exec("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    db.run("INSERT INTO gen_metadata VALUES (0, ?)", generationBlob(usage, 65123))
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    fs.copyFileSync(src, file)
    assert.deepEqual(fs.readdirSync(dir), ["session.db"])
    const initial = { source: null, idx: -1, generationIdx: -1 }
    const batch = modelUsageAfter(file, initial)
    assert.deepEqual(batch, { source: "gen_metadata", steps: [{ idx: 0, ...usage, context: 65123 }] })
    assert.deepEqual(modelUsageCursor(file), { source: null, idx: -1, generationIdx: 0 })
    // Must neither fail SQLITE_CANTOPEN (macOS libsqlite3) nor create -wal/-shm sidecars (upstream SQLite).
    assert.deepEqual(fs.readdirSync(dir), ["session.db"])
    fs.rmSync(dir, { recursive: true })
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("re-reads against the live file when -wal appears mid-read during an immutable open", { skip: !openDatabase }, () => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wal-race-src-"))
  const src = path.join(srcDir, "writer.db")
  const first = { input: 100, output: 10, write: 0, read: 500, thinking: 2 }
  const second = { input: 240, output: 25, write: 0, read: 600, thinking: 5 }
  try {
    const db = openDatabase(src)
    db.exec("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    db.run("INSERT INTO gen_metadata VALUES (0, ?)", generationBlob(first, 1000))
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()

    for (const throwOnImmutable of [false, true]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wal-race-"))
      const file = path.join(dir, "session.db")
      let writer
      try {
        fs.copyFileSync(src, file)
        assert.deepEqual(fs.readdirSync(dir), ["session.db"])
        let reads = 0
        const cursor = {
          source: null,
          idx: -1,
          get generationIdx() {
            if (++reads === 1) {
              // Simulate agy resuming the store and writing a new WAL frame after ?immutable=1 opened.
              writer = openDatabase(file)
              writer.exec("PRAGMA wal_autocheckpoint = 0")
              writer.run("INSERT INTO gen_metadata VALUES (1, ?)", generationBlob(second, 2000))
              if (throwOnImmutable) throw new Error("simulated mid-write page inconsistency")
            }
            return -1
          },
        }
        const batch = modelUsageAfter(file, cursor)
        assert.equal(reads, 2, `expected immutable pass followed by live WAL re-read (throw=${throwOnImmutable})`)
        assert.deepEqual(batch, {
          source: "gen_metadata",
          steps: [
            { idx: 0, ...first, context: 1000 },
            { idx: 1, ...second, context: 2000 },
          ],
        })
        writer.close()
        writer = null
        fs.rmSync(dir, { recursive: true })
      } finally {
        try { writer?.close() } catch {}
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    // Counterpart: when an immutable read throws and -wal did NOT appear, must return
    // null without falling through to a live open (which would create -wal/-shm sidecars).
    const noWalDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wal-no-sidecar-"))
    try {
      const noWalFile = path.join(noWalDir, "session.db")
      fs.copyFileSync(src, noWalFile)
      let attempts = 0
      const brokenCursor = {
        source: null,
        idx: -1,
        get generationIdx() {
          attempts++
          throw new Error("corrupt page without concurrent -wal")
        },
      }
      assert.equal(modelUsageAfter(noWalFile, brokenCursor), null)
      assert.equal(attempts, 1)
      assert.deepEqual(fs.readdirSync(noWalDir), ["session.db"])
      fs.rmSync(noWalDir, { recursive: true })
    } finally {
      fs.rmSync(noWalDir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true })
  }
})

test("handles URI-sensitive path characters, relative file: prefixes, and Windows extended/UNC paths", { skip: !openDatabase }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agy-uri-edge-"))
  const src = path.join(base, "src.db")
  const usage = { input: 310, output: 19, write: 0, read: 1200, thinking: 4 }
  const liveUsage = { input: 420, output: 28, write: 0, read: 1500, thinking: 6 }
  const origCwd = process.cwd()
  try {
    const db = openDatabase(src)
    db.exec("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    db.run("INSERT INTO gen_metadata VALUES (0, ?)", generationBlob(usage, 2000))
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()

    const dirNames = ["hash # %20 目录"]
    if (process.platform !== "win32") {
      dirNames.push("query?dir#frag", "file:rel#dir?mode=rwc")
    }

    for (const name of dirNames) {
      const sub = path.join(base, name)
      fs.mkdirSync(sub, { recursive: true })
      const file = path.join(sub, "session.db")
      fs.copyFileSync(src, file)

      // Checkpointed WAL read with `#`, `%20`, `?`, Unicode: must percent-encode cleanly and leave zero sidecars.
      const initial = { source: null, idx: -1, generationIdx: -1 }
      assert.deepEqual(modelUsageAfter(file, initial), {
        source: "gen_metadata",
        steps: [{ idx: 0, ...usage, context: 2000 }],
      })
      assert.deepEqual(fs.readdirSync(sub), ["session.db"])

      if (process.platform === "win32") {
        // Extended-length `\\?\C:\...` path starts with `\\` and contains `?` plus `#`/`%20`/space/Unicode.
        const extendedFile = file.startsWith("\\\\") ? file : `\\\\?\\${file}`
        assert.deepEqual(modelUsageAfter(extendedFile, initial), {
          source: "gen_metadata",
          steps: [{ idx: 0, ...usage, context: 2000 }],
        })
        assert.deepEqual(modelUsageCursor(extendedFile), { source: "gen_metadata", idx: 0 })
        assert.deepEqual(fs.readdirSync(sub), ["session.db"])

        // If administrative loopback UNC share (`\\127.0.0.1\C$\...`) is reachable, verify UNC share too.
        const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(file)
        if (driveMatch) {
          const uncFile = `\\\\127.0.0.1\\${driveMatch[1]}$\\${driveMatch[2]}`
          if (fs.existsSync(uncFile)) {
            assert.deepEqual(modelUsageAfter(uncFile, initial), {
              source: "gen_metadata",
              steps: [{ idx: 0, ...usage, context: 2000 }],
            })
            assert.deepEqual(fs.readdirSync(sub), ["session.db"])
          }
        }
      }

      // Live uncheckpointed WAL read via BOTH absolute and relative path (guards `file:...` under SQLITE_OPEN_URI).
      const writer = openDatabase(file)
      try {
        writer.exec("PRAGMA wal_autocheckpoint = 0")
        writer.run("INSERT INTO gen_metadata VALUES (1, ?)", generationBlob(liveUsage, 3000))
        process.chdir(base)
        const relFile = path.join(name, "session.db")
        assert.deepEqual(modelUsageAfter(relFile, { source: "gen_metadata", idx: 0 }), {
          source: "gen_metadata",
          steps: [{ idx: 1, ...liveUsage, context: 3000 }],
        })
      } finally {
        process.chdir(origCwd)
        writer.close()
      }
      fs.rmSync(sub, { recursive: true })
    }

    assert.equal(lastModelStep(""), null)
    assert.equal(lastModelStep("bad\0path.db"), null)
    assert.equal(modelUsageCursor("bad\0path.db"), null)
  } finally {
    process.chdir(origCwd)
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("uncheckpointed WAL store with incompatible schema is never checkpointed or rewritten", { skip: !openDatabase }, () => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-unckpt-src-"))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-unckpt-dst-"))
  const src = path.join(srcDir, "s.db")
  const dst = path.join(dir, "s.db")
  let db
  try {
    db = openDatabase(src)
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0")
    // Old schema: `steps` lacks `status`, and `gen_metadata` is absent.
    db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)")
    for (let i = 0; i < 40; i++) {
      db.run("INSERT INTO steps VALUES (?, 15, ?)", i, new Uint8Array(2048).fill(7))
    }
    // Snapshot while writer still holds uncheckpointed frames in -wal (simulating crashed agy).
    fs.copyFileSync(src, dst)
    fs.copyFileSync(`${src}-wal`, `${dst}-wal`)
    db.close()
    db = null

    const dbBefore = fs.readFileSync(dst)
    const walBefore = fs.readFileSync(`${dst}-wal`)
    assert.ok(walBefore.length > 0, "expected non-empty uncheckpointed WAL")

    assert.equal(lastModelStep(dst), null)
    assert.equal(modelStepsAfter(dst, -1), null)
    assert.equal(modelUsageCursor(dst), null)

    assert.equal(fs.existsSync(`${dst}-wal`), true, "WAL file must not be checkpointed away")
    assert.equal(Buffer.compare(fs.readFileSync(dst), dbBefore), 0, "main DB bytes must remain untouched")
    assert.equal(Buffer.compare(fs.readFileSync(`${dst}-wal`), walBefore), 0, "WAL bytes must remain untouched")
  } finally {
    try { db?.close() } catch {}
    fs.rmSync(srcDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("an EXCLUSIVE-locked store returns null immediately without waiting on busy timeouts", { skip: !openDatabase }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-locked-test-"))
  const file = path.join(dir, "session.db")
  const locker = openDatabase(file)
  try {
    locker.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    locker.exec("BEGIN EXCLUSIVE")
    locker.run("INSERT INTO gen_metadata VALUES (0, ?)", generationBlob({ input: 100, output: 10, read: 0, thinking: 0 }))
    const t0 = performance.now()
    assert.equal(modelUsageCursor(file), null)
    assert.equal(modelUsageAfter(file, { source: "gen_metadata", idx: -1 }), null)
    const elapsed = performance.now() - t0
    assert.ok(elapsed < 150, `locked store read took ${elapsed.toFixed(1)}ms; expected immediate non-blocking return`)
    locker.exec("ROLLBACK")
  } finally {
    try { locker.close() } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
