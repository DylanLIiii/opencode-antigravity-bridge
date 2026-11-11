import { spawn } from "node:child_process"
import path from "node:path"

export function windowsEnv(env, name) {
  const key = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

// Explicit opt-in: a Windows host launches agy inside this WSL distribution.
// The setting is never inferred, and a failure never falls back to a native agy.
export function wslDistro(env = process.env, platform = process.platform) {
  const distro = windowsEnv(env, "AGY_BRIDGE_WSL_DISTRO")?.trim()
  return platform === "win32" && distro ? distro : null
}

// AGY_PATH keeps its single-executable meaning: here a bare command name or an
// absolute Linux path inside the distro. It is never interpreted as shell text.
export function wslAgyPath(env = process.env, platform = process.platform) {
  if (!wslDistro(env, platform)) return null
  const executable = windowsEnv(env, "AGY_PATH")?.trim() || "agy"
  if (/[\0\r\n\\]/.test(executable) || /^[a-zA-Z]:/.test(executable) || (executable.includes("/") && !executable.startsWith("/"))) {
    throw new Error("with AGY_BRIDGE_WSL_DISTRO, AGY_PATH must be a bare command or an absolute Linux path inside the distribution (for example /home/me/.local/bin/agy), not a Windows path")
  }
  if (!executable.startsWith("/") && !/^[a-zA-Z0-9_.+-]+$/.test(executable)) throw new Error("WSL AGY_PATH must be one executable, not a shell command")
  if (executable.startsWith("/mnt/")) {
    throw new Error("with AGY_BRIDGE_WSL_DISTRO, AGY_PATH must be installed inside the distribution, not on a /mnt Windows drive")
  }
  return executable
}

// Only the standard /mnt/<drive> automount is supported; there is no wslpath
// probe, so a customised [automount] root is an explicit limitation.
export function wslPath(file, distro, platform = process.platform) {
  if (!distro || platform !== "win32" || typeof file !== "string") return file
  if (file.startsWith("//") || /[\0\r\n]/.test(file)) throw new Error("Unsupported WSL path: UNC paths and line breaks are unavailable")
  if (file.startsWith("/")) return file
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(file)
  if (!match) throw new Error(`WSL mode needs a Windows drive path (C:\\...) to map to /mnt/<drive>: ${file}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`
}

// nc shim run by agy inside the distro. It starts the *host* Node .exe through
// WSL interop (absolute /mnt path, so appendWindowsPath is not needed). The
// module argument stays a Windows path because the .exe is a Windows process;
// the control port/token arrive through WSLENV, never argv.
export function wslMcpShim(executable, server, distro) {
  const quote = value => {
    if (/[\0\r\n]/.test(value)) throw new Error("invalid WSL MCP shim path")
    return `'${String(value).replace(/'/g, `'\\''`)}'`
  }
  return `#!/bin/sh\nexec ${quote(wslPath(executable, distro, "win32"))} ${quote(server)}\n`
}

const WSL_FORWARDED = ["AGY_CLI_DISABLE_AUTO_UPDATE", "AGY_BRIDGE_CONTROL_PORT", "AGY_BRIDGE_TOKEN"]

// WSLENV is case-sensitive and unflagged entries are shared in both directions.
export function wslForwardedEnv(env) {
  const result = { ...env }
  const controlled = new Set([...WSL_FORWARDED, "WSLENV"])
  for (const key of Object.keys(result)) if (controlled.has(key.toUpperCase())) delete result[key]
  const names = (windowsEnv(env, "WSLENV") || "").split(":").filter(name => name && !WSL_FORWARDED.includes(name.split("/")[0].toUpperCase()))
  for (const name of WSL_FORWARDED) {
    const value = windowsEnv(env, name)
    if (value != null) { result[name] = value; names.push(name) }
  }
  return { ...result, WSLENV: names.join(":") }
}

// Fixed script + positional arguments: nothing user-controlled is interpolated
// into shell text. The script only prepends the shim directory to the guest PATH
// (the distro's own PATH is preserved so a bare `agy` still resolves).
const WSL_PATH_SCRIPT = 'PATH="$1:$PATH"; shift; exec "$@"'

export function wslSpawnSpec(file, args, distro, env = process.env, guestCwd = null) {
  const guestBin = windowsEnv(env, "AGY_BRIDGE_WSL_BIN")
  return {
    file: windowsEnv(env, "AGY_BRIDGE_WSL_EXE") || "wsl.exe",
    args: [
      "-d", distro, ...(guestCwd ? ["--cd", guestCwd] : []), "--exec",
      ...(guestBin ? ["/bin/sh", "-c", WSL_PATH_SCRIPT, "sh", guestBin, file, ...args] : [file, ...args]),
    ],
    options: {},
  }
}

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
  const distro = wslDistro(env, platform)
  if (distro) return wslSpawnSpec(file, args, distro, env)
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
  let env = childEnv(options?.env)
  const distro = wslDistro(env)
  // The Windows child keeps its native cwd; only the guest sees the /mnt path.
  const command = distro
    ? wslSpawnSpec(file, args, distro, env, options.cwd ? wslPath(options.cwd, distro) : null)
    : agySpawnSpec(file, args, process.platform, env)
  if (distro) env = wslForwardedEnv(env)
  return spawn(command.file, command.args, { ...options, ...command.options, windowsHide: true, env })
}

export function windowsMcpShim(executable, server) {
  const quote = value => {
    if (/["\0\r\n]/.test(value)) throw new Error("invalid Windows MCP shim path")
    return `"${value.replace(/%/g, "%%")}"`
  }
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quote(executable)} ${quote(server)}\r\n`
}
