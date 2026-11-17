import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import readline from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { nativeFixture } from "./test/bridge-native-fixture.mjs"
import { nativeAccountResult, nativeAccountSlot } from "./native-accounts.mjs"

const defaults = { type: "api", key: "agy" }
const record = name => { const { type: _, ...fields } = nativeAccountResult(name); return { type: "api", ...fields } }
const parse = raw => raw.split("\n\n").flatMap(block => {
  const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1]
  return event && data ? [{ event, data: JSON.parse(data) }] : []
})

test("native Magpie accounts share model IDs and isolate auth, tools, usage and missing profiles", { skip: process.platform === "win32" }, async t => {
  const f = nativeFixture(), saved = { ...process.env }
  Object.assign(process.env, f.env)
  const writes = []
  const { AntigravityBridgePlugin } = await import("./index.mjs")
  const plugin = await AntigravityBridgePlugin({ magpie: {}, client: { auth: { set: async value => writes.push(value) } } })
  t.after(() => {
    f.cleanup()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
  assert.equal(plugin.auth.single, false)
  assert.equal(plugin.auth.methods.length, 5)
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await plugin.auth.methods[1].authorize({ name: "cancelled", source: f.source }, { signal: cancelled.signal })).type, "failed")
  assert(!fs.existsSync(path.join(f.accounts, "cancelled")))
  const created = await plugin.auth.methods[1].authorize({ name: "Yazi", source: f.source })
  assert.deepEqual(created, nativeAccountResult("Yazi"))
  assert.equal(JSON.stringify(created).includes("SYNTHETIC_NATIVE_ACCOUNT_ONLY"), false)
  assert.deepEqual(await plugin.auth.methods[0].authorize(), { type: "success", key: "agy" })
  assert.deepEqual(await plugin.auth.methods[4].authorize({ name: "Yazi" }), created)
  assert.equal((await plugin.auth.methods[4].authorize({ name: "missing" })).type, "failed")
  const catalogs = await Promise.all([defaults, record("Yazi")].map(auth => plugin.provider.models({}, { auth })))
  assert.deepEqual(Object.keys(catalogs[0]).sort(), Object.keys(catalogs[1]).sort())
  assert(Object.keys(catalogs[0]).length >= 3)
  assert(Object.values(catalogs[1]).every(m => !m.id.includes("/") && !m.name.includes("[Yazi]")))
  const loaders = await Promise.all([defaults, record("Yazi")].map(auth => plugin.auth.loader(async () => auth)))
  const body = { model: "gemini-test-medium", stream: false, metadata: { user_id: "same-conversation" }, messages: [{ role: "user", content: "native account routing" }] }
  const send = (loader, request) => loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(request) })
  const before = f.logs().filter(e => e.type === "user").length
  for (const loader of loaders) assert.equal((await send(loader, body)).status, 200)
  const users = f.logs().filter(e => e.type === "user").slice(before)
  assert.equal(users.length, 2)
  const initFor = user => f.logs().find(e => e.type === "init" && e.convId === user.convId)
  assert.equal(initFor(users[0]).geminiDir, null)
  assert.equal(initFor(users[1]).geminiDir, path.join(f.accounts, "Yazi"))
  assert.notEqual(initFor(users[0]).pid, initFor(users[1]).pid)
  for (const [index, loader] of loaders.entries()) {
    const request = { ...body, stream: true, messages: [{ role: "user", content: "TOOL native account" }],
      tools: [{ name: "echo", description: "Echo", input_schema: { type: "object", properties: { text: { type: "string" } } } }] }
    const first = parse(await (await send(loader, request)).text())
    const call = first.find(e => e.data.content_block?.type === "tool_use").data.content_block
    const args = JSON.parse(first.filter(e => e.data.delta?.type === "input_json_delta").map(e => e.data.delta.partial_json).join(""))
    const text = first.filter(e => e.data.delta?.type === "text_delta").map(e => e.data.delta.text).join("")
    const continued = { ...request, messages: [...request.messages,
      { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { ...call, input: args }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `account-${index}-result` }] },
    ] }
    const final = parse(await (await send(loader, continued)).text())
    assert.equal(final.find(e => e.event === "message_delta")?.data.delta.stop_reason, "end_turn")
    const result = f.logs().filter(e => e.type === "mcpResult").at(-1)
    const init = f.logs().find(e => e.type === "init" && e.convId === result.convId)
    assert.equal(init.geminiDir, index ? path.join(f.accounts, "Yazi") : null)
    assert.equal(result.result.content[0].text, `account-${index}-result`)
  }
  const usageBefore = f.logs().filter(e => e.type === "usage").length
  const usage = await Promise.all([defaults, record("Yazi")].map(auth => plugin.auth.usage(async () => auth)))
  assert(usage.every(u => u.windows.length === 1 && !u.windows[0].name.includes("[Yazi]")))
  const usageCalls = f.logs().filter(e => e.type === "usage").slice(usageBefore)
  assert.equal(usageCalls.length, 2)
  assert.equal(usageCalls.filter(e => e.args.includes(`--gemini_dir=${path.join(f.accounts, "Yazi")}`)).length, 1)
  const count = f.logs().filter(e => e.type === "user").length
  const mismatch = await send(loaders[0], { ...body, model: "Yazi/gemini-test-medium" })
  assert.equal(mismatch.status, 409)
  assert.equal(f.logs().filter(e => e.type === "user").length, count)
  fs.renameSync(path.join(f.accounts, "Yazi"), path.join(f.root, "removed-Yazi"))
  const missing = await send(loaders[1], { ...body, messages: [{ role: "user", content: "missing profile" }] })
  assert.equal(missing.status, 503)
  assert.equal((await missing.json()).error.code, "bridge_account_unavailable")
  assert.equal(f.logs().filter(e => e.type === "user").length, count)
  fs.renameSync(path.join(f.root, "removed-Yazi"), path.join(f.accounts, "Yazi"))
  const manifest = path.join(f.root, "manifest.json")
  fs.writeFileSync(manifest, JSON.stringify([{ name: "batch-a", source: f.source }, { name: "batch-b", source: f.source }]))
  assert.deepEqual(await plugin.auth.methods[2].authorize({ manifest }), nativeAccountResult("batch-a"))
  assert.deepEqual(writes, [{ path: { id: nativeAccountSlot("batch-b") }, body: record("batch-b") }])
  fs.writeFileSync(manifest, JSON.stringify([{ name: "no-client-a", source: f.source }, { name: "no-client-b", source: f.source }]))
  const noClient = await AntigravityBridgePlugin({ magpie: {} })
  assert.equal((await noClient.auth.methods[2].authorize({ manifest })).type, "failed")
  assert(!fs.existsSync(path.join(f.accounts, "no-client-a")))
  const invalid = await plugin.auth.loader(async () => ({ type: "api", key: "agy:..%2Foutside" }))
  assert.equal((await send(invalid, body)).status, 400)
  const signedOut = await plugin.auth.loader(async () => undefined)
  assert.equal((await send(signedOut, body)).status, 401)
})

test("real Magpie host keeps two native rows and routes identical models through the selected account", {
  skip: !process.env.AGY_BRIDGE_TEST_HOST_JS || !process.env.AGY_BRIDGE_TEST_HOST_RUNTIME || process.platform === "win32",
}, async t => {
  const f = nativeFixture()
  fs.cpSync(f.source, path.join(f.accounts, "Yazi"), { recursive: true })
  const authPath = path.join(f.root, "auth.json"), provider = "antigravity-bridge"
  const unrelated = { type: "api", key: "SYNTHETIC_OTHER_PLUGIN" }
  fs.writeFileSync(authPath, JSON.stringify({ [provider]: defaults, unrelated }))
  const host = spawn(process.env.AGY_BRIDGE_TEST_HOST_RUNTIME, ["run", process.env.AGY_BRIDGE_TEST_HOST_JS], {
    cwd: f.root, env: { ...process.env, ...f.env, HOME: f.root, XDG_CONFIG_HOME: path.join(f.root, "config") }, stdio: ["pipe", "pipe", "pipe"],
  })
  host.stderr.resume()
  const pending = new Map(), lines = readline.createInterface({ input: host.stdout })
  let next = 0
  lines.on("line", line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const item = pending.get(message.id)
    if (!item) return
    if (message.event) { item.frames.push(message); return }
    pending.delete(message.id)
    clearTimeout(item.timer)
    message.error ? item.reject(new Error(message.error.message)) : item.resolve({ result: message.result, frames: item.frames })
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")) }, 20000)
    pending.set(id, { resolve, reject, timer, frames: [] })
    host.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  })
  const call = async (method, params) => (await request(method, params)).result
  t.after(async () => {
    host.kill("SIGKILL")
    await new Promise(resolve => host.once("exit", resolve))
    lines.close()
    for (const item of pending.values()) clearTimeout(item.timer)
    f.cleanup()
  })
  await call("init", { authPath, directory: f.root, plugins: [{ spec: "bridge-native-test", target: fileURLToPath(new URL("./index.mjs", import.meta.url)) }] })
  const result = await call("apiKey", { provider, method: 4, account: "new", inputs: { name: "Yazi" } })
  assert.equal(result.ok, true)
  assert.notEqual(result.account, provider)
  const again = await call("apiKey", { provider, method: 4, account: "new", inputs: { name: "Yazi" } })
  assert.equal(again.account, result.account)
  const stored = JSON.parse(fs.readFileSync(authPath, "utf8"))
  assert.deepEqual(stored[provider], defaults)
  assert.deepEqual(stored[result.account], record("Yazi"))
  assert.deepEqual(stored.unrelated, unrelated)
  assert.equal(Object.keys(stored).length, 3)
  // An existing name starts a sign-in again; nothing changes until its
  // callback completes.
  const duplicateGoogle = await call("authorize", { provider, method: 3, account: "new", inputs: { name: "Yazi" } })
  assert.equal(duplicateGoogle.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), stored)
  const row = (await call("providers", {})).find(p => p.id === provider)
  assert.equal(row.accounts.length, 2)
  assert.equal(row.accounts[1].accountId, "Yazi")
  assert(row.models.every(m => !m.id.includes("/") && !m.name.includes("[Yazi]")))
  for (const account of [provider, result.account]) {
    const checked = await call("check", { provider, account })
    assert(checked.models.length > 0 && checked.models.every(id => !id.includes("/")))
    assert.equal(checked.usage.windows.length, 1)
    const body = { model: "gemini-test-medium", stream: false, messages: [{ role: "user", content: "same model through real host" }] }
    const response = await request("fetch", { provider, account, model: body.model, npm: "@ai-sdk/anthropic", url: "agy://local/messages", body: Buffer.from(JSON.stringify(body)).toString("base64") })
    assert.equal(response.frames.find(f => f.event === "head")?.status, 200)
    const payload = JSON.parse(response.frames.filter(f => f.event === "chunk").map(f => Buffer.from(f.data, "base64").toString()).join(""))
    assert.equal(payload.stop_reason, "end_turn")
  }
  const users = f.logs().filter(e => e.type === "user")
  assert.equal(users.length, 2)
  assert.deepEqual(users.map(u => f.logs().find(e => e.type === "init" && e.convId === u.convId).geminiDir), [null, path.join(f.accounts, "Yazi")])
  const ticket = await call("authorize", { provider, method: 3, account: "new", inputs: { name: "browser" } })
  assert.equal(ticket.ok, true)
  const google = await call("callback", { session: ticket.session, code: "4/smoke-login-code" })
  assert.equal(google.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8"))[google.account], record("browser"))
  const manifest = path.join(f.root, "manifest.json")
  fs.writeFileSync(manifest, JSON.stringify([{ name: "batch-a", source: f.source }, { name: "batch-b", source: f.source }]))
  const batch = await call("apiKey", { provider, method: 2, account: "new", inputs: { manifest } })
  assert.equal(batch.ok, true)
  const afterBatch = JSON.parse(fs.readFileSync(authPath, "utf8"))
  assert.deepEqual(afterBatch[batch.account], record("batch-a"))
  assert.deepEqual(afterBatch[nativeAccountSlot("batch-b")], record("batch-b"))
  assert.deepEqual(afterBatch[provider], defaults)
  assert.deepEqual(afterBatch.unrelated, unrelated)
  assert.equal(Object.keys(afterBatch).length, 6)
  const badTicket = await call("authorize", { provider, method: 3, account: "new", inputs: { name: "rejected" } })
  const refused = await call("callback", { session: badTicket.session, code: "https://antigravity.google/oauth-callback?state=wrong&code=synthetic" })
  assert.equal(refused.ok, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), afterBatch)
  assert(!fs.existsSync(path.join(f.accounts, "rejected")))
  await call("signOut", { provider, account: result.account })
  const remaining = { ...afterBatch }
  delete remaining[result.account]
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), remaining)
  await call("reload", { provider })
  assert.equal((await call("providers", {})).find(p => p.id === provider).accounts.length, 4)
  assert(fs.existsSync(path.join(f.accounts, "Yazi/antigravity-cli/antigravity-oauth-token")))
  // The user's case: the row was removed but the profile stayed. Adding the
  // same name again through the Google sign-in signs it in again rather than
  // failing, and gives Magpie a working row back.
  const conversation = path.join(f.accounts, "Yazi/antigravity-cli/conversations/kept.pb")
  fs.mkdirSync(path.dirname(conversation), { recursive: true })
  fs.writeFileSync(conversation, "kept conversation")
  const readd = await call("authorize", { provider, method: 3, account: "new", inputs: { name: "yazi" } })
  assert.equal(readd.ok, true)
  const readded = await call("callback", { session: readd.session, code: "4/smoke-login-code" })
  assert.equal(readded.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8"))[readded.account], record("Yazi"))
  assert.equal(fs.readFileSync(conversation, "utf8"), "kept conversation")
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.accounts, "Yazi/antigravity-cli/antigravity-oauth-token"), "utf8")).refresh_token, "SYNTHETIC_LOGIN_FIXTURE_ONLY")
  const checked = await call("check", { provider, account: readded.account })
  assert(checked.models.length > 0)
  assert.equal(checked.usage.windows.length, 1)
  // A row whose profile is gone: usage marks it as needing sign-in.
  fs.rmSync(path.join(f.accounts, "batch-b"), { recursive: true })
  const lapsed = await call("usage", { provider, account: nativeAccountSlot("batch-b") })
  assert.equal(lapsed.signIn, "expired")
})

test("signing an account in again keeps its rows and conversations, refreshes its catalog and retires its idle agy", { skip: process.platform === "win32" }, async t => {
  const f = nativeFixture(), saved = { ...process.env }
  Object.assign(process.env, f.env)
  const { AntigravityBridgePlugin } = await import("./index.mjs?resign")
  const plugin = await AntigravityBridgePlugin({ magpie: {}, client: { auth: { set: async () => {} } } })
  t.after(() => {
    f.cleanup()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
  const importMethod = plugin.auth.methods[1]
  assert.deepEqual(await importMethod.authorize({ name: "Work", source: f.source }), nativeAccountResult("Work"))
  const dir = path.join(f.accounts, "Work")
  const conversation = path.join(dir, "antigravity-cli", "conversations", "kept.pb")
  fs.mkdirSync(path.dirname(conversation), { recursive: true })
  fs.writeFileSync(conversation, "kept conversation")
  const auth = record("Work")
  const loader = await plugin.auth.loader(async () => auth)
  const body = { model: "gemini-test-medium", stream: false, metadata: { user_id: "resign" }, messages: [{ role: "user", content: "before re-sign-in" }] }
  assert.equal((await loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })).status, 200)
  const live = f.logs().filter(e => e.type === "init" && e.geminiDir === dir).at(-1)
  assert(live, "the account ran in its own agy")
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  assert(alive(live.pid))

  // Same name, different case: a sign-in again, not a failure.
  const fresh = path.join(f.root, "fresh-token")
  fs.writeFileSync(fresh, JSON.stringify({ refresh_token: "SYNTHETIC_RESIGNED" }))
  assert.deepEqual(await importMethod.authorize({ name: "work", source: fresh }), nativeAccountResult("Work"))
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "antigravity-cli/antigravity-oauth-token"), "utf8")).refresh_token, "SYNTHETIC_RESIGNED")
  assert.equal(fs.readFileSync(conversation, "utf8"), "kept conversation")
  for (let i = 0; i < 100 && alive(live.pid); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert(!alive(live.pid), "the idle agy holding the old token was stopped")

  const probes = () => f.logs().filter(e => e.type === "models" && e.geminiDir === dir).length
  const before = probes()
  await plugin.provider.models({}, { auth })
  assert.equal(probes(), before + 1, "the catalog is read again after a sign-in again")
  await plugin.provider.models({}, { auth })
  await plugin.provider.models({}, { auth })
  assert.equal(probes(), before + 1, "a fresh catalog is served from cache, not re-read on every listing")

  // Batch imports keep refusing existing names: all-or-nothing, never overwrite.
  const manifest = path.join(f.root, "manifest.json")
  fs.writeFileSync(manifest, JSON.stringify([{ name: "Work", source: f.source }, { name: "other", source: f.source }]))
  assert.equal((await plugin.auth.methods[2].authorize({ manifest })).type, "failed")
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "antigravity-cli/antigravity-oauth-token"), "utf8")).refresh_token, "SYNTHETIC_RESIGNED")
  assert(!fs.existsSync(path.join(f.accounts, "other")))

  // A response in progress is not cut off: its agy finishes the tool turn
  // under the old credential, then stops instead of being reused.
  const request = { model: "gemini-test-medium", stream: true, metadata: { user_id: "resign-busy" }, messages: [{ role: "user", content: "TOOL during re-sign-in" }],
    tools: [{ name: "echo", description: "Echo", input_schema: { type: "object", properties: { text: { type: "string" } } } }] }
  const send = payload => loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(payload) })
  const first = parse(await (await send(request)).text())
  const call = first.find(e => e.data.content_block?.type === "tool_use").data.content_block
  const args = JSON.parse(first.filter(e => e.data.delta?.type === "input_json_delta").map(e => e.data.delta.partial_json).join(""))
  const text = first.filter(e => e.data.delta?.type === "text_delta").map(e => e.data.delta.text).join("")
  const busy = f.logs().filter(e => e.type === "init" && e.geminiDir === dir).at(-1)
  assert.deepEqual(await importMethod.authorize({ name: "Work", source: f.source }), nativeAccountResult("Work"))
  assert(alive(busy.pid), "a pending tool turn keeps its agy through a sign-in again")
  const final = parse(await (await send({ ...request, messages: [...request.messages,
    { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { ...call, input: args }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "busy-result" }] }] })).text())
  assert.equal(final.find(e => e.event === "message_delta")?.data.delta.stop_reason, "end_turn")
  for (let i = 0; i < 150 && alive(busy.pid); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert(!alive(busy.pid), "it stops once its response is complete")
})

test("a row whose profile is gone tells Magpie it needs signing in again", { skip: process.platform === "win32" }, async t => {
  const f = nativeFixture(), saved = { ...process.env }
  Object.assign(process.env, f.env)
  const { AntigravityBridgePlugin } = await import("./index.mjs?gone")
  const plugin = await AntigravityBridgePlugin({ magpie: {} })
  t.after(() => {
    f.cleanup()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
  const gone = record("Gone")
  const usage = await plugin.auth.usage(async () => gone)
  assert.equal(usage.signIn, "expired")
  assert.match(usage.error, /Sign in again/)
  await assert.rejects(plugin.provider.models({}, { auth: gone }), error => error.signIn === "expired")
  const loader = await plugin.auth.loader(async () => gone)
  const response = await loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify({
    model: "gemini-test-medium", stream: false, messages: [{ role: "user", content: "x" }] }) })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("x-magpie-sign-in"), "expired")
  assert.equal(response.headers.get("x-should-retry"), "false")
  // A malformed reference also asks for sign-in; a transient failure would not.
  const invalid = await plugin.auth.usage(async () => ({ type: "api", key: "agy:..%2Fx" }))
  assert.equal(invalid.signIn, "expired")
  const unselected = await plugin.auth.usage(async () => undefined)
  assert.equal(unselected.signIn, "kept")
})
