import 'dotenv/config'
import Fastify from 'fastify'
import fastifyMiddie from '@fastify/middie'
import fastifyStatic from '@fastify/static'
import type { ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { Store } from './store.js'
import { Ingester } from './ingester.js'

const port = Number(process.env.PORT ?? 3000)
const targetHandle = process.env.TARGET_HANDLE ?? 'michael.bsky.team'
const service = process.env.JETSTREAM_SERVICE ?? 'https://jetstream.us-east.bsky.network'
const app = Fastify({ logger: { timestamp: () => `,"time":"${new Date().toISOString()}"` } })
const clients = new Set<ServerResponse>()
const startupAbort = new AbortController()
let profile: { handle: string; [key: string]: unknown } = { handle: targetHandle }
let store: Store | undefined
let ingester: Ingester | undefined
let broadcastTimer: NodeJS.Timeout | undefined
let heartbeatTimer: NodeJS.Timeout | undefined
let startupTask = Promise.resolve()
let shutdownTask: Promise<void> | undefined
let shuttingDown = false

async function main() {
  const identity = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(targetHandle)}`, { signal: startupAbort.signal })
  if (!identity.ok) throw new Error(`Could not resolve ${targetHandle}: ${identity.status}`)
  const resolvedIdentity: unknown = await identity.json()
  if (!resolvedIdentity || typeof resolvedIdentity !== 'object' || !('did' in resolvedIdentity) || typeof resolvedIdentity.did !== 'string') throw new Error(`Invalid identity response for ${targetHandle}`)
  const { did } = resolvedIdentity
  if (shuttingDown) return
  const currentStore = new Store('./data/at-me.db', { did, service })
  store = currentStore
  try {
    const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, { signal: startupAbort.signal })
    if (response.ok) {
      const fetchedProfile: unknown = await response.json()
      if (!fetchedProfile || typeof fetchedProfile !== 'object' || Array.isArray(fetchedProfile)) throw new Error('Invalid profile response')
      profile = { ...fetchedProfile, handle: 'handle' in fetchedProfile && typeof fetchedProfile.handle === 'string' ? fetchedProfile.handle : targetHandle }
    }
  } catch (error) {
    if (!shuttingDown) app.log.warn({ err: error }, 'Profile display fetch failed')
  }
  if (shuttingDown) return
  profile = { ...profile, handle: profile.handle ?? targetHandle, did }
  const currentIngester = new Ingester(currentStore, service, process.env.JETSTREAM_API_KEY, did, app.log)
  ingester = currentIngester
  const diagnostics = () => ({
    lastError: currentIngester.lastError,
    lastAdvisory: currentIngester.lastAdvisory,
    lastConnectedAt: currentIngester.lastConnectedAt
  })
  const payload = () => ({ profile, service, ingestion: currentIngester.status, diagnostics: diagnostics(), snapshot: currentStore.snapshot() })
  const broadcast = () => {
    broadcastTimer = undefined
    if (shuttingDown) return
    const message = `data: ${JSON.stringify({ type: 'snapshot', ...payload() })}\n\n`
    clients.forEach(client => client.write(message))
  }
  const scheduleBroadcast = () => { if (!shuttingDown && !broadcastTimer) broadcastTimer = setTimeout(broadcast, 250) }
  currentIngester.onEvent(event => { if (event.kind === 'identity' && event.handle) profile = { ...profile, handle: event.handle }; scheduleBroadcast() })
  currentIngester.onStatus(scheduleBroadcast)
  void currentIngester.start()
  app.get('/api/bootstrap', async () => payload())
  app.get('/api/events', async (_request, reply) => {
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    response.write(`data: ${JSON.stringify({ type: 'snapshot', ...payload() })}\n\n`)
    clients.add(response)
    response.on('close', () => clients.delete(response))
  })
  heartbeatTimer = setInterval(() => clients.forEach(client => client.write(': heartbeat\n\n')), 15_000)
  app.get('/health', async (_request, reply) => {
    const ok = currentIngester.status === 'streaming'
    return reply.code(ok ? 200 : 503).send({
      ok,
      ingestion: currentIngester.status,
      ...diagnostics(),
      lastEventAt: currentStore.snapshot().lastEventAt,
      cursor: String(currentStore.cursor),
      did: currentStore.scope.did,
      service
    })
  })
  if (process.env.NODE_ENV !== 'production') {
    await app.register(fastifyMiddie)
    if (shuttingDown) return
    // Vite is a dev dependency; load it only in development so production can omit it.
    const { createServer: createViteServer } = await import('vite')
    if (shuttingDown) return
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
    app.addHook('onClose', async () => { await vite.close() })
    if (shuttingDown) return
    app.use((request, reply, next) => {
      if (request.url?.startsWith('/api/') || request.url === '/health') return next()
      return vite.middlewares(request, reply, next)
    })
  } else await app.register(fastifyStatic, { root: resolve('dist'), wildcard: false })
  if (shuttingDown) return
  await app.listen({ port, host: '0.0.0.0' })
  if (!shuttingDown) app.log.info({ port }, 'Atmosphere Dashboard online')
}
function shutdown() {
  if (shutdownTask) return shutdownTask
  shuttingDown = true
  startupAbort.abort()
  clearTimeout(broadcastTimer)
  broadcastTimer = undefined
  clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  shutdownTask = (async () => {
    await startupTask
    try { await ingester?.stop() } catch (error) {
      app.log.error({ err: error }, 'Could not stop ingestion')
      process.exitCode = 1
    }
    try { store?.close() } catch (error) {
      app.log.error({ err: error }, 'Could not flush storage')
      process.exitCode = 1
    }
    clients.forEach(client => client.end())
    clients.clear()
    try { await app.close() } catch (error) {
      app.log.error({ err: error }, 'Could not close HTTP server')
      process.exitCode = 1
    }
  })()
  return shutdownTask
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
startupTask = main().catch(error => {
  if (shuttingDown) return
  app.log.fatal({ err: error }, 'Service startup failed')
  process.exitCode = 1
  void shutdown()
})
