import { Jetstream, websocketTransport, type LiveTransport, type TypedEvent } from '@bsky/jetstream'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyBaseLogger } from 'fastify'
import type { ActivityEvent, Source, Store } from './store.js'
export type IngestionStatus = 'backfilling' | 'streaming' | 'retrying' | 'offline'

export class Ingester {
  status: IngestionStatus = 'backfilling'
  lastError: string | null = null
  lastAdvisory: { name: string; message?: string } | null = null
  lastConnectedAt: string | null = null
  private controller?: AbortController
  private running?: Promise<void>
  private eventListeners = new Set<(event: ActivityEvent) => void>()
  private statusListeners = new Set<(status: IngestionStatus) => void>()
  constructor(private store: Store, private service: string, private apiKey: string | undefined, private did: string, private logger: FastifyBaseLogger) {}
  onEvent(listener: (event: ActivityEvent) => void) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener) }
  onStatus(listener: (status: IngestionStatus) => void) { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }

  start() {
    if (this.running) return this.running
    this.controller = new AbortController()
    this.running = this.run(this.controller.signal).finally(() => { this.running = undefined; this.setStatus('offline') })
    return this.running
  }

  async stop() {
    this.controller?.abort()
    await this.running
  }

  private async run(signal: AbortSignal) {
    let rebuild = false
    while (!signal.aborted) {
      try {
        if (rebuild) { rebuild = false; this.store.reset() }
        this.setStatus('backfilling')
        let source: Source = 'archive'
        const client = new Jetstream({
          service: this.service, apiKey: this.apiKey?.trim() || undefined, validateWire: true,
          fetchImpl: (input, init) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
            if (url.pathname === '/xrpc/network.bsky.jetstream.planSnapshot') {
              source = 'archive'
              this.setStatus('backfilling')
            }
            return fetch(input, init)
          }
        })
        const transport = websocketTransport({
          onConnect: () => {
            this.lastConnectedAt = new Date().toISOString()
            this.lastError = null
            this.setStatus('streaming')
          },
          onDisconnect: () => { if (!signal.aborted) this.setStatus('retrying') },
          onReconnect: error => {
            this.lastError = error instanceof Error ? error.message : String(error)
            this.setStatus('retrying')
            this.logger.warn({ err: error }, 'Jetstream reconnecting')
          }
        })
        const liveTransport: LiveTransport = {
          stream: (getUrl, streamSignal, options) => {
            source = 'live'
            return transport.stream(getUrl, streamSignal, options)
          }
        }
        for await (const event of client.replay({
          dids: [this.did as `did:${string}:${string}`], afterSeq: this.store.cursor, signal, liveTransport,
          onError: error => this.logger.warn({ err: error }, 'Jetstream replay warning'),
          onInfo: info => {
            this.lastAdvisory = info
            this.logger.warn({ info }, 'Jetstream live advisory')
            if (info.name === 'FutureCursor') {
              // seq is instance-local. Never mix the old cache with a new sequence space.
              rebuild = true
              throw new Error('Jetstream sequence changed; rebuilding the cache from zero')
            }
          }
        })) this.accept(event, source)
        if (!signal.aborted) throw new Error('Jetstream replay ended unexpectedly')
      } catch (error) {
        if (signal.aborted) break
        this.lastError = error instanceof Error ? error.message : String(error)
        this.setStatus('retrying')
        this.logger.error({ err: error, rebuild }, 'Jetstream transport stopped')
        if (!rebuild) {
          try { await delay(5000, undefined, { signal }) } catch { break }
        }
      }
    }
  }

  private accept(event: TypedEvent, source: Source) { const normalized = normalize(event, source); if (this.store.add(normalized)) this.eventListeners.forEach(listener => listener(normalized)) }
  private setStatus(status: IngestionStatus) { this.status = status; this.statusListeners.forEach(listener => listener(status)) }
}

function normalize(evt: TypedEvent, source: Source): ActivityEvent {
  const base = { seq: evt.seq, time: evt.time, did: evt.did, kind: evt.kind, source }
  if (evt.kind === 'commit') {
    const commit = evt.commit
    const event = { ...base, operation: commit.operation, collection: commit.collection, rkey: commit.rkey, rev: commit.rev }
    return commit.operation === 'delete' ? event : { ...event, record: commit.record, cid: commit.cid }
  }
  if (evt.kind === 'identity') return { ...base, handle: evt.identity.handle }
  if (evt.kind === 'account') return { ...base, active: evt.account.active, status: evt.account.status }
  return { ...base, rev: evt.sync.rev }
}
