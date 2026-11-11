# 2026-11-11 Account import, optional context unlock, leaner prompts (0.4.0)

## Decisions

- **Import** reuses the existing named-profile layout (`<root>/<name>/antigravity-cli/antigravity-oauth-token`,
  routed by the `<name>/` model prefix and `--gemini_dir`). Magpie keeps its single
  `agy` sentinel (`single: true`); no extra host identity per account. The UI uses
  Magpie's native `auth.methods[].prompts` (text) + `authorize(inputs)` (verified in
  Magpie v0.1.3734 `host.js`); the CLI and the forms call `importAccounts()`.
  No overwrite/`--force`: a collision is an error (an overwrite would have to deal
  with live pooled sessions bound to the old credential).
- **Context unlock** is CLI-only and explicit. A copy of agy is patched, never the
  install; the plugin picks the copy at process start only while the manifest is
  enabled and its SHA-256s verify (size/mtime only cache an already-hashed file).
  Anything unexpected falls back to the official binary. Selecting the binary once
  per process is the whole lifecycle: no hot switching, so an active session, a
  pending tool result or native steering never changes context mode mid-flight.
  Three limits stay separate: the client-declared window (256K default, 512K with
  the copy, GPT-OSS 131,072), the bridge submission budget (1 MiB) and the
  official-agy per-user-step clamp (180,000 bytes, dropped only for the copy,
  whose gates 4A/4B remove it).
- **Prompts**: only bridge-owned scaffolding was shortened. Native ACP steering and
  session reuse are unchanged.

## Prompt scaffold UTF-8 bytes (`measure-prompt.mjs`, 10 call/result pairs)

| item | before | after |
| --- | --- | --- |
| per call/result pair | 755 | 331 |
| history preamble + 10 pairs total | 7883 | 3577 |
| working-directory note + wrapper | 323 | 222 |
| JSON-schema reminder (empty schema) | 237 | 176 |
| json_object reminder | 195 | 133 |

Bytes are UTF-8 bytes, not tokens.
