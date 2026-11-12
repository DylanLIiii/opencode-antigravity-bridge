import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeInputSchema } from './tool-schema.mjs'

test('unsupported RE2 patterns become hints and large declarations keep fields', () => {
  const properties = Object.fromEntries(Array.from({length: 2400}, (_, i) => ['p'+i, { type: 'string' }]))
  properties.bad = {type:'string', pattern:'^(?=foo)foo'}
  properties.safe = {type:'string', pattern:'^\\u0041+$'}
  const source = {type:'object', properties, required:['p2399']}
  const result = sanitizeInputSchema(source)
  assert.equal(Object.keys(result.properties).length, 2402)
  assert.equal(result.properties.bad.pattern, undefined)
  assert.match(result.properties.bad.description, /pattern/)
  assert.equal(result.properties.safe.pattern, '^\\x{0041}+$')
  assert.deepEqual(result.required, ['p2399'])
  assert.equal(source.properties.bad.pattern, '^(?=foo)foo')
})

test('inferred array items preserve resolved refs and sanitize nested patterns', () => {
  const resolved = sanitizeInputSchema({type:'array', $defs:{v:{type:'object',properties:{x:{type:'string'}},required:['x']}}, allOf:[{type:'array',items:{$ref:'#/$defs/v'}}]})
  assert.equal(resolved.items.properties.x.type, 'string')
  assert.deepEqual(resolved.items.required, ['x'])
  const pattern = sanitizeInputSchema({type:'array',anyOf:[{type:'array',items:{type:'string',pattern:'(?<=x)y'}}]})
  assert.equal(pattern.items.pattern, undefined)
  assert.match(pattern.items.description, /pattern/)
})
