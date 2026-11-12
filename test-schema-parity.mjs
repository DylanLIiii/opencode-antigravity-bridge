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
