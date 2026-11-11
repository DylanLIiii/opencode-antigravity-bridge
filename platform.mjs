import { spawn } from "node:child_process"
import path from "node:path"

export function agyCandidates(env, home, platform = process.platform) {
  const windows = platform === "win32"
  const paths = windows ? path.win32 : path.posix
  const names = windows ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"]
  const searchPath = env.PATH || (windows ? env.Path : "") || ""
  const candidates = env.AGY_PATH ? [env.AGY_PATH] : []
  for (const directory of searchPath.split(windows ? ";" : ":")) {
    if (directory) candidates.push(...names.map(name => paths.join(directory.replace(/^"|"$/g, ""), name)))
  }
  const directories = windows ? [
    paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "agy", "bin"),
    paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "Programs", "Antigravity", "bin"),
    paths.join(home, ".local", "bin"),
    paths.join(home, ".gemini", "bin"),
  ] : [paths.join(home, ".local", "bin"), paths.join(home, ".gemini", "bin"), "/usr/local/bin", "/opt/homebrew/bin"]
  for (const directory of directories) candidates.push(...names.map(name => paths.join(directory, name)))
  return candidates
}

// The cmd.exe escaping algorithm is adapted from node-cross-spawn:
// https://github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js
// Copyright (c) 2018 Made With MOXY Lda
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g

function cmdArgument(value, doubleEscape) {
  let argument = String(value)
  if (/[\0\r\n]/.test(argument)) throw new Error("a Windows command argument contains a line break or NUL")
  argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  argument = argument.replace(/(?=(\\+?)?)\1$/, "$1$1")
  argument = `"${argument}"`.replace(cmdMeta, "^$1")
  // npm's cmd-shim adds a second cmd expansion pass when forwarding %*.
  return doubleEscape ? argument.replace(cmdMeta, "^$1") : argument
}

export function agySpawnSpec(file, args, platform = process.platform, env = process.env) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(file)) return { file, args, options: {} }
  if (/[\0\r\n]/.test(file)) throw new Error("a Windows command path contains a line break or NUL")
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const command = [path.win32.normalize(file).replace(cmdMeta, "^$1"), ...args.map(arg => cmdArgument(arg, doubleEscape))].join(" ")
  return {
    file: env.ComSpec || env.COMSPEC || env.comspec || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${command}"`],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  }
}

export function childEnv(overrides, platform = process.platform, inherited = process.env) {
  const env = {}
  const names = new Map()
  for (const source of [inherited, overrides]) {
    for (const [key, value] of Object.entries(source || {})) {
      if (key.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE") continue
      // Windows treats env names case-insensitively; keep the caller's PATH.
      const name = platform === "win32" ? key.toUpperCase() : key
      if (names.has(name)) delete env[names.get(name)]
      names.set(name, key)
      env[key] = value
    }
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true"
  return env
}

export function spawnAgy(file, args, options = {}) {
  const env = childEnv(options?.env)
  const command = agySpawnSpec(file, args, process.platform, env)
  return spawn(command.file, command.args, { ...options, ...command.options, windowsHide: true, env })
}

export function windowsMcpShim(executable, server) {
  const quote = value => {
    if (/["\0\r\n]/.test(value)) throw new Error("invalid Windows MCP shim path")
    return `"${value.replace(/%/g, "%%")}"`
  }
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quote(executable)} ${quote(server)}\r\n`
}
