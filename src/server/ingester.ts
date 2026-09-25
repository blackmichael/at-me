import { Jetstream } from '@bsky/jetstream'
import type { ActivityEvent, Source, Store } from './store.js'

export type IngestionStatus = 'backfilling' | 'streaming' | 'retrying' | 'offline'

export class Ingester {
  status: IngestionStatus = 'backfilling'
  private eventListeners = new Set<(event: ActivityEvent) => void>()
  private statusListeners = new Set<(status: IngestionStatus) => void>()
  constructor(private store: Store, private service: string, private apiKey: string | undefined, private did: string) {}
  onEvent(listener: (event: ActivityEvent) => void) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener) }
  onStatus(listener: (status: IngestionStatus) => void) { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }

  async start() {
    const client = new Jetstream({ service: this.service, apiKey: this.apiKey, validateWire: true })
    try {
      this.setStatus('backfilling')
      for await (const event of client.snapshot({ dids: [this.did as `did:${string}:${string}`], afterSeq: this.store.cursor, onError: error => console.error('Jetstream snapshot warning:', error) })) this.accept(event as any, 'archive')
      this.store.beginLive(new Date().toISOString())
      this.setStatus('streaming')
      const cursor = { load: async () => this.store.cursor, save: async () => undefined }
      for await (const event of client.live({ dids: [this.did as `did:${string}:${string}`], cursor, onError: error => console.error('Jetstream live warning:', error), onInfo: info => console.warn('Jetstream live advisory:', info) })) this.accept(event as any, 'live')
    } catch (error) {
      this.setStatus('retrying')
      console.error('Jetstream transport stopped:', error)
      setTimeout(() => void this.start(), 5000)
    }
  }

  private accept(event: any, source: Source) { const normalized = normalize(event, source); if (this.store.add(normalized)) this.eventListeners.forEach(listener => listener(normalized)) }
  private setStatus(status: IngestionStatus) { this.status = status; this.statusListeners.forEach(listener => listener(status)) }
}

function normalize(evt: any, source: Source): ActivityEvent {
  if (!evt.time || Number.isNaN(Date.parse(evt.time))) throw new Error(`Jetstream event ${evt.seq} has no valid envelope time`)
  const base = { seq: Number(evt.seq), time: evt.time, did: evt.did, kind: evt.kind, source } as const
  if (evt.kind === 'commit') return { ...base, operation: evt.commit.operation, collection: evt.commit.collection, rkey: evt.commit.rkey, record: evt.commit.record, cid: evt.commit.cid, rev: evt.commit.rev }
  if (evt.kind === 'identity') return { ...base, handle: evt.identity.handle }
  if (evt.kind === 'account') return { ...base, active: evt.account.active, status: evt.account.status }
  return { ...base, rev: evt.sync.rev }
}
