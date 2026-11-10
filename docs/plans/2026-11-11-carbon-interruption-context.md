# Carbon interruption and user-input truncation

## Evidence

Read-only copies of recent AGY conversation stores and bridge events showed:

- Installed bridge 0.3.1, AGY 1.5.4, model `gemini-4-carbon-high`.
- At 2026-11-11 00:09:42 +08:00, a replay submitted 389,762 text bytes including
  session instructions and four images. The stored user message contained the
  complete current turn. The model input retained a 192,000-byte rendered prefix
  and appended `<truncated 152637 bytes>`.
- At 00:11:17, a tool-result request with interruption triggered
  `interrupted_tool_turn` after about 50 seconds of client tool wait. A replacement
  session submitted 411,890 text bytes. Its model input had the same retained
  prefix and `<truncated 174765 bytes>`, dropping the new instruction as well.
- The default deferred deadline is 150 seconds. The logged 50-second wait does
  not establish that this particular replay was caused by deferral; the old
  event does not distinguish history mismatch, incomplete results, and deferral.
  Deferred steering was independently reproduced as another replay trigger.
- These requests fit the bridge's 1 MiB total budget. The model's context window
  and AGY's per-user-step truncation are separate constraints. This evidence
  does not establish that every interruption or every model loses context.

No user prompts, tool contents, credentials, or conversation-store copies are
included in the repository.

## Decisions

Preserve compatible sessions for complete deferred tool-result batches. Deliver
the available results, cancel and settle the old turn, and submit the new
instruction with its results in that session. If the old turn was waiting for
late results after ACP completed, end that wait without creating another prompt
or retaining duplicate unsent input. Include earlier deferred results that have
been accepted but not yet delivered upstream.

Keep the existing configurable total submission budget. Add a separate
180,000-byte ceiling on ACP user-input text, reserving 1,024 bytes per image for
upstream labels and URIs. Apply it to replay, native continuation, steering,
combined unsent input, and deferred result prompts. Preflight before consuming
results or replacing a session. Historical-result omission remains the existing
replay fallback; if the replay still exceeds either limit, ask the client to
compact. Already compacted Claude Code histories get `prompt_budget_exceeded`
without the reactive-compaction phrase.

Simply raising the bridge budget cannot prevent the upstream cut. Moving the
current instruction to the beginning would still silently lose history. No
supported ACP setting to raise the per-user-step limit was established; the
CLI rejected `--override-cascade-config-fields`. The conservative ceiling is
therefore enforced independently of the configurable total budget.

## Validation

The old implementation failed the new replay-budget regression and the deferred
steering smoke scenarios (ordinary steering and explicit interruption, with AGY
either polling or no longer waiting). Tests cover UTF-8 byte counting, combined
text blocks, image-label reserves, installed system instructions, already
compacted input, rejection before session replacement/result delivery, and
subsequent use of the preserved session. The real CLI integration also delays
the tool result beyond its MCP deadline and asks for both an earlier session
code and the tool-result code after steering.

`npm test` passed: 100 unit/compatibility tests and 494 smoke checks. The real
carbon integration was attempted but stopped at `session/new` with
`Authentication required`, before any model request. Real-model validation of
the change remains outstanding. Existing user sessions and the installed plugin
were not replaced by these checks.
