import { Resvg } from '@resvg/resvg-js'
import type { FastifyInstance } from 'fastify'

export function registerOpenGraphRoute(app: FastifyInstance) {
  // The poster is independent of account data; rasterize once per server start.
  const image = new Resvg(renderOpenGraphSvg()).render().asPng()
  app.get('/opengraph.png', async (_request, reply) => reply
    .header('Content-Type', 'image/png')
    .header('Cache-Control', 'public, max-age=3600, s-maxage=86400')
    .send(image))
}

export function renderOpenGraphSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#062c26"/>
  <path d="M900 0H1200V630H720Z" fill="#90f5b5"/>
  <g font-family="DejaVu Sans, sans-serif">
    <text x="1035" y="425" text-anchor="middle" font-size="490" font-weight="700" fill="#062c26" transform="rotate(-12 1035 315)">@</text>
    <g fill="#e5ffef">
      <text x="64" y="187" font-size="88" font-weight="700" letter-spacing="-5">Atmosphere</text>
      <text x="64" y="282" font-size="88" font-weight="700" letter-spacing="-5">Activity</text>
      <text x="68" y="391" font-size="30">An AT Protocol identity</text>
      <text x="68" y="433" font-size="30">activity dashboard.</text>
    </g>
    <text x="68" y="556" fill="#90f5b5" font-size="18">Profile signals. Repository records. Recent activity.</text>
  </g>
</svg>`
}
