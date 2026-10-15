/**
 * 生成 PWA 图标（纯 Node，无原生依赖）。
 * 图形：一个带缺口的进度环 + 缺口端点圆点，品牌绿底。
 * 用法：node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'icons')

const BRAND = [0x2f, 0x7d, 0x5b]
const FG = [0xff, 0xff, 0xff]

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const inRoundedRect = (x, y, radius) => {
  const r = radius
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r || (x >= r && x <= 1 - r) || (y >= r && y <= 1 - r)
}

function render(size, { rounded, padScale }) {
  const SS = 4
  const out = Buffer.alloc(size * size * 4)
  const cx = 0.5
  const cy = 0.52
  const rOuter = 0.30 * padScale
  const rInner = 0.205 * padScale
  const dotR = 0.055 * padScale
  const gapFrom = -104
  const gapTo = -46
  const dotAngle = gapTo * (Math.PI / 180)
  const dotR0 = (rOuter + rInner) / 2
  const dotX = cx + Math.cos(dotAngle) * dotR0
  const dotY = cy + Math.sin(dotAngle) * dotR0

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          let pr = 0
          let pg = 0
          let pb = 0
          let pa = 0
          const insideBg = rounded ? inRoundedRect(x, y, 0.22) : true
          if (insideBg) {
            pr = BRAND[0]; pg = BRAND[1]; pb = BRAND[2]; pa = 255
          }
          const dx = x - cx
          const dy = y - cy
          const dist = Math.sqrt(dx * dx + dy * dy)
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI
          const inRing = dist <= rOuter && dist >= rInner && !(angle >= gapFrom && angle <= gapTo)
          const inDot = (x - dotX) ** 2 + (y - dotY) ** 2 <= dotR * dotR
          if (inRing || inDot) {
            pr = FG[0]; pg = FG[1]; pb = FG[2]; pa = 255
          }
          r += pr; g += pg; b += pb; a += pa
        }
      }
      const n = SS * SS
      const idx = (py * size + px) * 4
      out[idx] = Math.round(r / n)
      out[idx + 1] = Math.round(g / n)
      out[idx + 2] = Math.round(b / n)
      out[idx + 3] = Math.round(a / n)
    }
  }
  return encodePng(size, size, out)
}

mkdirSync(outDir, { recursive: true })
const jobs = [
  { file: 'icon-192.png', size: 192, opts: { rounded: true, padScale: 1 } },
  { file: 'icon-512.png', size: 512, opts: { rounded: true, padScale: 1 } },
  { file: 'maskable-512.png', size: 512, opts: { rounded: false, padScale: 0.72 } },
  { file: 'apple-touch-icon-180.png', size: 180, opts: { rounded: false, padScale: 1 } }
]
for (const job of jobs) {
  const buf = render(job.size, job.opts)
  writeFileSync(join(outDir, job.file), buf)
  console.log(`${job.file}  ${buf.length} bytes`)
}