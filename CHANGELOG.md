# Changelog

## 0.6.1

- Clarify the Bridge's native account actions with short localized labels for existing CLI access, single-account import, manifest import and adding a Google account.
- Explain in the account forms that existing accounts are kept and a new name is required. Document the existing-account entry through Magpie's Sign in again chooser.

## 0.6.0

- Align ACP and SQLite usage accounting, cache estimates and read-only WAL handling with agy-cli 0.1.22; thinking is included once in output.
- Improve session identity, tool schema compatibility, model discovery, assistant prefill and system instruction compatibility while preserving native steering and account isolation.
- Keep the minimal agent enabled by default; `AGY_BRIDGE_MINIMAL_AGENT=0` disables it. Estimated cache usage is not a measured Google cache hit rate.
- Replay once when a tool catalog grows, and classify upstream `INVALID_ARGUMENT` as a redacted, non-retryable invalid request without claiming to identify its root cause.

## 0.5.1

- Fix #43 with explicit Windows-to-WSL agy launch mode, coherent ACP paths and host MCP interop; preserve native defaults and literal argv.
- Forward control environment variables bidirectionally and resolve Windows environment names case-insensitively. WSL mode uses only the distro default account and explicitly excludes host profiles/import, quota and context unlock.
- Add deterministic launch/path regressions and a simulated sign-in/models/ACP/MCP tool roundtrip; real Windows/WSL teardown remains unverified.

## 0.5.0

- Add **Sign in a new agy account with Google** to Magpie's native sign-in list.
  Name the account, authorize in the browser, and paste the final callback URL
  or authorization code into Magpie. The official `agy acp --login` owns PKCE,
  token exchange and credential format; the bridge checks full callback URLs
  against the original redirect and state. Current agy uses the hosted
  `antigravity.google/oauth-callback` page, so a paste is required.
- Keep new credentials in a private, hidden staging profile with file storage
  forced, without changing the default keyring login. Publish through the existing
  import backend only after successful login, a refresh-token check and an
  isolated `agy models` probe. Existing accounts are never overwritten. The host
  keeps only its `agy` sentinel; account/model routing and separate ACP process
  pools continue to use the named credential file. Successful login invalidates
  account and model caches.
- Bound output and input sizes, URL/completion/probe waits and total login life.
  Cancellation during a sign-in RPC, a newer sign-in, expiry and normal host exit
  clean up the owned process tree and staging profile. Closing the paste dialog
  between RPCs is observed on expiry or the next sign-in. Errors omit child output,
  codes and credentials. Add synthetic login/process regression coverage.

## 0.4.1

- Stop forwarding agy's internal conversation-title summarizer as thinking
  (#39). agy 1.5.5 reports that helper's reasoning as ordinary
  `agent_thought_chunk` updates in the user's own turn, so one turn could carry
  dozens of multi-kilobyte chunks that all began with the same summarizer prompt
  echo, flooding the transcript and collapsing prefix-keyed reasoning in clients.
  The bridge now suppresses a thought only when it both opens with the
  summarizer's `Thinking Process:` header and echoes its own step, goal and length
  instruction within the opening window, plus a bounded continuation region for
  the recognizable fields of that prompt when they arrive in a later chunk.
  Unrelated reasoning, including summary tasks without that signature, passes
  through.
  Streaming, thought signatures and the turn's activity timeout are preserved:
  suppressed chunks still count as agy output. `AGY_BRIDGE_KEEP_SUMMARY_THOUGHTS=1`
  forwards them again for diagnosis.
- Known limits: the filter is a content heuristic, because no native ACP source
  discriminator has been verified for these updates; a summary continuation that
  arrives mid-word, or without one of the prompt's distinguishing phrases, can
  still reach the client. A legitimate thought echoing the same signature can be
  suppressed; use the diagnostic override to inspect the unfiltered stream.

## 0.4.0

- Add native account import. Magpie's sign-in list now has "Import an agy
  account" and "Import several agy accounts from a manifest" forms (text prompts
  and `authorize(inputs)`), and the packaged `agy-bridge accounts import` CLI
  calls the same backend. Sources are an existing agy profile directory or an
  `antigravity-oauth-token` file on the Magpie host; a manifest is
  `[{"name","source"}]`. Everything is validated before the first write, imports
  are all-or-nothing, existing accounts are never overwritten, names reject
  traversal/reserved/colliding values, tokens are written `0600` in `0700`
  directories, and credentials are never printed. Keyring-wrapped
  (`go-keyring-base64:`) sources are unwrapped to native JSON. The accounts
  cache is now per accounts root.
- Add an optional, default-off context unlock: `agy-bridge context
  status|unlock|disable`. `unlock` copies the official agy into a bridge-managed
  directory and applies the pinned, SHA-256-checked
  [dsh-plugin-bundle](https://github.com/lili-luo/dsh-plugin-bundle/tree/0a90ec37c69430608084e33ebc2f891e328c9e89/agy-context-unlock)
  patch (MIT, see `vendor/agy-context-unlock`) to the copy only, re-checks all six
  gates, and records source/patcher/patched SHA-256, version and architecture.
  Selection verifies both source and copy hashes; the cache also tracks ctime.
  Published copies are immutable and reused by hash, failed manifest publication
  preserves the previous selection, and old copies remain until explicit purge.
  The official install is never modified; unknown or failing builds keep the
  default. Only while a verified copy is selected does the bridge declare a 512K
  client window and lift its own 180,000-byte ACP submission clamp
  (GPT-OSS stays at 131,072). The selection is made when Magpie starts. Upstream
  verified the patch only up to agy 1.5.3; no end-to-end long-context run was done
  here for 1.5.4 or any platform.
- Shorten bridge-owned prompt scaffolding without touching user, system, tool
  result, image or schema content: the historical tool-record caveat is stated
  once per record instead of twice (per call/result pair 755 -> 331 UTF-8 bytes),
  and the history preamble, working-directory note and structured-output
  reminders are shorter (before/after UTF-8 bytes in
  `docs/plans/2026-11-11-import-context-prompt.md`).

## 0.3.5

- Preserve per-step SQLite usage cursors across staggered parallel MCP tool
  calls from an already-measured model generation. Confirm after one poll tick
  that neither `steps` (`step_type = 15`) nor `gen_metadata` has advanced, then
  report zero incremental usage (`agy_sibling`) without waiting out the 1-second
  store timeout, recalibrating token ratios on zeros, or dropping
  `turn.stepCursor` before subsequent generations and `end_turn` reconciliation.

## 0.3.4

- Fix named accounts on Windows reusing the default sign-in. agy prefers the
  machine-global Windows Credential Manager over a `--gemini_dir` token file, so
  account processes, model catalog probes, and named-account usage probes now
  set agy's file-storage switch (`WSL_INTEROP`) and read the account's own
  `antigravity-oauth-token` (#33). A real WSL interop path is left untouched,
  and the default account keeps the global keyring.
- Document the Windows file-backed login flow, including the plaintext refresh
  token caveat, NTFS ACL guidance, and the separate-user/VM alternative when
  plaintext storage is unacceptable.

## 0.3.3

- Fix process-pool starvation with parallel subagents and abandoned tool waits
  (#29). Raise the default pool and Magpie concurrency limits to 16, with a
  positive-integer `AGY_BRIDGE_MAX_PROCS` override. Under pool pressure, prefer
  idle processes, then reclaim stale detached turns or detached tool waits with
  no client progress for `AGY_BRIDGE_DETACHED_EVICT_MS` (default 30 seconds).
  Protect attached, cancelling and steering turns, plus tool-result continuations
  awaiting catalog acknowledgment. Complete late tool-result history can replay
  in a replacement process, including reclaimed forks with a still-active root.
- Enable Windows quota queries with batch-file launch support, isolated account
  tokens, browser blockers, process-tree cleanup and temporary-directory retries
  (#30).
- Isolate background summaries that fork from an already answered tool step,
  preserving the primary session and its newer pending calls. Ignore answered
  calls when routing later requests, and allow complete results from a superseded
  sibling to replay independently without a new user instruction (#31).
- Fix post-compaction replay deadlocks in long tool-heavy sessions (#34). When
  full replay exceeds a budget, use compact, escaped tool records without
  repeated per-record caveats and with explicit omitted-result markers.
- If compact records still exceed a budget, omit the oldest complete exchanges
  with an explicit notice. Preserve opening context, compaction summaries, the
  latest exchange and the complete current turn, including pending tool results.
  This also lets client summarization requests proceed with bounded history.
  Both the 180,000-byte ACP ceiling (including image-label reserves) and total
  submission budget still apply; protected content that cannot fit is rejected.
- Limit compaction-loop suppression to summaries in the final eight messages,
  allowing sessions with older summaries to request client compaction again.

## 0.3.2

- Prefer AGY 1.5.0+ native steering by sending another prompt in the running
  session. Wait for both ACP requests before finishing the client response;
  deliver live results only through MCP and include undelivered deferred results
  with the instruction. Older versions, model changes and explicit concurrent-
  prompt rejections fall back to cancel/settle/prompt in the same session.
  Compatible ended or cancelling tool turns also continue without replay.
  Report the actual incompatible-context reason when replay is necessary.
- Preserve the AGY session when user steering or interruption accompanies a
  complete batch of deferred tool results, including tools AGY stopped waiting
  for. Keep earlier undelivered results and avoid a duplicate late-result prompt.
- Guard each ACP user prompt against AGY's independent input truncation limit.
  AGY 1.5.4 was observed truncating rendered user input at 192,000 bytes, dropping
  the latest instruction during carbon history replay. Use a 180,000-byte text
  ceiling with room for wrappers and image labels, separate from the configurable
  1 MiB total budget. Oversized replay tries historical-result omission, then
  rejects before replacing the session or accepting tools. Already compacted
  input keeps the non-looping `prompt_budget_exceeded` error.

## 0.3.1

- Fix an endless compaction loop in Claude Code after a history change (#27).
  Raise the default `AGY_BRIDGE_MAX_PROMPT_TEXT_BYTES` budget from 128 KiB to
  1 MiB, so a typical compacted history (often 250–350 KiB of UTF-8 text) can
  replay. A replay over budget now omits historical tool-result bodies before
  failing. An over-budget history that already holds a Claude Code compaction
  summary returns `prompt_budget_exceeded` without the "prompt is too long"
  wording, so the client does not compact again.

## 0.3.0

- Support multiple Antigravity accounts. Each named account is a full Gemini CLI
  directory under `~/.config/magpie-agy-bridge/accounts/<name>/` (override with
  `AGY_BRIDGE_ACCOUNTS_DIR`) containing its own `antigravity-cli/antigravity-oauth-token`;
  sign in per account by running `agy --gemini_dir=<dir>` once. Named accounts appear
  in the model catalog as `<account>/<model-id>` (display name prefixed `[account]`),
  start agy processes with `--gemini_dir=<dir>`, and keep conversations, parked
  session state, dedup keys and the local usage store isolated per account. The
  default account (agy's global sign-in) stays available without a prefix.
  Accounts need a file-based token and an agy that accepts `--gemini_dir`;
  keyring/ADC sign-in is machine-global and cannot be isolated per directory.
  The quota hook aggregates all accounts, labelling each window with `[account]`.

## 0.2.0

- Declare a conservative 256,000-token client context window, configurable with
  `AGY_BRIDGE_CONTEXT_WINDOW`, so hosts can plan compaction. Keep GPT-OSS within
  its 131,072-token physical window. Window declarations are independent of the
  per-submission text budget and require a separately verified upstream capacity.
- Prefer generation-time `gen_metadata` billing before client tools finish,
  retaining completed `steps` for older or unused-generation stores. Pin each
  turn to one source to avoid duplicate accounting, and reconcile final input
  with ACP totals before reporting measured usage.
- Emit bounded, content-free model usage diagnostics with actual input, cache,
  output, thinking and the separate local context estimate when available.

## 0.1.3

- Keep the AGY session when user steering accompanies a complete batch of live
  tool results. Deliver results once, cancel and settle the old ACP prompt, then
  submit the current results and queued instruction as a new prompt in that
  session, preserving results that AGY may otherwise mark as canceled.
- Check submitted UTF-8 text against a configurable 128 KiB budget. Oversized
  replay returns `context_length_exceeded` before replacing the existing session,
  so the client can supply a compacted history with the complete current turn.
- Trace session creation, resume, replay reasons and prompt sizes using bounded,
  content-free events. Add real-CLI and simulated regressions for steering and
  oversized-history recovery.

## 0.1.2

- Add a display name and English/Chinese descriptions for Magpie plugin cards,
  highlighting the official CLI approach to reducing impersonation-related
  account risk and token savings from lean prompts and session reuse.
- Update the package description to match the English UI summary.

## 0.1.1

- Preserve pending tools across sibling conversation requests and recover queued
  user messages and late fork results (#17, PR #20).
- Bound ACP upstream inactivity, improve timeout diagnostics and cleanup, and
  default bare Argon requests to medium effort (#18, PR #20).
- Delimit historical tool records and add optional historical-result omission
  during replay (#19, PR #20).
- Read the MCP server version from `package.json` so package and protocol metadata
  stay in sync.
