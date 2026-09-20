// Live3D 图标生成器:256×256 RGBA PNG,零依赖(node:zlib 压缩 + 手写 PNG 块)。
// 造型对齐 src/orb.ts 的缺省小球:紫色亮面球身(#8b7fd6)、两只深色椭圆眼带高光、下弧笑嘴、一圈斜环、腮红。
// 用法:npm run icon(= node scripts/make-icon.mjs icon.png)
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const W = 256, H = 256, SS = 4
const out = process.argv[2] || 'icon.png'
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x))

const BG_TOP = hex('#f5f2ff'), BG_BOT = hex('#e2dafa')
const BODY = hex('#8b7fd6'), INK = hex('#1b2130'), WHITE = [255, 255, 255], BLUSH = hex('#ff9fb4'), RING = hex('#b9aef0')
const C = { x: 128, y: 122, r: 76 }
const L = (() => { const v = [-0.45, -0.62, 0.64]; const n = Math.hypot(...v); return v.map((x) => x / n) })()
const HV = (() => { const v = [L[0], L[1], L[2] + 1]; const n = Math.hypot(...v); return v.map((x) => x / n) })()
const TILT = (-14 * Math.PI) / 180

function inRoundRect(x, y, r) {
  const qx = Math.max(Math.abs(x - 128) - (128 - r), 0), qy = Math.max(Math.abs(y - 128) - (128 - r), 0)
  return Math.hypot(qx, qy) <= r
}
function ringHit(x, y) {
  // 斜椭圆环:在旋转坐标里判 (u/rx)²+(v/ry)² 落在两条椭圆之间
  const dx = x - C.x, dy = y - (C.y + 8)
  const u = dx * Math.cos(-TILT) - dy * Math.sin(-TILT)
  const v = dx * Math.sin(-TILT) + dy * Math.cos(-TILT)
  const outer = (u / 110) ** 2 + (v / 30) ** 2, inner = (u / 102) ** 2 + (v / 24) ** 2
  return { on: outer <= 1 && inner >= 1, front: v > 0 }
}

/** 一个采样点的颜色 [r,g,b,a](a 0..1),从后往前叠。 */
function sample(x, y) {
  if (!inRoundRect(x, y, 58)) return [0, 0, 0, 0]
  let col = mix(BG_TOP, BG_BOT, y / H)
  const blend = (c, a) => { col = mix(col, c, clamp(a)) }
  // 地面阴影
  const sh = ((x - 128) / 60) ** 2 + ((y - 214) / 9) ** 2
  if (sh < 1) blend([70, 52, 140], 0.2 * (1 - sh))
  const ring = ringHit(x, y)
  if (ring.on && !ring.front) blend(RING, 0.9)
  // 球身
  const dx = x - C.x, dy = y - C.y, d2 = dx * dx + dy * dy
  if (d2 <= C.r * C.r) {
    const nx = dx / C.r, ny = dy / C.r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
    const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2])
    const spec = Math.pow(Math.max(0, nx * HV[0] + ny * HV[1] + nz * HV[2]), 60)
    const rim = Math.pow(1 - nz, 3)
    let c = BODY.map((v) => v * (0.62 + 0.5 * diff))
    c = mix(c, WHITE, rim * 0.18)
    c = mix(c, WHITE, clamp(spec * 0.85))
    col = c
    // 腮红
    for (const bx of [86, 170]) {
      const b = ((x - bx) / 12) ** 2 + ((y - 146) / 7) ** 2
      if (b < 1) blend(BLUSH, 0.5 * (1 - b))
    }
    // 眼睛 + 高光
    for (const ex of [101, 155]) {
      if (((x - ex) / 11) ** 2 + ((y - 118) / 16) ** 2 <= 1) {
        col = INK
        if ((x - (ex + 4)) ** 2 + (y - 111) ** 2 <= 16) col = WHITE
      }
    }
    // 笑嘴:下半圆弧
    const mx = x - 128, my = y - 134, md = Math.hypot(mx, my)
    if (my > 4 && Math.abs(md - 18) <= 3) col = INK
  }
  if (ring.on && ring.front) blend(RING, 0.95)
  // 右上角一颗小星星(done 阶段的星星)
  const sx = x - 204, sy = y - 58
  if (Math.abs(sx) * Math.abs(sy) < 22 && Math.abs(sx) + Math.abs(sy) < 16) blend(hex('#ffd36b'), 1)
  return [...col, 1]
}

const px = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const [cr, cg, cb, ca] = sample(x + (i + 0.5) / SS, y + (j + 0.5) / SS)
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca
    }
    const o = (y * W + x) * 4
    const n = SS * SS
    px[o] = a ? Math.round(r / a) : 0
    px[o + 1] = a ? Math.round(g / a) : 0
    px[o + 2] = a ? Math.round(b / a) : 0
    px[o + 3] = Math.round((a / n) * 255)
  }
}

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(H * (W * 4 + 1))
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4) }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
