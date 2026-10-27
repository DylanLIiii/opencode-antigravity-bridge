# Antigravity CLI quota design

Approved approach: query the ambient, signed-in `agy` using its structured
`-p /usage --output-format json` command and expose the result through Magpie's
`auth.usage(getAuth, provider)` extension. Do not read, copy, or persist Google
credentials or impersonate the IDE. The bridge remains single-account.

Alternatives considered: remote OAuth APIs (require credential ownership and
client impersonation), or localhost HTTPS probing (new agy releases gate it
behind an unavailable CSRF token). Neither is needed for this feature.

Quota windows retain each group, including model-specific allowances, and each
explicit cadence and reset. Missing fractions are unknown, never zero or full.
Disabled buckets are omitted. Windows are display-only (`aside: true`), so this
feature cannot unexpectedly change gateway routing. Token usage stays separate.
The CLI report contains no verified account/plan identity, so neither is invented
or borrowed from Magpie's separate Antigravity sign-in.

Use a private temporary workspace, a tools/MCP-free custom agent, failing browser
launchers, and per-child auto-update suppression. Gate print usage on agy >=
1.1.11 so old slash-command implementations cannot send `/usage` to a model.
Bound total query time (15 seconds by default, within Magpie's 20-second budget)
and combined output (1 MiB). Stop the owned process group and remove the workspace
on every outcome. Only concurrent reads share work; completed results are not
cached here, leaving freshness/account changes to agy and Magpie.

Diagnostics are fixed messages, not raw CLI output, URLs, emails, or tokens.
Errors preserve the bridge's sentinel sign-in (`signIn: kept`) because a quota
failure does not prove the bridge account was revoked. No global agy settings,
MCP configuration, installed plugins, or Magpie configuration are changed.

References (read-only):
- CodexBar `0aa34100b7a7ea397bcbf14eaab388d3f32aa4a1`,
  `AntigravityQuotaSummaryParser.swift`, `AntigravityProviderDescriptor.swift`,
  `AntigravityCLIUsageReportTests.swift`.
- Magpie `5b4dec58e47d1eb961f5a3f4417c441f77662c7d`, `internal/plugin/host.js`
  (`auth.usage` contract), `internal/provider/plugin_usage.go`, and
  `internal/provider/google.go` (shared quota groups and model-specific pools).
