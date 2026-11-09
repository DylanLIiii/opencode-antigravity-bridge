# Issue #14: tool schema and deferred-tool compatibility

The bridge must preserve the client's tool catalog while presenting schemas that
agy can translate to CloudCode function declarations. Keep agent isolation and
the existing MCP catalog refresh ordering.

## Implementation

- Extract the schema adapter to `tool-schema.mjs`, included in the npm package.
- Expand local references before dropping definitions; cap depth at 32 and visits
  at 2048 per tool. Recursive or unresolved references receive explicit hints.
- Emit scalar types, merge object alternatives with common required fields, and
  combine `allOf` required fields and bounds. Normalize tuple items. Keep
  unsupported constraints in descriptions rather than outgoing schema keywords.
- Supply `query` and `max_results` only for a declared `ToolSearch` whose schema
  is absent. Preserve explicit schemas and existing `tool_choice` restrictions.
- Continue exposing full deferred definitions received in `body.tools`; announce
  newly loaded tools before releasing the pending search result.

## Validation

Focused schema tests cover reference resolution, recursion bounds, unions,
compositions, tuples and input immutability. Compatibility tests cover search
fallbacks, explicit schemas, deferred definitions and tool selection. The fake
ACP/MCP smoke test loads and invokes a new tool in one live turn. The opt-in real
CLI integration test includes references, nullability and composition in its
tool declaration, so a successful native call also verifies schema acceptance.

## Limits

This adapter approximates JSON Schema and does not validate execution arguments.
The client remains responsible for validation and authorization. The bridge
cannot supply tool definitions that never arrive from the client. Real Windows
Claude Desktop and agy 1.5.3 require separate end-to-end validation.
