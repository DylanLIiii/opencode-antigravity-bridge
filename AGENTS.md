# Project conventions

## Version updates

- The maintainer requires a version bump with each project change PR. Include it
  before opening the PR; one bump covers all commits in that PR.
- Compare against the latest `main` version. Use a patch bump for fixes and
  maintenance; use an appropriate minor/major bump for features or breaking changes.
- Keep `package.json` as the source of the package version. MCP server metadata
  reads it automatically; do not introduce another hard-coded package version.
- Update `CHANGELOG.md` with the version and a concise description of the changes.
