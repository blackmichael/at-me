import { Resvg } from '@resvg/resvg-js'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

type OpenGraphEvent = {
  time?: unknown
  kind?: unknown
  operation?: unknown
  collection?: unknown
  rkey?: unknown
}

type OpenGraphProfile = {
  avatar?: unknown
  displayName?: unknown
  handle?: unknown
  verification?: unknown
}

type OpenGraphSnapshot = {
  records: number
  families: unknown[]
  recordTypes: number
  activity24h: number
  recent: OpenGraphEvent[]
}

export type OpenGraphState = {
  profile: OpenGraphProfile
  snapshot: OpenGraphSnapshot
  ingestion: string
}

const width = 1200
const height = 630
const avatarLimit = 512 * 1024
const avatarCacheMs = 5 * 60_000
let avatarCache: { url: string; expiresAt: number; value: Promise<string | undefined> } | undefined
const statusLabels: Record<string, string> = { streaming: 'LIVE', offline: 'OFFLINE', backfilling: 'RECONSTRUCTING', retrying: 'RETRYING' }
const fontPath = fileURLToPath(new URL('./IBMPlexMono-Regular.ttf', import.meta.url))

export function registerOpenGraphRoute(app: FastifyInstance, current: () => OpenGraphState) {
  app.get('/opengraph.png', async (_request, reply) => {
    const state = current()
    const avatar = await loadAvatar(state.profile.avatar)
    const image = new Resvg(renderOpenGraphSvg(state, avatar), {
      fitTo: { mode: 'original' },
      font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' }
    }).render().asPng()
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=60, s-maxage=300')
      .send(image)
  })
}

export function renderOpenGraphSvg(state: OpenGraphState, avatar?: string) {
  const { profile, snapshot } = state
  const handle = text(profile.handle) || 'AT Protocol account'
  const displayName = truncate(text(profile.displayName) || handle, 44)
  const handleLabel = truncate(handle.startsWith('@') ? handle : `@${handle}`, 58)
  const issuer = verificationIssuer(profile)
  const avatarMarkup = avatar
    ? `<defs><clipPath id="avatar-clip"><circle cx="112" cy="151" r="46"/></clipPath></defs><circle cx="112" cy="151" r="47" fill="#082114" stroke="#4e705a"/><image x="66" y="105" width="92" height="92" href="${escapeXml(avatar)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>`
    : ''
  const profileX = avatar ? 184 : 64
  const verificationMarkup = issuer
    ? `<text x="${profileX}" y="205" fill="#75ad82" font-size="14">Verified by ${escapeXml(truncate(issuer, 64))}</text>`
    : ''
  const status = statusLabels[state.ingestion] ?? 'CONNECTING'
  const statusColor = status === 'LIVE' ? '#5cff8a' : status === 'OFFLINE' ? '#d67968' : '#e7c86b'
  const eventRows = snapshot.recent.slice(0, 3).map(renderEvent).join('')
  const activityMarkup = eventRows || '<text x="82" y="474" fill="#75ad82" font-size="14">No repository rows received yet.</text>'

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="scanlines" width="1" height="4" patternUnits="userSpaceOnUse"><path d="M0 0h1" stroke="#8cffaa" stroke-opacity=".035"/></pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="#020604"/>
  <rect width="${width}" height="${height}" fill="url(#scanlines)"/>
  <g font-family="'IBM Plex Mono',monospace">
    <path d="M0 70H1200" stroke="#4e705a"/>
    <text x="56" y="43" fill="#d5ffe0" font-size="18" letter-spacing="1.4">ATMOSPHERE ACTIVITY</text>
    <circle cx="1068" cy="38" r="4" fill="${statusColor}"/>
    <text x="1082" y="43" fill="${statusColor}" font-size="13">${status}</text>

    ${avatarMarkup}
    <text x="${profileX}" y="151" fill="#d5ffe0" font-size="34">${escapeXml(displayName)}</text>
    <text x="${profileX}" y="180" fill="#5cff8a" font-size="16">${escapeXml(handleLabel)}</text>
    ${verificationMarkup}

    <rect x="56" y="230" width="1088" height="140" fill="#031007" stroke="#4e705a"/>
    <path d="M56 272H1144M328 272V370M600 272V370M872 272V370" stroke="#4e705a"/>
    <text x="78" y="257" fill="#d5ffe0" font-size="16">Repository state</text>
    ${stat(78, 'RECORDS STORED', snapshot.records)}
    ${stat(350, 'LEXICON FAMILIES', snapshot.families.length)}
    ${stat(622, 'RECORD TYPES', snapshot.recordTypes)}
    ${stat(894, '24-HOUR ACTIVITY', snapshot.activity24h)}

    <rect x="56" y="392" width="1088" height="210" fill="#031007" stroke="#4e705a"/>
    <path d="M56 434H1144" stroke="#4e705a"/>
    <text x="78" y="419" fill="#d5ffe0" font-size="16">Recent events</text>
    ${activityMarkup}
  </g>
</svg>`
}

function stat(x: number, label: string, value: number) {
  return `<text x="${x}" y="300" fill="#75ad82" font-size="12">${label}</text><text x="${x}" y="343" fill="#d5ffe0" font-size="28">${new Intl.NumberFormat('en-US').format(Number.isFinite(value) ? value : 0)}</text>`
}

function renderEvent(event: OpenGraphEvent, index: number) {
  const y = 474 + index * 40
  const operation = text(event.operation) || text(event.kind) || 'event'
  const color = operation === 'create' ? '#5cff8a' : operation === 'update' ? '#e7c86b' : operation === 'delete' ? '#d67968' : '#75ad82'
  const collection = text(event.collection) || text(event.kind) || 'event'
  const key = text(event.rkey)
  const item = truncate(key ? `${collection}/${key}` : collection, 76)
  const time = typeof event.time === 'string' && Number.isFinite(Date.parse(event.time))
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(event.time))
    : ''
  return `<text x="82" y="${y}" fill="${color}" font-size="12">${escapeXml(operation.toUpperCase())}</text><text x="190" y="${y}" fill="#d5ffe0" font-size="14">${escapeXml(item)}</text><text x="1118" y="${y}" text-anchor="end" fill="#75ad82" font-size="12">${escapeXml(time)}</text>${index < 2 ? `<path d="M78 ${y + 14}H1122" stroke="#082114"/>` : ''}`
}

function verificationIssuer(profile: OpenGraphProfile) {
  const value = profile.verification
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('verifications' in value) || !Array.isArray(value.verifications)) return ''
  const valid = value.verifications.find(isValidVerification)
  if (!valid) return ''
  const handle = 'issuerHandle' in valid ? text(valid.issuerHandle) : ''
  if (handle) return handle.startsWith('@') ? handle : `@${handle}`
  return ('issuerDisplayName' in valid ? text(valid.issuerDisplayName) : '') || ('issuer' in valid ? text(valid.issuer) : '')
}

type ValidVerification = { isValid: true }
function isValidVerification(value: unknown): value is ValidVerification {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'isValid' in value && value.isValid === true
}



function text(value: unknown) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '') : '' }
function truncate(value: string, length: number) { const chars = Array.from(value); return chars.length > length ? `${chars.slice(0, length - 1).join('')}…` : value }
function escapeXml(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }

async function loadAvatar(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string') return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.bsky.app' || !url.pathname.startsWith('/img/avatar/') || url.username || url.password) return undefined
  if (avatarCache?.url === url.href && avatarCache.expiresAt > Date.now()) return avatarCache.value
  const pending = fetchAvatar(url.href)
  avatarCache = { url: url.href, expiresAt: Date.now() + avatarCacheMs, value: pending }
  return pending
}

async function fetchAvatar(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: 'image/jpeg,image/png,image/webp' }, redirect: 'error', signal: AbortSignal.timeout(2_000) })
    const mime = response.headers.get('content-type')?.split(';', 1)[0]
    if (!response.ok || !mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return undefined
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > avatarLimit) return undefined
    if (!response.body) return undefined
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > avatarLimit) { await reader.cancel(); return undefined }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return total ? `data:${mime};base64,${Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('base64')}` : undefined
  } catch { return undefined }
}
