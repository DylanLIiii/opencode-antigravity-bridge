# Changelog

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
