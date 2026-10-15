// Reference encoders for the RFB pixel encodings, written from the protocol specification
// (rfbproto; RFC 6143 §7.7.5 for TRLE) and independently of the decoders in src/: tests encode a
// known image with these, feed the bytes to `Decoder` and compare what comes out.
//
// Images are `width * height` pixels in the client's pixel format. The encoders work on pixel
// bytes, and only look inside a pixel where the wire format does (ZRLE/TRLE CPIXELs, Tight TPIXELs
// and the gradient filter).

import { once } from 'node:events'
import zlib from 'node:zlib'
import type { PixelFormat } from '../../src/pixel-format.ts'

// ---------------------------------------------------------------------------------------------
// Deterministic randomness

export type Rng = () => number

/** mulberry32: a small seeded PRNG giving floats in [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An integer in [0, n). */
export function randInt(r: Rng, n: number): number {
  return Math.floor(r() * n)
}

// ---------------------------------------------------------------------------------------------
// Pixels, written from the PIXEL_FORMAT definition

export interface Image {
  width: number
  height: number
  /** Bytes per pixel. */
  bpp: number
  /** `width * height` pixels, row after row. */
  data: Buffer
}

/** The bytes of pixel value `v` (an unsigned integer) in `pf`'s byte order. */
export function pixelBytes(pf: PixelFormat, v: number): Buffer {
  const n = pf.bitsPerPixel / 8
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    const byte = Math.floor(v / 2 ** (8 * i)) % 256 // i-th least significant byte
    out[pf.bigEndian ? n - 1 - i : i] = byte
  }
  return out
}

/** The pixel value stored at `buf[off]` in `pf`'s byte order. */
export function pixelValue(pf: PixelFormat, buf: Uint8Array, off: number): number {
  const n = pf.bitsPerPixel / 8
  let v = 0
  for (let i = 0; i < n; i++) v = v * 256 + (buf[pf.bigEndian ? off + i : off + n - 1 - i] as number)
  return v
}

/** A true-colour pixel value from components already in the channel ranges (0..max). */
export function makePixel(pf: PixelFormat, r: number, g: number, b: number): number {
  return r * 2 ** pf.redShift + g * 2 ** pf.greenShift + b * 2 ** pf.blueShift
}

/** The red, green and blue components (0..max) of a true-colour pixel value. */
export function components(pf: PixelFormat, v: number): [number, number, number] {
  return [
    Math.floor(v / 2 ** pf.redShift) % (pf.redMax + 1),
    Math.floor(v / 2 ** pf.greenShift) % (pf.greenMax + 1),
    Math.floor(v / 2 ** pf.blueShift) % (pf.blueMax + 1),
  ]
}

/** A random pixel: random components for true colour, a random index for colour-map formats. */
export function randomPixel(pf: PixelFormat, r: Rng): number {
  if (!pf.trueColor) return randInt(r, 2 ** Math.min(pf.depth, pf.bitsPerPixel))
  return makePixel(pf, randInt(r, pf.redMax + 1), randInt(r, pf.greenMax + 1), randInt(r, pf.blueMax + 1))
}

/** An image whose pixel values come from `value(x, y)`. */
export function imageFrom(pf: PixelFormat, width: number, height: number, value: (x: number, y: number) => number) {
  const bpp = pf.bitsPerPixel / 8
  const data = Buffer.alloc(width * height * bpp)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixelBytes(pf, value(x, y)).copy(data, (y * width + x) * bpp)
  }
  return { width, height, bpp, data } satisfies Image
}

/** An identity for the pixel at index `i` (equal keys: equal pixel bytes). */
function keyAt(img: Image, i: number): number {
  switch (img.bpp) {
    case 1:
      return img.data[i] as number
    case 2:
      return img.data.readUInt16LE(i * 2)
    default:
      return img.data.readUInt32LE(i * 4)
  }
}

function pixelAt(img: Image, i: number): Buffer {
  return img.data.subarray(i * img.bpp, (i + 1) * img.bpp)
}

// ---------------------------------------------------------------------------------------------
// Test images

const STYLES = ['solid', 'text', 'coloured', 'k3', 'k4', 'k7', 'k16', 'k100', 'gradient', 'noise', 'runs'] as const

/**
 * A deterministic test image: `cell`×`cell` blocks, two neighbouring blocks at a time in the same
 * style (solid areas, two-colour "text", a few colours, a hundred colours, gradients, noise,
 * long horizontal runs), so tile encoders meet every kind of tile and carry state between tiles.
 */
export function testImage(pf: PixelFormat, width: number, height: number, seed: number, cell = 16): Image {
  const r = rng(seed)
  const values = new Float64Array(width * height)
  // Colours shared by all blocks: background and ink of "text", the usual solid colour.
  const paper = randomPixel(pf, r)
  const ink = randomPixel(pf, r)
  const cols = Math.ceil(width / cell)
  const set = (x: number, y: number, v: number) => {
    values[y * width + x] = v
  }
  for (let cy = 0; cy * cell < height; cy++) {
    for (let cx = 0; cx * cell < width; cx++) {
      const style = STYLES[(Math.floor((cx + cy * cols) / 2) + seed) % STYLES.length] as (typeof STYLES)[number]
      const x0 = cx * cell
      const y0 = cy * cell
      const x1 = Math.min(width, x0 + cell)
      const y1 = Math.min(height, y0 + cell)
      const area = (v: (x: number, y: number) => number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, v(x, y))
      }
      const box = (colour: () => number) => {
        // A random rectangle inside the block.
        const bx = x0 + randInt(r, x1 - x0)
        const by = y0 + randInt(r, y1 - y0)
        const bw = 1 + randInt(r, Math.min(6, x1 - bx))
        const bh = 1 + randInt(r, Math.min(6, y1 - by))
        const c = colour()
        for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) set(x, y, c)
      }
      const palette = (k: number) => Array.from({ length: k }, () => randomPixel(pf, r))
      switch (style) {
        case 'solid': {
          const c = (cx + cy) % 3 === 0 ? randomPixel(pf, r) : paper
          area(() => c)
          break
        }
        case 'text': {
          area(() => paper)
          for (let i = 3 + randInt(r, 4); i > 0; i--) box(() => ink)
          break
        }
        case 'coloured': {
          area(() => paper)
          const p = palette(3)
          for (let i = 3 + randInt(r, 4); i > 0; i--) box(() => p[randInt(r, 3)] as number)
          break
        }
        case 'k3':
        case 'k4':
        case 'k7':
        case 'k16':
        case 'k100': {
          const p = palette(Number(style.slice(1)))
          let c = p[0] as number
          area(() => {
            if (r() < 0.4) c = p[randInt(r, p.length)] as number
            return c
          })
          break
        }
        case 'gradient':
          area((x, y) => {
            if (!pf.trueColor) return (x * 3 + y * 5) % 256
            const fx = (x - x0) / Math.max(1, x1 - x0 - 1)
            const fy = (y - y0) / Math.max(1, y1 - y0 - 1)
            return makePixel(
              pf,
              Math.round(fx * pf.redMax),
              Math.round(fy * pf.greenMax),
              Math.round(((fx + fy) / 2) * pf.blueMax),
            )
          })
          break
        case 'noise':
          area(() => randomPixel(pf, r))
          break
        case 'runs': {
          const p = palette(200)
          let left = 0
          let c = 0
          area(() => {
            if (left === 0) {
              left = 1 + randInt(r, 400)
              c = p[randInt(r, p.length)] as number
            }
            left--
            return c
          })
          break
        }
      }
    }
  }
  return imageFrom(pf, width, height, (x, y) => values[y * width + x] as number)
}

/** An image of `k` random colours, in short runs. */
export function paletteImage(pf: PixelFormat, width: number, height: number, k: number, seed: number): Image {
  const r = rng(seed)
  const p: number[] = []
  // Distinct colours, as far as the format has them.
  for (let tries = 0; p.length < k && tries < k * 50; tries++) {
    const c = randomPixel(pf, r)
    if (!p.includes(c)) p.push(c)
  }
  let c = p[0] as number
  return imageFrom(pf, width, height, () => {
    if (r() < 0.5) c = p[randInt(r, p.length)] as number
    return c
  })
}

// ---------------------------------------------------------------------------------------------
// Output

/** A growable byte buffer with the big-endian writers RFB uses. */
export class ByteWriter {
  #buf = Buffer.alloc(256)
  #length = 0

  get length(): number {
    return this.#length
  }

  #room(n: number): void {
    if (this.#length + n <= this.#buf.length) return
    const next = Buffer.alloc(Math.max(this.#buf.length * 2, this.#length + n))
    this.#buf.copy(next, 0, 0, this.#length)
    this.#buf = next
  }

  u8(v: number): this {
    this.#room(1)
    this.#buf[this.#length++] = v & 0xff
    return this
  }

  u16(v: number): this {
    this.#room(2)
    this.#buf.writeUInt16BE(v, this.#length)
    this.#length += 2
    return this
  }

  u32(v: number): this {
    this.#room(4)
    this.#buf.writeUInt32BE(v >>> 0, this.#length)
    this.#length += 4
    return this
  }

  s32(v: number): this {
    this.#room(4)
    this.#buf.writeInt32BE(v | 0, this.#length)
    this.#length += 4
    return this
  }

  bytes(b: Uint8Array): this {
    this.#room(b.length)
    this.#buf.set(b, this.#length)
    this.#length += b.length
    return this
  }

  toBuffer(): Buffer {
    return Buffer.from(this.#buf.subarray(0, this.#length))
  }
}

/** Packs one bit per pixel, rows padded to whole bytes, the most significant bit leftmost. */
export function packBits(width: number, height: number, bit: (x: number, y: number) => boolean): Buffer {
  const rowBytes = Math.ceil(width / 8)
  const out = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (bit(x, y)) out[y * rowBytes + Math.floor(x / 8)] |= 0x80 >> (x % 8)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// zlib: one deflate stream per connection, each rect ending with a sync flush

/** A deflate stream that lasts across rects: `compress()` returns the next part of the stream. */
export class Deflater {
  readonly #z: zlib.Deflate
  #chunks: Buffer[] = []

  constructor(level = 6) {
    this.#z = zlib.createDeflate({ level })
    this.#z.on('data', (chunk: Buffer) => this.#chunks.push(chunk))
  }

  async compress(data: Uint8Array): Promise<Buffer> {
    if (data.length > 0) this.#z.write(data)
    await new Promise<void>((resolve) => this.#z.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()))
    // A sync flush ends with an empty stored block, 00 00 FF FF; wait until all of it has arrived.
    for (;;) {
      const out = Buffer.concat(this.#chunks)
      if (out.length >= 4 && out.readUInt32BE(out.length - 4) === 0x0000ffff) {
        this.#chunks = []
        return out
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  close(): void {
    this.#z.close()
  }
}

/**
 * zlib data that inflates to `mib` MiB of `fill` bytes (about 1 KB per MiB), after `head`: the first
 * sync-flushed part of a stream, or with `end` a whole stream. Nothing that size is ever held.
 */
export async function zlibBomb(mib: number, options: { fill?: number; head?: Buffer; end?: boolean } = {}) {
  const z = zlib.createDeflate()
  const parts: Buffer[] = []
  z.on('data', (chunk: Buffer) => parts.push(chunk))
  if (options.head) z.write(options.head)
  const chunk = Buffer.alloc(1 << 20, options.fill ?? 0)
  for (let i = 0; i < mib; i++) z.write(chunk)
  if (options.end) {
    z.end()
    await once(z, 'end')
    return Buffer.concat(parts)
  }
  await new Promise<void>((resolve) => z.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()))
  // A sync flush ends with an empty stored block, 00 00 FF FF; wait until all of it has arrived.
  for (;;) {
    const out = Buffer.concat(parts)
    if (out.length >= 4 && out.readUInt32BE(out.length - 4) === 0x0000ffff) {
      z.close()
      return out
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------------------------
// Raw, RRE, CoRRE

export function encodeRaw(img: Image): Buffer {
  return Buffer.from(img.data)
}

interface SubRect {
  x: number
  y: number
  w: number
  h: number
  /** Index of one of its pixels in the image. */
  pixel: number
  key: number
}

/**
 * Covers the pixels of the `w`×`h` area at `x0`, `y0` that differ from `bgKey` with solid
 * rectangles (greedy: grow right, then down). Coordinates are relative to the area.
 */
function cover(img: Image, x0: number, y0: number, w: number, h: number, bgKey: number, maxSide = 0xffff) {
  const done = new Uint8Array(w * h)
  const rects: SubRect[] = []
  const key = (x: number, y: number) => keyAt(img, (y0 + y) * img.width + x0 + x)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (done[y * w + x]) continue
      const k = key(x, y)
      if (k === bgKey) continue
      let rw = 1
      while (x + rw < w && rw < maxSide && !done[y * w + x + rw] && key(x + rw, y) === k) rw++
      let rh = 1
      grow: while (y + rh < h && rh < maxSide) {
        for (let i = 0; i < rw; i++) if (done[(y + rh) * w + x + i] || key(x + i, y + rh) !== k) break grow
        rh++
      }
      for (let j = 0; j < rh; j++) done.fill(1, (y + j) * w + x, (y + j) * w + x + rw)
      rects.push({ x, y, w: rw, h: rh, pixel: (y0 + y) * img.width + x0 + x, key: k })
    }
  }
  return rects
}

/** The most frequent pixel of an area (the first one seen on ties), as a pixel index. */
function mostFrequent(img: Image, x0: number, y0: number, w: number, h: number) {
  const counts = new Map<number, { n: number; pixel: number }>()
  let best = { n: 0, pixel: y0 * img.width + x0 }
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = y * img.width + x
      const k = keyAt(img, i)
      let c = counts.get(k)
      if (!c) {
        c = { n: 0, pixel: i }
        counts.set(k, c)
      }
      c.n++
      if (c.n > best.n) best = c
    }
  }
  return { pixel: best.pixel, key: keyAt(img, best.pixel), distinct: counts.size }
}

/** RRE (`compact` false) or CoRRE (`compact` true; the rect must be at most 255×255). */
export function encodeRre(img: Image, compact: boolean): Buffer {
  const bg = mostFrequent(img, 0, 0, img.width, img.height)
  const rects = cover(img, 0, 0, img.width, img.height, bg.key, compact ? 255 : 0xffff)
  const w = new ByteWriter().u32(rects.length).bytes(pixelAt(img, bg.pixel))
  for (const r of rects) {
    w.bytes(pixelAt(img, r.pixel))
    if (compact) w.u8(r.x).u8(r.y).u8(r.w).u8(r.h)
    else w.u16(r.x).u16(r.y).u16(r.w).u16(r.h)
  }
  return w.toBuffer()
}

// ---------------------------------------------------------------------------------------------
// Hextile

const HEX_RAW = 1
const HEX_BG = 2
const HEX_FG = 4
const HEX_ANY = 8
const HEX_COLOURED = 16

export interface HextileStats {
  raw: number
  /** Background only, background specified. */
  solid: number
  /** Background only, carried over from the previous tile (subencoding 0). */
  solidCarried: number
  /** Background plus subrects in one foreground colour, foreground specified. */
  mono: number
  /** ...with the foreground carried over from the previous tile. */
  monoCarried: number
  coloured: number
  /** Tiles that reused the previous tile's background. */
  bgCarried: number
}

export function hextileStats(): HextileStats {
  return { raw: 0, solid: 0, solidCarried: 0, mono: 0, monoCarried: 0, coloured: 0, bgCarried: 0 }
}

/**
 * Hextile, choosing for each tile the smallest of raw, background only, background + foreground
 * subrects and coloured subrects, and carrying background and foreground over as the spec allows
 * (not after a raw tile; the foreground not after a coloured tile).
 */
export function encodeHextile(img: Image, stats = hextileStats()): Buffer {
  const out = new ByteWriter()
  const { bpp } = img
  let bg: number | null = null
  let fg: number | null = null
  for (let ty = 0; ty < img.height; ty += 16) {
    const th = Math.min(16, img.height - ty)
    for (let tx = 0; tx < img.width; tx += 16) {
      const tw = Math.min(16, img.width - tx)
      const back = mostFrequent(img, tx, ty, tw, th)
      const bgSame = bg === back.key
      if (back.distinct === 1) {
        if (bgSame) {
          out.u8(0)
          stats.solidCarried++
        } else {
          out.u8(HEX_BG).bytes(pixelAt(img, back.pixel))
          stats.solid++
        }
        bg = back.key
        continue
      }
      const rects = cover(img, tx, ty, tw, th, back.key)
      const first = rects[0] as SubRect
      const mono = rects.every((r) => r.key === first.key)
      const fgSame = mono && fg === first.key
      const size = 1 + (bgSame ? 0 : bpp) + (mono && !fgSame ? bpp : 0) + 1 + rects.length * (mono ? 2 : bpp + 2)
      if (rects.length > 255 || size >= 1 + tw * th * bpp) {
        out.u8(HEX_RAW)
        for (let y = ty; y < ty + th; y++) {
          out.bytes(img.data.subarray((y * img.width + tx) * bpp, (y * img.width + tx + tw) * bpp))
        }
        bg = null
        fg = null
        stats.raw++
        continue
      }
      let sub = HEX_ANY
      if (!bgSame) sub |= HEX_BG
      if (mono && !fgSame) sub |= HEX_FG
      if (!mono) sub |= HEX_COLOURED
      out.u8(sub)
      if (!bgSame) out.bytes(pixelAt(img, back.pixel))
      if (mono && !fgSame) out.bytes(pixelAt(img, first.pixel))
      out.u8(rects.length)
      for (const r of rects) {
        if (!mono) out.bytes(pixelAt(img, r.pixel))
        out.u8((r.x << 4) | r.y).u8(((r.w - 1) << 4) | (r.h - 1))
      }
      if (bgSame) stats.bgCarried++
      if (mono) {
        if (fgSame) stats.monoCarried++
        else stats.mono++
      } else {
        stats.coloured++
      }
      bg = back.key
      fg = mono ? first.key : null
    }
  }
  return out.toBuffer()
}

// ---------------------------------------------------------------------------------------------
// Zlib

/** Zlib: the raw pixels through the connection's deflate stream, after a U32 length. */
export async function encodeZlib(deflater: Deflater, img: Image): Promise<Buffer> {
  const compressed = await deflater.compress(img.data)
  return new ByteWriter().u32(compressed.length).bytes(compressed).toBuffer()
}

// ---------------------------------------------------------------------------------------------
// ZRLE and TRLE

/**
 * Where the 3 bytes of a CPIXEL go in a pixel: `size` 3 when the format is 32-bit true colour of
 * depth 24 or less whose colour bits all fit in the least or the most significant three bytes,
 * `offset` being the first of the three bytes in memory. When both fit, the bytes that come first
 * in memory win (what TigerVNC and libvncserver do).
 */
export function cpixelLayout(pf: PixelFormat): { size: number; offset: number } {
  const bpp = pf.bitsPerPixel / 8
  if (pf.bitsPerPixel !== 32 || !pf.trueColor || pf.depth > 24) return { size: bpp, offset: 0 }
  const used = makePixel(pf, pf.redMax, pf.greenMax, pf.blueMax)
  const lowFits = used < 2 ** 24
  const highFits = used % 256 === 0
  // In memory, a little-endian pixel starts with its least significant byte.
  const firstThree = pf.bigEndian ? highFits : lowFits
  if (firstThree) return { size: 3, offset: 0 }
  if (lowFits || highFits) return { size: 3, offset: 1 }
  return { size: 4, offset: 0 }
}

export type TileKind =
  | 'raw'
  | 'solid'
  | 'packed1'
  | 'packed2'
  | 'packed4'
  | 'plainRle'
  | 'paletteRle'
  | 'reusePacked'
  | 'reuseRle'
  /** A run of 256 pixels or more. */
  | 'longRun'
  /** A run that continues on the next row. */
  | 'wrappedRun'

export type TileStats = Record<TileKind, number>

export function tileStats(): TileStats {
  return {
    raw: 0,
    solid: 0,
    packed1: 0,
    packed2: 0,
    packed4: 0,
    plainRle: 0,
    paletteRle: 0,
    reusePacked: 0,
    reuseRle: 0,
    longRun: 0,
    wrappedRun: 0,
  }
}

export interface TileOptions {
  /** `auto`: the smallest subencoding for each tile; `cycle`: every applicable one in turn. */
  mode?: 'auto' | 'cycle'
  stats?: TileStats
}

const CHOICES = ['raw', 'solid', 'packed', 'plainRle', 'paletteRle', 'reusePacked', 'reuseRle'] as const
type Choice = (typeof CHOICES)[number]

/** The run length bytes: 255s, then the rest (length - 1 = 255 * count + rest). */
function runLengthBytes(len: number): number[] {
  const out: number[] = []
  let n = len - 1
  while (n >= 255) {
    out.push(255)
    n -= 255
  }
  out.push(n)
  return out
}

/** The tiles of ZRLE (64×64) or TRLE (16×16, `trle` true: palette reuse allowed). */
function encodeTiles(img: Image, pf: PixelFormat, size: number, trle: boolean, opts: TileOptions): Buffer {
  const out = new ByteWriter()
  const layout = cpixelLayout(pf)
  const stats = opts.stats ?? tileStats()
  const cpixel = (i: number) => {
    const p = pixelAt(img, i)
    out.bytes(layout.size === img.bpp ? p : p.subarray(layout.offset, layout.offset + 3))
  }
  let next = 0 // the choice to try first in `cycle` mode
  // The palette the previous tile sent or reused (TRLE), as keys and pixel indices.
  let prev: { keys: number[]; pixels: number[]; packed: boolean } | null = null

  for (let ty = 0; ty < img.height; ty += size) {
    const th = Math.min(size, img.height - ty)
    for (let tx = 0; tx < img.width; tx += size) {
      const tw = Math.min(size, img.width - tx)
      const n = tw * th
      // The tile's pixels in order, its colours by first appearance, and its runs.
      const idx: number[] = []
      for (let y = ty; y < ty + th; y++) for (let x = tx; x < tx + tw; x++) idx.push(y * img.width + x)
      const keys = idx.map((i) => keyAt(img, i))
      const colours: number[] = []
      const colourPixel: number[] = []
      for (let i = 0; i < n; i++) {
        if (!colours.includes(keys[i] as number)) {
          colours.push(keys[i] as number)
          colourPixel.push(idx[i] as number)
        }
        if (colours.length > 200) break
      }
      const runs: { start: number; len: number }[] = []
      for (let i = 0; i < n; ) {
        let j = i + 1
        while (j < n && keys[j] === keys[i]) j++
        runs.push({ start: i, len: j - i })
        i = j
      }
      const p = colours.length
      const bitsFor = (size: number) => (size <= 2 ? 1 : size <= 4 ? 2 : 4)
      const rleBytes = runs.reduce((s, r) => s + runLengthBytes(r.len).length, 0)
      const prevHasAll = prev !== null && colours.every((k) => (prev as { keys: number[] }).keys.includes(k))
      const sizes: Partial<Record<Choice, number>> = {}
      sizes.raw = n * layout.size
      if (p === 1) sizes.solid = layout.size
      if (p >= 2 && p <= 16) sizes.packed = p * layout.size + Math.ceil((tw * bitsFor(p)) / 8) * th
      sizes.plainRle = runs.length * layout.size + rleBytes
      const paletteRuns = runs.reduce((s, r) => s + (r.len === 1 ? 1 : 1 + runLengthBytes(r.len).length), 0)
      if (p >= 2 && p <= 127) sizes.paletteRle = p * layout.size + paletteRuns
      if (trle && prevHasAll && prev?.packed) {
        sizes.reusePacked = Math.ceil((tw * bitsFor(prev.keys.length)) / 8) * th
      }
      if (trle && prevHasAll) sizes.reuseRle = paletteRuns

      let choice: Choice
      if (opts.mode === 'cycle') {
        let k = next
        while (sizes[CHOICES[k % CHOICES.length] as Choice] === undefined) k++
        choice = CHOICES[k % CHOICES.length] as Choice
        next = (k + 1) % CHOICES.length
      } else {
        choice = 'raw'
        for (const c of CHOICES) if ((sizes[c] ?? Infinity) < (sizes[choice] as number)) choice = c
      }

      // Palette entries (keys and pixel indices) this tile's indices refer to.
      let palette = { keys: colours, pixels: colourPixel }
      if (choice === 'reusePacked' || choice === 'reuseRle') palette = prev as typeof palette
      const indexOf = (i: number) => palette.keys.indexOf(keys[i] as number)
      const emitRuns = (withPalette: boolean) => {
        for (const r of runs) {
          if (r.len >= 256) stats.longRun++
          if (Math.floor(r.start / tw) !== Math.floor((r.start + r.len - 1) / tw)) stats.wrappedRun++
          if (withPalette) {
            if (r.len === 1) {
              out.u8(indexOf(r.start))
              continue
            }
            out.u8(indexOf(r.start) | 0x80)
          } else {
            cpixel(idx[r.start] as number)
          }
          for (const b of runLengthBytes(r.len)) out.u8(b)
        }
      }
      const emitPacked = (bits: number) => {
        const rowBytes = Math.ceil((tw * bits) / 8)
        for (let y = 0; y < th; y++) {
          const row = Buffer.alloc(rowBytes)
          for (let x = 0; x < tw; x++) {
            const bit = x * bits
            row[Math.floor(bit / 8)] |= indexOf(y * tw + x) << (8 - bits - (bit % 8))
          }
          out.bytes(row)
        }
      }

      switch (choice) {
        case 'raw':
          out.u8(0)
          for (const i of idx) cpixel(i)
          stats.raw++
          prev = null
          break
        case 'solid':
          out.u8(1)
          cpixel(idx[0] as number)
          stats.solid++
          prev = null
          break
        case 'packed': {
          out.u8(p)
          for (const i of colourPixel) cpixel(i)
          const bits = bitsFor(p)
          emitPacked(bits)
          stats[`packed${bits}` as TileKind]++
          prev = { keys: colours, pixels: colourPixel, packed: true }
          break
        }
        case 'plainRle':
          out.u8(128)
          emitRuns(false)
          stats.plainRle++
          prev = null
          break
        case 'paletteRle':
          out.u8(128 + p)
          for (const i of colourPixel) cpixel(i)
          emitRuns(true)
          stats.paletteRle++
          prev = { keys: colours, pixels: colourPixel, packed: false }
          break
        case 'reusePacked':
          out.u8(127)
          emitPacked(bitsFor(palette.keys.length))
          stats.reusePacked++
          break
        case 'reuseRle':
          out.u8(129)
          emitRuns(true)
          stats.reuseRle++
          break
      }
    }
  }
  return out.toBuffer()
}

/** ZRLE: 64×64 tiles through the connection's deflate stream, after a U32 length. */
export async function encodeZrle(
  deflater: Deflater,
  img: Image,
  pf: PixelFormat,
  opts: TileOptions = {},
): Promise<Buffer> {
  const compressed = await deflater.compress(encodeTiles(img, pf, 64, false, opts))
  return new ByteWriter().u32(compressed.length).bytes(compressed).toBuffer()
}

/** TRLE: 16×16 tiles as they are, with palette reuse. */
export function encodeTrle(img: Image, pf: PixelFormat, opts: TileOptions = {}): Buffer {
  return encodeTiles(img, pf, 16, true, opts)
}

// ---------------------------------------------------------------------------------------------
// Tight and TightPNG

/** True when Tight sends 3-byte R, G, B TPIXELs for `pf`. */
export function tightRgb(pf: PixelFormat): boolean {
  return (
    pf.trueColor &&
    pf.bitsPerPixel === 32 &&
    pf.depth === 24 &&
    pf.redMax === 255 &&
    pf.greenMax === 255 &&
    pf.blueMax === 255
  )
}

/** Bytes in `fakeJpeg`'s header: SOI, then a SOF0 segment with one component. */
export const FAKE_JPEG_HEADER = 15

/**
 * Stand-in JPEG data for a `width`×`height` rect: a real start (SOI and a baseline frame header with
 * the size), then `rest`. Decoders check only the header; tests decode the rest themselves.
 */
export function fakeJpeg(width: number, height: number, rest: Uint8Array = Buffer.alloc(0)): Buffer {
  const header = new ByteWriter().u16(0xffd8).u16(0xffc0).u16(11).u8(8).u16(height).u16(width)
  return header.u8(1).u8(1).u8(0x11).u8(0).bytes(rest).toBuffer()
}

/** Tight's compact length: 7 bits per byte, least significant first, at most 3 bytes. */
export function compactLength(n: number): Buffer {
  if (n < 0 || n >= 1 << 22) throw new Error(`compact length ${n} out of range`)
  if (n < 0x80) return Buffer.from([n])
  if (n < 0x4000) return Buffer.from([(n & 0x7f) | 0x80, n >> 7])
  return Buffer.from([(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, n >> 14])
}

export type TightMethod = 'fill' | 'copy' | 'palette' | 'gradient'

export interface TightOptions {
  method: TightMethod
  /** The zlib stream for BasicCompression (default 0). */
  stream?: number
  /** Streams to reset before this rect (bit n: stream n). */
  reset?: number
  /** BasicCompression Without Zlib (control 0xA0, or 0xE0 with a filter id). */
  noZlib?: boolean
  /** Send the filter id even for the copy filter. */
  filterId?: boolean
}

export interface TightStats {
  raw: number
  compressed: number
  noZlib: number
  len1: number
  len2: number
  len3: number
  palette2: number
  paletteN: number
  gradient: number
  resets: number
}

export function tightStats(): TightStats {
  return {
    raw: 0,
    compressed: 0,
    noZlib: 0,
    len1: 0,
    len2: 0,
    len3: 0,
    palette2: 0,
    paletteN: 0,
    gradient: 0,
    resets: 0,
  }
}

/** The encoder side of one connection's Tight state: four deflate streams. */
export class TightEncoder {
  readonly #streams: (Deflater | null)[] = [null, null, null, null]
  readonly stats: TightStats = tightStats()

  #reset(bits: number): void {
    for (let i = 0; i < 4; i++) {
      if (bits & (1 << i)) {
        this.#streams[i]?.close()
        this.#streams[i] = null
        this.stats.resets++
      }
    }
  }

  #length(w: ByteWriter, n: number): void {
    const b = compactLength(n)
    this.stats[`len${b.length}` as 'len1' | 'len2' | 'len3']++
    w.bytes(b)
  }

  /** A Tight rect of `img` (pixels in `pf`). */
  async encode(img: Image, pf: PixelFormat, opts: TightOptions): Promise<Buffer> {
    const reset = opts.reset ?? 0
    this.#reset(reset)
    const stream = opts.stream ?? 0
    const rgb = tightRgb(pf)
    const n = img.width * img.height
    const tpixel = (i: number): Buffer => {
      if (!rgb) return Buffer.from(pixelAt(img, i))
      const [r, g, b] = components(pf, pixelValue(pf, img.data, i * img.bpp))
      return Buffer.from([r, g, b])
    }
    const out = new ByteWriter()
    if (opts.method === 'fill') {
      return out
        .u8(0x80 | reset)
        .bytes(tpixel(0))
        .toBuffer()
    }

    let filter = 0
    const head: Buffer[] = []
    let data: Buffer
    if (opts.method === 'copy') {
      data = Buffer.concat(Array.from({ length: n }, (_, i) => tpixel(i)))
    } else if (opts.method === 'palette') {
      filter = 1
      const keys: number[] = []
      const first: number[] = []
      const index = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        const k = keyAt(img, i)
        let j = keys.indexOf(k)
        if (j < 0) {
          j = keys.length
          keys.push(k)
          first.push(i)
        }
        index[i] = j
      }
      if (keys.length > 256) throw new Error('palette filter: more than 256 colours')
      head.push(Buffer.from([keys.length - 1]), ...first.map(tpixel))
      if (keys.length === 2) {
        data = packBits(img.width, img.height, (x, y) => index[y * img.width + x] === 1)
        this.stats.palette2++
      } else {
        data = Buffer.from(index)
        this.stats.paletteN++
      }
    } else {
      if (pf.bitsPerPixel === 8) throw new Error('gradient filter: needs 16 or 32 bits per pixel')
      filter = 2
      data = gradient(img, pf, rgb)
      this.stats.gradient++
    }

    const sendFilter = filter !== 0 || opts.filterId === true
    if (opts.noZlib) {
      out.u8((sendFilter ? 0xe0 : 0xa0) | reset)
    } else {
      out.u8((stream << 4) | (sendFilter ? 0x40 : 0) | reset)
    }
    if (sendFilter) out.u8(filter)
    for (const b of head) out.bytes(b)
    if (opts.noZlib) {
      this.stats.noZlib++
      out.bytes(data)
    } else if (data.length < 12) {
      this.stats.raw++
      out.bytes(data)
    } else {
      let z = this.#streams[stream]
      if (!z) {
        z = new Deflater()
        this.#streams[stream] = z
      }
      const compressed = await z.compress(data)
      this.stats.compressed++
      this.#length(out, compressed.length)
      out.bytes(compressed)
    }
    return out.toBuffer()
  }

  /** A JpegCompression rect carrying `jpeg` (the decoder reads only its frame header; see `fakeJpeg`). */
  jpeg(jpeg: Uint8Array, reset = 0): Buffer {
    this.#reset(reset)
    const out = new ByteWriter().u8(0x90 | reset)
    this.#length(out, jpeg.length)
    return out.bytes(jpeg).toBuffer()
  }

  /** A TightPNG PngCompression rect. */
  png(png: Uint8Array, reset = 0): Buffer {
    this.#reset(reset)
    const out = new ByteWriter().u8(0xa0 | reset)
    this.#length(out, png.length)
    return out.bytes(png).toBuffer()
  }

  close(): void {
    for (const z of this.#streams) z?.close()
  }
}

/**
 * The gradient filter (TightVNC's FilterGradient24 / FilterGradient): each colour component minus
 * the prediction left + up - upLeft clamped to 0..max (pixels outside the rect are 0). For RGB
 * TPIXELs the result is R, G, B difference bytes; otherwise difference pixels in `pf`, each
 * component modulo max + 1.
 */
function gradient(img: Image, pf: PixelFormat, rgb: boolean): Buffer {
  const { width: w, height: h } = img
  const max = rgb ? [255, 255, 255] : [pf.redMax, pf.greenMax, pf.blueMax]
  const comp = (x: number, y: number): number[] => {
    if (x < 0 || y < 0) return [0, 0, 0]
    return components(pf, pixelValue(pf, img.data, (y * w + x) * img.bpp))
  }
  const out = Buffer.alloc(w * h * (rgb ? 3 : img.bpp))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const here = comp(x, y)
      const left = comp(x - 1, y)
      const up = comp(x, y - 1)
      const upLeft = comp(x - 1, y - 1)
      const diff = here.map((v, c) => {
        const m = max[c] as number
        const predicted = Math.min(m, Math.max(0, (left[c] as number) + (up[c] as number) - (upLeft[c] as number)))
        return (((v - predicted) % (m + 1)) + (m + 1)) % (m + 1)
      })
      const i = y * w + x
      if (rgb) out.set(diff, i * 3)
      else pixelBytes(pf, makePixel(pf, diff[0] as number, diff[1] as number, diff[2] as number)).copy(out, i * img.bpp)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Cursor pseudo-encodings

/** Cursor: the pixels (client format), then a 1-bit mask (1: the pixel is part of the cursor). */
export function encodeRichCursor(img: Image, mask: (x: number, y: number) => boolean): Buffer {
  return Buffer.concat([img.data, packBits(img.width, img.height, mask)])
}

/** X Cursor: primary and secondary R, G, B, a bitmap (1: primary) and a mask (1: visible). */
export function encodeXCursor(
  width: number,
  height: number,
  primary: [number, number, number],
  secondary: [number, number, number],
  bitmap: (x: number, y: number) => boolean,
  mask: (x: number, y: number) => boolean,
): Buffer {
  if (width === 0 || height === 0) return Buffer.alloc(0)
  return Buffer.concat([
    Buffer.from([...primary, ...secondary]),
    packBits(width, height, bitmap),
    packBits(width, height, mask),
  ])
}

/** Cursor With Alpha: the S32 encoding of what follows, then the R, G, B, A pixels in it. */
export function encodeCursorWithAlpha(encoding: number, body: Uint8Array): Buffer {
  return new ByteWriter().s32(encoding).bytes(body).toBuffer()
}

/** The pixel format of Cursor With Alpha data: bytes R, G, B, A. */
export const rgbaFormat: PixelFormat = {
  bitsPerPixel: 32,
  depth: 32,
  bigEndian: false,
  trueColor: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 0,
  greenShift: 8,
  blueShift: 16,
}

/** VMware cursor type 0: an AND mask and an XOR mask, both pixels in the client's format. */
export function encodeVMwareClassicCursor(and: Image, xor: Image): Buffer {
  return Buffer.concat([Buffer.from([0, 0]), and.data, xor.data])
}

/** VMware cursor type 1: R, G, B, A bytes. */
export function encodeVMwareAlphaCursor(rgba: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([1, 0]), rgba])
}
