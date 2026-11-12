// Standalone checks for Gemini array `items` filling. Run with:
//   node test/array-items-unit.mjs
import { ensureGeminiArrayItems, PERMISSIVE_LEAF_TYPES, PERMISSIVE_ARRAY_DEPTH } from "../array-items.mjs"

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok  ${name}`)
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? " :: " + detail : ""}`)
}

function sanitize(schema) {
  return ensureGeminiArrayItems(schema)
}

function permissiveTypes(items) {
  return (items?.anyOf || []).map((branch) => branch.type)
}

function isPermissiveItems(items, depth = PERMISSIVE_ARRAY_DEPTH) {
  const types = permissiveTypes(items)
  if (JSON.stringify(types) !== JSON.stringify([...PERMISSIVE_LEAF_TYPES, "array"])) return false
  const arrayBranch = items.anyOf[types.indexOf("array")]
  if (depth <= 1) {
    return JSON.stringify((arrayBranch.items?.anyOf || []).map((branch) => branch.type)) === JSON.stringify(PERMISSIVE_LEAF_TYPES)
  }
  return isPermissiveItems(arrayBranch.items, depth - 1)
}

function countArrayDepth(items) {
  let depth = 0
  let node = items
  while (node?.anyOf) {
    const arrayBranch = node.anyOf.find((branch) => branch && branch.type === "array")
    if (!arrayBranch) break
    depth++
    node = arrayBranch.items
  }
  return depth
}

// Production shape: Pydantic Optional[list[str]] as seen on minimax-code input_images.
{
  const production = sanitize({
    type: "object",
    properties: {
      input_images: {
        anyOf: [
          { items: { type: "string" }, type: "array" },
          { type: "null" },
        ],
        default: null,
        title: "Input Images",
        type: "array",
      },
    },
  })
  const images = production.properties.input_images
  check("Pydantic optional array (production input_images) gets typed items from anyOf",
    images.type === "array"
      && images.items && images.items.type === "string"
      && Array.isArray(images.anyOf)
      && images.anyOf.some((branch) => branch && branch.type === "null"),
    JSON.stringify(images))
  check("production input_images sanitizer is idempotent",
    JSON.stringify(sanitize(production)) === JSON.stringify(production))
}

// Do not narrow a string|list union by stamping type: array on the parent.
{
  const schema = sanitize({
    type: "object",
    properties: {
      path: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      list_or_string: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
      },
    },
  })
  const path = schema.properties.path
  const flipped = schema.properties.list_or_string
  check("string|list union keeps both branches and does not get type:array",
    path.type === undefined
      && Array.isArray(path.anyOf)
      && path.anyOf[0].type === "string"
      && path.anyOf[1].type === "array"
      && path.anyOf[1].items.type === "string",
    JSON.stringify(path))
  check("list|string union (array first) is also left un-narrowed",
    flipped.type === undefined
      && flipped.anyOf[0].type === "array"
      && flipped.anyOf[1].type === "string",
    JSON.stringify(flipped))
}

// Do not drop null from an array|null anyOf that has no top-level type.
{
  const schema = sanitize({
    type: "object",
    properties: {
      maybe: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "null" },
        ],
        default: null,
      },
    },
  })
  const maybe = schema.properties.maybe
  check("array|null anyOf without a top-level type keeps null and is not forced to type:array",
    maybe.type === undefined
      && maybe.anyOf.some((branch) => branch && branch.type === "null")
      && maybe.anyOf.some((branch) => branch && branch.type === "array"),
    JSON.stringify(maybe))
}

// Bare array / items:true get a least-narrowing typed items + a hint, not string.
{
  const schema = sanitize({
    type: "object",
    properties: {
      bare: { type: "array" },
      items_true: { type: "array", items: true },
      empty_items: { type: "array", items: {} },
      desc_only: { type: "array", items: { description: "paths" } },
      from_enum: { type: "array", items: { enum: ["a", "b"] } },
      from_props: { type: "array", items: { properties: { url: { type: "string" } } } },
      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      prefix: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
      nullable: { type: ["array", "null"] },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tags: { type: "array" },
          },
        },
      },
      contains_arr: { type: "object", contains: { type: "array" } },
    },
  })
  const p = schema.properties
  check("bare array gets permissive typed items and a hint, not string",
    isPermissiveItems(p.bare.items)
      && (p.bare.description || "").includes("array items were untyped"),
    JSON.stringify(p.bare))
  check("permissive items allow several levels of nested arrays, not just one",
    // Literal 8: reading PERMISSIVE_ARRAY_DEPTH here would stay green if it were 1.
    countArrayDepth(p.bare.items) === 8,
    String(countArrayDepth(p.bare.items)))
  check("items:true gets permissive typed items and a hint",
    isPermissiveItems(p.items_true.items)
      && (p.items_true.description || "").includes("array items were untyped"),
    JSON.stringify(p.items_true))
  check("empty items object gets permissive types",
    isPermissiveItems(p.empty_items.items),
    JSON.stringify(p.empty_items))
  check("description-only items keep the hint and gain permissive types",
    isPermissiveItems(p.desc_only.items)
      && p.desc_only.items.description === "paths",
    JSON.stringify(p.desc_only))
  check("items type is inferred from enum without inventing string on a typeless parent",
    p.from_enum.items.type === "string" && JSON.stringify(p.from_enum.items.enum) === JSON.stringify(["a", "b"]),
    JSON.stringify(p.from_enum))
  check("items with properties keep those properties and do not gain a forced type:object",
    p.from_props.items.type === undefined && p.from_props.items.properties.url.type === "string",
    JSON.stringify(p.from_props))
  check("tuple items are left as a list, with a hint, not collapsed to the first item",
    Array.isArray(p.tuple.items)
      && p.tuple.items.length === 2
      && p.tuple.items[0].type === "string"
      && p.tuple.items[1].type === "number"
      && (p.tuple.description || "").includes("tuple items were left as a list"),
    JSON.stringify(p.tuple))
  check("prefixItems tuples are left in place with a hint and gain a sibling items field",
    Array.isArray(p.prefix.prefixItems)
      && p.prefix.prefixItems.length === 2
      && p.prefix.items
      && (p.prefix.description || "").includes("tuple items were left as a list"),
    JSON.stringify(p.prefix))
  check("nullable array type is kept, and items are filled without dropping null",
    JSON.stringify(p.nullable.type) === JSON.stringify(["array", "null"])
      && p.nullable.items,
    JSON.stringify(p.nullable))
  check("nested typeless array items are filled recursively without forcing string when untyped",
    isPermissiveItems(p.nested.items.properties.tags.items),
    JSON.stringify(p.nested))
  check("contains also receives filled array items",
    isPermissiveItems(p.contains_arr.contains.items),
    JSON.stringify(p.contains_arr))
  check("array-items sanitizer is idempotent",
    JSON.stringify(sanitize(schema)) === JSON.stringify(schema))
}

{
  const schema = sanitize({
    type: "array",
    anyOf: [
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "number" } },
    ],
  })
  check("multiple array combinator branches become an anyOf of their items, not just the first",
    schema.items && Array.isArray(schema.items.anyOf)
      && schema.items.anyOf.some((branch) => branch && branch.type === "string")
      && schema.items.anyOf.some((branch) => branch && branch.type === "number"),
    JSON.stringify(schema))
}

{
  const schema = sanitize({
    type: "array",
    items: { maxLength: 3 },
    anyOf: [
      { type: "array", items: { type: "string" } },
    ],
  })
  check("existing typeless items constraints are merged, not overwritten, when copying combinator items",
    schema.items.type === "string" && schema.items.maxLength === 3,
    JSON.stringify(schema))
}

{
  const schema = sanitize({
    type: "array",
    anyOf: [
      { type: "array", items: { type: "string" } },
      {},
    ],
  })
  check("anyOf with a typeless {} branch does not gain global items:string",
    isPermissiveItems(schema.items)
      && Array.isArray(schema.anyOf)
      && schema.anyOf.some((branch) => branch && Object.keys(branch).length === 0)
      && (schema.description || "").includes("array items were untyped"),
    JSON.stringify(schema))
}

{
  const schema = sanitize({
    type: "array",
    anyOf: [
      { type: "array", items: { type: "string" } },
      { type: "array" },
    ],
  })
  const onlyString = schema.items?.type === "string" && !schema.items.anyOf
  const allowsNumber = isPermissiveItems(schema.items)
    || (Array.isArray(schema.items?.anyOf) && schema.items.anyOf.some((branch) => (
      branch?.type === "number" || isPermissiveItems(branch) || Array.isArray(branch?.anyOf)
    )))
  check("anyOf with an items-less array branch does not narrow to items:string",
    !onlyString && allowsNumber,
    JSON.stringify(schema))
}

{
  const schema = sanitize({
    type: "array",
    items: { enum: [1, 1.5, null] },
  })
  check("mixed numeric enum does not get type:integer from the first sample",
    schema.items.type === "number" && JSON.stringify(schema.items.enum) === JSON.stringify([1, 1.5, null]),
    JSON.stringify(schema))
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nALL OK")
