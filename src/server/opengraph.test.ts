import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerOpenGraphRoute } from './opengraph.js'

test('Open Graph endpoint serves a cacheable 1200x630 PNG poster', async t => {
  const app = Fastify({ logger: false })
  registerOpenGraphRoute(app, 'astrid.example')
  t.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/opengraph.png' })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'] ?? '', /^image\/png/)
  assert.match(response.headers['cache-control'] ?? '', /public, max-age=3600, s-maxage=86400/)
  assert.equal(response.rawPayload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(response.rawPayload.readUInt32BE(16), 1200)
  assert.equal(response.rawPayload.readUInt32BE(20), 630)
})
