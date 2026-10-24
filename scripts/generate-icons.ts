import { Resvg } from '@resvg/resvg-js'
import { readFile, writeFile } from 'node:fs/promises'

const publicDir = new URL('../public/', import.meta.url)
const svg = await readFile(new URL('favicon.svg', publicDir), 'utf8')
const background = '#062c26'

function render(size: number, source = svg, opaque = false) {
  return new Resvg(source, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
    ...(opaque ? { background } : {}),
  }).render()
}

for (const size of [16, 32]) {
  await writeFile(new URL(`favicon-${size}x${size}.png`, publicDir), render(size).asPng())
}
for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['android-chrome-192x192.png', 192],
  ['android-chrome-512x512.png', 512],
  ['mstile-150x150.png', 150],
] as const) {
  await writeFile(new URL(name, publicDir), render(size, svg, true).asPng())
}

// Keep the whole badge inside the central 80%-diameter maskable safe circle.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><g transform="translate(8 8) scale(.75)">${svg}</g></svg>`
await writeFile(new URL('icon-maskable-512x512.png', publicDir), render(512, maskable, true).asPng())

// Safari needs a monochrome silhouette with transparent cutouts.
const pinned = svg
  .replace(/<circle id="disc-background"[^>]*\/>/, '')
  .replace('fill="#90f5b5"', 'fill="#000000"')
await writeFile(new URL('safari-pinned-tab.svg', publicDir), pinned)

// Classic BMP-backed ICO entries work in older clients as well as modern browsers.
const sizes = [16, 32, 48]
const directory = Buffer.alloc(6 + sizes.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
const entries: Buffer[] = []
let offset = directory.length
for (const [index, size] of sizes.entries()) {
  const pixels = render(size).pixels
  const maskStride = Math.ceil(size / 32) * 4
  const bitmapSize = size * size * 4
  const bitmap = Buffer.alloc(40 + bitmapSize + maskStride * size)
  bitmap.writeUInt32LE(40, 0)
  bitmap.writeInt32LE(size, 4)
  bitmap.writeInt32LE(size * 2, 8)
  bitmap.writeUInt16LE(1, 12)
  bitmap.writeUInt16LE(32, 14)
  bitmap.writeUInt32LE(bitmapSize, 20)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4
      const target = 40 + ((size - y - 1) * size + x) * 4
      bitmap[target] = pixels[source + 2]
      bitmap[target + 1] = pixels[source + 1]
      bitmap[target + 2] = pixels[source]
      bitmap[target + 3] = pixels[source + 3]
      if (pixels[source + 3] === 0) {
        bitmap[40 + bitmapSize + (size - y - 1) * maskStride + (x >> 3)] |= 0x80 >> (x % 8)
      }
    }
  }
  const entry = 6 + index * 16
  directory[entry] = size
  directory[entry + 1] = size
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(bitmap.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  entries.push(bitmap)
  offset += bitmap.length
}
await writeFile(new URL('favicon.ico', publicDir), Buffer.concat([directory, ...entries]))
console.log('Generated browser, Apple, Android, maskable, Safari, and Windows icons from public/favicon.svg')
