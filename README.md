# opencode-antigravity-bridge

A [magpie](https://github.com/yetone/magpie) provider plugin that serves an
**Antigravity subscription through a real `agy` CLI process**, instead of
impersonating the Antigravity IDE over HTTPS.

## Why this plugin exists

Magpie's built-in Antigravity provider talks to Google Code Assist by
sending HTTPS requests with the Antigravity IDE's `User-Agent` header.
Google detects this impersonation and **bans the Google account** — the
same way Anthropic bans Claude accounts that call the API with a
subscription OAuth token directly.

The Claude subscription provider in magpie avoids this by running the real
`claude` binary and letting IT talk to Anthropic. This plugin applies the
same pattern to Antigravity: it keeps one
`agy --input-format stream-json --output-format stream-json` process per
conversation and translates between Anthropic Messages and agy's
stream-json protocol.

```
Client (Amp, Claude Code, ...)
  │  Anthropic Messages (POST /v1/messages)
  ▼
magpie gateway
  │  routed to the antigravity-bridge provider
  ▼
this plugin
  │  translates to agy stream-json
  ▼
real agy process
  │  Google-signed requests with the IDE's real identity
  ▼
Google Code Assist backend
```

Google only ever sees the real `agy` binary, so the account is safe.

## Requirements

- `agy` (Antigravity CLI) installed and **signed in interactively at least
  once** (`agy` caches the credentials).
- magpie with OpenCode-style provider plugin support.

## Install

From a local checkout (current state — not yet on npm):

```sh
magpie plugin add ./magpie-agy-bridge
```

## Use

1. Sign in to Antigravity through the plugin (Providers → Antigravity
   Bridge → Sign in). The plugin runs `agy models` to verify the CLI is
   signed in.
2. Pick a model (`gemini-3.7-flash-high`, `gemini-4-argon-medium`, …) for
   your agent in magpie. The list is read live from `agy models`, falling
   back to a curated list if the CLI is unavailable.
3. Talk to the agent as usual. Magpie routes the request through this
   plugin to the real `agy`.

## What works

- **Streaming responses** (translated from agy's `step_update` events to
  Anthropic SSE).
- **Multi-turn conversations** — the agy process is reused across turns of
  one conversation; a new conversation (or a crash) starts a fresh process
  with the full history replayed.
- **Reasoning effort** via the model id's `-low`/`-medium`/`-high` suffix.
- **Token usage reporting**, correctly de-cumulated per turn (agy's
  `result.usage` is session-cumulative).
- **Client tools**, by convention: client tool declarations are rendered
  into the prompt as a `TOOL_CALL <name> <json>` text protocol; agy's
  matching output lines become Anthropic `tool_use` blocks for the client
  to execute. Tool results come back on the next turn as `[tool result]`
  text.
- **Keepalive pings** on long turns; **proper error frames** (not silent
  truncation) when agy dies mid-turn.
- **Conversation pool**: at most 4 concurrent agy processes; idle ones are
  reaped after 10 minutes; a busy conversation refuses a concurrent turn
  with HTTP 503.

## What doesn't (by design)

- **Images and other non-text content.** agy's `--input-format stream-json`
  accepts text blocks only. A request containing an image/document is
  refused with a 400. If you need vision, use magpie's built-in Antigravity
  provider (and accept the ban risk) or another provider.
- **agy executing the client's tools.** That would require magpie's
  internal MCP callback channel, which is private to the built-in Claude
  bridge. Client tools work via the text convention above; the client runs
  them, agy doesn't.

  **Why client tools work differently here.** In magpie's built-in Claude
  bridge, the `claude` process calls client tools through a private MCP
  channel that synchronously returns results mid-turn — the tool call and
  its result happen inside a single HTTP request. That channel lives in
  the Go gateway and isn't available to npm plugins. This plugin uses a
  text convention instead: agy writes `TOOL_CALL name {json}` as a line of
  output, the plugin converts it to an Anthropic `tool_use` block, the
  client executes it, and the result comes back on the next turn.
  Functionally equivalent, just one extra HTTP round-trip per tool call.
- **Multiple Google accounts.** agy reads exactly one sign-in from
  `~/.gemini/antigravity-cli`; there is no `AGY_HOME` env var
  ([google-antigravity/antigravity-cli#155](https://github.com/google-antigravity/antigravity-cli/issues/155)).
  Signing in again replaces the previous one.
- **Automatic agy installation.** Install Antigravity CLI yourself.

## Development

```sh
# Syntax check
node --check index.mjs

# Smoke test: uses a fake agy binary to exercise the process pool, the
# Anthropic SSE translation, TOOL_CALL conversion, mid-turn death, and
# image refusal. 15 checks.
node test-smoke.mjs
```

## License

MIT
