# opencode-antigravity-bridge

A [magpie](https://github.com/yetone/magpie) provider plugin that serves an
**Antigravity subscription through a real `agy` CLI process**, rather than
impersonating the Antigravity IDE over HTTPS.

The plugin translates between Anthropic Messages and agy's stream-json
protocol. It keeps one agy process per conversation and exposes client tools
to agy through a real stdio MCP server. Google sees requests made by the real
CLI; this avoids client-identity spoofing, but it is not a guarantee against
account restrictions or changes to Google's policies.

```
Client (Amp, Claude Code, ...)
  │  Anthropic Messages (POST /v1/messages)
  ▼
magpie gateway
  │  antigravity-bridge provider
  ▼
this plugin
  │  agy stream-json + native MCP tool calls
  ▼
real agy process
  ▼
Google Code Assist backend
```

## Requirements

- Antigravity CLI (`agy`), signed in interactively at least once. Version
  **1.3.3** is the version used for the real-CLI verification.
- magpie with OpenCode-style provider plugin support.
- No global MCP configuration is required. The plugin creates an isolated,
  temporary agent configuration for each agy process.

## Install

From a local checkout (not yet published to npm):

```sh
magpie plugin add ./opencode-antigravity-bridge
```

## Use

1. Run `agy` interactively once and sign in to your Google account.
2. In magpie, choose Providers → Antigravity Bridge → Sign in. This verifies
   the CLI with `agy models`; agy owns the actual Google credentials.
3. Pick a model reported by `agy models` and talk to the agent as usual.

## What works

- **Streaming responses** translated from agy `step_update` events to
  Anthropic SSE, including keepalive pings and explicit terminal error frames.
- **Multi-turn conversations** with process reuse. A model or tool-definition
  change starts a fresh process and replays the rendered history.
- **Native client tools through MCP**, including JSON Schema declarations,
  parallel and consecutive calls, tool errors, and multiple tool rounds.
- **Real tool results across HTTP requests.** The first response ends with
  `stop_reason: tool_use`, while agy's MCP call remains pending. The next
  request's `tool_result` resolves that exact MCP call, and the same agy turn
  continues into the next response. No successful placeholder result or text
  `TOOL_CALL` convention is used.
- **Token usage reporting**, converted from agy's session-cumulative usage to
  per-turn deltas.
- **Conversation pooling**: at most four agy processes, ten-minute idle
  reaping, LRU eviction, and HTTP 503 for conflicting concurrent responses.
- **Isolated tool configuration**: a custom agent with `tools: []` and only
  the client-declared MCP server. Unexpected non-bridge tool steps fail the
  turn instead of being silently executed. The client's working directory is
  added with `--add-dir` when magpie supplies it.
- **Actual HTTP 400 errors** for unsupported request content detected before
  streaming starts.

The MCP transport forwards each declared `input_schema`, but that does not
automatically execute full JSON Schema validation. The bridge validates tool
names and argument shapes; the client that executes a tool must still validate
its arguments and authorize the operation.

## Limitations

- **User images and documents** are rejected with HTTP 400 because agy's
  stream-json input accepts text blocks only. Base64 images returned inside a
  `tool_result` are passed through as MCP image content.
- **Text beside a live `tool_result`** is rejected with HTTP 400. Send that
  text after the tool continuation completes rather than misattributing it to
  the tool output.
- **One Google account.** agy owns one sign-in, and the magpie provider is
  declared as a single-account provider.
- **No automatic agy installation** and no support guarantee for CLI protocol
  changes. The helper supports agy's modern `server/discover` MCP handshake
  (`2026-07-28`) and legacy `initialize` handshakes.
- **Timeouts**: model/output inactivity defaults to 5 minutes and waiting for
  a client tool result to 30 minutes. Set `AGY_BRIDGE_TURN_TIMEOUT_MS` or
  `AGY_BRIDGE_TOOL_TIMEOUT_MS` to override them.

## Development

```sh
node --check index.mjs
node --check mcp-server.mjs
node test-smoke.mjs
npm pack --dry-run
```

The smoke test uses a fake agy process and the real stdio MCP helper. Its 52
checks cover normal streaming, process reuse, same-opening conversation
isolation, native tool round-trips, parallel/consecutive calls, atomic result
validation, tool failures, simultaneous startup, process death, timeouts,
cancellation, tool-list changes, UTF-8 chunk boundaries, workspace cleanup,
dynamic model parsing, protocol declaration, and HTTP 400 behavior.

The plugin was also installed into **Magpie 0.1.1356** with its real Bun host.
CLI keyless sign-in passed, and direct requests to the gateway's
`/v1/messages` verified both a plain-text response and a native
`tool_use → tool_result → end_turn` round-trip using agy 1.3.3.

## License

MIT
