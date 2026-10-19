import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import Fastify from 'fastify'
import { WebSocketServer, type WebSocket } from 'ws'
import { Ingester } from './ingester.js'
import { Store, type ActivityEvent } from './store.js'

const did = 'did:plc:og5t4xeyapx5fwjx5hnr2c56'
const logger = Fastify({ logger: false }).log
const cid = 'bafyreifeiiwh4ixnliny4pe3sp35f5la6gd3avxtf4zseka6ezz4y6nskq'
const event: ActivityEvent = {
  seq: 1, time: '2026-10-18T12:00:00.000Z', did, kind: 'commit', source: 'live',
  operation: 'create', collection: 'app.bsky.feed.post', rkey: 'new', rev: '3my2vevlxbs2f', cid,
  record: { $type: 'app.bsky.feed.post', text: 'Current sequence space', createdAt: '2026-10-18T12:00:00.000Z' }
}
function sendEvent(socket: WebSocket, seq: number) {
  socket.send(JSON.stringify({ $type: 'message', payload: {
    $type: 'network.bsky.jetstream.subscribeEvents#commit', seq, did, time: event.time,
    operation: event.operation, collection: event.collection, rkey: event.rkey, rev: event.rev, cid, record: event.record
  } }))
}
async function fixture(sealedTipSeq: number, onConnect: (socket: WebSocket, request: IncomingMessage) => void) {
  const afterSeqs: number[] = []
  const server = createServer(async (request, response) => {
    if (request.url !== '/xrpc/network.bsky.jetstream.planSnapshot') { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    afterSeqs.push(JSON.parse(body).afterSeq)
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      plannedThroughSeq: sealedTipSeq, sealedTipSeq, segments: [],
      stats: { segmentsExamined: 0, segmentsMatched: 0, blocksMatched: 0, entries: 0 }
    }))
  })
  const sockets = new WebSocketServer({ server, path: '/xrpc/network.bsky.jetstream.subscribeEvents' })
  sockets.on('connection', onConnect)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  return {
    service: `http://127.0.0.1:${address.port}`, afterSeqs,
    async close() {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>(resolve => sockets.close(() => resolve()))
      server.closeIdleConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
function received(ingester: Ingester) {
  return new Promise<ActivityEvent>(resolve => {
    const remove = ingester.onEvent(value => { remove(); resolve(value) })
  })
}

test('FutureCursor discards the old cache and replays a new sequence space durably', { timeout: 10000 }, async t => {
  let connections = 0
  const upstream = await fixture(0, socket => {
    if (++connections === 1) {
      socket.send(JSON.stringify({ $type: 'message', payload: {
        $type: 'network.bsky.jetstream.subscribeEvents#info', name: 'FutureCursor', message: 'archive was rebuilt'
      } }))
    } else sendEvent(socket, 1)
  })
  const directory = mkdtempSync(join(tmpdir(), 'at-me-recovery-'))
  const path = join(directory, 'cache.db')
  const scope = { did, service: upstream.service }
  const store = new Store(path, scope)
  // Reusing seq 1 below must not be suppressed by the previous cache's seen set.
  store.add({ ...event, seq: 1, rkey: 'obsolete' })
  store.add({ ...event, seq: 1000, rkey: 'old-tip' })
  const ingester = new Ingester(store, upstream.service, '  ', did, logger)
  t.after(async () => { await ingester.stop(); store.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }) })
  const next = received(ingester)
  void ingester.start()
  assert.equal((await next).rkey, 'new')
  assert.equal(ingester.status, 'streaming')
  assert.equal(ingester.lastAdvisory?.name, 'FutureCursor')
  assert.equal(ingester.lastError, null)
  assert.equal(store.cursor, 1)
  assert.equal(store.snapshot().records, 1)
  assert.deepEqual(store.snapshot().recent.map(row => row.rkey), ['new'])
  assert.deepEqual(upstream.afterSeqs, [1000, 0])
  await ingester.stop()
  store.close()
  const reopened = new Store(path, scope)
  assert.equal(reopened.cursor, 1)
  assert.deepEqual(reopened.snapshot().recent.map(row => row.rkey), ['new'])
  reopened.close()
})

test('an inactive account cuts over at the global archive tip, not its last matching event', { timeout: 10000 }, async t => {
  const upstream = await fixture(100, (socket, request) => {
    const cursor = new URL(request.url!, 'http://fixture').searchParams.get('cursor')
    if (cursor === '100') sendEvent(socket, 101)
    else socket.close(1008, 'cursor too old')
  })
  const directory = mkdtempSync(join(tmpdir(), 'at-me-cutover-'))
  const store = new Store(join(directory, 'cache.db'), { did, service: upstream.service })
  store.add({ ...event, seq: 5, rkey: 'previous' })
  const ingester = new Ingester(store, upstream.service, undefined, did, logger)
  t.after(async () => { await ingester.stop(); store.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }) })
  const next = received(ingester)
  void ingester.start()
  assert.equal((await next).seq, 101)
  assert.equal(store.cursor, 101)
  assert.equal(store.snapshot().records, 2)
  await ingester.stop()
  assert.equal(ingester.status, 'offline')
})
