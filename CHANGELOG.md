# Changelog

## 0.1.1

- Preserve pending tools across sibling conversation requests and recover queued
  user messages and late fork results (#17, PR #20).
- Bound ACP upstream inactivity, improve timeout diagnostics and cleanup, and
  default bare Argon requests to medium effort (#18, PR #20).
- Delimit historical tool records and add optional historical-result omission
  during replay (#19, PR #20).
- Read the MCP server version from `package.json` so package and protocol metadata
  stay in sync.
