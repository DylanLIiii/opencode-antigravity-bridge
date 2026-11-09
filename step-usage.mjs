// Per-model-call usage from agy's local conversation store.
//
// ACP reports usage once, accumulated over a whole session/prompt, and agy
// 1.5.x sends no usage_update notifications. agy does record each model call:
// <conversations>/<sessionId>.db, table `steps`, one row per call with
// step_type 15 and status 3 (done), the counts in Protobuf field 9 of
// `metadata` (2 uncached input, 3 output, 4 cache write, 5 cache read,
// 9 thinking). Summed over a prompt they equal the ACP total exactly.
// Format first decoded by lili-luo/dsh-plugin-bundle (dsh-llm-antigravity-acp,
// MIT). Any failure here returns null and the caller keeps its estimate.
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MODEL_STEP = 15
const STEP_DONE = 3
const require = createRequire(import.meta.url)

let opener

// node:sqlite (Node >= 22.5, Bun) or bun:sqlite; null when neither loads.
function loadOpener() {
  if (opener !== undefined) return opener
  opener = null
  try {
    const { DatabaseSync } = require("node:sqlite")
    if (typeof DatabaseSync === "function") {
      opener = (file) => {
        const db = new DatabaseSync(file, { readOnly: true, timeout: 50 })
        return { all: (sql, ...args) => db.prepare(sql).all(...args), close: () => db.close() }
      }
      return opener
    }
  } catch {}
  try {
    const { Database } = require("bun:sqlite")
    opener = (file) => {
      const db = new Database(file, { readonly: true })
      db.exec("PRAGMA busy_timeout = 50")
      return { all: (sql, ...args) => db.query(sql).all(...args), close: () => db.close() }
    }
  } catch {}
  return opener
}

export function conversationsDir(env = process.env) {
  return env.AGY_BRIDGE_CONVERSATIONS_DIR ||
    path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations")
}

export function sessionDbPath(sessionId, env = process.env) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) return null
  return path.join(conversationsDir(env), `${sessionId}.db`)
}

function varint(buf, at) {
  let value = 0
  let scale = 1
  for (let i = 0; i < 10; i++) {
    const byte = buf[at + i]
    if (byte === undefined) return null
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 }
    scale *= 128
  }
  return null
}

// Calls fn(field, wire, value | bytes) for each field; false on malformed input.
function walk(buf, fn) {
  let at = 0
  while (at < buf.length) {
    const tag = varint(buf, at)
    if (!tag || tag.value < 8) return false
    at = tag.next
    const field = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (wire === 0) {
      const item = varint(buf, at)
      if (!item) return false
      at = item.next
      fn(field, wire, item.value)
    } else if (wire === 2) {
      const len = varint(buf, at)
      if (!len || len.next + len.value > buf.length) return false
      fn(field, wire, buf.subarray(len.next, len.next + len.value))
      at = len.next + len.value
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      if (at > buf.length) return false
    } else {
      return false
    }
  }
  return true
}

const count = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0

export function decodeStepUsage(metadata) {
  const buf = metadata instanceof Uint8Array ? metadata
    : ArrayBuffer.isView(metadata) ? new Uint8Array(metadata.buffer, metadata.byteOffset, metadata.byteLength)
      : null
  if (!buf) return null
  let stats = null
  const ok = walk(buf, (field, wire, value) => {
    if (field !== 9 || wire !== 2) return
    const usage = { input: 0, output: 0, write: 0, read: 0, thinking: 0 }
    if (!walk(value, (sub, subWire, n) => {
      if (subWire !== 0) return
      if (sub === 2) usage.input = count(n)
      else if (sub === 3) usage.output = count(n)
      else if (sub === 4) usage.write = count(n)
      else if (sub === 5) usage.read = count(n)
      else if (sub === 9) usage.thinking = count(n)
    })) return
    stats = usage
  })
  return ok ? stats : null
}

function query(file, sql, ...args) {
  if (!file || !fs.existsSync(file)) return null
  const open = loadOpener()
  if (!open) return null
  let db
  try {
    db = open(file)
    return db.all(sql, ...args)
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

// Highest completed model-call index, -1 for an empty or missing store, null
// when the store exists but cannot be read.
export function lastModelStep(file) {
  if (!file) return null
  if (!fs.existsSync(file)) return -1
  const rows = query(file,
    `SELECT COALESCE(MAX(idx), -1) AS idx FROM steps WHERE step_type = ${MODEL_STEP} AND status = ${STEP_DONE}`)
  const idx = Number(rows?.[0]?.idx)
  return Number.isSafeInteger(idx) ? idx : null
}

// Completed model calls after `afterIdx`, oldest first: [{ idx, input, output, write, read, thinking }].
export function modelStepsAfter(file, afterIdx) {
  const rows = query(file,
    `SELECT idx, metadata FROM steps WHERE step_type = ${MODEL_STEP} AND status = ${STEP_DONE} AND idx > ? ORDER BY idx`,
    afterIdx)
  if (!rows) return null
  const steps = []
  for (const row of rows) {
    const idx = Number(row.idx)
    const usage = decodeStepUsage(row.metadata)
    if (!Number.isSafeInteger(idx) || !usage) continue
    steps.push({ idx, ...usage })
  }
  return steps
}
