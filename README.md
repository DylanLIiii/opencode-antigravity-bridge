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
3. Pick a model and, when offered, a thinking level. Effort-specific IDs from
   `agy models` are grouped into one model with variants, then mapped back to
   the corresponding agy ID for each request.

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
  per-turn deltas. When agy reports reasoning, `message_delta.usage` includes
  Anthropic-compatible `output_tokens_details.thinking_tokens`. agy's public
  output does not expose the corresponding visible thinking text or signatures.
- **Client-compatible continuation**: cache markers, string/block text,
  split assistant messages and outer text whitespace do not invalidate a turn.
  Client-renamed tool IDs are matched only when history, tool names and arguments
  identify one pending response. Actual history edits/compaction with known call
  IDs retire the old process and replay the current history and real results.
- **Protocol context notices** beside tool results, including trailing
  user/system/developer messages, reach MCP inside a separate `system-reminder`.
  This covers OpenCode `<system-update>` messages, background task notifications,
  and recognized hook/token-count notices without treating them as user messages.
- **Conversation pooling**: at most four agy processes, ten-minute idle
  reaping, LRU eviction, and HTTP 503 for conflicting concurrent responses.
- **Isolated tool configuration**: a custom agent with `tools: []` and only
  the client-declared MCP server. Unexpected non-bridge tool steps fail the
  turn instead of being silently executed. An available absolute client directory
  from `x-magpie-work-dir` or the caller's environment text is added with
  `--add-dir`. agy still starts in its isolated agent workspace; the prompt
  identifies the caller's environment as the place where client tools execute,
  including when the client is on another machine.
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
- **User instructions beside a live `tool_result`** are still rejected with
  HTTP 400. Complete `<system-update>` elements, task notifications, and
  recognized hook/token-count notices are supported, but agy's mid-turn
  user-message queue has not been verified. Send user instructions after the
  tool continuation completes.
- **Ambiguous or unrecognized rewritten tool IDs** are not guessed. Ambiguous
  matches return 503; unrecognized results that conflict with a pending pooled
  conversation return 409. Conflicting duplicates and mixed-conversation result
  batches also remain 409 errors.
- **One Google account.** agy owns one sign-in, and the magpie provider is
  declared as a single-account provider.
- **No automatic agy installation** and no support guarantee for CLI protocol
  changes. The helper supports agy's modern `server/discover` MCP handshake
  (`2026-07-28`) and legacy `initialize` handshakes.
- **Timeouts**: process startup defaults to 60 seconds, model/output inactivity
  to 5 minutes, and waiting for a client tool result to 30 minutes. Set
  `AGY_BRIDGE_START_TIMEOUT_MS`, `AGY_BRIDGE_TURN_TIMEOUT_MS`, or
  `AGY_BRIDGE_TOOL_TIMEOUT_MS` to override them. agy's eligibility/authentication
  check runs before init and can still fail independently of the bridge.

## Development

```sh
node --check index.mjs
node --check mcp-server.mjs
node test-smoke.mjs
npm pack --dry-run
```

The smoke test uses a fake agy process and the real stdio MCP helper. Its 123
checks pass under both Node and Bun. They cover streaming, process reuse,
conversation isolation, native tool round-trips, parallel/consecutive calls,
atomic result validation, failures, startup, death, timeouts, cancellation,
model/tool changes, UTF-8, cleanup, model discovery/effort routing, protocol
selection, HTTP errors, reformatted histories, renamed tool IDs (including
ambiguity and changed arguments), compaction replay, task/system-update notices,
and local/remote caller environments.

The plugin was also installed into **Magpie 0.1.1356** with its real Bun host.
CLI keyless sign-in passed, and direct requests to the gateway's
`/v1/messages` verified both a plain-text response and a native
`tool_use → tool_result → end_turn` round-trip using agy 1.3.3.

## Official Claude Bridge alignment (2026-10-26)

Compared against [Magpie's source at e5dd869](https://github.com/yetone/magpie/tree/e5dd86965b56a8a176790e2c1ade09f9ef554208),
whose latest reachable release tag was `v0.1.1566`:

- Content-based continuation, safe tool-ID remapping and replay on changed
  history follow the official bridge's `match`, `remap`, `follows` and
  `serveSubscription` approach. This plugin retains stricter checks on tool
  arguments and internal text whitespace.
- [Background task notices](https://github.com/yetone/magpie/commit/9a2106220c6d89708db158048ac2b7ebbb5ef082)
  are forwarded as reminders alongside real results. User mid-turn instructions
  still need agy-specific queue support.
- [Caller environment clarification](https://github.com/yetone/magpie/commit/13f9c7fca11b8ccb2aa7fb1b397e26d4f7b3bc3a)
  and directory recognition are adapted. Unlike Claude Code, agy must keep its
  isolated workspace to discover the restricted custom agent; this plugin uses
  `--add-dir` instead of moving the process into the caller's directory.
- Claude's named-account transition, `--json-schema` workaround, and
  memory-budget eviction with on-disk session resume are Claude-specific and
  are not implemented here. MCP input schemas remain intact. Live tool-list
  changes rebuild/replay instead of using Claude's dynamic registration.

On 2026-10-26, the continuation changes were also verified with real agy 1.3.5
and Magpie 0.1.1564. An isolated local gateway served the plugin directly, and
an actual OpenCode 2.1.2 session completed `shell (exit 18) → system-update →
tool_result → second shell call → end_turn`. Local usage records confirmed that
`antigravity-bridge`, not `remote-magpie`, served every request.

Repeated real-agy probes also exposed intermittent pre-init eligibility failures
(such as an `oauth2/v2/userinfo` EOF). These are upstream startup failures, not
successful tool-continuation runs; startup errors now retain agy's actual error
text instead of only reporting a missing init event.

## License

MIT
