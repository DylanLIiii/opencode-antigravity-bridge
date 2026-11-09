// ide-tools passes through agy's JSON Schema -> CloudCode Schema translator.
// Use a conservative subset here; the client remains responsible for validating
// real arguments. Constraints that cannot be represented become model hints.
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"])
const TEXT_FIELDS = ["title", "description", "format", "pattern"]
const NUMBER_FIELDS = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value)

export const TOOL_SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search for deferred tools by keyword, or use select:<tool_name>." },
    max_results: { type: "integer", description: "Maximum number of tools to return.", minimum: 1 },
  },
  required: ["query"],
}

function appendHint(node, hint) {
  if (!hint || node.description?.includes(hint)) return
  node.description = node.description ? `${node.description} (${hint})` : hint
}

function summarize(value) {
  const text = JSON.stringify(value)
  return text?.length > 1500 ? text.slice(0, 1500) + "…" : text
}

function cleanTypeFields(out, pruneRequired = false) {
  if (!out.type) return out
  if (out.type !== "array") for (const key of ["items", "minItems", "maxItems"]) delete out[key]
  if (out.type !== "object") {
    for (const key of ["properties", "required", "minProperties", "maxProperties"]) delete out[key]
  } else if (out.properties && pruneRequired) {
    const required = [...new Set(out.required || [])].filter(key => Object.hasOwn(out.properties, key))
    if (required.length) out.required = required
    else delete out.required
  }
  if (out.type !== "string") for (const key of ["minLength", "maxLength", "pattern", "enum"]) delete out[key]
  if (out.type !== "number" && out.type !== "integer") for (const key of ["minimum", "maximum"]) delete out[key]
  return out
}

// Alternatives share only common required fields; allOf requires their union.
function mergeSchemas(schemas, intersection) {
  const meaningful = schemas.filter(schema => Object.keys(schema).length)
  if (!meaningful.length) return {}
  if (meaningful.length === 1) return meaningful[0]
  const out = { ...meaningful[0] }
  const types = [...new Set(meaningful.map(schema => schema.type).filter(Boolean))]
  if (types.length) out.type = types[0]
  if (types.length > 1) appendHint(out, `Accepts types: ${types.join(" | ")}`)
  for (const schema of meaningful.slice(1)) appendHint(out, schema.description)

  const objects = meaningful.filter(schema => schema.properties)
  if (objects.length) {
    const keys = [...new Set(objects.flatMap(schema => Object.keys(schema.properties)))]
    out.properties = Object.fromEntries(keys.map(key => [key, mergeSchemas(
      objects.filter(schema => Object.hasOwn(schema.properties, key)).map(schema => schema.properties[key]), intersection,
    )]))
    const required = new Set(meaningful.flatMap(schema => schema.required || []))
    out.required = [...required].filter(key => intersection || meaningful.every(schema => schema.required?.includes(key)))
  }
  const arrays = meaningful.filter(schema => schema.items)
  if (arrays.length) out.items = mergeSchemas(arrays.map(schema => schema.items), intersection)
  for (const key of NUMBER_FIELDS) {
    const values = meaningful.map(schema => schema[key]).filter(value => value !== undefined)
    if (!values.length || (!intersection && values.length !== meaningful.length)) {
      delete out[key]
      continue
    }
    const lower = key === "minimum" || key.startsWith("min")
    out[key] = (lower === intersection ? Math.max : Math.min)(...values)
  }
  const enums = meaningful.filter(schema => schema.enum)
  if (enums.length && (intersection || enums.length === meaningful.length)) {
    const values = [...new Set(enums.flatMap(schema => schema.enum))]
    out.enum = intersection ? values.filter(value => enums.every(schema => schema.enum.includes(value))) : values
    if (!out.enum.length) delete out.enum
  } else delete out.enum
  // Branch-specific formats/patterns/defaults must not constrain every union arm.
  for (const key of ["format", "pattern", "default"]) {
    if (!intersection && meaningful.some(schema => JSON.stringify(schema[key]) !== JSON.stringify(out[key]))) delete out[key]
    else if (intersection && out[key] === undefined) {
      const source = meaningful.find(schema => schema[key] !== undefined)
      if (source) out[key] = source[key]
    }
  }
  return cleanTypeFields(out)
}

function resolvePointer(root, ref) {
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  try {
    let target = root
    for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~")
      if ((!isObject(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) return undefined
      target = target[key]
    }
    return target
  } catch { return undefined }
}

export function sanitizeInputSchema(root) {
  let remaining = 2048
  const fallback = hint => ({ type: "string", description: hint })
  function visit(schema, depth = 0, active = new Set()) {
    if (depth > 32 || --remaining < 0) return fallback("Schema expansion limit reached; follow the tool's original argument contract.")
    if (!isObject(schema)) return fallback(schema === false ? "No value is allowed by the original schema." : "Accepts any JSON value.")
    if (active.has(schema)) return fallback("Recursive schema; follow the tool's original argument contract.")
    const nextActive = new Set(active).add(schema)
    const child = value => visit(value, depth + 1, nextActive)
    let out = {}
    for (const key of TEXT_FIELDS) if (typeof schema[key] === "string") out[key] = schema[key]
    for (const key of NUMBER_FIELDS) if (typeof schema[key] === "number" && Number.isFinite(schema[key])) out[key] = schema[key]
    if (schema.default !== undefined) out.default = structuredClone(schema.default)

    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(type => TYPES.has(type))
    if (types.length) {
      out.type = types[0]
      if (types.includes("array") && schema.items !== undefined) out.type = "array"
      else if (types.includes("object") && (schema.properties !== undefined || schema.additionalProperties !== undefined)) out.type = "object"
    }
    if (Array.isArray(schema.type) && schema.type.length > 1) appendHint(out, `Accepts types: ${schema.type.join(" | ")}`)
    const nullOnly = schema.type === "null" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "null")
    if (nullOnly || schema.nullable === true) appendHint(out, nullOnly ? "Must equal: null" : "Accepts null.")
    if (isObject(schema.properties)) {
      out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, child(value)]))
      out.type ??= "object"
    }
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter(key => typeof key === "string")
      out.type ??= "object"
    }
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null
    if (tuple) {
      out.items = tuple.length ? mergeSchemas(tuple.map(child), false) : fallback("Accepts any JSON value.")
      appendHint(out, `Tuple positions: ${summarize(tuple)}`)
      if (Array.isArray(schema.prefixItems) && schema.items !== undefined) appendHint(out, `Additional tuple items: ${summarize(schema.items)}`)
      out.type ??= "array"
    } else if (schema.items !== undefined) {
      out.items = child(schema.items)
      out.type ??= "array"
    }
    // additionalProperties/patternProperties are deliberately hints, since agy
    // versions differ in their support even though newer Google protos allow them.
    for (const key of ["additionalProperties", "patternProperties", "not", "contains", "uniqueItems", "dependentRequired", "if", "then", "else", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      if (schema[key] !== undefined) appendHint(out, `${key}: ${summarize(schema[key])}`)
    }
    if (schema.additionalProperties !== undefined || schema.patternProperties !== undefined) out.type ??= "object"
    if (typeof schema.$ref === "string") {
      const target = resolvePointer(root, schema.$ref)
      if (target !== undefined) out = mergeSchemas([child(target), out], true)
      else appendHint(out, `Unresolved schema reference: ${schema.$ref}`)
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (!Array.isArray(schema[key]) || !schema[key].length) continue
      const branches = schema[key].filter(branch => key === "allOf" || branch?.type !== "null")
      if (branches.length !== schema[key].length) appendHint(out, "Accepts null.")
      if (branches.length) out = mergeSchemas([mergeSchemas(branches.map(child), key === "allOf"), out], true)
      if (schema[key].length > 1) appendHint(out, `${key} constraints: ${summarize(schema[key])}`)
    }

    const values = Array.isArray(schema.enum) ? schema.enum : Object.hasOwn(schema, "const") ? [schema.const] : null
    if (!out.type && values?.length) {
      const value = values.find(value => value !== null)
      const type = Array.isArray(value) ? "array" : typeof value
      if (TYPES.has(type)) out.type = type
    }
    if (!out.type) {
      out.type = depth === 0 ? "object" : "string"
      if (!schema.type && !schema.$ref && !schema.anyOf && !schema.oneOf && !schema.allOf) appendHint(out, "Accepts any JSON value.")
    }
    if (values) {
      if (out.type === "string" && values.length && values.every(value => typeof value === "string" && value.length)) out.enum = [...values]
      else if (values.length) appendHint(out, `${Object.hasOwn(schema, "const") ? "Must equal" : "Allowed values"}: ${values.map(value => JSON.stringify(value)).join(", ")}`)
    }
    if (out.type === "array") out.items ??= fallback("Accepts any JSON value.")
    if (out.type === "object") out.properties ??= {}
    return cleanTypeFields(out)
  }
  // A required-only allOf branch may refer to properties supplied by a sibling.
  // Prune dangling names only after every composition has been merged.
  function finish(schema) {
    if (schema.properties) Object.values(schema.properties).forEach(finish)
    if (schema.items) finish(schema.items)
    return cleanTypeFields(schema, true)
  }
  return finish(visit(root))
}
