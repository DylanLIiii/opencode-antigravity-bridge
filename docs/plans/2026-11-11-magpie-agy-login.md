# Magpie agy Login Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Magpie browser sign-in method that saves an independent agy account for ACP use.

**Architecture:** A native `oauth` method asks for an account name and owns one `agy acp --login` process in a hidden staging profile. Magpie opens its authorization link and accepts the code or complete callback URL. agy owns PKCE, token exchange and refresh; the bridge validates callback identity and publishes only a validated credential through the existing import backend.

**Tech Stack:** Dependency-free Node/Bun ES modules, child-process pipes, Magpie `auth.methods`.

---

## Decisions and evidence

- User approved implementation in a separate worktree. Start from `origin/main` (`d93a6e6`, package 0.4.1); release this feature as 0.5.0.
- Local agy 1.5.4 advertises `acp --login`, `--gemini_dir` and `--app-data-dir`. An isolated, browser-blocked probe emitted a Google authorization URL with S256 PKCE, state, and `redirect_uri=https://antigravity.google/oauth-callback`. Its prompt accepts a code or full URL. No login or token exchange was performed.
- Use Magpie's `method: "code"` flow. The hosted official callback requires a paste; claiming automatic localhost completion would be incorrect for this CLI. Reimplementing Google's OAuth client would add client/scope/refresh compatibility work. Driving the interactive TUI would add terminal parsing. The dedicated login command avoids both.
- Keep the existing `single: true` sentinel and account/model prefix routing. Add the new method without shifting existing method indices. No Magpie fork, global keyring writes, default-account mutation, or credential copy into Magpie's auth store.
- Stage under the account root with 0700 permissions, force agy's file-storage mode for login and probes, suppress CLI browser launching, and pipe input as data. Publish via `importAccount()` only after agy exits successfully, a refresh token exists and the isolated models probe succeeds. Imported credentials are 0600. Existing names remain protected, including collisions during a pending login.
- Full callback URLs must match the original redirect origin/path and state; accept a raw code as the CLI does. Never fetch pasted URLs or echo child output, tokens, codes or OAuth errors. Bound URL/output sizes and process lifetimes. Cancellation during RPC work and a newer sign-in clean up the process and staging directory. A paste flow has no host RPC waiting between its steps, so an abandoned flow also needs its own expiry.

## Tasks

1. Add `test-accounts-login.mjs`: synthetic child processes exercise native method contract, chunked URLs, callback/state validation, raw-code completion, publication permissions, probe/CLI failures, timeout/cancellation, replacement, collisions and secret redaction. Run it before implementation to confirm it fails.
2. Add `accounts-login.mjs`: native OAuth method factory, bounded child lifecycle, official URL parsing and staging/import transaction. Run the new tests and the existing account-import/platform tests.
3. Wire the method into `index.mjs`, invalidate account/catalog caches on publication, and extend native-form smoke coverage without weakening existing assertions.
4. Update `package.json` to 0.5.0 and include the new module/test command. Update both READMEs and `CHANGELOG.md` with the UI steps, paste behavior, isolation and lifecycle limits.
5. Run all Node suites and smoke checks, compare any failures with the untouched base, run `git diff --check`, and verify the packed package contains and can load the login module. Perform an isolated real-CLI authorization-link/cancellation probe without signing into an account.

## Acceptance

A Magpie user can name a fresh account, open Google's sign-in page, paste the final address or code and receive a successful sentinel sign-in only after the named credential is usable. The account becomes visible as `<name>/<model>`, and existing per-account ACP process and usage isolation apply. Every unsuccessful path leaves existing accounts intact and publishes no new account. Live Google account exchange and GUI clicking require a separate manual run and must not be claimed as tested.

## Verification

- Final `npm test`: all Node suites have 199 passed, 1 skipped and 0 failed (200 tests), followed by the smoke result below. The command still exits 1 because of the pre-existing smoke failures.
- 34 synthetic login tests pass under Magpie's bundled Bun 1.4.4. Coverage includes native Windows batch/env handling through an injected child, concurrent attempts, changing account roots mid-login, malformed callbacks, cancellation and expiry. Native Windows/Linux login has not been exercised.
- Smoke: all eight new checks pass, including callback publication, immediate model discovery, ACP profile routing and quota aggregation. All 12 failures out of 680 checks exactly match a separately extracted, untouched `d93a6e6` main baseline (12 failures out of 672), by assertion name; no existing assertions were relaxed.
- The implemented method was exercised with real agy 1.5.4 in an isolated temporary account root. It extracted the official authorization link with S256/state, rejected a synthetic callback with the wrong state, and removed all staging entries. No Google account was authorized and no credential was exchanged.
- An actual `npm pack` contains `accounts-login.mjs`; the unpacked 0.5.0 package loads and advertises the native OAuth method. Installed Magpie 0.1.3734 host source confirms the prompts, code callback, cancellation context and sentinel-only save contract.
- `git diff --check` passes. A live GUI/Google exchange and subsequent refresh remain manual validation.
