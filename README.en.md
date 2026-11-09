# opencode-antigravity-bridge

> 中文介绍见 [README.md](README.md)。

A [magpie](https://github.com/yetone/magpie) provider plugin that serves an
**Antigravity subscription through a real `agy` CLI process**, rather than
impersonating the Antigravity IDE over HTTPS.

The plugin translates Anthropic Messages to the **Agent Client Protocol (ACP)**
that `agy acp` serves on stdio, following the approach of
[T3 Code's Antigravity driver](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/provider/acp).
It keeps one agy session per conversation and serves the client's tools to agy
as its IDE tools over MCP. Google sees requests made by the real CLI; ACP keeps
the `zed / 0.0.0` compatibility identity required by agy's non-Gemini model
allowlist. This is not a guarantee against account restrictions or changes to
Google's policies.

```
Client (OpenCode, Amp, Claude Code, ...)
  │  Anthropic Messages (POST /v1/messages, SSE)
  ▼
magpie gateway ── antigravity-bridge provider (this plugin)
  │  ACP JSON-RPC on stdio: initialize · session/new|resume · set_model ·
  │  session/prompt · session/update (message + thought chunks) · cancel
  ▼
agy acp --agent magpie-bridge --ide-mcp-port <port>
  │  runs `nc` → the bridge's private shim → mcp-server.mjs (stdio MCP)
  │  client tools appear to the model as mcp_ide-tools_<name>
  ▼
Google Code Assist backend
```

## Requirements

- Antigravity CLI (`agy`) with the `acp` subcommand, signed in interactively at
  least once. Text/tool transport was verified with **1.4.12** and **1.5.0**;
  user image input requires an image-capable ACP server (verified with **1.5.0**).
- magpie with OpenCode-style provider plugin support.
- No global MCP configuration is required, and none is used: the plugin creates
  an isolated, temporary agent per agy process.

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

- **Streaming responses** from ACP `agent_message_chunk` updates, with
  keepalive pings and explicit terminal error frames.
- **User image input** as inline base64 PNG, JPEG, GIF or WebP. Text and images
  keep their order in initial prompts, continued turns and history replay.
  The server must advertise `promptCapabilities.image`; otherwise the request
  returns HTTP 400 before streaming. Gemini and Claude model entries expose
  image input to the host; the runtime capability check still applies.
- **Thinking summaries.** agy's `agent_thought_chunk` summaries stream as
  Anthropic `thinking` blocks (`thinking_delta`), each closed by a
  `signature_delta`, so clients keep the block and replay it in history. agy's
  ACP stream exposes no model signature, so the bridge issues one: `agyb1.` plus
  an HMAC-SHA256 over the session and the block text under a per-process key.
  Send `thinking: { "type": "disabled" }` or set `AGY_BRIDGE_THINKING=0` to
  suppress them.
- **All account models.** The ACP client identifies as `zed / 0.0.0`, the
  allowlisted compatibility identity used by T3 Code, which is how agy offers
  Claude and GPT-OSS models besides Gemini. Changing the model, or the effort
  level, uses the server's ACP
  `model` and `thought_level` configuration options inside the live session.
  Model changes refresh the available thinking levels; configuration update
  notifications keep the selection current. Older servers without these
  options or `session/set_config_option` use `session/set_model` instead.
  Real configuration errors are surfaced, and the conversation is not replayed.
- **Native client tools through MCP**, served as agy's IDE tools: JSON Schema
  declarations, parallel and consecutive calls, tool errors, image results and
  multiple tool rounds. The first response ends with `stop_reason: tool_use`
  while agy's MCP call stays pending; the next request's `tool_result` resolves
  that exact call and the same agy turn continues. No placeholder results and no
  text `TOOL_CALL` convention.
- **Long-running client tools.** agy fails an IDE MCP call after a fixed three
  minutes. Before that deadline (150 s, `AGY_BRIDGE_IDE_CALL_DEADLINE_MS`) the
  bridge answers that the tool is still running; an identical repeat call from
  the model waits for the original run instead of reaching the client again, and
  a result that arrives after agy ended its turn is delivered in a follow-up
  prompt within the same response. The client runs each call exactly once.
- **Live tool catalog changes** (for example OpenCode Code Mode) reach agy
  through MCP `notifications/tools/list_changed`, including in the middle of a
  tool continuation; the session is kept. A catalog that cannot be confirmed
  fails before `session/prompt` with `tool_list_unconfirmed`, and a disconnected
  MCP watch reconnects with bounded backoff and requests a fresh tool list.
- **Session resume, including across restarts.** After every completed turn,
  and when an idle (10 minutes, `AGY_BRIDGE_IDLE_MS`) or LRU-evicted process is
  stopped, the bridge records the conversation's agy session in a private state
  file (`$XDG_STATE_HOME/magpie-agy-bridge/sessions.json`, mode 0600,
  `AGY_BRIDGE_STATE_FILE` overrides). It holds only the session ID, the working
  directory and SHA-256 hashes of the history and instructions, never message
  text. The next request whose history and instructions hash the same, also
  after a Magpie or plugin restart, starts agy with `session/resume` and sends
  only the new message (within `AGY_BRIDGE_RESUME_TTL_MS`, default 6 hours).
  Instructions are appended only on `session/new`, never appended again on
  resume. A failed resume or startup restores the durable snapshot instead of
  discarding it; only a missing/unsupported conversation falls back to
  `session/new`. Concurrent bridge processes merge the file instead of
  overwriting it.
- **Cancellation without loss.** A client that stops reading gets
  `session/cancel`; the session stays alive and the partial answer the client
  saw becomes part of the expected history.
- **Upstream errors without retry amplification.** agy reports API failures as
  an in-band `⚠ Agent execution terminated due to error.` message and
  `end_turn`. The bridge withholds that marker and reads the real reason from
  the process's own log. Generic `RESOURCE_EXHAUSTED`/429 is no longer described
  as confirmed quota exhaustion and is not automatically retryable. Once a
  prompt has been submitted, an identical streaming or non-streaming retry gets
  `prompt_outcome_unknown` rather than issuing another `session/prompt`; a
  different follow-up can continue the surviving session without replaying it.
- **Scoped system-prompt guard.** Standalone Claude billing metadata blocks and
  two exact Claude Agent SDK identity sentences are normalized before system
  blocks are flattened. User messages, tool results, code quotations, vendor
  names and safety instructions are not globally rewritten. Set
  `AGY_BRIDGE_PROMPT_GUARD=0` to disable this compatibility layer.
- **Per-response token usage.** ACP reports one total per `session/prompt`,
  which can span several responses (tool round-trips), and agy sends no
  `usage_update`. agy does record every model call in its conversation store
  (`~/.gemini/antigravity-cli/conversations/<sessionId>.db`); each response
  reports the calls it covered from there: the latest call's uncached input,
  `cache_read_input_tokens` and cache writes, and the calls' output with
  thought tokens itemized in `output_tokens_details.thinking_tokens`. Without
  SQLite support (Node < 22.5, or Node 22/23 without `--experimental-sqlite`)
  or a readable store, responses fall back to an estimate calibrated on ACP's
  totals. Set `AGY_BRIDGE_STEP_USAGE=0` to disable store reads entirely.
- **Long answers continue.** A prompt that stops on `max_tokens` is continued in
  the same session and response, up to 3 times (`AGY_BRIDGE_MAX_CONTINUATIONS`).
  agy's own output-cap notice ("Your previous response was cut off…") is not
  shown.
- **Subscription quota reporting** in Magpie through `auth.usage`, using the
  real CLI's structured `/usage` report.
- **Client-compatible continuation**: cache markers, string/block text, split
  assistant messages, outer text whitespace, client-normalized `tool_use.input`
  arguments, and trailing `system`/`developer` context messages (such as Claude
  Code's per-turn hook, environment, and deferred-tool reminders) do not
  invalidate a turn or force a session restart. Client-renamed tool IDs are
  matched only when history, tool names and arguments identify one pending
  response. Real history edits (compaction), user-interrupted or rejected tool
  turns (`[Request interrupted by user]`, tool-rejection prompts), and mid-turn
  queued user commands (`<queued-command>` / Claude Code `queued_command`
  envelopes) start a fresh session and replay the current history and real
  results.
- **Protocol context notices, Claude Code hooks, and tool companions** beside
  tool results: trailing user/system/developer notices reach MCP inside a
  separate `system-reminder` (OpenCode `<system-update>`, background task and
  `<teammate-message>` / `<channel>` notifications, `/loop` status folds, Claude
  Code environment/file-change/progress reminders, and `PreToolUse` /
  `PostToolUse` / `PostToolUseFailure` / `Stop` / `TaskCreated` /
  `PermissionDenied` hook outputs, while empty `hook success: Success` and
  `<total_tokens>` boilerplate is stripped), and Claude Code's tool-companion
  blocks (`Skill` prompt bodies, image coordinate dimensions and base64 images,
  and `ToolSearch` `tool_reference` / `Tool loaded.` blocks) attach directly to
  their preceding matching tool result. Skill companions must carry a `Base
  directory for this skill:`, `ARGUMENTS:` / `Skill arguments:` prefix, or a
  Markdown heading containing "skill" or "instructions"; unmarked user text
  is rejected rather than treated as tool output.
- **Broad Anthropic Messages compatibility**: `/v1/messages/count_tokens` (a local estimate, not a model tokenizer),
  non-streaming `stream: false` responses, `output_config.format` /
  `response_format` JSON schema reminders (used by Claude Code `type: "prompt"`
  hooks), plain-text `document` and `search_result` blocks, historical
  `server_tool_use` / `web_search_tool_result` blocks, MCP `input_schema`
  keyword sanitization for Gemini/Vertex compatibility, effort selection via
  `output_config.effort` / `thinking.budget_tokens`, Windows `.cmd` / `.bat` and
  WSL `/mnt/<drive>` working-directory translation, and same-family model alias
  fallback. Claude Haiku never silently routes to Gemini Flash.
- **Conversation pooling**: at most four agy processes, idle reaping, LRU
  eviction, and HTTP 503 for conflicting concurrent responses.
- **Isolation without a permission bypass.** The agent is defined with
  `tools: []`, `inheritMcp: false`, `inheritCustomizations: false` and
  `excludeDefaultComponents: true`, so the user's global MCP servers, skills and
  plugins never reach the model. agy is not started with
  `--dangerously-skip-permissions`: every `session/request_permission` (shell,
  file edits, browser, questions) is answered with a rejection. Client tools
  need no permission because they arrive through MCP. An available absolute
  client directory from `x-magpie-work-dir` or the caller's environment text is
  added with `--add-dir`; agy still runs in its isolated workspace, and the
  session instructions say where client tools execute.
- **Actual HTTP 400 errors** for unsupported request content detected before
  streaming starts.

The MCP transport sanitizes `input_schema` keywords for agy's Gemini/Vertex
translator. Local references are expanded with depth and node limits; nullable
types, compositions and tuples are reduced to a conservative schema subset.
Object alternatives retain their properties and common required fields; `allOf`
combines required fields. Mixed types and unsupported constraints become description
hints. This does not execute full JSON Schema validation. The bridge validates tool
names and argument shapes; the client that executes a tool must still validate
its arguments and authorize the operation.

A client-declared `ToolSearch` without an `input_schema` receives `query` and
`max_results` parameters. Deferred definitions present in the client's tool list
are exposed to agy; definitions added after a search are announced and re-listed
before the search result is released. The bridge cannot discover tools whose
definitions the client never sends.

`output_config.effort` and `thinking.budget_tokens` select a level when
Anthropic `thinking.type` is `enabled` or `adaptive`. Generic
`reasoning_effort`, `reasoningEffort`, `reasoning.effort` and
`generationConfig.thinkingConfig.thinkingLevel` do not require that envelope;
`thinking.type: "disabled"` suppresses these request-level overrides.
`count_tokens` estimates text at roughly four ASCII bytes or three non-ASCII
UTF-8 bytes per token and uses a fixed 1,600 tokens per image. It should not be
used as an exact quota or context-limit measurement.

## Token cost

The client's system prompt is installed once per session with ACP
`_meta.antigravity.systemPrompt.append`, and each turn sends only the new user
message. agy's own coding-agent prompt and built-in tool catalog are excluded,
because the client supplies both. Measured with agy 1.4.12 (`gemini-3.8-flash`):

| agy agent configuration | input tokens, "Reply OK" |
|---|---|
| agy default agent | 8,357 |
| `tools: []` only (the stream-json bridge's agent; also exposed the user's global MCP servers) | 3,677 |
| + `inheritMcp: false`, `inheritCustomizations: false` | 3,123 |
| + `excludeDefaultComponents: true` (this bridge) | **509** |

A scripted three-turn coding conversation with one tool round (two client tools,
`gemini-3.8-flash-low`) consumed **4,109** input tokens in total with this
bridge and **15,351** with agy's default components kept
(`AGY_BRIDGE_MINIMAL_AGENT=0`), 73% less. Tool rounds cost no extra prompt,
model switches, tool catalog changes, cancellations, upstream errors and idle
resumes no longer replay the conversation, and long tools cost one short model
call per 150 s of waiting only when a tool runs longer than that.

**Prompt caching** is decided by Google's backend, not the bridge. The bridge
keeps the request prefix as stable as it can: the instructions are installed
once per session and agy keeps the conversation, so each turn appends only the
new message. Measured on agy 1.4.12 with a 5.5k-token stable system prompt
over four turns of one session:

| model | turn 1 | turns 2–4 (input / cache read) |
|---|---|---|
| `gemini-4-argon-low` | 5,567 / 0 | 2,155 / 3,513 · 2,152 / 3,619 · 2,151 / 3,722 |
| `gemini-3.8-flash-low` | 5,528 / 0 | 0 cache read on every turn |

Argon's cache read on each turn equals the previous turn's whole prompt minus
a constant 2,049 tokens (2,054 on the second turn): the last ~2k tokens of a
request are never served from cache, whatever they contain. agy's request is
append-only (its per-turn local time sits inside each user message and never
changes afterwards), so the shortfall is the backend's, not a moving part in
the prefix. The hit rate therefore grows with prompt size: about 62–64% for
the 5.5k prompt above, and 91.7% for a 26k prompt (turn 3 read 23,944 of
26,097, exactly the previous 25,993 minus 2,049). OpenCode prompts with tool
definitions are usually far longer, so expect 90%+ there. The 2,049 constant
is inferred from these runs on `gemini-4-argon-low`; Google does not document
it. Flash reported no cached tokens with `systemPrompt.append`, with
the instructions in the first message, or with agy's default components kept,
so that is the backend's behaviour for that model, not a prefix the bridge
changes. Cached tokens appear as `cache_read_input_tokens`.

## Subscription limits

Open Magpie's **Usage / Allowances** page and refresh the Antigravity Bridge
card, or query it from the terminal:

```sh
magpie quota antigravity-bridge --json
magpie quota refresh antigravity-bridge --json
```

Magpie must be running this updated checkout (an older installed copy does not
gain the hook automatically). This is Magpie's `auth.usage` extension, not a
native OpenCode V2 quota UI. A current Magpie with plugin usage support is
required; the hook was verified with the **0.1.1599** host.

The plugin queries `agy --version`, then runs
`agy -p /usage --output-format json` with a restricted custom agent and a
bounded print timeout. It reads the **current agy sign-in**, not a Google
account separately added to Magpie. It does not read, copy, or save Google
tokens, impersonate the IDE, scrape the TUI, or send a model prompt. `agy`
remains responsible for authentication and quota requests. An unrecognized
version, or one older than **1.1.11**, is rejected before print mode because
older slash-command implementations could treat `/usage` as a model prompt.

Quota probes use a private `--gemini_dir` profile. Print-mode startup therefore
discovers only that empty profile instead of the user's global
`~/.gemini/config` skills, rules, plugins, MCP servers and settings. A
file-based agy sign-in is linked into the profile when present; otherwise the
probe relies on the same keyring/ADC credentials as the CLI. The link is
removed with the workspace and the token contents are never copied. Hidden
`--gemini_dir` support is probed with the version call; older CLIs fall back to
the normal Gemini directory. Set `AGY_BRIDGE_USAGE=0` to skip automatic quota
probes entirely (for example while investigating a CLI or macOS approval
service problem).

- Each returned group/cadence becomes a named window with percent used and,
  when available, its absolute reset time. Weekly-only plans do not gain a
  fictional five-hour allowance. Separate model groups retain their names.
- Disabled buckets are omitted. Missing or invalid fractions are **unknown**,
  not 0% or 100%; reset-only rows say `Limits not available`. If no enabled
  bucket has measured quota, the card reports an error instead of fake bars.
- The report supplies no verified email or plan, so the hook does not invent
  either. Token counts in inference responses are separate from these limits.
- Windows are **display-only** (`aside: true`): this update does not change
  routing or automatically stop requests when a window is exhausted.
- Concurrent reads share one query; sequential reads query agy again. Magpie
  can apply its own quota cache and refresh cooldown.
- Queries default to a **15-second total subprocess budget** and **1 MiB output
  limit**. `AGY_BRIDGE_USAGE_TIMEOUT_MS` can shorten that budget or raise it up
  to 18 seconds, below Magpie's 20-second usage-hook deadline. Version probing
  is capped at three seconds within that budget.
- A private temporary workspace contains the custom agent (`tools: []`,
  `mcpServers: []`, `inheritMcp: false`, `inheritCustomizations: false`,
  `excludeDefaultComponents: true`) and failing
  `open`/`xdg-open`/`BROWSER` launchers, preventing background usage refreshes
  from opening OAuth browser login. Queries set
  `AGY_CLI_DISABLE_AUTO_UPDATE=true` only for their child processes. They do
  not change global agy settings or the user's updater preferences.
- On completion, failure, timeout, or cancellation, the query's owned POSIX
  process group is stopped and its workspace removed. Processes that detach
  into a different process group are outside this cleanup guarantee. Errors
  show sanitized diagnostics, not raw stderr, tokens, or account URLs, and do
  not mark the bridge's sentinel login as revoked. Run `agy` interactively to
  repair an expired CLI sign-in.

Quota probing currently supports **macOS and Linux**. Windows returns an
explicit unsupported error rather than querying without browser/process guards.

References: CodexBar's
[CLI quota parser](https://github.com/steipete/CodexBar/blob/0aa34100b7a7ea397bcbf14eaab388d3f32aa4a1/Sources/CodexBarCore/Providers/Antigravity/AntigravityQuotaSummaryParser.swift)
and [guarded print probe](https://github.com/steipete/CodexBar/blob/0aa34100b7a7ea397bcbf14eaab388d3f32aa4a1/Sources/CodexBarCore/Providers/Antigravity/AntigravityProviderDescriptor.swift),
and Magpie's [usage hook](https://github.com/yetone/magpie/blob/5b4dec58e47d1eb961f5a3f4417c441f77662c7d/internal/plugin/host.js)
and [official Antigravity quota pools](https://github.com/yetone/magpie/blob/5b4dec58e47d1eb961f5a3f4417c441f77662c7d/internal/provider/google.go).
The bridge uses the CLI path, not Magpie's remote OAuth implementation.

## Limitations

- **User images and binary documents**: user prompt images require an `agy`
  process that advertises ACP `promptCapabilities.image` (agy 1.5.0 does;
  older servers may return HTTP 400). Image URLs, malformed base64 and
  binary/PDF documents return HTTP 400. Images inside or beside a
  `tool_result` are passed through as MCP image content. Plain-text
  `document` and `search_result` blocks are rendered as text.
- **agy runs parallel IDE tool calls one after another.** Each call reaches the
  client in its own `tool_use` response; calls agy issues together still leave
  in one response.
- **Thinking signatures are the bridge's, not Anthropic's.** The blocks are
  summaries, not raw reasoning, and their `agyb1.` signatures are only
  meaningful to this bridge (which needs nothing back: agy keeps its own
  context). The Anthropic API would reject them, so a client must not forward
  these blocks to a real Anthropic model after switching providers.
- **Plain user instructions beside a live `tool_result`** are still rejected
  with HTTP 400. Complete `<system-update>` elements, task/channel/teammate
  notifications, recognized Claude Code hook notices, and tool companions are
  forwarded on the live MCP turn; explicit Claude Code mid-turn
  `queued_command` envelopes and user follow-ups after a rejected/stopped tool
  call cancel the live turn and replay cleanly in a new session.
- **Ambiguous or unrecognized rewritten tool IDs** are not guessed. Ambiguous
  matches return 503; unrecognized results that conflict with a pending pooled
  conversation return 409. Conflicting duplicates and mixed-conversation result
  batches also remain 409 errors.
- **One Google account.** agy owns one sign-in; the bridge never calls ACP
  `authenticate` (it switches agy to a different sign-in path) and relies on the
  CLI's existing login.
- **The IDE tool connection uses a private `nc`.** agy runs `nc host port` for
  `--ide-mcp-port`; the bridge puts its own `nc` (and `nc.cmd` on Windows) first
  in agy's PATH, which runs `mcp-server.mjs` authenticated by a per-process
  token.
- **No automatic agy installation** and no support guarantee for CLI protocol
  changes. The MCP helper answers as a `2025-11-25` server, because agy's
  `2026-07-28` mode expects notifications through `subscriptions/listen`.
- **Timeouts**: process startup defaults to 60 seconds, model/output inactivity
  to 5 minutes, and waiting for a client tool result to 30 minutes. Set
  `AGY_BRIDGE_START_TIMEOUT_MS`, `AGY_BRIDGE_TURN_TIMEOUT_MS`, or
  `AGY_BRIDGE_TOOL_TIMEOUT_MS` to override them.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `AGY_PATH` | PATH lookup | agy executable |
| `AGY_BRIDGE_THINKING` | on | `0` stops forwarding thought summaries |
| `AGY_BRIDGE_EFFORT` | unset | force `minimal` / `low` / `medium` / `high` / `xhigh` / `max` (`ultra` aliases `max`); explicit legacy model suffixes retain their level |
| `AGY_BRIDGE_MINIMAL_AGENT` | on | `0` keeps agy's default prompt components (about 2,600 more input tokens per model call) |
| `AGY_BRIDGE_PROMPT_GUARD` | on | `0` disables scoped system metadata/identity normalization |
| `AGY_BRIDGE_TOOL_LIST_WAIT_MS` | 5000 | fail before prompt if the current client tool catalog is not confirmed within this budget |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | when a running client tool is reported as still running (must stay below agy's 180 s) |
| `AGY_BRIDGE_IDLE_MS` | 600000 | idle time before a process is parked for resume |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | parked-session resume and submitted-prompt dedupe retention |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | where resumable sessions are recorded (hashes only) |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 s / 5 min / 30 min | startup, agy inactivity, client tool result |
| `AGY_BRIDGE_USAGE` | on | `0` (also `false` / `off` / `no` / `disabled`) skips automatic quota probes entirely |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | quota subprocess budget, capped at 18000 ms |
| `AGY_BRIDGE_MCP_TRACE` | unset | file that receives the MCP helper's traffic (diagnostics) |
| `AGY_BRIDGE_MAX_CONTINUATIONS` | 3 | automatic continuations of an answer cut at the output cap (`0` disables) |
| `AGY_BRIDGE_CONVERSATIONS_DIR` | `~/.gemini/antigravity-cli/conversations` | agy's conversation store, read for per-call usage |
| `AGY_BRIDGE_STEP_USAGE` | on | `0` (also `false` / `off` / `no` / `disabled`) skips per-call usage from agy's conversation store entirely |

## Development

```sh
node --check index.mjs
node --check mcp-server.mjs
node --check usage.mjs
npm test
npm pack --dry-run
```

The smoke test runs the plugin against a fake agy that speaks ACP on stdio and
reaches the client tools the way the real one does, by running `nc` from PATH,
so the bridge's shim, the real stdio MCP helper and the control channel are all
exercised. The current suite has 330 smoke checks and 67 focused Node tests.
Historical Bun results are documented below; the current expanded suite has not
been rerun on Bun. These tests do not substitute for Windows end-to-end
validation. Together they cover the minimal agent, the allowlisted ACP identity,
scoped prompt guarding, submitted-prompt dedupe, session
instructions, streaming, thought
summaries with bridge-issued signatures, per-turn usage, session reuse, conversation isolation, native tool
round-trips, parallel/consecutive calls, atomic result validation, failures,
permission denial, in-band upstream errors and quota errors, startup timeouts and
failures, death, tool timeouts, cancels that arrive before the prompt, long tools past the MCP deadline (repeat-call
waiting and late delivery), cancellation with `session/cancel`, LRU eviction
with `session/resume`, resume after a simulated bridge restart from the hashed state file, in-session model switches, live tool catalog changes,
UTF-8, cleanup, model discovery/effort routing, HTTP errors, reformatted
histories, renamed tool IDs (including ambiguity and changed arguments),
compaction replay, task/system-update notices, and local/remote caller
environments, plus the public quota hook. Image cases cover ordered multimodal
prompts, continuations, replay, restart/resume, metadata normalization,
capability rejection and invalid input. Configuration cases cover grouped
selectors, model-dependent thinking levels, server notifications, legacy
fallback and genuine errors. The 14 focused tests in
`test-usage.mjs` cover quota parsing, version gating, browser/update guards,
output/time budgets, cancellation, process-group and workspace cleanup, safe
diagnostics, concurrency, and fresh sequential reads. Run those under Bun with
`bun test ./test-usage.mjs`, and the smoke suite with `bun test-smoke.mjs`.
The earlier 170-check suite passed on Bun; the new cases have not been run on
Bun in this environment.

Real CLI checks are opt-in and consume a small amount of the signed-in
account's model quota:

```sh
AGY_BRIDGE_INTEGRATION=1 npm run test:integration
# Optionally choose another image-capable model or include quota reporting:
AGY_BRIDGE_INTEGRATION=1 AGY_BRIDGE_TEST_MODEL=gemini-4-argon AGY_BRIDGE_TEST_USAGE=1 npm run test:integration
```

The integration check uses private temporary bridge state and two separate
Node processes. It checks image comprehension, a native MCP tool round trip,
final text and token usage, then cross-process resume with the original image
and tool context and a different thinking level. It uses the normal `AGY_PATH`
and CLI environment. It does not change global model or proxy settings.

On Linux with real **agy 1.5.0**, this check passed with `gemini-3.8-flash`
and `gemini-4-argon`: each model identified the red test image, used the client
tool once, and remembered the image color and tool result after a new bridge
process resumed the same agy session. A separate control-plane probe verified ACP model
configuration switches between Gemini and Claude and thinking-level changes.
Neither model emitted a thinking summary in the checked first turn. An earlier
Argon attempt exceeded the 60-second ACP startup budget; the control-plane
probe and full integration retry passed without increasing that budget. The
cause of the earlier timeout is unresolved. Real quota reporting on 1.5.0
remains unverified: an earlier Google eligibility request returned EOF, and the
final quota-hook retry timed out within its 18-second budget. The parser and
host timeout budget are unchanged.

The ACP transport was verified on Linux with real agy **1.4.12** through the
plugin's fetch hook: thought summaries and text, a `tool_use → tool_result →
end_turn` round trip, an in-session switch from Gemini to Claude Sonnet 5.5 that
kept the conversation, cancellation followed by a continued turn, a tool added
mid-conversation via `list_changed`, a 50-second client tool with a 20-second
deadline (two repeat-call waits, one client execution), idle eviction
followed by `session/resume` in a new agy process, and a real restart (a new
Node process continuing the conversation from the state file). Not verified in the Magpie
GUI or with OpenCode end to end on this transport.

The quota hook was verified on macOS using real agy **1.4.7**, directly and
through the official **Magpie 0.1.1599 Bun host** in an isolated temporary
configuration. The earlier stream-json transport was verified with Magpie
0.1.1356/0.1.1564, agy 1.3.3/1.3.5 and OpenCode 2.1.2; those runs predate the ACP
transport.

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
  changes now use MCP `list_changed` instead of a rebuild/replay.

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
