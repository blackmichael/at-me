import { StrictMode, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

type Snapshot = any
// Keep every array consumed during render here; this state is used before bootstrap resolves.
const empty: Snapshot = { cursorText: '0', records: 0, recordTypes: 0, families: [], declaredMonthly: [], recentActivityDaily: [], recent: [] }

function App() {
  const [data, setData] = useState<Snapshot>(empty)
  const [profile, setProfile] = useState<any>({ handle: 'michael.bsky.team' })
  const [service, setService] = useState('')
  const [connection, setConnection] = useState('connecting')
  const [loaded, setLoaded] = useState(false)

  const apply = (next: any) => {
    if (next.snapshot) setData(next.snapshot)
    if (next.profile) setProfile(next.profile)
    if (next.service) setService(next.service)
    if (next.ingestion) setConnection(next.ingestion)
    setLoaded(true)
  }
  const refresh = () => {
    setConnection('connecting')
    return fetch('/api/bootstrap')
      .then(response => response.ok ? response.json() : Promise.reject(response))
      .then(apply)
      .catch(() => setConnection('offline'))
  }

  useEffect(() => {
    void refresh()
    const source = new EventSource('/api/events')
    source.onmessage = event => { try { apply(JSON.parse(event.data)) } catch { setConnection('offline') } }
    source.onerror = () => setConnection('offline')
    return () => source.close()
  }, [])

  const shownFamilies = data.families.slice(0, 12)
  const omittedFamilies = data.families.length - shownFamilies.length
  const maxFamily = Math.max(...shownFamilies.map((family: any) => family.records), 1)

  return <>
    <a className="skip" href="#content">Skip to Activity</a>
    <header className="masthead">
      <div className="header-identity">
        <h1 className="page-title">ATMOSPHERE IDENTITY</h1>
        <p className="header-did" translate="no">{profile.did ?? '…'}</p>
      </div>
      <div className="connection">
        <span className="connection-status" role="status" aria-live="polite"><i className={`led ${connection === 'streaming' ? 'on' : ''}`} aria-hidden="true" />{statusLabel(connection)}</span>
        {connection === 'offline' ? <button type="button" className="retry-button" onClick={() => void refresh()}>Retry Connection</button> : null}
      </div>
    </header>
    <main id="content">
      <section className="identity" aria-labelledby="identity-title">
        <div className="identity-grid">
          <div className="identity-copy">
            <h2 id="identity-title" translate="no">{profile.displayName ?? profile.handle}</h2>
            <p className="handle" translate="no">@{profile.handle}</p>
            {verifiedBy(profile) ? <p className="verifier" translate="no">Verified by {verifiedBy(profile)}</p> : null}
          </div>
        </div>
      </section>

      <section className="registers section-card" aria-labelledby="overview-title">
        <div className="card-head"><h2 id="overview-title">Repository state</h2></div>
        <div className="register-grid">
          <Register name="Records Stored" value={display(loaded, data.records)} note="records in current fold" />
          <Register name="Lexicon Families" value={display(loaded, data.families.length)} note="namespace groups" />
          <Register name="Record Types" value={display(loaded, data.recordTypes)} note="collections represented" />
          <Register name="24-Hour Activity" value={display(loaded, data.activity24h)} note={loaded ? `${exact(data.activity24hCreates)} creates · ${exact(data.activity24hUpdates)} updates · ${exact(data.activity24hDeletes)} deletes` : 'record changes'} />
        </div>
      </section>

      <section className="terminal section-card" aria-labelledby="activity-title">
        <div className="card-head terminal-head">
          <div><h2 id="activity-title">Recent events</h2></div>
        </div>
        <ol className="event-list" tabIndex={0} aria-label="Recent Jetstream repository events">
          {data.recent.map((event: any) => <Event event={event} key={event.seq} />)}
          {!data.recent.length ? <li className="empty">{loaded ? 'No repository rows received yet.' : 'Loading repository rows…'}</li> : null}
        </ol>
      </section>

      <section className="lower-grid">
        <article className="module namespaces">
          <ModuleHead title="Top lexicon families" note={`sorted by ${loaded ? 'current records' : 'loading'}`} />
          <div className="table-scroll family-table-wrap" tabIndex={0} role="region" aria-label="Top lexicon families table">
            <table className="family-table">
              <caption className="sr-only">Top current lexicon families, sorted by current records</caption>
              <thead><tr><th>Family</th><th>Records</th><th>Collections</th></tr></thead>
              <tbody>{shownFamilies.map((family: any) => <tr key={family.name}>
                <td translate="no"><strong>{family.name}</strong><small className="collection-list">{family.collections.map((collection: any) => collection.name).join(', ')}</small><span className="bar" aria-hidden="true" style={{ width: `${family.records / maxFamily * 100}%` }} /></td>
                <td>{exact(family.records)}</td><td>{exact(family.collections.length)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {!shownFamilies.length ? <p className="empty">{loaded ? 'No current records in the fold.' : 'Loading lexicon families…'}</p> : null}
          {omittedFamilies > 0 ? <p className="omitted">{omittedFamilies} additional families are not shown.</p> : null}
        </article>
        <DeclaredTrend data={data.declaredMonthly} />
        <LiveTrend data={data.recentActivityDaily} />
      </section>

    </main>
    <footer><Token label="Copy Jetstream service" value={service} placeholder="Jetstream v2" /><span translate="no">cursor {data.cursorText}</span></footer>
  </>
}

function Register({ name, value, note }: any) { return <dl className="register"><dt>{name}</dt><dd className="register-value">{value}</dd><dd className="register-note">{note}</dd></dl> }
function ModuleHead({ title, note }: any) { return <div className="module-head"><h2>{title}</h2>{note ? <span>{note}</span> : null}</div> }

function DeclaredTrend({ data }: any) {
  const [selected, setSelected] = useState<number | null>(null)
  const [tabStop, setTabStop] = useState(0)
  const chartRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<Array<HTMLButtonElement | null>>([])
  const max = Math.max(...data.map((bucket: any) => bucket.count), 1)

  useEffect(() => {
    if (selected === null) return
    const dismissKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null)
    }
    const dismissPointer = (event: PointerEvent) => {
      if (chartRef.current && !chartRef.current.contains(event.target as Node)) { barRefs.current[selected]?.blur(); setSelected(null) }
    }
    window.addEventListener('keydown', dismissKey)
    document.addEventListener('pointerdown', dismissPointer)
    return () => { window.removeEventListener('keydown', dismissKey); document.removeEventListener('pointerdown', dismissPointer) }
  }, [selected])

  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else if (event.key === 'ArrowRight') next = Math.min(data.length - 1, index + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = data.length - 1
    else return
    event.preventDefault()
    setTabStop(next)
    barRefs.current[next]?.focus()
  }
  const selectBar = (index: number, element: HTMLButtonElement) => {
    setTabStop(index)
    setSelected(current => current === index ? null : index)
    element.scrollIntoView({ block: 'nearest', inline: 'center' })
  }
  const labelIndexes = axisIndexes(data.length)
  const plotStyle = { '--bucket-count': Math.max(data.length, 1) } as CSSProperties

  return <article className="module trend records-timeline">
    <ModuleHead title="Records timeline" note={`${exact(data.length)} months`} />
    <figure>
      <div className="chart-scroll" ref={chartRef}>
        <div className="monthly-plot" style={plotStyle}>
          <div className="trend-chart single" aria-label="Monthly record counts">
            <span className="y-label y-max" aria-hidden="true">{exact(max)}</span><span className="y-label y-zero" aria-hidden="true">0</span>
            {data.map((bucket: any, index: number) => {
              const selectedBar = selected === index
              const tooltipId = `month-tooltip-${index}`
              const edge = index < 3 ? 'tooltip-start' : index >= data.length - 3 ? 'tooltip-end' : ''
              return <button
                ref={element => { barRefs.current[index] = element }}
                type="button"
                className={`trend-col month-bar ${selectedBar ? 'selected' : ''} ${edge}`}
                key={bucket.month}
                tabIndex={(tabStop < data.length ? tabStop : 0) === index ? 0 : -1}
                aria-label={`${monthRange(bucket.month)}: ${exact(bucket.count)} records`}
                aria-pressed={selectedBar}
                aria-describedby={selectedBar ? tooltipId : undefined}
                onFocus={() => setTabStop(index)}
                onKeyDown={event => moveFocus(event, index)}
                onClick={event => selectBar(index, event.currentTarget)}
              >
                <Segment value={bucket.count} max={max} />
                {selectedBar ? <span id={tooltipId} className="chart-tooltip" role="tooltip"><strong>{exact(bucket.count)} records</strong><small>{monthRange(bucket.month)}</small></span> : null}
              </button>
            })}
          </div>
          <div className="x-axis" aria-hidden="true">{labelIndexes.map(index => <span key={data[index].month}>{shortMonth(data[index].month)}</span>)}</div>
        </div>
      </div>
      <figcaption>{data.length ? 'Bars show records grouped by month.' : 'No dated records found.'}</figcaption>
    </figure>
    <TrendData label="Current records by month" data={data} field="month" compact summary="View Records Table" />
  </article>
}

function LiveTrend({ data }: any) {
  const max = Math.max(...data.map((bucket: any) => bucket.count), 1)
  const total = data.reduce((sum: number, bucket: any) => sum + bucket.count, 0)
  return <article className="module trend">
    <ModuleHead title="Recent activity" note="last 14 days" />
    <figure>
      <div className="trend-chart" aria-hidden="true">{data.map((bucket: any) => <div className="trend-col" key={bucket.day}><Segment kind="create" value={bucket.creates} max={max} /><Segment kind="update" value={bucket.updates} max={max} /><Segment kind="delete" value={bucket.deletes} max={max} /><Segment kind="marker" value={bucket.markers} max={max} /></div>)}</div>
      <figcaption>{`${exact(total)} record changes in the displayed period. Empty dates render as zero.`}</figcaption>
    </figure>
    <Range data={data} field="day" />
    <div className="legend"><span><i className="legend-dot create" /> create</span><span><i className="legend-dot update" /> update</span><span><i className="legend-dot delete" /> delete</span><span><i className="legend-dot marker" /> marker</span></div>
    <TrendData label="Record changes by day" data={data} field="day" summary="View Activity Table" />
  </article>
}

function TrendData({ label, data, field, compact = false, summary }: any) {
  const operations = data.some((bucket: any) => 'creates' in bucket)
  const table = <table className={compact ? 'compact-table' : 'activity-table'}>
    <caption>{label}</caption>
    <thead><tr><th>Date</th><th>{operations ? 'Total' : 'Records'}</th>{operations ? <><th>Create</th><th>Update</th><th>Delete</th><th>Marker</th></> : null}</tr></thead>
    <tbody>{data.map((bucket: any) => <tr key={bucket[field]}><td>{field === 'month' ? monthName(bucket[field]) : dayName(bucket[field])}</td><td>{exact(bucket.count)}</td>{operations ? <><td>{exact(bucket.creates)}</td><td>{exact(bucket.updates)}</td><td>{exact(bucket.deletes)}</td><td>{exact(bucket.markers)}</td></> : null}</tr>)}</tbody>
  </table>
  return <details className={`trend-data ${compact ? 'compact' : ''}`}><summary>{summary}</summary>{operations ? <div className="table-scroll" tabIndex={0} role="region" aria-label={`${label} table`}>{table}</div> : table}</details>
}

function Segment({ kind, value, max }: any) { return value > 0 ? <i className={kind} style={{ height: `${value / max * 100}%` }} /> : null }
function Range({ data, field }: any) { return <div className="dates"><span>{data[0]?.[field] ? shortDay(data[0][field]) : '--'}</span><span>{data.at(-1)?.[field] ? shortDay(data.at(-1)[field]) : '--'}</span></div> }
function Event({ event }: any) {
  const [expanded, setExpanded] = useState(false)
  const operation = event.operation ?? event.kind
  const detailId = `event-detail-${event.seq}`
  const hasRecord = event.record && typeof event.record === 'object'
  return <li className={`event ${expanded ? 'expanded' : ''}`}>
    <button type="button" className="event-trigger" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(current => !current)}>
      <span className="event-summary"><span className="event-primary"><span className={`event-operation ${operation}`}>{operation}</span><strong translate="no" title={event.collection && event.rkey ? `${event.collection}/${event.rkey}` : event.collection ?? event.kind}>{event.collection ?? event.kind}{event.rkey ? <span className="event-rkey">/{event.rkey}</span> : null}</strong></span><time dateTime={event.time}><span>{formatEventDate(event.time)}</span><small>{formatEventTime(event.time)}</small></time></span>
      <span className="event-toggle" aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    <div id={detailId} className="event-detail" hidden={!expanded}>
      <div className="event-detail-head"><span>record payload</span>{event.rkey ? <span translate="no">rkey {event.rkey}</span> : null}</div>
      {hasRecord ? <pre><code>{JSON.stringify(event.record, null, 2)}</code></pre> : <p className="event-no-record">This event has no record payload.</p>}
    </div>
  </li>
}

function Token({ label, value, placeholder, className = '', prefix = '' }: any) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  if (!value) return <span className={`token-placeholder ${className}`} translate="no">{placeholder}</span>
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setStatus('idle'), 2400)
  }
  return <span className={`token-wrap ${className}`} translate="no"><button type="button" className="token" onClick={() => void copy()} aria-label={label} title={value}><span className="token-value">{prefix}{value}</span></button><span className={`copy-status ${status}`} role="status" aria-live="polite">{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed. Select the full value below.' : ''}</span>{status === 'failed' ? <code className="copy-fallback">{value}</code> : null}</span>
}

function display(loaded: boolean, value: number | undefined) { return loaded ? exact(value) : '—' }
const locales = navigator.languages?.length ? navigator.languages : [navigator.language]
function exact(value: number | undefined) { return new Intl.NumberFormat(locales).format(value ?? 0) }
function axisIndexes(length: number) { if (length <= 4) return Array.from({ length }, (_, index) => index); return [0, Math.round((length - 1) / 3), Math.round((length - 1) * 2 / 3), length - 1].filter((index, position, values) => values.indexOf(index) === position) }
function shortMonth(month: string) { return new Intl.DateTimeFormat(locales, { month: 'short', year: '2-digit' }).format(monthDate(month)) }
function monthName(month: string) { return new Intl.DateTimeFormat(locales, { month: 'long', year: 'numeric' }).format(monthDate(month)) }
function monthRange(month: string) { const start = monthDate(month), end = new Date(start.getFullYear(), start.getMonth() + 1, 0); return `${new Intl.DateTimeFormat(locales, { month: 'short', day: 'numeric' }).format(start)}–${new Intl.DateTimeFormat(locales, { day: 'numeric', year: 'numeric' }).format(end)}` }
function formatEventDate(value: string) { return new Intl.DateTimeFormat(locales, { month: 'short', day: 'numeric' }).format(new Date(value)) }
function formatEventTime(value: string) { return new Intl.DateTimeFormat(locales, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(value)) }
function dayName(day: string) { return new Intl.DateTimeFormat(locales, { month: 'short', day: 'numeric', year: 'numeric' }).format(dayDate(day)) }
function shortDay(day: string) { return new Intl.DateTimeFormat(locales, { month: 'short', day: 'numeric' }).format(dayDate(day)) }
function monthDate(month: string) { const [year, value] = month.split('-').map(Number); return new Date(year, value - 1, 1) }
function dayDate(day: string) { const [year, month, value] = day.split('-').map(Number); return new Date(year, month - 1, value) }
function statusLabel(value: string) { return value === 'streaming' ? 'LIVE' : value === 'backfilling' ? 'RECONSTRUCTING' : value === 'retrying' ? 'RETRYING' : value === 'offline' ? 'OFFLINE' : 'CONNECTING' }
function verifiedBy(profile: any) { const verification = profile.verification?.verifications?.find((item: any) => item.isValid); if (!verification) return ''; return verification.issuerHandle ? `@${verification.issuerHandle}` : verification.issuerDisplayName ?? verification.issuer ?? '' }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
