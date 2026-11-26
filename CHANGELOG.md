# Changelog

## 0.9.4

- Recognize Codex CLI and Magpie compaction summaries (`Another language model started to solve this problem...`) alongside Claude Code summaries, split assistant-less post-compaction `replacement_history` turns into replayable history + trailing turn, and proactively omit superseded older compaction summaries even below the 180 KB ACP prompt ceiling while keeping opening context, the latest summary, and the active turn intact.
- Recognize stock Codex / Magpie checkpoint compaction requests (`You are performing a CONTEXT CHECKPOINT COMPACTION...`) for `<180 KB` fragment staging without weakening exact-prompt anti-injection checks.

## 0.9.3

- Return agy’s standalone quota and model-capacity warnings as structured 429 and 503 errors. Magpie can try the next routing candidate when the warning arrives before any answer text.

## 0.9.2

- Sign an existing named account in again from **Add a Google account** or **Import an account** by entering its name (case-insensitive). Only its credential file is replaced, staged in the same folder and renamed over the old one; conversations, settings and logs stay, and any failure keeps the previous credential. Previously an existing folder refused the name, so an account whose Magpie row had been removed could not be added back. Manifest imports still never overwrite.
- After a sign-in again, drop that account's cached catalog, ACP probes, quota reader and dead-sign-in mark, and stop its idle agy processes so the next request uses the new credential; a response in progress finishes first.
- Add `agy-bridge accounts remove <name>` (Magpie removes only its own row and does not notify plugins) and `agy-bridge accounts replace <name> <source>`. Symlinked folders and credentials are unlinked or refused, never followed.
- Report a missing or invalid account profile as needing sign-in: usage returns `signIn: "expired"`, listings throw with `signIn: "expired"`, and requests answer `X-Magpie-Sign-In: expired`, so Magpie marks the row instead of showing a bare read failure.
- Only the single-account import form may replace an existing account's credential; a manifest that happens to hold one entry still refuses the name.
- A catalog read that began before a sign-in again cannot publish its list afterwards (per-account generation guard), so request routing never uses the old credential's models. The caches are invalidated before the credential swap as well as after, and every scope that names the account (`agy:<name>` and `dir:<path>`) is cleared, not just one of them.
- Match a named account case-insensitively when clearing its state and retiring its processes, the same way account names are unique.
- Retry the `resume append` protocol test once when its fixture child exits before starting a session, a spawn flake seen on loaded Windows runners (and on `main`'s jobs) rather than a protocol result.
- Drop a name's cached catalogs and probes after every successful sign-in or import, including one that creates a profile afresh: a profile deleted and signed in again under the same name keeps the same account key, so it must not serve the previous credential's models for the cache's lifetime.
- Serve each account's `agy models` catalog from a 10-minute cache with one shared background refresh, bounded first wait and last-good retention on failure. Each listing previously started a cold CLI per account (7.5–8.5 s measured), which with quota reads approached Magpie's per-listing budget.
- Sweep hidden `.login-*`, `.import-*` and `.removed-*` staging folders older than an hour on plugin start and before a sign-in or import.

## 0.9.1

- Declare a 512,000-token context window to Magpie and OpenCode for the official agy CLI, bounded by smaller model limits. Require a selected, verified managed unlock for larger windows, up to the model's physical limit (maximum 1,048,576); model metadata and `AGY_BRIDGE_CONTEXT_WINDOW` can no longer bypass the official ceiling. Keep GPT-OSS capped at 131,072.
- Handle agy 1.5.8+ ACP `usage_update` notifications as context occupancy diagnostics, including updates outside active turns, without counting them as billable per-call usage. Report upstream physical capacity separately from the client declaration.
- Share context policy between the provider and settings page, and update bilingual context controls and documentation for the 512K default and optional larger-window unlock.

## 0.9.0

- Register hook-defined providers in the OpenCode 2.x adapter and contain failed sign-in callbacks. Bound and cancel installer version checks, route archive/file errors to the caller, and preserve the working Windows binary on replacement or rollback failure.
- Isolate fake-ACP and timeout fixtures from host sign-in/keychain state and background metadata/update requests on every platform.
- Give native Windows sign-in fixtures their required OS environment, verify auth failures after version probing, and track model-probe lifetimes independently of reused process IDs. Increase only the fixture handshake deadline for busy CI runners.
- Preserve latest main's Pi-Bolt/Claude Code prompt rewrites and client-cancel recovery. Review fixes keep original submission guards after later prompt rejections and require output from each compaction fragment and the final summary.
- Treat retry-notice-only output as an empty failed response, while preserving uncorroborated terminal quotations and successful recovery output.
- Isolate optional CloudCode credential reads from WSL and test/mock default profiles, add `AGY_BRIDGE_CLOUDCODE_METADATA=0`, honor metadata cache TTL and preserve successful metadata after transient refresh failures. Account resets invalidate in-flight cache writes.
- Query CloudCode model metadata (`loadCodeAssist` / `fetchAvailableModels`) and known Antigravity limits so models report accurate `limit.context`, `limit.output`, image capabilities, and `reasoning` flags (`gemini-pro-orchestrator*`, `claude-opus-4-6-thinking`, 1M Gemini/Claude 5.5, 250K Claude 4.6, 65K image model).
- Prevent silent empty or failed `agy` turns from falsely returning HTTP 200 by checking `agy-acp.log`, notice state, delivered content, and SQLite step completion (`step_type=15`) before settling a turn.
- Remove bogus `1`-token floor in `responseUsage` for zero-output non-final steps and zero-estimate inputs.
- Add client tool-budget capping (`tool-budget.mjs`) to protect small-window OpenCode / IDE callers from oversized `tools[]` definitions and map `ideToolOf` tool call names cleanly.
- Incorporate `agy-cli` 0.1.55–0.1.64 parity updates: `cloak.mjs` DeepSeek Harness / Claude Code CLI rules, pre-spawn stored sign-in health & `storedEmail` naming (`signin.mjs`), `Symbol.for("magpie.fellBack")` fallback signaling, explicit `status: 400` in `streamErrorOf` (`plugins#1151`), managed fallback CLI installer & `auth.cli` (`install.mjs`, `ownAgyPath`, `X_OK` cache re-validation), `run_command` `toolSummary` deduplication (`plugins#1174`), and glog startup diagnostic stripping / `invalid_grant` & structured failure handling in `usage.mjs` (`plugins#1177`).
- Deliver client system instructions in first-turn `<external_system_instructions>` by default (`AGY_BRIDGE_SYSTEM_APPEND=1` opt-in for `session/new` `systemPrompt.append`), track `systemAppend` in parked session compatibility, suppress `agy` 1.5.9 `⚠ RESOURCE_EXHAUSTED (code 429)` / attempt-1 refusal banners and fast-fail via `refuseTurn`, and avoid mislabeling sanitized 429 errors as `AGY_ERROR_PROMPT_GUARD_MATCHED`.
- Split the OpenCode 1.x / 2.x plugin entrypoint (`opencode.mjs` / `opencode2.mjs`) and expose `"."` -> `"./opencode2.mjs"` in `package.json` while keeping `main` as `"./index.mjs"`.

## 0.8.9

- Say interactive Claude Code's system prompt another way so Antigravity no longer answers it with `RESOURCE_EXHAUSTED (code 429)` whatever quota is left. Three passages are turned away on their own: the identity line `You are Claude Code, Anthropic's official CLI for Claude.` (now `You're …`, as the Agent SDK variants were already handled by prompt-guard), the `IMPORTANT: Assist with authorized security testing…` policy, and the `<pasted_content>` guidance. Small edits to the two passages are still turned away, so each is sent as an equivalent rewording that keeps every instruction; matching folds whitespace and invisible characters as before.
- Rewrite the Pi-Bolt opening identity to a neutral equivalent before sending system instructions to agy, preserving the surrounding persona, documentation paths, user/tool text and client-text session identities (#73).
- Let an identical retry after an acknowledged client cancellation request a full answer in the original live agy session without resubmitting the original prompt (#74). Require unchanged request context and no tool work, serialize competing retries, preserve the client's history view, and keep upstream failures, timeouts, dead sessions and cancelled compaction blocked.
- Clear cancelled-session references when eligibility ends and protect a claimed continuation from competing session mutations. Cover cancellation recovery and client-history reuse in the cross-platform fake-ACP suite.
- Track authentication-test child lifetimes with dedicated connections so Windows PID reuse cannot report unrelated processes as leaked fixture children.

## 0.8.8

- Recover oversized stock OpenCode compaction requests by sending ordered, UTF-8-safe history fragments within agy's per-prompt limit, then returning only the final summary (#65). Use a temporary tool-free session so pending tools keep their original owner; prevalidate the full bounded plan, suppress ingestion acknowledgements, and stop on cancellation or upstream failure. Ordinary oversized input is still rejected without truncation. Multi-fragment compaction uses additional model calls and remains subject to the configured total text budget and model context window.
- Match complete verified stock prompts so added or customized instructions retain ordinary execution. Compaction budget failures return terminal `prompt_budget_exceeded` errors without requesting another compaction.

## 0.8.7

- Recognize agy network and depleted AI credits failures, retain API/retry-log error evidence, and suppress invalid-output retry notices while preserving quoted text and recovered replies (#66).
- Replace zero-width system-prompt cloaking with equivalent wording across whitespace and invisible characters, remove standalone billing metadata, and reword path-reference guidance on system/developer/reminder outputs while preserving user text, tool payloads and session identities (#67).
- Release prior HTTP response payloads during multi-step tool turns and hash nested tool-result images in session identities, reducing memory retained by screenshot loops while preserving late-result usage estimates (#68). Previously parked sessions containing tool-result images replay once after this identity-format change.
- Isolate smoke tests from saved account profiles and verify separate-session replay for complete unmatched tool histories while preserving the surviving branch.
- Add a project Coding Hub with OpenCode routing, isolated delegation, and repository-specific validation rules.

## 0.8.6

- Frame Claude Code compaction requests as summary-only. When the client appends its compaction instruction to a still-unanswered prompt, the history footer and a closing reminder now ask for the summary and record the question as pending work, instead of "Answer the current turn", whose answer would be lost in the discarded compaction reply.

## 0.8.5

- Allow once for permission requests identifying advertised client MCP tools, while continuing to reject agy's built-in tools. This addresses tool calls stopped by agy 1.5.8 permission checks (#63).

## 0.8.4

- Restore capability-advertised system append on every native agy 1.5+ resume, without repeating instructions in user turns or accumulating append text. Preserve older ACP behavior.
- Bound configuration RPCs on all supported versions with `AGY_BRIDGE_CONFIG_TIMEOUT_MS` (default 30 seconds). Native agy 1.5+ also waits for the matching session notification before applying effort or sending a prompt. Missing confirmations return retryable HTTP 503, contradictory notifications return HTTP 502, and waits are cleaned up on failure or shutdown. Retain legacy model fallback only for an unsupported method.
- Add production-provider/fake-ACP protocol regressions and run them in the existing cross-platform CI matrix, including Windows Node 22 and checkout paths with spaces.

## 0.8.3

- Host the self-contained bilingual product page on GitHub Pages through a dedicated Actions workflow that uploads only `docs/index.html`. Link the live site from both READMEs and keep README links working when the page is hosted or its language changes.

## 0.8.2

- Make OAuth-retry fixtures run on native Windows using a `.cmd` launcher and Node's executable for the production MCP adapter, with process shutdown before temporary-file cleanup. Decode compat fixture file URLs with `fileURLToPath`. Run both suites in three-platform CI and add Windows Node 22 coverage alongside Node 24.

## 0.8.1

- Recover the context settings service after a Magpie hot update overlaps old and new plugin hosts. Wait in the background when the port belongs to a previous Bridge service, including 0.8.0, then take over after it closes. Keep model requests responsive and stop retrying unidentified applications after a bounded startup check.

## 0.8.0

- Add an Antigravity Bridge context entry to Magpie's Provider menu and sidebar. Choose the default or managed unlock, review and confirm, follow background execution, retry failures, and restore default without deleting copies. Show saved, verified and running modes separately, including restart requirements and context overrides. WSL remains read-only for this native patcher.
- Run blocking context verification and patching outside the shared plugin host, with a loopback-only service, capability-protected actions, allowed frame ancestors and a shared command deadline. Clean only a terminated task's own temporary copy. Official agy and existing sessions keep their original behavior until the user applies a new selection.
- Redesign the Chinese and English READMEs and add a self-contained bilingual product page with synthetic account routing and cache illustrations. Document historical token/cache measurements with their conditions and distinguish declared context windows from verified capacity.

## 0.7.1

- Fix model discovery by running the CLI catalog and a bounded 10-second ACP wait concurrently. Serve successful cached models during refresh, throttle failed probes, keep the full CLI catalog when ACP is unknown, and prefer live session handshakes over older probes.

## 0.7.0

- Expose named Google profiles as separate native Magpie account rows sharing ordinary model IDs. Bind requests, model discovery, sessions and quota to the account selected by Magpie, enabling its existing account preferences and routing.
- Add “Use a saved Bridge account” to register existing profiles without Google authorization. Keep the original `agy` default account and all profile credentials; signing out removes only the host registration. UI imports and Google sign-in now register individual native accounts, including manifest imports.
- Fail closed when a selected profile is missing, its reference is invalid, or a legacy model prefix names another account. Keep account-prefixed catalogs for OpenCode and default-account-only behavior for Windows-to-WSL mode.

## 0.6.5

- Fix #49: raise the default `AGY_BRIDGE_TURN_TIMEOUT_MS` from 2 to 10 minutes, so a large tool call that agy generates silently (for example a ~40 KB `Write`) is no longer cut off at 120 seconds. The cost is slower stall detection: a truly silent or metadata-only turn now fails after 10 minutes. The bridge still cannot detect tool-argument generation progress, and clients or gateways keep their own deadlines. Explicit overrides, the 30-minute tool-result wait, cancellation cleanup and the no-replay rule for submitted prompts are unchanged.

## 0.6.4

- Filter standalone agy retry and terminal notices while preserving quoted model text; corroborate terminal failures with this prompt’s log or an abnormal result.
- Preserve the latest real user task and paired tools during replay trimming; reject protected content that exceeds the prompt budget.
- Classify FAILED_PRECONDITION as a non-retryable rejected request and document a finite timeout workaround for silent tool argument generation.

## 0.6.3

- Recover from agy's mid-session OAuth expiry. A long-lived `agy acp` process does not refresh its access token inside a session, so after about an hour its first model call fails with `UNAUTHENTICATED (code 401)` and the turn ends. When that happens before anything is streamed or any tool is called, the bridge now drops the process, parks the session with its pre-turn history, and replays the same request once on a fresh process, which loads the refreshed token file and resumes the same agy session. A second 401 is returned as `upstream_unauthenticated` (502). 401 is classified separately from 403 and is never retried on the same process.

## 0.6.2

- Declare native named-account support so Magpie offers an add-account entry and stops warning that another Google login replaces existing accounts. Keep the single-account declaration in WSL mode.
- Keep one Bridge connection through the shared `agy` sentinel; verify CLI validation, account/manifest imports and OAuth completion against Magpie's real host with synthetic credentials.
- Keep English and Chinese plugin summaries within Magpie's 300 UTF-8 byte limit and document the account-name step before the browser opens.

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
