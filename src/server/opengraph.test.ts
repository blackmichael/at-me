import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { Resvg } from '@resvg/resvg-js'
import { registerOpenGraphRoute, renderOpenGraphSvg, type OpenGraphState } from './opengraph.js'

function state(): OpenGraphState {
  return {
    profile: {
      avatar: 'http://127.0.0.1/avatar.png',
      displayName: 'Astrid <Ops> & Friends',
      handle: 'astrid.example',
      verification: { verifications: [{ isValid: false, issuerHandle: 'bad.example' }, { isValid: true, issuerHandle: 'trust.example' }] }
    },
    snapshot: {
      records: 1287,
      families: [{ name: 'app.bsky' }, { name: 'com.atproto' }],
      recordTypes: 19,
      activity24h: 23,
      recent: [
        { time: '2026-10-22T12:30:00.000Z', kind: 'commit', operation: 'create', collection: 'app.bsky.feed.post', rkey: 'post<&' },
        { time: '2026-10-22T11:30:00.000Z', kind: 'commit', operation: 'update', collection: 'app.bsky.feed.like', rkey: 'like-1' },
        { time: '2026-10-22T10:30:00.000Z', kind: 'commit', operation: 'delete', collection: 'app.bsky.feed.post', rkey: 'post-0' },
        { time: '2026-10-22T09:30:00.000Z', kind: 'commit', operation: 'create', collection: 'app.bsky.feed.post', rkey: 'older' }
      ]
    },
    ingestion: 'streaming'
  }
}

test('Open Graph SVG reflects current identity and activity with escaped text', () => {
  const svg = renderOpenGraphSvg(state(), 'data:image/png;base64,ZmFrZQ==')

  assert.match(svg, /Astrid &lt;Ops&gt; &amp; Friends/)
  assert.match(svg, /@astrid\.example/)
  assert.match(svg, /Verified by @trust\.example/)
  assert.match(svg, /RECORDS STORED.*1,287/s)
  assert.match(svg, /href="data:image\/png;base64,ZmFrZQ=="/)
  assert.match(svg, /CREATE.*app\.bsky\.feed\.post\/post&lt;&amp;.*Oct 22/s)
  assert.doesNotMatch(svg, /<Ops>|<\/Ops>|Verified by @bad\.example/)
  assert.doesNotMatch(svg, /older/)
})

test('Open Graph endpoint returns a current 1200x630 PNG snapshot', async t => {
  const app = Fastify({ logger: false })
  const avatarPng = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff4f65"/></svg>').render().asPng()
  t.mock.method(globalThis, 'fetch', async () => new Response(Uint8Array.from(avatarPng), { headers: { 'content-type': 'image/png' } }))
  const withAvatar = state()
  withAvatar.profile.avatar = 'https://cdn.bsky.app/img/avatar/fixture'
  let current = withAvatar
  registerOpenGraphRoute(app, () => current)
  t.after(() => app.close())

  const withAvatarResponse = await app.inject({ method: 'GET', url: '/opengraph.png' })
  assert.equal(withAvatarResponse.statusCode, 200)
  assert.match(withAvatarResponse.headers['content-type'] ?? '', /^image\/png/)
  assert.match(withAvatarResponse.headers['cache-control'] ?? '', /max-age=60/)
  assert.equal(withAvatarResponse.rawPayload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(withAvatarResponse.rawPayload.readUInt32BE(16), 1200)
  assert.equal(withAvatarResponse.rawPayload.readUInt32BE(20), 630)

  current = { ...current, profile: { ...current.profile, avatar: undefined } }
  const withoutAvatar = await app.inject({ method: 'GET', url: '/opengraph.png' })
  assert.notDeepEqual(withoutAvatar.rawPayload, withAvatarResponse.rawPayload)

  current = { ...current, profile: withAvatar.profile, ingestion: 'offline' }
  const second = await app.inject({ method: 'GET', url: '/opengraph.png' })
  assert.equal(second.statusCode, 200)
  assert.notDeepEqual(second.rawPayload, withAvatarResponse.rawPayload)
})
