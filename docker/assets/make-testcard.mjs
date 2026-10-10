#!/usr/bin/env node
// Deterministic generator for the RFB test servers' screen content (docker/README.md).
//
//   node docker/assets/make-testcard.mjs     writes, next to this script:
//     testcard.png      1000x750 RGB test card, shown full screen as the X root window background
//     cursor.png        12x19 RGBA: the X cursor shape set on the root window (hotspot 11,18)
//     cursor.xbm        cursor source bitmap (1 = foreground colour), with x_hot/y_hot
//     cursor-mask.xbm   cursor mask bitmap (1 = visible)
//
// Plain Node, no dependencies; same output on every run and platform. Commit the outputs.
//
// The card exercises the encoders' sub-modes: large solid areas, 2-colour areas (glyphs,
// checkerboards, stripes), <= 16 colours, ~100 colours with runs, smooth gradients, seeded noise and
// sharp shapes. Panel edges are deliberately off the 16- and 64-pixel tile grids, and 1000x750 is
// not a multiple of 16, so encoders produce partial edge tiles.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const W = 1000
const H = 750
const out = dirname(fileURLToPath(import.meta.url))

const img = new Uint8Array(W * H * 3)

function set(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 3
  img[i] = c[0]
  img[i + 1] = c[1]
  img[i + 2] = c[2]
}

function fill(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c)
}

// mulberry32: small seeded PRNG, identical everywhere.
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

// 5x7 bitmap font: each glyph is 7 rows of 5 bits (MSB = leftmost column).
const FONT = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14],
  1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2],
  5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14],
  7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 12, 4, 8],
  ':': [0, 12, 12, 0, 12, 12, 0],
  '/': [0, 1, 2, 4, 8, 16, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '=': [0, 0, 31, 0, 31, 0, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  '#': [10, 10, 31, 10, 31, 10, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
}

// Draws text with a 6x9 cell per character at scale 1; returns the x after the last glyph.
function text(x0, y0, str, fg, scale = 1) {
  let x = x0
  for (const ch of str) {
    const g = FONT[ch]
    if (!g) throw new Error(`no glyph for ${JSON.stringify(ch)}`)
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) if (g[r] & (16 >> c)) fill(x + c * scale, y0 + r * scale, scale, scale, fg)
    x += 6 * scale
  }
  return x
}

// --- Layout ---------------------------------------------------------------------------------------
// Columns and rows of panels (x, width / y, height); none starts on a 16-pixel boundary.
const C1 = [9, 297]
const C2 = [317, 321]
const C3 = [649, 342]
const R1 = [9, 195]
const R2 = [215, 195]
const R3 = [421, 195]
const R4 = [627, 114]

// Background: one solid colour behind everything (large solid areas between panels).
fill(0, 0, W, H, [29, 53, 87])

// 1-pixel white frame on the screen edge, with 4x4 coloured corner markers (edge-tile checks).
fill(0, 0, W, 1, [255, 255, 255])
fill(0, H - 1, W, 1, [255, 255, 255])
fill(0, 0, 1, H, [255, 255, 255])
fill(W - 1, 0, 1, H, [255, 255, 255])
fill(0, 0, 4, 4, [255, 0, 0])
fill(W - 4, 0, 4, 4, [0, 255, 0])
fill(0, H - 4, 4, 4, [0, 0, 255])
fill(W - 4, H - 4, 4, 4, [255, 0, 255])

// A1: one large solid rectangle.
fill(C1[0], R1[0], C1[1], R1[1], [241, 250, 238])

// A2: colour bars (top 3/4 at full intensity, bottom 1/4 reversed at 75%).
{
  const bars = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 0],
  ]
  const [x0, w] = C2
  const [y0, h] = R1
  const split = Math.round((h * 3) / 4)
  for (let i = 0; i < 8; i++) {
    const xa = x0 + Math.round((i * w) / 8)
    const xb = x0 + Math.round(((i + 1) * w) / 8)
    fill(xa, y0, xb - xa, split, bars[i])
    const rev = bars[7 - i].map((v) => Math.round(v * 0.75))
    fill(xa, y0 + split, xb - xa, h - split, rev)
  }
}

// A3: smooth 2-D gradient (red across, green down, blue falling diagonally).
{
  const [x0, w] = C3
  const [y0, h] = R1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1)
      const v = y / (h - 1)
      set(x0 + x, y0 + y, [Math.round(255 * u), Math.round(255 * v), Math.round(255 * (1 - u) * (1 - v))])
    }
}

// B1: 2-colour text panels (black on white, then dark green on cream, at scales 1 and 2).
{
  const [x0, w] = C1
  const [y0, h] = R2
  const top = 118
  fill(x0, y0, w, top, [255, 255, 255])
  const ink = [0, 0, 0]
  const lines = [
    'RFB2 TEST CARD 1000x750 DEPTH 24',
    'THE QUICK BROWN FOX JUMPS OVER',
    'THE LAZY DOG. 0123456789 (+-=/:#,)',
    'GENERATED BY',
    'DOCKER/ASSETS/MAKE-TESTCARD.MJS',
  ]
  for (const [i, l] of lines.entries()) text(x0 + 5, y0 + 5 + i * 9, l, ink)
  text(x0 + 5, y0 + 55, 'RAW HEXTILE ZRLE', ink, 2)
  text(x0 + 5, y0 + 75, 'TIGHT ZLIB RRE', ink, 2)
  text(x0 + 5, y0 + 95, 'COPYRECT', ink, 2)
  fill(x0, y0 + top, w, h - top, [250, 240, 200])
  const green = [0, 90, 40]
  text(x0 + 7, y0 + top + 6, 'NOT A MULTIPLE OF 16:', green)
  text(x0 + 7, y0 + top + 16, '1000 = 62x16 + 8, 750 = 46x16 + 14', green)
  text(x0 + 7, y0 + top + 30, 'EDGE TILES', green, 3)
  text(x0 + 7, y0 + top + 58, 'SEED 0x52464232', green)
}

// B2: 2x2 sub-panels of 2-colour patterns.
{
  const [x0, w] = C2
  const [y0, h] = R2
  const wl = 161
  const ht = 97
  // 1-pixel checkerboard, black / white
  for (let y = 0; y < ht; y++)
    for (let x = 0; x < wl; x++) set(x0 + x, y0 + y, (x + y) & 1 ? [0, 0, 0] : [255, 255, 255])
  // 2-pixel checkerboard, crimson / teal
  for (let y = 0; y < ht; y++)
    for (let x = wl; x < w; x++) set(x0 + x, y0 + y, ((x >> 1) + (y >> 1)) & 1 ? [220, 20, 60] : [0, 200, 200])
  // vertical stripes of widths 1, 2, 3, amber / charcoal
  for (let x = 0, k = 0; x < wl; k++) {
    const sw = (k % 3) + 1
    fill(x0 + x, y0 + ht, Math.min(sw, wl - x), h - ht, k & 1 ? [40, 40, 40] : [255, 200, 0])
    x += sw
  }
  // horizontal 1-pixel lines with a diagonal hatch, blue / white
  for (let y = ht; y < h; y++)
    for (let x = wl; x < w; x++) set(x0 + x, y0 + y, y & 1 || (x + y) % 7 === 0 ? [0, 0, 255] : [255, 255, 255])
}

// B3: 12 colours: random rectangles from a fixed palette.
{
  const [x0, w] = C3
  const [y0, h] = R2
  const pal = [
    [0, 0, 0],
    [255, 255, 255],
    [128, 0, 0],
    [0, 128, 0],
    [0, 0, 128],
    [128, 128, 0],
    [0, 128, 128],
    [128, 0, 128],
    [255, 128, 0],
    [192, 192, 192],
    [64, 64, 64],
    [255, 105, 180],
  ]
  const rnd = prng(0x52464201)
  fill(x0, y0, w, h, pal[9])
  for (let i = 0; i < 90; i++) {
    const rw = int(rnd, 3, 70)
    const rh = int(rnd, 3, 50)
    const rx = int(rnd, 0, w - rw)
    const ry = int(rnd, 0, h - rh)
    fill(x0 + rx, y0 + ry, rw, rh, pal[int(rnd, 0, pal.length - 1)])
  }
}

// C1: ~100 colours in horizontal runs of 1..24 pixels (palette RLE territory).
{
  const [x0, w] = C1
  const [y0, h] = R3
  const rnd = prng(0x52464202)
  const pal = Array.from({ length: 100 }, () => [int(rnd, 0, 255), int(rnd, 0, 255), int(rnd, 0, 255)])
  for (let y = 0; y < h; y++) {
    // every other row repeats the row above, so there are vertical runs too
    if (y & 1) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y - 1) * W + x0 + x) * 3
        set(x0 + x, y0 + y, [img[i], img[i + 1], img[i + 2]])
      }
      continue
    }
    for (let x = 0; x < w; ) {
      const run = int(rnd, 1, 24)
      fill(x0 + x, y0 + y, Math.min(run, w - x), 1, pal[int(rnd, 0, pal.length - 1)])
      x += run
    }
  }
}

// C2: seeded full-colour noise (incompressible: raw sub-encodings).
{
  const [x0, w] = C2
  const [y0, h] = R3
  const rnd = prng(0x52464232)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) set(x0 + x, y0 + y, [int(rnd, 0, 255), int(rnd, 0, 255), int(rnd, 0, 255)])
}

// C3: sharp shapes on a dark background (no anti-aliasing).
{
  const [x0, w] = C3
  const [y0, h] = R3
  fill(x0, y0, w, h, [16, 16, 16])
  const disc = (cx, cy, r0, r1, c) => {
    for (let y = -r1; y <= r1; y++)
      for (let x = -r1; x <= r1; x++) {
        const d = x * x + y * y
        if (d <= r1 * r1 && d >= r0 * r0) set(x0 + cx + x, y0 + cy + y, c)
      }
  }
  disc(60, 60, 0, 47, [230, 57, 70]) // filled circle
  disc(170, 60, 30, 45, [233, 196, 106]) // ring
  // triangle
  for (let y = 0; y < 90; y++) {
    const half = Math.floor(y / 2)
    fill(x0 + 270 - half, y0 + 15 + y, 2 * half + 1, 1, [42, 157, 143])
  }
  // diamond
  for (let y = -40; y <= 40; y++) {
    const half = 40 - Math.abs(y)
    fill(x0 + 70 - half, y0 + 150 + y, 2 * half + 1, 1, [69, 123, 230])
  }
  // 1-pixel lines: diagonal, horizontal, vertical
  for (let i = 0; i < 160; i++) set(x0 + 140 + i, y0 + 115 + Math.floor(i / 2), [255, 255, 255])
  fill(x0 + 140, y0 + 190, 190, 1, [255, 255, 0])
  fill(x0 + 335, y0 + 5, 1, 185, [0, 255, 255])
  // single dots
  for (let i = 0; i < 12; i++) set(x0 + 150 + i * 13, y0 + 103, [255, 0, 255])
}

// D1: horizontal ramps: grey, red, green, blue bands.
{
  const x0 = C1[0]
  const w = C3[0] - 11 - x0 // 629 wide, up to x = 637
  const [y0, h] = R4
  const bands = [(v) => [v, v, v], (v) => [v, 0, 0], (v) => [0, v, 0], (v) => [0, 0, v]]
  for (let b = 0; b < 4; b++) {
    const ya = y0 + Math.round((b * h) / 4)
    const yb = y0 + Math.round(((b + 1) * h) / 4)
    for (let x = 0; x < w; x++) fill(x0 + x, ya, 1, yb - ya, bands[b](Math.round((255 * x) / (w - 1))))
  }
}

// D2: vertical ramp, orange to blue.
{
  const [x0, w] = C3
  const [y0, h] = R4
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1)
    fill(x0, y0 + y, w, 1, [Math.round(255 * (1 - v)), Math.round(128 - 64 * v), Math.round(255 * v)])
  }
}

// --- Cursor ---------------------------------------------------------------------------------------
// 12x19 arrow pointing down-right at its hotspot, the bottom-right pixel (11,18), which is
// transparent. The servers park the pointer at (0,0): only the hotspot pixel of a cursor drawn into
// the framebuffer falls on screen, so it changes no pixel and the framebuffer equals testcard.png.
// (Parked at (0,0), TigerVNC also sends the cursor shape to new clients straight away: it sends an
// empty cursor, and draws it into the framebuffer, while the pointer is anywhere else than where the
// client last put it, and a new client's last position counts as (0,0).)
// The shape touches the top and left edges, so no server crops it: all send the same 12x19 image.
// 'O' = foreground (source bit 1), '#' = background (source bit 0), '.' = transparent (mask 0).
const ARROW = [
  // the usual up-left arrow, rotated by 180 degrees below
  'O..........',
  'OO.........',
  'O#O........',
  'O##O.......',
  'O###O......',
  'O####O.....',
  'O#####O....',
  'O######O...',
  'O#######O..',
  'O########O.',
  'O#####OOOOO',
  'O##O##O....',
  'O#O.O##O...',
  'OO..O##O...',
  'O....O##O..',
  '.....O##O..',
  '......O##O.',
  '......OOO..',
]
const CURSOR = [...ARROW.map((row) => `${[...row].reverse().join('')}.`).reverse(), '.'.repeat(ARROW[0].length + 1)]
const HOT_X = CURSOR[0].length - 1
const HOT_Y = CURSOR.length - 1
const CURSOR_FG = [20, 40, 160]
const CURSOR_BG = [255, 230, 80]
const CW = CURSOR[0].length
const CH = CURSOR.length

function xbm(name, bit) {
  const bytes = []
  for (const row of CURSOR)
    for (let b = 0; b < Math.ceil(CW / 8); b++) {
      let v = 0
      for (let i = 0; i < 8; i++) if (bit(row[b * 8 + i])) v |= 1 << i // LSB = leftmost
      bytes.push(`0x${v.toString(16).padStart(2, '0')}`)
    }
  const lines = []
  for (let i = 0; i < bytes.length; i += 12) lines.push(`   ${bytes.slice(i, i + 12).join(', ')}`)
  return (
    `#define ${name}_width ${CW}\n#define ${name}_height ${CH}\n` +
    `#define ${name}_x_hot ${HOT_X}\n#define ${name}_y_hot ${HOT_Y}\n` +
    `static unsigned char ${name}_bits[] = {\n${lines.join(',\n')} };\n`
  )
}

// --- PNG ------------------------------------------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
// Encodes 8-bit RGB (channels 3) or RGBA (channels 4); per row picks the filter with the smallest
// sum of absolute values (the usual heuristic), which keeps the gradients small.
function png(width, height, channels, pixels) {
  const stride = width * channels
  const rows = []
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride)
    let best = null
    let bestSum = Infinity
    for (let f = 0; f < 5; f++) {
      const row = Buffer.alloc(stride + 1)
      row[0] = f
      let sum = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0
        const b = prev[i]
        const c = i >= channels ? prev[i - channels] : 0
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]
        const v = (cur[i] - pred) & 0xff
        row[i + 1] = v
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = row
      }
    }
    rows.push(best)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const cursorRGBA = new Uint8Array(CW * CH * 4)
for (const [y, row] of CURSOR.entries()) {
  for (const [x, ch] of [...row].entries()) {
    if (ch === '.') continue
    const i = (y * CW + x) * 4
    cursorRGBA.set([...(ch === 'O' ? CURSOR_FG : CURSOR_BG), 255], i)
  }
}

writeFileSync(join(out, 'testcard.png'), png(W, H, 3, img))
writeFileSync(join(out, 'cursor.png'), png(CW, CH, 4, cursorRGBA))
writeFileSync(
  join(out, 'cursor.xbm'),
  xbm('cursor', (ch) => ch === 'O'),
)
writeFileSync(
  join(out, 'cursor-mask.xbm'),
  xbm('cursor_mask', (ch) => ch === 'O' || ch === '#'),
)

const colours = new Set()
for (let i = 0; i < img.length; i += 3) colours.add((img[i] << 16) | (img[i + 1] << 8) | img[i + 2])
console.log(
  `testcard.png ${W}x${H}, ${colours.size} colours; cursor ${CW}x${CH} hotspot ${HOT_X},${HOT_Y} fg ${CURSOR_FG} bg ${CURSOR_BG}`,
)
for (const row of CURSOR) console.log(`  ${row}`)
