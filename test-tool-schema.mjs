import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeInputSchema } from "./tool-schema.mjs"

const supported = new Set(["type", "title", "description", "format", "pattern", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "default", "enum", "properties", "required", "items"])
function assertCompatible(schema) {
  assert.ok(["object", "array", "string", "number", "integer", "boolean"].includes(schema.type))
  for (const key of Object.keys(schema)) assert.ok(supported.has(key), `Unsupported keyword ${key}`)
  if (schema.items) {
    assert.equal(schema.type, "array")
    assert.equal(Array.isArray(schema.items), false)
    assertCompatible(schema.items)
  }
  if (schema.properties) {
    assert.equal(schema.type, "object")
    Object.values(schema.properties).forEach(assertCompatible)
  }
  for (const key of schema.required || []) assert.ok(Object.hasOwn(schema.properties, key))
}

test("nullable unions always emit a scalar type and retain null semantics", () => {
  const schema = sanitizeInputSchema({ type: "object", properties: {
    path: { type: ["string", "null"] },
    offset: { anyOf: [{ type: "integer" }, { type: "null" }] },
    value: { oneOf: [{ type: "string" }, { type: "number" }] },
    absent: { type: "null" },
    nullArray: { type: ["null"] },
  } })
  assertCompatible(schema)
  assert.equal(schema.properties.path.type, "string")
  assert.match(schema.properties.path.description, /null/)
  assert.equal(schema.properties.offset.type, "integer")
  assert.match(schema.properties.offset.description, /null/)
  assert.match(schema.properties.value.description, /string \| number/)
  assert.match(schema.properties.absent.description, /Must equal: null/)
  assert.match(schema.properties.nullArray.description, /Must equal: null/)
})

test("object alternatives keep every property and require only common fields", () => {
  const schema = sanitizeInputSchema({ anyOf: [
    { type: "object", properties: { mode: { const: "file" }, path: { type: "string" } }, required: ["mode", "path"] },
    { type: "object", properties: { mode: { const: "text" }, text: { type: "string" } }, required: ["mode", "text"] },
  ] })
  assertCompatible(schema)
  assert.deepEqual(Object.keys(schema.properties), ["mode", "path", "text"])
  assert.deepEqual(schema.required, ["mode"])
  assert.deepEqual(schema.properties.mode.enum, ["file", "text"])
  assert.match(schema.description, /anyOf constraints/)
})

test("allOf combines required fields and intersects bounds on repeated properties", () => {
  const schema = sanitizeInputSchema({ allOf: [
    { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 20 } }, required: ["count"] },
    { type: "object", properties: { count: { type: "integer", minimum: 5, maximum: 10 }, path: { type: "string" } }, required: ["path", "missing"] },
  ] })
  assertCompatible(schema)
  assert.deepEqual(schema.required, ["count", "path"])
  assert.equal(schema.properties.count.minimum, 5)
  assert.equal(schema.properties.count.maximum, 10)
})

test("local references resolve before definitions are removed and preserve sibling constraints", () => {
  const input = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { "Options/a~b": { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    definitions: { Count: { type: "integer", minimum: 1 } },
    properties: {
      options: { $ref: "#/$defs/Options~1a~0b", description: "Search options" },
      count: { $ref: "#/definitions/Count", maximum: 10 },
    },
  }
  const original = structuredClone(input)
  const schema = sanitizeInputSchema(input)
  assertCompatible(schema)
  assert.equal(schema.properties.options.properties.path.type, "string")
  assert.deepEqual(schema.properties.options.required, ["path"])
  assert.match(schema.properties.options.description, /Search options/)
  assert.equal(schema.properties.count.minimum, 1)
  assert.equal(schema.properties.count.maximum, 10)
  assert.deepEqual(input, original)
})

test("allOf can require properties declared only by a sibling branch", () => {
  const schema = sanitizeInputSchema({ allOf: [
    { type: "object", properties: { path: { type: "string" } } },
    { required: ["path", "missing"] },
  ] })
  assertCompatible(schema)
  assert.deepEqual(schema.required, ["path"])
})

test("recursive and unresolved references terminate with explicit hints", () => {
  const schema = sanitizeInputSchema({ type: "object", $defs: {
    Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
  }, properties: {
    head: { $ref: "#/$defs/Node" },
    remote: { $ref: "https://example.com/schema.json" },
    missing: { $ref: "#/$defs/Unknown" },
  } })
  assertCompatible(schema)
  assert.match(schema.properties.head.properties.next.description, /Recursive schema/)
  assert.match(schema.properties.remote.description, /Unresolved schema reference/)
  assert.match(schema.properties.missing.description, /Unresolved schema reference/)
})

test("reference expansion is bounded for deep and exponentially shared schemas", () => {
  const $defs = { End: { type: "string" } }
  for (let i = 0; i < 40; i++) $defs[`Node${i}`] = { type: "object", properties: {
    a: { $ref: i === 39 ? "#/$defs/End" : `#/$defs/Node${i + 1}` },
    b: { $ref: i === 39 ? "#/$defs/End" : `#/$defs/Node${i + 1}` },
  } }
  const schema = sanitizeInputSchema({ type: "object", $defs, properties: { root: { $ref: "#/$defs/Node0" } } })
  assertCompatible(schema)
  assert.match(JSON.stringify(schema), /Schema expansion limit/)
  assert.ok(JSON.stringify(schema).length < 500_000)
})

test("tuple arrays and dictionary schemas become compatible shapes with constraint hints", () => {
  const schema = sanitizeInputSchema({ type: "object", additionalProperties: false, properties: {
    tuple: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false },
    legacy: { type: "array", items: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "integer" } } }] },
    empty: { type: "array", items: [] },
    dictionary: { type: "object", additionalProperties: { type: "integer" }, patternProperties: { "^x": { type: "string" } } },
  } })
  assertCompatible(schema)
  assert.match(schema.description, /additionalProperties: false/)
  assert.match(schema.properties.tuple.description, /Tuple positions/)
  assert.equal(schema.properties.legacy.items.properties.b.type, "integer")
  assert.match(schema.properties.dictionary.description, /additionalProperties/)
})

test("mixed nested alternatives cannot leave array or object fields on scalar schemas", () => {
  const schema = sanitizeInputSchema({ anyOf: [
    { type: "object", properties: { value: { type: "string", minLength: 2 } } },
    { type: "object", properties: { value: { type: "array", items: { type: "number" } } } },
  ] })
  assertCompatible(schema)
  assert.equal(schema.properties.value.type, "string")
  assert.equal(schema.properties.value.items, undefined)
  assert.equal(schema.properties.value.minLength, undefined)
})

test("numeric enums and constants become hints, string constants become enum", () => {
  const schema = sanitizeInputSchema({ type: "object", properties: {
    numeric: { type: "integer", enum: [0, 1, 2] },
    empty: { type: "string", enum: [""] },
    constant: { const: "fixed" },
    numericConstant: { const: 7 },
    boolean: false,
  }, required: ["numeric", "missing", "numeric"] })
  assertCompatible(schema)
  assert.match(schema.properties.numeric.description, /Allowed values: 0, 1, 2/)
  assert.equal(schema.properties.empty.enum, undefined)
  assert.deepEqual(schema.properties.constant.enum, ["fixed"])
  assert.match(schema.properties.numericConstant.description, /Must equal: 7/)
  assert.deepEqual(schema.required, ["numeric"])
})

test("ordinary supported schemas preserve descriptions, bounds and defaults without mutation", () => {
  const schema = { type: "object", properties: {
    name: { type: "string", description: "Name", minLength: 1, pattern: "^a", default: "alice" },
    count: { type: "integer", minimum: 1, maximum: 10 },
  }, required: ["name"] }
  const output = sanitizeInputSchema(schema)
  assert.deepEqual(output, schema)
  assert.notEqual(output.properties, schema.properties)
})
