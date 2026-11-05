import assert from "node:assert/strict"
import { test } from "node:test"
import { agyCandidates, agySpawnSpec, windowsMcpShim } from "./platform.mjs"

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
