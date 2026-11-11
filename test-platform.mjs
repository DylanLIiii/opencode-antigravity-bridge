import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { test } from "node:test"
import { agyCandidates, agySpawnSpec, childEnv, spawnAgy, windowsMcpShim } from "./platform.mjs"

test("Windows discovery considers exe/cmd/bat, Path and LOCALAPPDATA", () => {
  const candidates = agyCandidates({ Path: 'C:\\Program Files\\agy;D:\\tools', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'C:\\Users\\Test', 'win32')
  assert.deepEqual(candidates.slice(0, 3), ['C:\\Program Files\\agy\\agy.exe', 'C:\\Program Files\\agy\\agy.cmd', 'C:\\Program Files\\agy\\agy.bat'])
  assert.ok(candidates.includes('D:\\tools\\agy.cmd'))
  assert.ok(candidates.includes('C:\\Users\\Test\\AppData\\Local\\agy\\bin\\agy.exe'))
  assert.equal(agyCandidates({ AGY_PATH: 'C:\\custom\\agy.bat' }, 'C:\\Users\\Test', 'win32')[0], 'C:\\custom\\agy.bat')
})

test("POSIX discovery and direct executable arguments do not use a shell", () => {
  assert.deepEqual(agyCandidates({ PATH: '/usr/bin:/opt/bin' }, '/home/test', 'linux').slice(0, 2), ['/usr/bin/agy', '/opt/bin/agy'])
  for (const [file, platform] of [['/opt/agy', 'linux'], ['C:\\agy.exe', 'win32'], ['/opt/agy.cmd', 'linux']]) {
    const args = ['acp', '--add-dir', 'space & percent% quote"']
    assert.deepEqual(agySpawnSpec(file, args, platform), { file, args, options: {} })
  }
})

test("Windows batch wrappers use cmd explicitly and escape shell metacharacters", () => {
  for (const extension of ['cmd', 'bat', 'CMD']) {
    const spec = agySpawnSpec(`C:\\Program Files\\agy.${extension}`, ['acp', '--add-dir', 'C:\\a & b\\%NAME%!\\'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    assert.equal(spec.file, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(spec.args.slice(0, 4), ['/d', '/v:off', '/s', '/c'])
    assert.equal(spec.options.windowsVerbatimArguments, true)
    assert.equal(spec.options.windowsHide, true)
    const command = spec.args.at(-1)
    assert.ok(command.includes('Program^ Files'))
    for (const character of ['&', '%', '!']) assert.ok(command.includes('^' + character), command)
    assert.ok(command.includes('b\\^%NAME^%^!\\\\'), command)
  }
})

test("batch invocation rejects command line breaks", () => {
  for (const value of ['bad\npath', 'bad\rpath', 'bad\0path']) {
    assert.throws(() => agySpawnSpec('agy.cmd', ['--add-dir', value], 'win32'), /line break or NUL/)
    assert.throws(() => agySpawnSpec(value + '.cmd', [], 'win32'), /line break or NUL/)
  }
})

test("nc.cmd quotes paths, escapes percent expansion and disables delayed expansion", () => {
  const script = windowsMcpShim('C:\\Program Files\\node.exe', 'C:\\user%name%!\\mcp-server.mjs')
  assert.equal(script, '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"C:\\Program Files\\node.exe" "C:\\user%%name%%!\\mcp-server.mjs"\r\n')
  assert.throws(() => windowsMcpShim('node.exe', 'bad"path'), /invalid Windows MCP shim path/)
})

test("npm cmd-shims escape metacharacters for the second expansion pass", () => {
  const spec = agySpawnSpec('C:\\project\\node_modules\\.bin\\agy.cmd', ['a & %NAME%!'], 'win32', {})
  for (const character of ['&', '%', '!']) assert.ok(spec.args.at(-1).includes('^^^' + character))
})

function captureSpawn(platform, inherited, callback) {
  const originalSpawn = childProcess.spawn
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
  const originalEnv = process.env
  const calls = []
  const child = {}
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform })
    process.env = inherited
    childProcess.spawn = (file, args, options) => {
      calls.push({ file, args, options })
      return child
    }
    syncBuiltinESMExports()
    callback(calls, child)
  } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
    process.env = originalEnv
    Object.defineProperty(process, "platform", platformDescriptor)
  }
}

for (const platform of ["win32", "linux", "darwin"]) {
  test(`spawnAgy forces both protections with omitted or overriding options on ${platform}`, () => {
    const parent = Object.freeze({ PATH: "parent-path", PARENT_ONLY: "kept", AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
    captureSpawn(platform, parent, (calls, child) => {
      const file = platform === "win32" ? "C:\\Program Files\\Antigravity\\agy.exe" : "/opt/agy"
      const args = Object.freeze(["models", "space & percent% quote\""])
      const signal = new AbortController().signal
      const env = Object.freeze({ PATH: "caller-path", CALLER_ONLY: "kept", AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
      const options = Object.freeze({ env, cwd: "workspace", stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: false, signal })
      const before = structuredClone({ parent, env, args, options: { ...options, signal: undefined } })
      for (const supplied of [undefined, {}, { env: {} }, options]) {
        assert.equal(spawnAgy(file, args, supplied), child)
        const actual = calls.at(-1)
        assert.equal(actual.file, file)
        assert.equal(actual.args, args)
        assert.equal(actual.options.windowsHide, true, "spawnAgy must hide every child window")
        assert.equal(actual.options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true", "spawnAgy must disable auto update after all env overrides")
        assert.equal(actual.options.env.PARENT_ONLY, "kept")
        assert.notEqual(actual.options.env, parent)
        assert.notEqual(actual.options.env, supplied?.env)
      }
      const actual = calls.at(-1).options
      for (const key of ["cwd", "stdio", "detached", "signal"]) assert.equal(actual[key], options[key])
      assert.equal(actual.env.PATH, "caller-path")
      assert.equal(actual.env.CALLER_ONLY, "kept")
      assert.deepEqual({ parent, env, args, options: { ...options, signal: undefined } }, before)
    })
  })
}

test("spawnAgy deduplicates Windows env aliases without losing caller PATH or MCP settings", () => {
  const parent = Object.freeze({ Path: "parent-path", path: "duplicate-parent", agy_cli_disable_auto_update: "false", PARENT_ONLY: "kept", Mixed: "parent" })
  const env = Object.freeze({ PATH: "shim;caller-path", AGY_CLI_DISABLE_AUTO_UPDATE: "false", Agy_Cli_Disable_Auto_Update: "false", MIXED: "caller", AGY_BRIDGE_CONTROL_PORT: "12345", AGY_BRIDGE_TOKEN: "fixture" })
  captureSpawn("win32", parent, calls => {
    spawnAgy("C:\\Program Files\\Antigravity\\agy.exe", [], { env, windowsHide: false })
    const actual = calls[0].options.env
    assert.deepEqual(Object.keys(actual).filter(key => /^path$/i.test(key)), ["PATH"])
    assert.equal(actual.PATH, "shim;caller-path")
    assert.deepEqual(Object.keys(actual).filter(key => /^agy_cli_disable_auto_update$/i.test(key)), ["AGY_CLI_DISABLE_AUTO_UPDATE"])
    assert.equal(actual.AGY_CLI_DISABLE_AUTO_UPDATE, "true")
    assert.equal(actual.MIXED, "caller")
    assert.equal(actual.Mixed, undefined)
    for (const key of ["AGY_BRIDGE_CONTROL_PORT", "AGY_BRIDGE_TOKEN"]) assert.equal(actual[key], env[key])
    assert.equal(parent.Path, "parent-path")
    assert.equal(parent.agy_cli_disable_auto_update, "false")
    assert.equal(env.Agy_Cli_Disable_Auto_Update, "false")
  })
})

test("childEnv supports an isolated Windows environment without importing parent credentials", () => {
  const source = Object.freeze({ Path: "old", PATH: "new", browser: "old-browser", agy_cli_disable_auto_update: "false", ONLY_CALLER: "kept" })
  const actual = childEnv(source, "win32", {})
  assert.deepEqual(actual, { PATH: "new", browser: "old-browser", ONLY_CALLER: "kept", AGY_CLI_DISABLE_AUTO_UPDATE: "true" })
  assert.equal(source.Path, "old")
  assert.equal(childEnv({ PATH: "upper" }, "linux", { Path: "lower" }).Path, "lower")
})

test("spawnAgy resolves batch wrappers with the caller's ComSpec", () => {
  captureSpawn("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, calls => {
    spawnAgy("C:\\tools\\agy.cmd", ["--version"], { env: { COMSPEC: "D:\\Windows\\System32\\cmd.exe" } })
    assert.equal(calls[0].file, "D:\\Windows\\System32\\cmd.exe")
    assert.equal(calls[0].options.env.ComSpec, undefined)
  })
})

for (const extension of ["cmd", "bat"]) {
  test(`spawnAgy preserves Windows .${extension} escaping while forcing protections`, () => {
    const parent = Object.freeze({ ComSpec: "C:\\Windows\\System32\\cmd.exe", AGY_CLI_DISABLE_AUTO_UPDATE: "false" })
    captureSpawn("win32", parent, calls => {
      const file = `C:\\Program Files\\Antigravity & Tools\\agy.${extension}`
      const args = ["acp", "--add-dir", "C:\\space & percent% !\\"]
      const expected = agySpawnSpec(file, args, "win32", parent)
      spawnAgy(file, args, { windowsHide: false, windowsVerbatimArguments: false, env: { AGY_CLI_DISABLE_AUTO_UPDATE: "false" } })
      assert.equal(calls[0].file, expected.file)
      assert.deepEqual(calls[0].args, expected.args)
      assert.equal(calls[0].options.windowsVerbatimArguments, true)
      assert.equal(calls[0].options.windowsHide, true)
      assert.equal(calls[0].options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true")
    })
  })
}

test("WSL opt-in resolves Windows env aliases and replaces directional control rules", () => {
  captureSpawn("win32", {}, calls => {
    const args = ["models", "space ; $(touch nope) & %NAME%"]
    spawnAgy("/home/me/agy", args, { cwd: "C:\\work dir", env: {
      agy_bridge_wsl_distro: "Ubuntu", Agy_Bridge_Wsl_Exe: "D:\\WSL tools\\wsl.exe",
      WsLeNv: "OTHER/p:AGY_BRIDGE_TOKEN/u:agy_bridge_control_port/w",
      agy_bridge_token: "fixture", agy_bridge_control_port: "1234",
    } })
    const call = calls[0]
    assert.equal(call.file, "D:\\WSL tools\\wsl.exe")
    assert.deepEqual(call.args, ["-d", "Ubuntu", "--cd", "/mnt/c/work dir", "--exec", "/home/me/agy", ...args])
    assert.equal(call.options.cwd, "C:\\work dir")
    assert.equal(call.options.env.WSLENV, "OTHER/p:AGY_CLI_DISABLE_AUTO_UPDATE:AGY_BRIDGE_CONTROL_PORT:AGY_BRIDGE_TOKEN")
    assert.equal(call.options.env.AGY_BRIDGE_TOKEN, "fixture")
    assert.equal(call.options.env.agy_bridge_token, undefined)
    assert.ok(!call.args.includes("fixture"))
  })
})

test("WSL paths and positional shell preserve literal user arguments without native fallback", async () => {
  const { wslPath, wslAgyPath, wslSpawnSpec, wslMcpShim } = await import("./platform.mjs")
  assert.equal(wslPath("/home/a b/project", "Ubuntu", "win32"), "/home/a b/project")
  assert.equal(wslPath("D:\\a b\\x&y", "Ubuntu", "win32"), "/mnt/d/a b/x&y")
  assert.throws(() => wslPath("\\\\server\\share", "Ubuntu", "win32"), /drive path/)
  assert.throws(() => wslAgyPath({ AGY_BRIDGE_WSL_DISTRO: "Ubuntu", AGY_PATH: "C:\\agy.exe" }, "win32"), /Linux path/)
  const spec = wslSpawnSpec("/home/a b/agy", ["prompt", "$(touch nope); &"], "Ubuntu", { AGY_BRIDGE_WSL_BIN: "/mnt/c/shim dir" })
  assert.equal(spec.file, "wsl.exe")
  assert.deepEqual(spec.args.slice(-4), ["/mnt/c/shim dir", "/home/a b/agy", "prompt", "$(touch nope); &"])
  assert.equal(spec.args[5], 'PATH="$1:$PATH"; shift; exec "$@"')
  assert.match(wslMcpShim("C:\\Program Files\\node.exe", "C:\\a'b\\mcp.mjs", "Ubuntu"), /\/mnt\/c\/Program Files\/node.exe/)
})

test("WSL quota and context unlock reject before touching host credentials or launching", async () => {
  const { fetchUsage } = await import("./usage.mjs")
  const { unlockContext, findOfficialAgy } = await import("./context-unlock.mjs")
  const env = { agy_bridge_wsl_distro: "Ubuntu" }
  await assert.rejects(fetchUsage("agy", { env, platform: "win32", spawn: () => assert.fail("must not spawn quota") }), /Quota queries are unavailable/)
  assert.throws(() => unlockContext({ env, platform: "win32", run: () => assert.fail("must not patch") }), /Context unlock is unavailable/)
  assert.equal(findOfficialAgy(env, "C:\\Users\\test", "win32"), null)
  const { wslPath, wslAgyPath } = await import("./platform.mjs")
  assert.throws(() => wslPath("//server/share", "Ubuntu", "win32"), /UNC/)
  assert.throws(() => wslAgyPath({ ...env, AGY_PATH: "agy --foo; echo bad" }, "win32"), /one executable/)
})

test("WSL mode hides native profile import and OAuth sign-in methods", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("./index.mjs", import.meta.url), "utf8")
  assert.match(source, /wslDistro\(\) \? \[\] : \[\.\.\.ACCOUNT_IMPORT_METHODS, accountLogin\]/)
})
