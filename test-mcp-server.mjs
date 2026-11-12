import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import net from "node:net"
import readline from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const TOKEN = "mcp-server-test-token"
const MCP_SERVER = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))

async function waitUntil(read, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await delay(10)
  }
  assert.fail(`Timed out waiting for ${description}`)
}

async function withTimeout(promise, description, timeoutMs = 3000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function createControlServer(t, tools = []) {
  const requests = []
  const sockets = new Set()
  const watchers = new Set()
  let watchConnections = 0

  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.setEncoding("utf8")
    socket.on("error", () => {})
    socket.once("close", () => {
      sockets.delete(socket)
      watchers.delete(socket)
    })

    let buffer = ""
    let handled = false
    socket.on("data", chunk => {
      if (handled) return
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      handled = true

      let message
      try {
        message = JSON.parse(buffer.slice(0, newline))
      } catch {
        socket.destroy()
        return
      }
      requests.push(message)

      if (message.kind === "watch") {
        watchConnections++
        watchers.add(socket)
        return
      }
      if (message.kind === "list") {
        socket.end(JSON.stringify({ result: { tools } }) + "\n")
        return
      }
      if (message.kind === "call") {
        socket.end(JSON.stringify({
          result: { content: [{ type: "text", text: message.name }], isError: false },
        }) + "\n")
        return
      }
      socket.end(JSON.stringify({ error: { code: -32601, message: "unknown control request" } }) + "\n")
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  })

  return {
    port: server.address().port,
    requests,
    watchers,
    get watchConnections() {
      return watchConnections
    },
  }
}

function createMcpProcess(t, port) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: {
      ...process.env,
      AGY_BRIDGE_CONTROL_PORT: String(port),
      AGY_BRIDGE_TOKEN: TOKEN,
      AGY_BRIDGE_MCP_TRACE: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const messages = []
  let stderr = ""
  let exited = false
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", chunk => { stderr += chunk })
  child.on("error", error => { stderr += error.stack || error.message })
  readline.createInterface({ input: child.stdout }).on("line", line => {
    messages.push(JSON.parse(line))
  })

  const exitPromise = new Promise(resolve => {
    child.once("exit", (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })
  t.after(async () => {
    if (!exited) {
      child.kill("SIGKILL")
      await exitPromise
    }
  })

  function write(message) {
    child.stdin.write(JSON.stringify(message) + "\n")
  }

  async function request(id, method, params = {}) {
    write({ jsonrpc: "2.0", id, method, params })
    return waitUntil(
      () => messages.find(message => message.id === id && !message.method),
      `response to ${method} (${String(id)})`,
    )
  }

  async function close() {
    if (!exited) child.stdin.end()
    const outcome = await withTimeout(exitPromise, "MCP process exit")
    assert.equal(outcome.code, 0, stderr)
    assert.equal(outcome.signal, null, stderr)
  }

  return {
    messages,
    request,
    notify(method, params = {}) {
      write({ jsonrpc: "2.0", method, params })
    },
    close,
  }
}

async function initialize(mcp) {
  const response = await mcp.request("initialize-id", "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "mcp-server-test", version: "1.0.0" },
  })
  assert.equal(response.error, undefined)
  assert.equal(response.result.protocolVersion, "2025-11-25")
  assert.equal(response.result.capabilities.tools.listChanged, true)
}

test("tools/list marks every tool always loaded and preserves metadata", async t => {
  const control = await createControlServer(t, [
    { name: "one", inputSchema: { type: "object" }, _meta: { source: "client" } },
    { name: "two", inputSchema: { type: "object" } },
  ])
  const mcp = createMcpProcess(t, control.port)
  await initialize(mcp)
  const result = await mcp.request("list", "tools/list")
  assert.deepEqual(result.result.tools.map(tool => tool._meta), [
    { source: "client", "antigravity/alwaysLoad": true },
    { "antigravity/alwaysLoad": true },
  ])
  await mcp.close()
})

test("tools/call forwards exact string and numeric JSON-RPC request ids", async t => {
  const control = await createControlServer(t)
  const mcp = createMcpProcess(t, control.port)
  await initialize(mcp)

  const cases = [
    {
      id: "call-string",
      name: "echo-string",
      arguments: { text: "hello" },
      meta: { progressToken: "string-token" },
    },
    {
      id: 73,
      name: "echo-number",
      arguments: { text: "goodbye", count: 2 },
      meta: { progressToken: "number-token" },
    },
  ]

  for (const item of cases) {
    const response = await mcp.request(item.id, "tools/call", {
      name: item.name,
      arguments: item.arguments,
      _meta: item.meta,
    })
    assert.equal(response.id, item.id)
    assert.equal(response.error, undefined)
    assert.equal(response.result.content[0].text, item.name)
  }

  const calls = control.requests.filter(request => request.kind === "call")
  assert.equal(calls.length, cases.length)
  for (const [index, item] of cases.entries()) {
    assert.deepEqual(calls[index], {
      token: TOKEN,
      kind: "call",
      name: item.name,
      arguments: item.arguments,
      meta: item.meta,
      mcpRequestId: item.id,
    })
  }
  await mcp.close()
})

test("watch reconnects with one list_changed notification and stops after input close", async t => {
  const control = await createControlServer(t)
  const mcp = createMcpProcess(t, control.port)
  await initialize(mcp)
  mcp.notify("notifications/initialized")
  await waitUntil(() => control.watchConnections === 1, "initial watch connection")
  assert.equal(mcp.messages.filter(message => message.method === "notifications/tools/list_changed").length, 0)

  const firstWatcher = [...control.watchers][0]
  assert.ok(firstWatcher)
  firstWatcher.destroy()

  await waitUntil(() => control.watchConnections === 2, "reconnected watch")
  await waitUntil(() => control.watchers.size === 1, "old watch cleanup")
  const notification = await waitUntil(
    () => mcp.messages.find(message => message.method === "notifications/tools/list_changed"),
    "list_changed after reconnect",
  )
  assert.deepEqual(notification, { jsonrpc: "2.0", method: "notifications/tools/list_changed" })
  await delay(150)
  assert.equal(control.watchConnections, 2)
  assert.equal(mcp.messages.filter(message => message.method === "notifications/tools/list_changed").length, 1)

  // Close stdin while the next reconnect is in its initial backoff window.
  const secondWatcher = [...control.watchers][0]
  assert.ok(secondWatcher)
  secondWatcher.destroy()
  await waitUntil(() => control.watchers.size === 0, "second watch disconnect")
  await delay(25)
  await mcp.close()

  const connectionsAtClose = control.watchConnections
  await delay(250)
  assert.equal(control.watchConnections, connectionsAtClose)
  assert.equal(control.watchers.size, 0)
})
