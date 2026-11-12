import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"

// Simulation only: POSIX host emulates wsl.exe dispatch and standard paths.
// The existing smoke fake speaks real ACP and invokes the real MCP server via nc.
test("simulated WSL sign-in, models and ACP/MCP client tool roundtrip", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wsl-simulation-"))
  const previous = { ...process.env }
  let bridge
  try {
    const entry = new URL("./index.mjs", import.meta.url)
    const smoke = fs.readFileSync(new URL("./test-smoke.mjs", import.meta.url), "utf8")
    const fake = smoke.split('fs.writeFileSync(fakeAgy, String.raw`')[1].split('\n`)')[0]
    fs.writeFileSync(path.join(root, "fake.mjs"), fake)
    fs.writeFileSync(path.join(root, "agy"), `#!/bin/sh\nexec '${process.execPath}' '${root}/fake.mjs' "$@"\n`, { mode: 0o700 })
    fs.writeFileSync(path.join(root, "wsl"), '#!/bin/sh\nshift 2\nif [ "$1" = "--cd" ]; then cd "$2" || exit; shift 2; fi\nshift\nexec "$@"\n', { mode: 0o700 })
    // Force only the opt-in platform predicate, leaving all launch/MCP code real.
    let platform = fs.readFileSync(new URL("./platform.mjs", import.meta.url), "utf8")
    platform = platform.replace('wslDistro(env = process.env, platform = process.platform)', 'wslDistro(env = process.env, platform = "win32")')
    fs.writeFileSync(path.join(root, "platform.mjs"), platform)
    let source = fs.readFileSync(entry, "utf8").replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(target === "./platform.mjs" ? pathToFileURL(path.join(root, "platform.mjs")).href : new URL(target, entry).href)}`)
    source = source.replace('fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))', JSON.stringify(new URL("./mcp-server.mjs", import.meta.url).pathname))
    source = source.replace('new URL("./package.json", import.meta.url)', JSON.stringify(new URL("./package.json", entry).pathname))
    source += '\nexport { allProcs, workDirectory, getAccounts }; export async function cleanupSimulation() { await Promise.all([...allProcs].map(p => p.stop())); controlServer?.close(); }\n'
    fs.writeFileSync(path.join(root, "index.mjs"), source)
    Object.assign(process.env, { AGY_BRIDGE_WSL_DISTRO: "Simulation", AGY_BRIDGE_WSL_EXE: path.join(root, "wsl"), AGY_PATH: path.join(root, "agy"), FAKE_AGY_LOG: path.join(root, "log"), FAKE_AGY_STATE: root, AGY_BRIDGE_ACCOUNTS_DIR: path.join(root, "host-profiles-never-read") })
    bridge = await import(pathToFileURL(path.join(root, "index.mjs")).href)
    const plugin = await bridge.AntigravityBridgePlugin()
    assert.equal(plugin.auth.methods.length, 1)
    assert.deepEqual(await plugin.auth.methods[0].authorize(), { type: "success", key: "agy" })
    assert.ok(Object.keys(await plugin.provider.models()).some(key => key.includes("gemini-test")))
    assert.equal((await bridge.getAccounts(process.env.AGY_PATH)).length, 1)
    assert.equal(bridge.workDirectory("/home/guest/project with spaces"), "/home/guest/project with spaces")
    const loader = await plugin.auth.loader()
    const fetch = body => loader.fetch("agy://local/messages", { method: "POST", body: JSON.stringify(body) })
    const events = async response => (await new Response(response.body).text()).split("\n\n").flatMap(chunk => {
      const data = chunk.split("\n").find(line => line.startsWith("data: "))
      return data ? [JSON.parse(data.slice(6))] : []
    })
    const body = { model: "antigravity-bridge/gemini-test", messages: [{ role: "user", content: "TOOL native once" }], tools: [{ name: "echo", description: "Echo", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
    const first = await events(await fetch(body))
    const call = first.find(event => event.content_block?.type === "tool_use")?.content_block
    assert.equal(call?.name, "echo")
    call.input = JSON.parse(first.filter(event => event.delta?.type === "input_json_delta").map(event => event.delta.partial_json).join(""))
    assert.equal(call.input.text, "probe")
    const second = await events(await fetch({ ...body, messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: first.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join("") }, call] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "WSL simulated client result" }] }] }))
    assert.ok(second.some(event => event.delta?.stop_reason === "end_turn"))
    const logs = fs.readFileSync(path.join(root, "log"), "utf8").trim().split("\n").map(JSON.parse)
    assert.ok(logs.some(event => event.type === "mcpResult" && event.result?.content?.[0]?.text === "WSL simulated client result"))
    assert.ok(logs.filter(event => event.type === "models").every(event => event.geminiDir === null))
    const named = await fetch({ ...body, model: "antigravity-bridge/work/gemini-test" })
    assert.equal(named.status, 400)
    assert.match(await named.text(), /Named account profiles/)
    fs.writeFileSync(path.join(root, "wsl"), '#!/bin/sh\necho "distro or agy unavailable / not signed in" >&2\nexit 1\n', { mode: 0o700 })
    const failed = await plugin.auth.methods[0].authorize()
    assert.equal(failed.type, "failed")
    assert.match(failed.error, /Check wsl.exe, distro/)
    await assert.rejects(plugin.provider.models(), /WSL agy models failed/)
    fs.unlinkSync(path.join(root, "wsl"))
    assert.equal((await plugin.auth.methods[0].authorize()).type, "failed")
  } finally {
    await bridge?.cleanupSimulation()
    process.env = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
