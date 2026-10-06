import { Jetstream } from '@bsky/jetstream'
import type { FastifyBaseLogger } from 'fastify'
import type { ActivityEvent, Source, Store } from './store.js'
import type { TypedEvent } from '@bsky/jetstream'
export type IngestionStatus = 'backfilling' | 'streaming' | 'retrying' | 'offline'

export class Ingester {
  status: IngestionStatus = 'backfilling'
  private eventListeners = new Set<(event: ActivityEvent) => void>()
  private statusListeners = new Set<(status: IngestionStatus) => void>()
  constructor(private store: Store, private service: string, private apiKey: string | undefined, private did: string, private logger: FastifyBaseLogger) {}
  onEvent(listener: (event: ActivityEvent) => void) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener) }
  onStatus(listener: (status: IngestionStatus) => void) { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }

  async start() {
    const client = new Jetstream({ service: this.service, apiKey: this.apiKey, validateWire: true })
    try {
      this.setStatus('backfilling')
      for await (const event of client.snapshot({ dids: [this.did as `did:${string}:${string}`], afterSeq: this.store.cursor, onError: error => this.logger.warn({ err: error }, 'Jetstream snapshot warning') })) this.accept(event, 'archive')
      this.store.beginLive(new Date().toISOString())
      this.setStatus('streaming')
      const cursor = { load: async () => this.store.cursor, save: async () => undefined }
      for await (const event of client.live({ dids: [this.did as `did:${string}:${string}`], cursor, onError: error => this.logger.warn({ err: error }, 'Jetstream live warning'), onInfo: info => this.logger.warn({ info }, 'Jetstream live advisory') })) this.accept(event, 'live')
    } catch (error) {
      this.setStatus('retrying')
      this.logger.error({ err: error }, 'Jetstream transport stopped')
      setTimeout(() => void this.start(), 5000)
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
