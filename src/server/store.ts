import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Source = 'archive' | 'live'
export type ActivityEvent = {
  seq: number; time: string; did: string; kind: 'commit' | 'identity' | 'account' | 'sync'; source: Source
  operation?: 'create' | 'update' | 'delete'; collection?: string; rkey?: string; record?: Record<string, unknown>
  cid?: string; rev?: string; handle?: string; active?: boolean; status?: string
}
type RecordState = { did: string; collection: string; record: Record<string, unknown>; updatedAt: string; rev?: string; cid?: string }
type Scope = { did: string; service: string; version: 2 }
type Disk = { version: 2; scope: Scope; cursor: number; observedSince?: string; events: ActivityEvent[]; records: Record<string, RecordState>; identity?: { handle?: string; updatedAt: string }; account?: { active: boolean; status?: string; updatedAt: string } }

export class Store {
  private data: Disk
  private seen = new Set<number>()
  private cached?: ReturnType<Store['buildSnapshot']>
  private cachedAt = 0
  private flushTimer?: NodeJS.Timeout

  constructor(private path: string, scope: Omit<Scope, 'version'>) {
    mkdirSync(dirname(path), { recursive: true })
    const expected: Scope = { ...scope, version: 2 }
    if (!existsSync(path)) this.data = { version: 2, scope: expected, cursor: 0, events: [], records: {} }
    else {
      const loaded = JSON.parse(readFileSync(path, 'utf8')) as Partial<Disk>
      if (loaded.version !== 2 || !loaded.scope) {
        const backup = `${path}.legacy-${Date.now()}.json`
        renameSync(path, backup)
        this.data = { version: 2, scope: expected, cursor: 0, events: [], records: {} }
      } else if (loaded.scope.did !== expected.did || loaded.scope.service !== expected.service) {
        throw new Error(`Stored data belongs to ${loaded.scope.did} at ${loaded.scope.service}; use a separate DATABASE_PATH for ${expected.did}.`)
      } else this.data = loaded as Disk
    }
    this.seen = new Set(this.data.events.map(event => event.seq))
  }

  get cursor() { return this.data.cursor }
  get scope() { return this.data.scope }

  add(event: ActivityEvent) {
    if (this.seen.has(event.seq)) return false
    this.seen.add(event.seq); this.data.events.push(event); this.data.cursor = Math.max(this.data.cursor, event.seq)
    if (event.source === 'live' && !this.data.observedSince) this.data.observedSince = event.time
    this.fold(event); this.cached = undefined; this.scheduleFlush(); return true
  }

  beginLive(at: string) { if (!this.data.observedSince) { this.data.observedSince = at; this.cached = undefined; this.flush() } }

  snapshot() {
    if (!this.cached || Date.now() - this.cachedAt >= 60_000) { this.cached = this.buildSnapshot(); this.cachedAt = Date.now() }
    return this.cached
  }

  private fold(event: ActivityEvent) {
    if (event.kind === 'identity') { this.data.identity = { handle: event.handle, updatedAt: event.time }; return }
    if (event.kind === 'account') {
      this.data.account = { active: event.active ?? true, status: event.status, updatedAt: event.time }
      if (event.active === false && event.status === 'deleted') this.clearDid(event.did)
      return
    }
    if (event.kind === 'sync') { this.clearDid(event.did); return }
    if (!event.collection || !event.rkey) return
    const uri = `at://${event.did}/${event.collection}/${event.rkey}`
    if (event.operation === 'delete') delete this.data.records[uri]
    else if (event.record) this.data.records[uri] = { did: event.did, collection: event.collection, record: event.record, updatedAt: event.time, rev: event.rev, cid: event.cid }
  }

  private clearDid(did: string) { for (const [uri, record] of Object.entries(this.data.records)) if (record.did === did) delete this.data.records[uri] }

  private buildSnapshot() {
    const records = Object.values(this.data.records), archiveRows = this.data.events.filter(event => event.source === 'archive').length, live = this.data.events.filter(event => event.source === 'live')
    const recentStart = Math.max(0, this.data.events.length - 100), recentCutoff = Date.now() - 24 * 60 * 60 * 1000
    const recent = this.data.events.filter((event, index) => index >= recentStart || Date.parse(event.time) >= recentCutoff)
    const families = new Map<string, { records: number; collections: Map<string, number> }>()
    for (const record of records) {
      const family = lexiconFamily(record.collection), current = families.get(family) ?? { records: 0, collections: new Map<string, number>() }
      current.records++; current.collections.set(record.collection, (current.collections.get(record.collection) ?? 0) + 1); families.set(family, current)
    }
    const declared = new Map<string, number>()
    for (const record of records) { const date = declaredDate(record.record); if (date) declared.set(date.slice(0, 7), (declared.get(date.slice(0, 7)) ?? 0) + 1) }
    const activity = this.data.events.filter(event => event.kind === 'commit' && Date.parse(event.time) >= Date.now() - 24 * 60 * 60 * 1000)
    const activityDays = new Map<string, { count: number; creates: number; updates: number; deletes: number; markers: number }>()
    for (const event of this.data.events.filter(event => event.kind === 'commit')) {
      const day = event.time.slice(0, 10), bucket = activityDays.get(day) ?? { count: 0, creates: 0, updates: 0, deletes: 0, markers: 0 }
      bucket.count++; if (event.operation === 'create') bucket.creates++; else if (event.operation === 'update') bucket.updates++; else if (event.operation === 'delete') bucket.deletes++; activityDays.set(day, bucket)
    }
    const markers = this.data.events.filter(event => event.kind !== 'commit').length
    return {
      cursor: this.cursor, cursorText: String(this.cursor), archiveRows, records: records.length, markerRows: markers,
      observedSince: this.data.observedSince ?? null, liveObserved: live.length,
      activity24h: activity.length, activity24hCreates: activity.filter(event => event.operation === 'create').length, activity24hUpdates: activity.filter(event => event.operation === 'update').length, activity24hDeletes: activity.filter(event => event.operation === 'delete').length,
      recordTypes: new Set(records.map(record => record.collection)).size,
      liveCreates: live.filter(event => event.operation === 'create').length, liveUpdates: live.filter(event => event.operation === 'update').length, liveDeletes: live.filter(event => event.operation === 'delete').length,
      identity: this.data.identity, account: this.data.account,
      families: [...families].map(([name, value]) => ({ name, records: value.records, collections: [...value.collections].map(([name, records]) => ({ name, records })).sort((a, b) => b.records - a.records) })).sort((a, b) => b.records - a.records),
      declaredMonthly: fillMonths(declared), recentActivityDaily: recentDays(activityDays),
      recent: recent.reverse(), lastEventAt: this.data.events.at(-1)?.time ?? null
    }
  }

  private scheduleFlush() { if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush() }, 250) }
  private flush() { const temp = `${this.path}.tmp`; writeFileSync(temp, JSON.stringify(this.data)); renameSync(temp, this.path) }
  close() { if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined; this.flush() }
}

function lexiconFamily(collection: string) { const parts = collection.split('.'); return parts.length > 1 ? parts.slice(0, 2).join('.') : collection }
function declaredDate(record: Record<string, unknown>) { const value = record.createdAt; return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined }
function fillMonths(values: Map<string, number>) {
  if (!values.size) return []
  const months: { month: string; count: number }[] = [], [first] = [...values.keys()].sort(), last = [...values.keys()].sort().at(-1)!
  for (let date = new Date(`${first}-01T00:00:00Z`); date <= new Date(`${last}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1)) { const month = date.toISOString().slice(0, 7); months.push({ month, count: values.get(month) ?? 0 }) }
  return months
}
function recentDays(values: Map<string, { count: number; creates: number; updates: number; deletes: number; markers: number }>) {
  const today = new Date(); const days: { day: string; count: number; creates: number; updates: number; deletes: number; markers: number }[] = []
  for (let offset = 13; offset >= 0; offset--) { const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset)), day = date.toISOString().slice(0, 10); days.push({ day, ...(values.get(day) ?? { count: 0, creates: 0, updates: 0, deletes: 0, markers: 0 }) }) }
  return days
}
