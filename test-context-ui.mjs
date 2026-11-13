import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { createContextService, runContextTask, contextPort, DEFAULT_CONTEXT_PORT, CAPABILITY_HEADER } from "./context-ui-service.mjs"

const off = { enabled: false, active: false, state: "default" }
const on = { enabled: true, active: true, state: "unlocked", path: "/private/account/agy", dir: "/private/state", source: "/private/agy" }
async function fixture(t, options = {}) {
  const service = createContextService({ runTask: async () => off, ...options })
  await service.listen(0)
  t.after(() => service.close())
  const request = (route, { method = "GET", headers = {}, body, capability = true } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: service.port, path: route, method,
      headers: { ...(capability ? { [CAPABILITY_HEADER]: service.capability } : {}), ...headers } }, res => {
      let raw = ""
      res.setEncoding("utf8"); res.on("data", s => raw += s)
      res.on("end", () => { let data; try { data = JSON.parse(raw) } catch {} resolve({ status: res.statusCode, headers: res.headers, raw, data }) })
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body))
  })
  const action = (action, extra = {}) => request("/api/action", { method: "POST", headers: { "Content-Type": "application/json", Origin: "null" }, body: { action, confirm: action }, ...extra })
  const status = async () => { await request("/api/status"); await service.idle(); return (await request("/api/status")).data }
  return { service, request, action, status }
}

test("page navigation cannot be read through CORS; APIs require capability and JSON", async t => {
  const { request, service } = await fixture(t)
  for (const headers of [{ Origin: "https://evil.test" }, { Origin: "null" }, { "Sec-Fetch-Mode": "cors" }, { "Sec-Fetch-Dest": "empty" }]) {
    const r = await request("/", { headers, capability: false }); assert.equal(r.status, 403); assert.ok(!r.raw.includes(service.capability)); assert.ok(!r.headers["access-control-allow-origin"])
  }
  const page = await request("/", { capability: false, headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" } })
  assert.equal(page.status, 200)
  const script = /<script>([\s\S]*?)<\/script>/.exec(page.raw)[1]
  const hash = createHash("sha256").update(script).digest("base64")
  assert.ok(page.headers["content-security-policy"].includes(`'sha256-${hash}'`))
  assert.ok(!page.headers["access-control-allow-origin"])
  assert.equal((await request("/api/status", { capability: false })).status, 403)
  assert.equal((await request(`/api/status?capability=${service.capability}`, { capability: false })).status, 403)
  for (const route of ["/", "/api/status", "/bootstrap.html"]) assert.equal((await request(route, { headers: { Host: `evil.test:${service.port}` } })).status, 421)
  assert.equal((await request("/api/status", { headers: { Origin: "https://evil.test" } })).status, 403)
  const opaque = await request("/api/status", { headers: { Origin: "null" } })
  assert.equal(opaque.status, 200); assert.equal(opaque.headers["access-control-allow-origin"], "null")
  const preflight = await request("/api/action", { capability: false, method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Headers": CAPABILITY_HEADER } })
  assert.equal(preflight.status, 204); assert.equal(preflight.headers["access-control-allow-origin"], "null")
  assert.equal((await request("/api/action", { method: "POST", body: { action: "unlock", confirm: "unlock" } })).status, 415)
})

test("confirmation, success, saved/current separation, failure, retry and disable", async t => {
  let stored = off, fail = false, calls = [], current = "not-selected"
  const { action, status, request } = await fixture(t, { runtimeMode: () => current, runTask: async name => {
    calls.push(name)
    if (name === "status") return stored
    if (fail) throw Object.assign(new Error("unsupported build /private/profile/agy"), { code: "unsupported" })
    stored = name === "unlock" ? on : off; return stored
  } })
  let value = await status()
  assert.equal(value.current, "not-selected"); assert.equal(value.declaredContext, null); assert.equal(value.restartRequired, false)
  const before = calls.length
  assert.equal((await action("unlock", { body: { action: "unlock" } })).status, 400)
  assert.equal(calls.length, before)
  current = "default"
  assert.equal((await action("unlock")).status, 202)
  value = await status()
  assert.equal(value.desired, "unlocked"); assert.equal(value.current, "default"); assert.equal(value.restartRequired, true); assert.equal(value.declaredContext, 256000)
  assert.equal(value.last.ok, true); assert.ok(!JSON.stringify(value).includes("/private"))
  current = "unlocked"; fail = true
  assert.equal((await action("disable")).status, 202)
  value = await status()
  assert.equal(value.last.ok, false); assert.equal(value.desired, "unlocked"); assert.ok(!value.last.error.includes("/private"))
  fail = false
  assert.equal((await action("disable")).status, 202)
  value = await status()
  assert.equal(value.last.ok, true); assert.equal(value.desired, "default"); assert.equal(value.current, "unlocked"); assert.equal(value.restartRequired, true)
  assert.equal((await request("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400)
})

test("concurrent actions are rejected and status is responsive", async t => {
  let finish
  const { service, status, action, request } = await fixture(t, { runTask: name => name === "status" ? Promise.resolve(off) : new Promise(resolve => { finish = resolve }) })
  await status()
  assert.equal((await action("unlock")).status, 202)
  assert.equal((await action("disable")).status, 409)
  assert.equal((await request("/api/status")).data.operation.action, "unlock")
  finish(on); await service.idle()
  assert.equal((await request("/api/status")).data.last.ok, true)
})

test("override is reported separately, stale saved state is not actual unlock", async t => {
  const { status } = await fixture(t, { env: { AGY_BRIDGE_CONTEXT_WINDOW: "700000" }, runtimeMode: () => "default", runTask: async () => ({ enabled: true, active: false, state: "stale" }) })
  const s = await status()
  assert.equal(s.desired, "unlocked"); assert.equal(s.effective, "default"); assert.equal(s.current, "default")
  assert.equal(s.declaredContext, 700000); assert.equal(s.contextOverride, 700000); assert.equal(s.limits.gptOss, 131072)
})

test("blocking worker leaves shared host responsive and is bounded", async t => {
  const taskUrl = new URL("./test/context-ui-worker-fixture.mjs", import.meta.url)
  const { service, request } = await fixture(t, { runTask: undefined, taskUrl, env: { TEST_WORK_MS: "400" } })
  const start = Date.now()
  assert.equal((await request("/api/status")).status, 200)
  assert.equal((await request("/api/status")).data.checking, true)
  assert.ok(Date.now() - start < 350, "HTTP must respond while worker is blocked")
  await service.idle()
  assert.equal((await request("/api/status")).data.check.active, false)
  await assert.rejects(runContextTask("status", { taskUrl, env: { TEST_WORK_MS: "300" }, timeout: 30 }), /timed out/)
  await request("/api/status?refresh=1")
  await service.close()
  await service.idle()
  assert.equal(service.busy, false)
})

test("one bind attempt fails promptly and port options are validated", async t => {
  const { service } = await fixture(t)
  const other = createContextService({ runTask: async () => off })
  await assert.rejects(other.listen(service.port), { code: "EADDRINUSE" })
  await other.close()
  assert.equal(contextPort("39431"), 39431)
  for (const value of [0, -1, 65536, NaN, undefined, "oops"]) assert.equal(contextPort(value), DEFAULT_CONTEXT_PORT)
})

// Exercise the real inline UI script with a tiny DOM/network harness. No user
// state or agy is used. Magpie browser acceptance covers CSS and the iframe.
function pageHarness() {
  const html = fs.readFileSync(new URL("./ui/context-app.html", import.meta.url), "utf8")
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: "", hidden: false, disabled: false, checked: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn }, focus() {}, style: {} })
    return nodes.get(id)
  }
  let state = { desired: "default", effective: "default", current: "default", declaredContext: 256000, check: off, checking: false, operation: null, last: null }
  const requests = [], timers = []
  let failure = false
  const sandbox = { URL, URLSearchParams, console, location: { href: "http://host/_magpie/plugin/token/_magpie/service/", hash: "" },
    document: { getElementById: node, querySelectorAll: () => [], documentElement: { style: { setProperty() {} } } },
    addEventListener() {}, setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout() {},
    fetch: async (url, opts) => {
      requests.push({ url, opts })
      if (opts.method === "POST") {
        const body = JSON.parse(opts.body)
        state.last = failure ? { ok: false, error: "test failure" } : { ok: true }
        if (!failure) { state.desired = body.action === "unlock" ? "unlocked" : "default"; state.effective = state.desired }
      }
      return { ok: true, json: async () => structuredClone(state) }
    },
  }
  sandbox.window = sandbox; sandbox.parent = sandbox
  vm.createContext(sandbox)
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox)
  return { node, requests, setFailure: value => { failure = value }, settle: async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }, click: async id => node(id).listeners.click?.(), change: id => node(id).listeners.change?.() }
}

test("UI reviews before writing, cancel has no effect, error retry and default restore", async () => {
  const page = pageHarness(); await page.settle()
  assert.ok(page.requests[0].url.endsWith("/_magpie/service/api/status"), "proxy token path retained")
  page.change("unlocked"); await page.click("apply")
  assert.equal(page.node("review").hidden, false)
  assert.equal(page.requests.filter(r => r.opts.method === "POST").length, 0)
  await page.click("back"); assert.equal(page.node("review").hidden, true)
  assert.equal(page.requests.filter(r => r.opts.method === "POST").length, 0)
  page.change("unlocked"); await page.click("apply"); await page.click("confirm"); await page.settle()
  assert.match(page.node("feedback").textContent, /Saved successfully/)
  assert.equal(JSON.parse(page.requests.find(r => r.opts.method === "POST").opts.body).confirm, "unlock")
  page.setFailure(true); page.change("default"); await page.click("apply"); await page.click("confirm"); await page.settle()
  assert.match(page.node("feedback").textContent, /Operation failed/)
  assert.equal(page.node("apply").disabled, false)
  page.setFailure(false); await page.click("apply"); await page.click("confirm"); await page.settle()
  assert.match(page.node("feedback").textContent, /Saved successfully/)
  assert.equal(JSON.parse(page.requests.filter(r => r.opts.method === "POST").at(-1).opts.body).action, "disable")
})

test("package exposes a provider action, page, worker and portable CI test", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url)))
  assert.equal(pkg.magpie.actions[0].menu, "provider")
  assert.equal(pkg.magpie.actions[0].title, "Antigravity Bridge context")
  assert.equal(pkg.magpie.page.service.option, "contextPort")
  assert.equal(pkg.magpie.page.service.port, DEFAULT_CONTEXT_PORT)
  for (const file of ["context-ui-service.mjs", "context-ui-task.mjs", "ui/"]) assert.ok(pkg.files.includes(file))
  assert.ok(pkg.scripts.test.includes("test-context-ui.mjs"))
  assert.ok(fs.readFileSync(new URL("./.github/workflows/usage.yml", import.meta.url), "utf8").includes("test-context-ui.mjs"))
})


test("production worker restores default in scratch state without purging copies", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-context-ui-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const copy = path.join(dir, "0123456789abcdef")
  fs.mkdirSync(copy)
  fs.writeFileSync(path.join(copy, "agy"), "scratch-only-copy")
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, enabled: true }))
  const value = await runContextTask("disable", { env: { AGY_BRIDGE_CONTEXT_DIR: dir, PATH: dir } })
  assert.equal(value.active, false)
  assert.equal(value.state, "disabled")
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"))).enabled, false)
  assert.equal(fs.readFileSync(path.join(copy, "agy"), "utf8"), "scratch-only-copy")
})
