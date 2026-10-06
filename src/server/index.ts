import 'dotenv/config'
import Fastify from 'fastify'
import { createServer as createViteServer } from 'vite'
import { resolve } from 'node:path'
import { Store } from './store.js'
import { Ingester } from './ingester.js'

const port = Number(process.env.PORT ?? 3000)
const targetHandle = process.env.TARGET_HANDLE ?? 'michael.bsky.team'
const service = process.env.JETSTREAM_SERVICE ?? 'https://jetstream.us-east.bsky.network'
const app = Fastify({ logger: true })
const clients = new Set<NodeJS.WritableStream>()
let profile: any = { handle: targetHandle }
let store: Store
let ingester: Ingester
let broadcastTimer: NodeJS.Timeout | undefined

async function main() {
  const identity = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(targetHandle)}`)
  if (!identity.ok) throw new Error(`Could not resolve ${targetHandle}: ${identity.status}`)
  const { did } = await identity.json() as { did: string }
  store = new Store(process.env.DATABASE_PATH ?? './data/at-me.db', { did, service })
  try { const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`); if (response.ok) profile = await response.json() } catch (error) { console.warn('Profile display fetch failed:', error) }
  profile = { ...profile, handle: profile.handle ?? targetHandle, did }
  ingester = new Ingester(store, service, process.env.JETSTREAM_API_KEY, profile.did)
  const broadcast = () => { broadcastTimer = undefined; const message = `data: ${JSON.stringify({ type: 'snapshot', profile, service, ingestion: ingester.status, snapshot: store.snapshot() })}\n\n`; clients.forEach(client => client.write(message)) }
  const scheduleBroadcast = () => { if (!broadcastTimer) broadcastTimer = setTimeout(broadcast, 250) }
  ingester.onEvent(event => { if (event.kind === 'identity' && event.handle) profile = { ...profile, handle: event.handle }; scheduleBroadcast() })
  ingester.onStatus(scheduleBroadcast)
  void ingester.start()
  app.get('/api/bootstrap', async () => ({ profile, service, ingestion: ingester.status, snapshot: store.snapshot() }))
  app.get('/api/events', async (request, reply) => {
    reply.hijack(); const response = reply.raw
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    response.write(`data: ${JSON.stringify({ type: 'snapshot', profile, service, ingestion: ingester.status, snapshot: store.snapshot() })}\n\n`)
    clients.add(response)
    response.on('close', () => clients.delete(response))
  })
  app.get('/health', async () => ({ ok: ingester.status !== 'offline', ingestion: ingester.status, cursor: String(store.cursor), did: store.scope.did, service }))
  if (process.env.NODE_ENV !== 'production') {
    await app.register((await import('@fastify/middie')).default)
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
    app.use((request, reply, next) => {
      if (request.url?.startsWith('/api/') || request.url === '/health') return next()
      return vite.middlewares(request, reply, next)
    })
  } else await app.register((await import('@fastify/static')).default, { root: resolve('dist'), wildcard: false })
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`Atmosphere Identity online at http://localhost:${port}`)
}
void main()
process.on('SIGINT', () => { store.close(); process.exit(0) })
