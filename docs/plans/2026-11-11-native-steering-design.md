# Preserve AGY sessions across steering

The user wants native AGY steering first, same-session cancel/settle/prompt as
the next choice, and new-session history replay only when context cannot safely
continue. This extends the unreleased 0.3.2 fix; main is 0.3.1, so the existing
patch bump covers these changes.

## Protocol and ownership

AGY documents sending another `session/prompt` while a turn runs as steering
that turn. Support is documented from 1.5.0. Keep one bridge Turn for the
original prompt and injected prompts: ACP updates carry a session ID rather
than a prompt request ID. A steering acknowledgement may precede the remaining
output, or the original prompt may settle first. Drain all submitted requests
before producing the final client response. Keep submission deduplication for
each injected request, including cancellation and failures.

Queue the steering prompt before releasing the complete tool-result batch.
Deliver live MCP results once. Include only undelivered deferred results in the
new prompt and suppress their automatic late-result follow-up. Keep user images
and per-prompt byte limits. Apply a model change at a fresh prompt boundary using
the same-session cancellation path.

## Recovery order

1. AGY 1.5.0+ with the same model selection: overlapping prompt in the same session.
2. Older versions, model changes, or explicit rejection of concurrent prompts:
   cancel if still running, await settlement, then prompt in the same session.
   Repeat the current result batch on this path because AGY can replace a result
   with cancellation. Compatible already-ended turns also keep their session.
3. Actual history/instruction/workspace incompatibility or an unavailable session:
   existing bounded history replay, with the actual cause in diagnostics.

Do not use a fuzzy text threshold to accept changed tool results. Existing
structural normalization handles representation differences while preserving
branch identity. Do not retry on ambiguous transport, authentication, or model
errors: they do not prove the injected prompt was rejected before acceptance.

## Verification

Exercise both ACP reply orders, explicit rejection with same-session recovery,
non-retryable errors, legacy behavior, deferred delivery, live image/result
delivery without duplication, repeated steering, and concurrent client requests.
Run the existing unit and smoke suites. The opt-in real CLI test must distinguish
native steering from same-session cancellation; authentication remains a separate
prerequisite and mock results are not evidence of real-model correctness.

Sources:

- https://antigravity.google/docs/ide/extensions/acp/#work-with-the-agent
- https://agentclientprotocol.com/protocol/session-setup
- T3 Code commit 8ee7183e6c8a1c22a6698f4909ef7e2a423bec3a,
  `AntigravityAcpSupport.ts`, `CommandPolicy.ts`, `AcpSessionRuntime.ts`.
