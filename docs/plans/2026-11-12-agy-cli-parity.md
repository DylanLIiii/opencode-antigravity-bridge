# agy-cli 0.1.22 Parity Implementation Plan

> **For the implementation agent:** Follow the available executing-plans workflow within this single assigned Worker. Do not create subagents or new execution sessions.

**Goal:** Align cache/session/usage and active compatibility capabilities with pinned agy-cli 0.1.22 while retaining this package's provider contract, account isolation and WSL support.

**Architecture:** Adapt specific upstream helpers and state transitions to the existing bridge. Keep native ACP steering, the account-aware Proc pool and WSL launcher; apply schema and system-text compatibility at the boundary. Treat measured usage and bounded estimates as different evidence sources, with no claim of a measured Google cache-rate improvement.

**Tech Stack:** ESM JavaScript, Node24, Bun1.4.2 SQLite, ACP stdio, existing host MCP transport and node:test fixtures.

---

## Inputs and invariants

- Local base `2bef52c62a4c9a68a8e98d6e338c3866aa69112d` (main, 0.5.1).
- Upstream `b829a5541ecc0790b05a63308447bf87e952efbe` / `packages/agy-cli` (0.1.22), sparse source at `artifacts/sources/magpie-plugins-b829a55` under the external project root.
- Use accepted survey **v2**, not rejected v1, plus `local-map-main.md` and `prompt-usage-before.json`. Upstream package tests pass14/14 with isolated HOME and Bun1.4.2; this is fixture evidence.
- Preserve provider ID/package exports/auth options, native account import/browser OAuth and context-unlock opt-in, forced child auto-update suppression, thought-filter and prompt-guard behavior, account-aware model/usage caches, standard WSL mode and its explicit unsupported-DB/profile limits.
- Preserve stronger local native `steerTurn`; do not replace it with upstream's older replay-only behavior. Tool results reach MCP once; external tools are not re-executed.
- User explicitly requires **minimal agent enabled by default**. Preserve `AGY_BRIDGE_MINIMAL_AGENT !== "0"`; explicit `0` disables it. This intentional difference overrides the upstream opt-in default and the earlier draft proposal. Add default-on and explicit-off behavioral regression tests.
- No reverted schema-budget shrinking. No real-account credentials, vendor network tests, merges, releases or deployments.

## Task 1: Correct cache and billed usage

Files: `index.mjs`, meaningful new `test-usage-settlement.mjs`/fixtures or existing compatible harness, `test-smoke.mjs`.

1. Add failing public-fetch cases for ACP output already containing thinking and small cache reads with large thinking. Example raw usage `{inputTokens:10000,cachedReadTokens:100,cachedWriteTokens:0,outputTokens:500,thoughtTokens:400,totalTokens:10600}` must yield uncached input10000, cache read100 and output500, with thinking detail400.
2. Port upstream promptUsage's shape check and at-least-thinking output floor; update the DB model-call sum too: per-row output is `Math.max(item.output,item.thinking)`, not their sum. Source evidence is the upstream 0.1.22 author's agy1.5.4 store/ACP observation. Add SQLite-backed HTTP settlement fixtures as well as exact ACP fixtures; do not call synthetic fixtures a live measurement.
3. Teach `lastCacheRatio` from every prompt with real input, including cancelled ones; distinguish unset from a learned zero. During an uncalibrated tool loop estimate the cached prefix using the **largest previous settled window**, never the sum of repeated windows. Retain bounded final estimates/replay clipping.
4. Add tests for recorded-zero ratio, cancelled prompt ratio, multi-tool new-result uncached input, duplicate settlement idempotence and nonnegative integer tokens.
5. Run focused Node tests; preserve log and first commit. Report concrete results within5minutes of starting implementation.

## Task 2: Port read-only SQLite and settlement safety

Files: `step-usage.mjs`, `index.mjs`, `test-step-usage.mjs`/new focused settlement tests.

1. Adapt upstream opener/query/immutable URI and pending-generation handling. Prefer Bun's SQLite read-only+URI numeric flags, finalize statements, timeout0; Node fallback remains read-only. Resolve absolute paths first and handle Windows/UNC file URIs.
2. Test checkpointed WAL without sidecars leaves none; a WAL appearing during immutable read causes a live reread; unreadable/locked DB is null, never fabricated zero. Use local fixture files only.
3. Reconcile per-call prompt totals, give zero to an already counted generation only with causal evidence and no pending/new output, and disable store trust after cancelled/fallen-back/incompatible reads so late rows cannot leak into later prompts. Preserve or replace local sibling cursors only with equivalent tests, including pending incomplete generation, late commit and final no-new-call cases.
4. Maintain account-specific conversation paths and the existing WSL DB-disabled guard. Run focused cases under **Node and actual Bun1.4.2**, available through `npm exec --yes --package=bun@1.4.2 -- bun ...`.

## Task 3: Stable cache-preserving conversation identity

Files: `index.mjs`, new `test-conversation-key.mjs`/history fixtures and existing compatibility/smoke cases.

1. Port upstream exact volatile opening stripping, stable whole opening key, ASCII-only tag index handling, and strict flattened continuation matching. Hash the complete normalized opening, enforce full prior opening+reply line boundaries, send only new tail once, and retain user/account/model/tool identity boundaries.
2. Adapt canonical tool-use-input matching for active and persisted/resumed sessions where needed; names and strong random IDs must still identify the same calls. Do not broaden foreign-account/session matching or weaken the existing recovered-route safety checks.
3. Exercise changing timestamps/billing headers, Unicode before reminder tags, flattened3+turn reuse, tool input defaults filled by client, persisted resume and negative cases (changed user, tool name/history/workdir). Assert session init count and exact prompt/tool-result bytes.
4. Keep native steering and fallback no-duplicate-execution regressions, including image/steer, rejected tool, cancelled turn and tools-grown replay. Update tool growth handling only where the researched active behavior is missing.

## Task 4: Tool catalog and schema compatibility

Files: `index.mjs`, `tool-schema.mjs`, adapted `re2-pattern.mjs`/`array-items.mjs`, focused tests, package files.

1. Emit `_meta["antigravity/alwaysLoad"]=true` for all tools/list entries, preserve other metadata and stored catalog/signature. A large valid tool schema must remain complete; do not shrink fields based on size.
2. Port active upstream RE2 translation/drop-with-hint and permissive/inferred array-items semantics around the existing sanitizer. Resolve original refs/compositions consistently; keep required keys, tool search, legitimate user schemas and original caller objects intact.
3. Add public tools/list plus unit coverage for unsupported patterns, nested arrays/unions, fallback depth, nullable/tuple schema and large declarations. Preserve existing schema tests.

## Task 5: Active upstream compatibility and catalog behavior

Files: `index.mjs`, adapted `cloak.mjs`, `upstream-error.mjs` if needed, focused catalog/compat/prefill/cloak tests.

1. Identify ACP client by **our package's name/version**; package.json stays the version source. Add upstream-compatible minimum agy version handling and bounded offered-model probe before the first actual prompt. Probe caches/single-flight/backoff are keyed by runtime/account; no fake prompt, credential fallback, pool exhaustion, leaked temp processes or WSL path regression.
2. Preserve the user-required default minimal agent; `AGY_BRIDGE_MINIMAL_AGENT=0` selects the non-minimal agent. Test default-on and explicit-off behavior. Document this deliberate difference from upstream's default; no default migration is made. Existing optional context unlock remains unchanged.
3. Port text-only assistant prefill with upstream opt-out and protocol restrictions, plus author-aware quoted/unclosed notice tag behavior. Add positive and negative public request cases; update the old prefill rejection assertion to the new authorized behavior, preserve lone assistant/live tool-result restrictions.
4. Port upstream system/developer line compatibility (cloak) only at transmission, including append, fallback rendered system instructions, replay and notices. Keep original text for identity/history and keep user text literal. Classify a matching system-prompt-specific429 as invalid request with helpful text, leaving real quota429 classification unchanged. Local prompt-guard/thought-filter still work.
5. Preserve native OAuth/account APIs; upstream single-account sign-in must not replace ours. Add account/WSL regressions around catalog discovery and method visibility.

## Task 6: Integrate, document and deliver

1. Check latest origin/main. Work only in assigned isolated worktree; before delivery verify `git merge-base --is-ancestor origin/main HEAD`. If main moved, ordinary merge with correct ancestry and affected validation; no content-only integration/force-push.
2. Bump package to **0.6.0** (unless newer main requires a different version), CHANGELOG and Chinese/English README. Add precise upstream SHA/derived-file MIT attribution in NOTICE and preserve contributors' copyright/license text. Add every runtime helper/NOTICE to packed files.
3. Save this plan at `docs/plans/2026-11-12-agy-cli-parity.md` in the worktree; update scope/results if a concrete implementation tradeoff is discovered, with Main notified.
4. Run affected tests, the complete Node suite and full smoke. Compare exact known12baseline failure names; report any new ones and fix real regressions, never weaken safety assertions for green. Run required SQLite/settlement under actual Bun and ensure new tests are included in package test/3OS CI where portable. No full monorepo tests needed.
5. Run `git diff --check`, actual npm pack, unpacked descriptor/server import and CLI help, and byte-compare all packed files to final head. Preserve logs in Run outputRoot and identify exact commands, versions and head. Publish no credentials/logs containing prompt tokens.
6. Commit a clean candidate and immutable implementation report plus per-feature parity matrix (implemented/preserved/deliberate difference, tests and limits). Main pins it for independent Sage review, applies any necessary fixes, then publishes a new PR and verifies3OS CI. Leave merging/release to the maintainer.

## Checkpoints and handoff

One Craft Worker owns the implementation, no recursive delegation. First actual regression result within5minutes, progress checkpoints8minutes, estimated35-45minutes implementation+verification. If no progress, give the exact obstruction and next concrete step, not repeated plans. Main independently verifies usage numbers and the protocol/account boundaries and reuses unchanged baseline evidence. Review is a separate Sage read-only task against exact base/head, not another implementation.
