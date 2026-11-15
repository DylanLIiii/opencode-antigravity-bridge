import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  fetchCloudCodeModels,
  invalidateModelMetadataCache,
  isReasoningModel,
  resolveModelMetadata,
} from "./model-metadata.mjs"

const require = createRequire(import.meta.url)
let DatabaseSync = null
try { ({ DatabaseSync } = require("node:sqlite")) } catch {}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bridge-fixes-"))
const prevStoredSignIn = process.env.AGY_BRIDGE_STORED_SIGNIN
process.env.AGY_BRIDGE_STORED_SIGNIN = "skip"
after(() => {
  if (prevStoredSignIn === undefined) delete process.env.AGY_BRIDGE_STORED_SIGNIN
  else process.env.AGY_BRIDGE_STORED_SIGNIN = prevStoredSignIn
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

function writeFakeAgy(dir, scriptBody) {
  fs.mkdirSync(dir, { recursive: true })
  const fakeScript = path.join(dir, "agy.mjs")
  fs.writeFileSync(fakeScript, scriptBody)
  if (process.platform === "win32") {
    const fakeBin = path.join(dir, "agy.cmd")
    fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`)
    return fakeBin
  }
  const fakeBin = path.join(dir, "agy")
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeScript)} "$@"\n`, { mode: 0o755 })
  return fakeBin
}

function createCompatBridge() {
  const dir = path.join(root, "compat")
  fs.mkdirSync(dir, { recursive: true })
  const entry = new URL("./index.mjs", import.meta.url)
  let source = fs.readFileSync(entry, "utf8")
  source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
  source = source.replace('new URL("./package.json", import.meta.url)', JSON.stringify(fileURLToPath(new URL("./package.json", entry))))
  source += "\nexport { Turn, Proc, responseUsage, allProcs };\n"
  const out = path.join(dir, "bridge.mjs")
  fs.writeFileSync(out, source)
  return out
}

test("CloudCode model metadata sets real context, output, image capabilities, and reasoning", async () => {
  const accountsDir = path.join(root, "accounts-cloud")
  const namedDir = path.join(accountsDir, "alpha")
  fs.mkdirSync(path.join(namedDir, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(
    path.join(namedDir, "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "test-cloudcode-token" } }),
  )

  const server = http.createServer((req, res) => {
    if (req.url === "/v1internal:loadCodeAssist") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ cloudaicompanionProject: "proj-test" }))
      return
    }
    if (req.url === "/v1internal:fetchAvailableModels") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        models: {
          "gemini-3.8-flash-tiered": { maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsImages: true },
          "claude-opus-5-5-low": { maxTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
          "claude-opus-5-5-high": { maxTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
          "claude-opus-4-6-thinking": { maxTokens: 250_000, maxOutputTokens: 64_000, supportsImages: true },
          "gemini-3.1-flash-image": { maxTokens: 65_536, maxOutputTokens: 65_536, supportsImages: true },
          "gpt-oss-120b-medium": { maxTokens: 131_072, maxOutputTokens: 32_768, supportsImages: false },
        },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port

  const fakeDir = path.join(root, "fake-cloud-agy")
  const fakeBin = writeFakeAgy(fakeDir, `
const args = process.argv.slice(2);
if (args.includes("models")) {
  console.log([
    "gemini-3.8-flash-low Gemini 3.8 Flash (low)",
    "gemini-3.8-flash-high Gemini 3.8 Flash (high)",
    "gemini-pro-orchestrator Orchestrator (Carbon)",
    "claude-opus-5-5-low Claude Opus 5.5 (low)",
    "claude-opus-5-5-high Claude Opus 5.5 (high)",
    "claude-opus-4-6-thinking Claude Opus 4.6 (Thinking)",
    "gemini-3.1-flash-image Gemini 3.1 Flash Image",
    "gpt-oss-120b-medium GPT-OSS 120B (Medium)",
  ].join("\\n"));
  process.exit(0);
}
if (args.includes("acp")) {
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", chunk => {
    buf += chunk;
    const lines = buf.split("\\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }));
      } else if (msg.method === "session/new") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-1" } }));
      } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      } else if (msg.method === "session/prompt") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
      }
    }
  });
}
`)

  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_CLOUDCODE_URL: process.env.AGY_BRIDGE_CLOUDCODE_URL,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_CLOUDCODE_URL = `http://127.0.0.1:${port}`
  process.env.AGY_BRIDGE_USAGE = "0"
  invalidateModelMetadataCache()

  try {
    const cloud = await fetchCloudCodeModels({ key: "dir:" + namedDir, dir: namedDir }, fakeBin, true)
    assert.equal(cloud.hasCredentials, true)
    assert.deepEqual(resolveModelMetadata("gemini-3.8-flash", cloud), {
      context: 1_048_576,
      output: 65_536,
      supportsImages: true,
    })
    assert.equal(isReasoningModel("gemini-pro-orchestrator", undefined), true)
    assert.equal(isReasoningModel("gpt-oss-120b-medium", undefined), false)

    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-cloud=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const models = await plugin.provider.models(plugin.provider, {})

    assert.equal(models["alpha/gemini-3.8-flash"]?.limit.context, 1_048_576)
    assert.equal(models["alpha/gemini-3.8-flash"]?.limit.output, 65_536)
    assert.equal(models["alpha/claude-opus-5-5"]?.limit.context, 1_000_000)
    assert.equal(models["alpha/claude-opus-5-5"]?.limit.output, 128_000)
    assert.equal(models["alpha/claude-opus-4-6-thinking"]?.limit.context, 250_000)
    assert.equal(models["alpha/claude-opus-4-6-thinking"]?.limit.output, 64_000)
    assert.equal(models["alpha/claude-opus-4-6-thinking"]?.reasoning, true)
    assert.equal(models["alpha/gemini-pro-orchestrator"]?.reasoning, true)
    assert.equal(models["alpha/gemini-pro-orchestrator"]?.limit.context, 1_048_576)
    assert.equal(models["alpha/gemini-pro-orchestrator"]?.limit.output, 262_144)
    assert.equal(models["alpha/gemini-3.1-flash-image"]?.limit.context, 65_536)
    assert.equal(models["alpha/gpt-oss-120b-medium"]?.limit.context, 131_072)
    assert.equal(models["alpha/gpt-oss-120b-medium"]?.limit.output, 32_768)
    assert.equal(models["alpha/gpt-oss-120b-medium"]?.capabilities?.attachment, undefined)
  } finally {
    invalidateModelMetadataCache()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await new Promise(resolve => server.close(resolve))
  }
})

test("silent failures and 0-model-step SQLite errors never return fake HTTP 200", { skip: !DatabaseSync }, async () => {
  const convDir = path.join(root, "conv-silent")
  const accountsDir = path.join(root, "accounts-silent")
  const stateFile = path.join(root, "state-silent.json")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })

  const dbPath = path.join(convDir, "sess-zero-step.db")
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE steps (
      step_index INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL,
      status INTEGER NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
  `)
  db.prepare("INSERT INTO steps VALUES (0, 14, 3, ?)").run(Buffer.from("user"))
  db.prepare("INSERT INTO steps VALUES (1, 17, 7, ?)").run(Buffer.from("err"))
  db.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(Buffer.from([0x28, 0xd8, 0x9c, 0x05]))
  db.close()

  const fakeDir = path.join(root, "fake-silent-agy")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("models")) {
  console.log("gemini-test-medium Gemini Test (medium)");
  process.exit(0);
}
const logIndex = args.indexOf("--log-file");
const logFile = logIndex >= 0 ? args[logIndex + 1] : null;
let count = 0;
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", chunk => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }));
    } else if (msg.method === "session/new") {
      count++;
      const sessionId = count === 3 ? "sess-zero-step" : "sess-silent-" + count;
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId } }));
    } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    } else if (msg.method === "session/prompt") {
      const text = JSON.stringify(msg.params?.prompt || []);
      const sessionId = msg.params?.sessionId;
      if (text.includes("SILENT_LOG_EMPTY")) {
        if (logFile) fs.appendFileSync(logFile, "E] agent executor error: RESOURCE_EXHAUSTED (code 429): upstream rejected request\\n");
      } else if (text.includes("ZERO_MODEL_STEP_PROSE")) {
        if (sessionId && process.env.AGY_BRIDGE_CONVERSATIONS_DIR) {
          fs.copyFileSync(path.join(process.env.AGY_BRIDGE_CONVERSATIONS_DIR, "sess-zero-step.db"), path.join(process.env.AGY_BRIDGE_CONVERSATIONS_DIR, sessionId + ".db"));
        }
        if (logFile) fs.appendFileSync(logFile, "E] agent executor error: QUOTA_EXHAUSTED (code 429): quota exhausted\\n");
        console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retrying request without producing an upstream model step yet." } } } }));
      }
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    }
  }
});
`)

  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"

  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-silent=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    const send = (userId, content) => loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: userId },
        messages: [{ role: "user", content }],
      }),
    })

    const res1 = await send("u-silent-log", "SILENT_LOG_EMPTY")
    const body1 = await res1.json()
    assert.equal(res1.status, 429, JSON.stringify(body1))
    assert.ok(body1.error, JSON.stringify(body1))

    const res2 = await send("u-silent-empty", "SILENT_NO_LOG_EMPTY")
    const body2 = await res2.json()
    assert.equal(res2.status, 502, JSON.stringify(body2))
    assert.match(body2.error?.message || "", /without producing a model response/)

    const res3 = await send("u-zero-step", "ZERO_MODEL_STEP_PROSE")
    const body3 = await res3.json()
    assert.equal(res3.status, 429, JSON.stringify(body3))
    assert.equal(body3.error?.code, "AGY_ERROR_QUOTA_EXHAUSTED")
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("responseUsage does not fabricate 1 token on empty output or zero estimate", async () => {
  const compatPath = createCompatBridge()
  const { Turn, Proc, responseUsage, allProcs } = await import(pathToFileURL(compatPath).href)
  const proc = new Proc("unused-agy", "usage-floor-test", { tools: [], messages: [{ role: "user", content: "" }] })
  proc.stopping = true
  proc.expectedMessages = [{ role: "user", content: "" }]
  const turn = new Turn(proc, proc.expectedMessages)
  proc.turn = turn
  try {
    const step = turn.registerResponse({ messages: proc.expectedMessages })
    turn.stepInputEstimates[step.estimateIndex] = 0
    step.inputEstimate = 0
    const emptyUsage = responseUsage(proc, turn, step, [])
    assert.equal(emptyUsage.input_tokens, 0)
    assert.equal(emptyUsage.output_tokens, 0)

    const toolUsage = responseUsage(proc, turn, step, [{
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "/Users/example/project/very/long/file/name/for/estimation.ts", start_line: 1, end_line: 200 },
    }])
    assert.ok(toolUsage.output_tokens > 10, `expected tool_use output estimate > 10, got ${toolUsage.output_tokens}`)
  } finally {
    proc.finalizeTurn(turn)
    allProcs.delete(proc)
  }
})

test("streamErrorOf marks invalid_request_error with status 400 and preserves metadata", async () => {
  const { streamErrorOf } = await import(`./index.mjs?fixes-err=${Date.now()}`)
  const invalid = streamErrorOf({ kind: "invalid_request_error", message: "code 429 turned away", code: "bad_prompt", retryable: false })
  assert.deepEqual(invalid, { type: "invalid_request_error", message: "code 429 turned away", status: 400, code: "bad_prompt", retryable: false })
  const quota = streamErrorOf({ kind: "rate_limit_error", message: "quota", code: "rate_limit", retryable: true, retryAfterMs: 3000 })
  assert.equal(quota.status, undefined)
  assert.equal(quota.retry_after_ms, 3000)
})

test("run_command avoids agy toolSummary collision, restores default argument, and preserves fellBack signal", async () => {
  const workRoot = path.join(root, "tool-summary-work")
  const accountsDir = path.join(root, "tool-summary-accounts")
  const stateFile = path.join(root, "tool-summary-state.json")
  const fakeDir = path.join(root, "fake-tool-summary-agy")
  const logFile = path.join(root, "tool-summary.jsonl")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_TS_LOG;
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) {
  if (process.env.FAKE_MODELS_FAIL === "1") process.exit(1);
  console.log("gemini-test  Gemini Test");
  process.exit(0);
}
const sessionId = "s-ts";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function connectControl(payload, onReply) {
  return import("node:net").then((net) => new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, ...payload }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      onReply?.(msg);
      resolve(msg);
      sock.destroy();
    });
    sock.on("error", reject);
  }));
}
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    await connectControl({ kind: "list" }, (reply) => fs.appendFileSync(logFile, JSON.stringify({ step: "list", msg: reply }) + "\\n"));
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, models: { currentModelId: "gemini-test", availableModels: [{ modelId: "gemini-test", name: "Gemini Test" }] } } });
  } else if (msg.method === "session/prompt") {
    const callArgs = JSON.parse(process.env.FAKE_CALL_ARGS || "{}");
    void connectControl({ kind: "call", name: "run_command", arguments: callArgs }).catch(() => {});
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    FAKE_TS_LOG: process.env.FAKE_TS_LOG,
    FAKE_CALL_ARGS: process.env.FAKE_CALL_ARGS,
    FAKE_MODELS_FAIL: process.env.FAKE_MODELS_FAIL,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = workRoot
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.FAKE_TS_LOG = logFile
  const schema = {
    type: "object",
    properties: { CommandLine: { type: "string" }, toolSummary: { type: "string" } },
    required: ["CommandLine", "toolSummary"],
  }
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-ts=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    assert.equal(await plugin.auth.cli.installed(), true)

    process.env.FAKE_MODELS_FAIL = "1"
    const fallbackModels = await plugin.provider.models()
    assert.equal(fallbackModels[Symbol.for("magpie.fellBack")], true)

    delete process.env.FAKE_MODELS_FAIL
    const liveModels = await plugin.provider.models()
    assert.equal(liveModels[Symbol.for("magpie.fellBack")], undefined)

    const loader = await plugin.auth.loader()
    process.env.FAKE_CALL_ARGS = JSON.stringify({ CommandLine: "pwd" })
    const res1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: "u-ts-1" },
        tools: [{ name: "run_command", input_schema: schema }],
        messages: [{ role: "user", content: "run pwd" }],
      }),
    })
    const body1 = await res1.json()
    assert.equal(res1.status, 200, JSON.stringify(body1))
    assert.equal(body1.content.find(b => b.type === "tool_use")?.input?.toolSummary, "Run command")
    assert.deepEqual(schema.required, ["CommandLine", "toolSummary"])
    const listed = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse).find(e => e.step === "list")
    assert.deepEqual(listed.msg.result.tools[0].inputSchema.required, ["CommandLine"])

    process.env.FAKE_CALL_ARGS = JSON.stringify({ CommandLine: "pwd", toolSummary: "Show location" })
    const res2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: "u-ts-2" },
        tools: [{ name: "run_command", input_schema: schema }],
        messages: [{ role: "user", content: "run pwd with summary" }],
      }),
    })
    const body2 = await res2.json()
    assert.equal(res2.status, 200, JSON.stringify(body2))
    assert.equal(body2.content.find(b => b.type === "tool_use")?.input?.toolSummary, "Show location")
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("steering waiting-for-permission rejection falls back cleanly without 409 lockup", async () => {
  const workRoot = path.join(root, "steer-wait-work")
  const accountsDir = path.join(root, "steer-wait-accounts")
  const stateFile = path.join(root, "steer-wait-state.json")
  const fakeDir = path.join(root, "fake-steer-wait-agy")
  const logFile = path.join(root, "steer-wait.jsonl")
  await fs.promises.mkdir(workRoot, { recursive: true })
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_WAIT_LOG;
const record = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
const sessionId = "s-wait";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function connectControl(payload) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, ...payload }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      resolve(msg);
      sock.destroy();
    });
    sock.on("error", reject);
  });
}
let active = null;
let unseenDone = null;
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    record({ type: "session/new" });
    await connectControl({ kind: "list" });
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, models: { currentModelId: "gemini-test", availableModels: [{ modelId: "gemini-test", name: "Gemini Test" }] } } });
  } else if (msg.method === "session/cancel") {
    record({ type: "session/cancel" });
    if (active) {
      if (unseenDone) await unseenDone;
      const id = active.id;
      active = null;
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    const text = (msg.params?.prompt || []).map(p => p.text || "").join("\\n");
    record({ type: "session/prompt", id: msg.id, text });
    if (active) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Can't add this prompt to session s-wait: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again",
        },
      });
      if (!unseenDone) {
        unseenDone = new Promise(r => setTimeout(r, 15)).then(() =>
          connectControl({ kind: "call", name: "bash", arguments: { cmd: "pwd" } }).then(r => {
            record({ type: "unseen_bash_reply", r });
            return r;
          })
        );
      }
      return;
    }
    if (!text.includes("STOP_NOW")) {
      active = { id: msg.id };
      void connectControl({ kind: "call", name: "update_plan", arguments: { step: "1" } }).catch(() => {});
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RECOVERED_AFTER_WAIT" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    FAKE_WAIT_LOG: process.env.FAKE_WAIT_LOG,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = workRoot
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.FAKE_WAIT_LOG = logFile
  const tools = [
    { name: "update_plan", input_schema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] } },
    { name: "bash", input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  ]
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-wait=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    const messages1 = [{ role: "user", content: "start plan" }]
    const res1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-wait-1" }, tools, messages: messages1 }),
    })
    const body1 = await res1.json()
    assert.equal(res1.status, 200, JSON.stringify(body1))
    const toolUse = body1.content.find(b => b.type === "tool_use")
    assert.equal(toolUse?.name, "update_plan")

    const messages2 = [
      ...messages1,
      { role: "assistant", content: body1.content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "text", text: "Plan shown." }] },
          { type: "text", text: "STOP_NOW: answer instead" },
        ],
      },
    ]
    const res2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-wait-1" }, tools, messages: messages2 }),
    })
    const body2 = await res2.json()
    assert.equal(res2.status, 200, JSON.stringify(body2))
    assert.equal(body2.stop_reason, "end_turn")
    assert.ok(body2.content.some(b => b.type === "text" && b.text.includes("RECOVERED_AFTER_WAIT")), JSON.stringify(body2))

    const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
    assert.equal(events.filter(e => e.type === "session/new").length, 1)
    assert.equal(events.filter(e => e.type === "session/cancel").length, 1)
    assert.ok(events.some(e => e.type === "unseen_bash_reply" && (e.r?.result?.isError === true || !!e.r?.error)), JSON.stringify(events))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})
