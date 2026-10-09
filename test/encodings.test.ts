// Round trips through the rect decoders: reference encoders (test/helpers/encoders.ts, written from
// the spec) encode deterministic images, the bytes reach a ByteReader in random-sized chunks while
// `Decoder.decode` runs, and the decoded pixels must be the image again.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { encodings as E } from '../src/constants.ts'
import { Decoder } from '../src/decoder.ts'
import { RfbError } from '../src/errors.ts'
import { type Color, type PixelFormat, pixelFormats } from '../src/pixel-format.ts'
import { ByteReader } from '../src/reader.ts'
import type { Rect, RectHeader } from '../src/rect.ts'
import {
  ByteWriter,
  compactLength,
  Deflater,
  encodeCursorWithAlpha,
  encodeHextile,
  encodeRaw,
  encodeRichCursor,
  encodeRre,
  encodeTrle,
  encodeVMwareAlphaCursor,
  encodeVMwareClassicCursor,
  encodeXCursor,
  encodeZlib,
  encodeZrle,
  type HextileStats,
  hextileStats,
  type Image,
  imageFrom,
  makePixel,
  packBits,
  paletteImage,
  pixelBytes,
  pixelValue,
  type Rng,
  randInt,
  randomPixel,
  rgbaFormat,
  rng,
  TightEncoder,
  type TightOptions,
  type TightStats,
  type TileStats,
  testImage,
  tightStats,
  tileStats,
} from './helpers/encoders.ts'
import { encodePng } from './helpers/png-encoder.ts'

// ---------------------------------------------------------------------------------------------
// Pixel formats and images

const { bgrx, rgbx, rgb565, bgr233 } = pixelFormats

function pf32(redShift: number, greenShift: number, blueShift: number, more: Partial<PixelFormat> = {}): PixelFormat {
  return {
    bitsPerPixel: 32,
    depth: 24,
    bigEndian: false,
    trueColor: true,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift,
    greenShift,
    blueShift,
    ...more,
  }
}

const colourMap8: PixelFormat = { ...bgr233, trueColor: false }

/** Hextile subencoding bits. */
const HEX = { raw: 1, bg: 2, fg: 4, any: 8, coloured: 16 }

/** 16-bit colour map entries for `colourMap8`. */
const COLOUR_MAP: Color[] = Array.from({ length: 256 }, (_, i) => ({
  r: (i * 0x0101) & 0xffff,
  g: ((255 - i) * 0x0101) & 0xffff,
  b: ((i * 37) & 0xff) * 0x0101,
}))

const FORMATS: { name: string; pf: PixelFormat }[] = [
  { name: 'bgrx', pf: bgrx },
  { name: 'rgbx', pf: rgbx },
  { name: 'rgb565', pf: rgb565 },
  { name: 'bgr233', pf: bgr233 },
  // CPIXELs are the low three bytes, which come last in a big-endian pixel.
  { name: 'bgrx big-endian', pf: { ...bgrx, bigEndian: true } },
  // CPIXELs are the high three bytes, which come last in a little-endian pixel.
  { name: 'shifts 24/16/8', pf: pf32(24, 16, 8) },
  { name: 'shifts 24/16/8 big-endian', pf: pf32(24, 16, 8, { bigEndian: true }) },
  // Depth 32: full 4-byte CPIXELs, and 4-byte TPIXELs (not Tight's RGB).
  { name: 'depth 32', pf: pf32(0, 8, 16, { depth: 32 }) },
  { name: 'rgb565 big-endian', pf: { ...rgb565, bigEndian: true } },
  // 16 colour bits in the middle of a 32-bit pixel: 3-byte CPIXELs, 4-byte TPIXELs.
  { name: '16 bits in a 32-bit pixel', pf: pf32(19, 13, 8, { depth: 16, redMax: 31, greenMax: 63, blueMax: 31 }) },
  // Depth 24 with colours in all four bytes: full CPIXELs, but RGB TPIXELs.
  { name: 'colours in all four bytes', pf: pf32(0, 8, 24) },
  { name: '8-bit colour map', pf: colourMap8 },
]

const SIZES: [number, number][] = [
  [1, 1],
  [17, 5],
  [70, 33],
  [130, 129],
]

/** The pixel for an 8-bit-per-channel colour: each channel scaled to the nearest value. */
function modelPixel(pf: PixelFormat, r: number, g: number, b: number): number {
  const s = (v: number, max: number) => Math.round((v * max) / 255)
  return makePixel(pf, s(r, pf.redMax), s(g, pf.greenMax), s(b, pf.blueMax))
}

/** 8-bit-per-channel colour of a pixel value. */
function modelRgb(pf: PixelFormat, v: number, map: readonly (Color | undefined)[] = []): number[] {
  if (!pf.trueColor) {
    const c = map[v]
    return c ? [c.r >> 8, c.g >> 8, c.b >> 8] : [0, 0, 0]
  }
  const s = (shift: number, max: number) => Math.round(((Math.floor(v / 2 ** shift) % (max + 1)) * 255) / max)
  return [s(pf.redShift, pf.redMax), s(pf.greenShift, pf.greenMax), s(pf.blueShift, pf.blueMax)]
}

/** `width * height` pixels in `pf` from packed 8-bit colours (3 or 4 bytes each). */
function modelPixels(pf: PixelFormat, colours: Uint8Array, stride: number, count: number): Buffer {
  const bpp = pf.bitsPerPixel / 8
  const out = Buffer.alloc(count * bpp)
  for (let i = 0; i < count; i++) {
    const c = colours.subarray(i * stride, i * stride + 3)
    pixelBytes(pf, modelPixel(pf, c[0] as number, c[1] as number, c[2] as number)).copy(out, i * bpp)
  }
  return out
}

function noiseImage(pf: PixelFormat, width: number, height: number, seed: number): Image {
  const r = rng(seed)
  return imageFrom(pf, width, height, () => randomPixel(pf, r))
}

function solidImage(pf: PixelFormat, width: number, height: number, seed: number): Image {
  const c = randomPixel(pf, rng(seed))
  return imageFrom(pf, width, height, () => c)
}

// ---------------------------------------------------------------------------------------------
// Feeding a decoder

interface Item {
  header: RectHeader
  bytes: Buffer
}

function item(encoding: number, width: number, height: number, bytes: Buffer, x = 3, y = 7): Item {
  return { header: { x, y, width, height, encoding }, bytes }
}

/** Pushes `bytes` in random-sized chunks (often single bytes), letting the decoder run in between. */
async function feed(reader: ByteReader, bytes: Buffer, r: Rng): Promise<void> {
  for (let pos = 0; pos < bytes.length; ) {
    const roll = r()
    const n =
      roll < 0.3 ? 1 : roll < 0.6 ? 2 + randInt(r, 15) : roll < 0.92 ? 17 + randInt(r, 400) : 417 + randInt(r, 6000)
    // A copy: the decoder must not depend on how the chunks were cut.
    reader.push(Buffer.from(bytes.subarray(pos, pos + n)))
    pos += n
    if (r() < 0.04) await new Promise((resolve) => setImmediate(resolve))
    else await Promise.resolve()
  }
}

/**
 * Decodes `items` one after another from one reader fed in random chunks, on `decoder` (whose
 * zlib streams carry over from item to item). Every byte must be read, and no more.
 */
async function decodeAll(
  decoder: Decoder,
  items: Item[],
  pf: PixelFormat,
  seed: number,
  colorMap: readonly (Color | undefined)[] = [],
): Promise<Rect[]> {
  const reader = new ByteReader()
  const decoding = (async () => {
    const rects: Rect[] = []
    for (const it of items) rects.push(await decoder.decode(reader, it.header, pf, colorMap))
    return rects
  })()
  decoding.catch(() => {}) // rethrown below; not unhandled while feeding
  await feed(reader, Buffer.concat(items.map((it) => it.bytes)), rng(seed))
  // A decoder still waiting now wanted more bytes than the rects hold.
  reader.destroy(new Error('the decoder wanted more bytes than were sent'))
  const rects = await decoding
  assert.equal(reader.available, 0, 'the decoder left bytes unread')
  return rects
}

function pixelsOf(rect: Rect | undefined): Buffer {
  assert.ok(rect, 'no rect')
  assert.equal(rect.type, 'pixels')
  return (rect as Extract<Rect, { type: 'pixels' }>).data
}

/** Compares pixels, naming the first wrong one. */
function assertPixels(actual: Buffer, expected: Buffer, width: number, bpp: number, label: string): void {
  if (actual.equals(expected)) return
  assert.equal(actual.length, expected.length, `${label}: ${actual.length} bytes, not ${expected.length}`)
  let i = 0
  while (actual[i] === expected[i]) i++
  const p = Math.floor(i / bpp)
  const hex = (b: Buffer) => b.subarray(p * bpp, (p + 1) * bpp).toString('hex')
  assert.fail(`${label}: pixel ${p % width},${Math.floor(p / width)} is ${hex(actual)}, not ${hex(expected)}`)
}

/** Decodes `items` (expected to come out as `images`) and checks every one. */
async function roundTrip(
  label: string,
  items: Item[],
  images: Image[],
  pf: PixelFormat,
  seed: number,
  decoder = new Decoder(),
): Promise<void> {
  const rects = await decodeAll(decoder, items, pf, seed, COLOUR_MAP)
  rects.forEach((rect, i) => {
    const img = images[i] as Image
    assertPixels(pixelsOf(rect), img.data, img.width, img.bpp, `${label} #${i} (${img.width}×${img.height})`)
  })
  decoder.close()
}

function isProtocolError(message?: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof RfbError, `expected an RfbError, got ${String(err)}`)
    assert.equal(err.code, 'PROTOCOL_ERROR', err.message)
    if (message) assert.match(err.message, message)
    return true
  }
}

// What the encoders did over the whole run, checked at the end: every subencoding was exercised.
const coverage = {
  hextile: hextileStats(),
  zrle: tileStats(),
  trle: tileStats(),
  tight: tightStats(),
}

function addStats<T extends object>(into: T, from: T): void {
  const a = into as Record<string, number>
  for (const [k, v] of Object.entries(from)) a[k] = (a[k] ?? 0) + (v as number)
}

// ---------------------------------------------------------------------------------------------
// Every encoding in every pixel format

describe('pixel encodings round trip', () => {
  FORMATS.forEach(({ name, pf }, f) => {
    describe(name, () => {
      const seed = 1000 * (f + 1)
      const images = SIZES.map(([w, h], i) => testImage(pf, w, h, seed + i))
      const images11 = SIZES.map(([w, h], i) => testImage(pf, w, h, seed + 50 + i, 11))
      const images64 = SIZES.map(([w, h], i) => testImage(pf, w, h, seed + 70 + i, 64))

      test('Raw', async () => {
        const items = images.map((img) => item(E.raw, img.width, img.height, encodeRaw(img)))
        await roundTrip('Raw', items, images, pf, seed)
      })

      test('RRE and CoRRE', async () => {
        const all = [...images, ...images11]
        const items = [
          ...all.map((img) => item(E.rre, img.width, img.height, encodeRre(img, false))),
          ...all.map((img) => item(E.coRre, img.width, img.height, encodeRre(img, true))),
        ]
        await roundTrip('RRE', items, [...all, ...all], pf, seed + 1)
      })

      test('Hextile', async () => {
        const stats = hextileStats()
        const all = [...images, ...images11]
        const items = all.map((img) => item(E.hextile, img.width, img.height, encodeHextile(img, stats)))
        await roundTrip('Hextile', items, all, pf, seed + 2)
        addStats<HextileStats>(coverage.hextile, stats)
      })

      test('Zlib (one deflate stream across rects)', async () => {
        const deflater = new Deflater()
        const all = [...images, ...images11]
        const items: Item[] = []
        for (const img of all) items.push(item(E.zlib, img.width, img.height, await encodeZlib(deflater, img)))
        deflater.close()
        await roundTrip('Zlib', items, all, pf, seed + 3)
      })

      test('ZRLE (smallest and every tile type, one deflate stream)', async () => {
        const stats = tileStats()
        const deflater = new Deflater()
        const items: Item[] = []
        const all: Image[] = []
        for (const mode of ['auto', 'cycle'] as const) {
          for (const img of [...images, ...images64, ...images11]) {
            items.push(item(E.zrle, img.width, img.height, await encodeZrle(deflater, img, pf, { mode, stats })))
            all.push(img)
          }
        }
        deflater.close()
        await roundTrip('ZRLE', items, all, pf, seed + 4)
        addStats<TileStats>(coverage.zrle, stats)
      })

      test('TRLE (smallest and every tile type, palette reuse)', async () => {
        const stats = tileStats()
        const items: Item[] = []
        const all: Image[] = []
        for (const mode of ['auto', 'cycle'] as const) {
          for (const img of [...images, ...images11]) {
            items.push(item(E.trle, img.width, img.height, encodeTrle(img, pf, { mode, stats })))
            all.push(img)
          }
        }
        await roundTrip('TRLE', items, all, pf, seed + 5)
        addStats<TileStats>(coverage.trle, stats)
      })

      test('Tight (every filter, streams, without zlib)', async () => {
        const enc = new TightEncoder()
        const items: Item[] = []
        const all: Image[] = []
        const add = async (img: Image, opts: TightOptions) => {
          items.push(item(E.tight, img.width, img.height, await enc.encode(img, pf, opts)))
          all.push(img)
        }
        const gradient = pf.bitsPerPixel > 8
        for (const [i, img] of images.entries()) {
          await add(img, { method: 'copy', stream: i % 4 })
          await add(img, { method: 'copy', stream: (i + 1) % 4, filterId: true })
          if (gradient) await add(img, { method: 'gradient', stream: (i + 2) % 4 })
          await add(img, { method: 'copy', noZlib: true })
          if (gradient) await add(img, { method: 'gradient', noZlib: true })
        }
        for (const [w, h] of SIZES) {
          await add(paletteImage(pf, w, h, 2, seed + w), { method: 'palette', stream: 3 })
          await add(paletteImage(pf, w, h, 5, seed + h), { method: 'palette', stream: 2 })
          await add(paletteImage(pf, w, h, 200, seed + w + h), { method: 'palette', stream: 1 })
          await add(paletteImage(pf, w, h, 2, seed - w), { method: 'palette', noZlib: true })
          await add(paletteImage(pf, w, h, 9, seed - h), { method: 'palette', noZlib: true })
          await add(solidImage(pf, w, h, seed + w * h), { method: 'fill' })
        }
        // Noise doesn't compress: zlib data long enough for a 3-byte compact length.
        await add(noiseImage(pf, 130, 129, seed), { method: 'copy', stream: 0, reset: 0b0001 })
        if (gradient) await add(noiseImage(pf, 130, 129, seed + 1), { method: 'gradient', stream: 1 })
        enc.close()
        await roundTrip('Tight', items, all, pf, seed + 6)
        addStats<TightStats>(coverage.tight, enc.stats)
      })

      if (pf.trueColor) {
        test('TightPNG (PNG, fill and JPEG rects)', async () => {
          const enc = new TightEncoder()
          const items: Item[] = []
          const expected: Image[] = []
          const r = rng(seed + 7)
          const decodeJpeg = (jpeg: Buffer, w: number, h: number) => {
            assert.equal(jpeg.length, 9)
            return Buffer.from(Array.from({ length: w * h * 3 }, (_, i) => (i * 7 + w) & 0xff))
          }
          for (const [w, h] of SIZES) {
            const rgb = Buffer.from(Array.from({ length: w * h * 3 }, () => randInt(r, 256)))
            const bpp = pf.bitsPerPixel / 8
            const asImage = (data: Buffer): Image => ({ width: w, height: h, bpp, data })
            // RGB.
            const png = encodePng(w, h, rgb, { colorType: 2, bitDepth: 8, filter: (y) => y % 5 })
            items.push(item(E.tightPng, w, h, enc.png(png, w === 70 ? 0x0f : 0)))
            expected.push(asImage(modelPixels(pf, rgb, 3, w * h)))
            // RGBA: alpha is dropped.
            const rgba = Buffer.from(Array.from({ length: w * h * 4 }, () => randInt(r, 256)))
            items.push(item(E.tightPng, w, h, enc.png(encodePng(w, h, rgba, { colorType: 6, bitDepth: 8, filter: 4 }))))
            expected.push(asImage(modelPixels(pf, rgba, 4, w * h)))
            // A palette image.
            const palette = Buffer.from(Array.from({ length: 16 * 3 }, () => randInt(r, 256)))
            const indices = Array.from({ length: w * h }, () => randInt(r, 16))
            const colours = Buffer.from(indices.flatMap((i) => [...palette.subarray(i * 3, i * 3 + 3)]))
            items.push(
              item(E.tightPng, w, h, enc.png(encodePng(w, h, indices, { colorType: 3, bitDepth: 4, palette }))),
            )
            expected.push(asImage(modelPixels(pf, colours, 3, w * h)))
            // Fill and JPEG work as in Tight.
            const fill = solidImage(pf, w, h, seed + w)
            items.push(item(E.tightPng, w, h, await enc.encode(fill, pf, { method: 'fill' })))
            expected.push(fill)
            items.push(item(E.tightPng, w, h, enc.jpeg(Buffer.from('fake jpeg'))))
            expected.push(asImage(modelPixels(pf, decodeJpeg(Buffer.alloc(9), w, h), 3, w * h)))
          }
          enc.close()
          await roundTrip('TightPNG', items, expected, pf, seed + 7, new Decoder({ decodeJpeg }))
        })
      }
    })
  })

  test('every subencoding was exercised', () => {
    const zero = (stats: Record<string, number>) => Object.keys(stats).filter((k) => stats[k] === 0)
    assert.deepEqual(zero({ ...coverage.hextile }), [], 'Hextile')
    assert.deepEqual(zero({ ...coverage.zrle, reusePacked: 1, reuseRle: 1 }), [], 'ZRLE')
    assert.deepEqual(zero({ ...coverage.trle }), [], 'TRLE')
    assert.deepEqual(zero({ ...coverage.tight }), [], 'Tight')
  })
})

// ---------------------------------------------------------------------------------------------
// State across rects

describe('decoder state across rects', () => {
  test('a mixed sequence of rects on one Decoder', async () => {
    const pf = bgrx
    const decoder = new Decoder()
    const zlibStream = new Deflater()
    const zrleStream = new Deflater()
    const tight = new TightEncoder()
    const items: Item[] = []
    const expected: Image[] = []
    for (let i = 0; i < 6; i++) {
      const img = testImage(pf, 20 + i * 13, 9 + i * 7, 500 + i)
      const add = (encoding: number, bytes: Buffer) => {
        items.push(item(encoding, img.width, img.height, bytes, i, i))
        expected.push(img)
      }
      add(E.zlib, await encodeZlib(zlibStream, img))
      add(E.zrle, await encodeZrle(zrleStream, img, pf))
      add(E.tight, await tight.encode(img, pf, { method: 'copy', stream: i % 4 }))
      add(E.tight, await tight.encode(img, pf, { method: 'gradient', stream: (i + 1) % 4 }))
      add(E.hextile, encodeHextile(img))
      add(E.trle, encodeTrle(img, pf))
      add(E.raw, encodeRaw(img))
    }
    zlibStream.close()
    zrleStream.close()
    tight.close()
    await roundTrip('mixed', items, expected, pf, 77, decoder)
  })

  test('Tight stream resets: before a rect, in Fill and JPEG rects, all four at once', async () => {
    const pf = rgb565
    const enc = new TightEncoder()
    const items: Item[] = []
    const expected: (Image | null)[] = []
    const img = (seed: number) => testImage(pf, 40, 20, seed)
    const add = async (image: Image, opts: TightOptions) => {
      items.push(item(E.tight, image.width, image.height, await enc.encode(image, pf, opts)))
      expected.push(image)
    }
    await add(img(1), { method: 'copy', stream: 1 })
    await add(img(2), { method: 'copy', stream: 1 })
    // The encoder starts stream 1 over; the decoder must too.
    await add(img(3), { method: 'copy', stream: 1, reset: 0b0010 })
    await add(img(4), { method: 'gradient', stream: 0 })
    await add(img(5), { method: 'gradient', stream: 0 })
    await add(solidImage(pf, 40, 20, 6), { method: 'fill', reset: 0b0001 })
    await add(img(7), { method: 'gradient', stream: 0 })
    await add(img(8), { method: 'copy', stream: 2 })
    items.push(item(E.tight, 40, 20, enc.jpeg(Buffer.from([1, 2, 3]), 0b0100)))
    expected.push(null)
    await add(img(9), { method: 'copy', stream: 2 })
    await add(img(10), { method: 'copy', stream: 3 })
    await add(paletteImage(pf, 40, 20, 7, 11), { method: 'palette', stream: 3, reset: 0b1111 })
    await add(img(12), { method: 'copy', stream: 0 })
    await add(img(13), { method: 'copy', stream: 1 })
    await add(img(14), { method: 'copy', stream: 2 })
    await add(img(15), { method: 'copy', stream: 3 })
    enc.close()
    assert.equal(enc.stats.resets, 1 + 1 + 1 + 4)
    const rects = await decodeAll(new Decoder(), items, pf, 5)
    rects.forEach((rect, i) => {
      const e = expected[i]
      if (e === null) assert.deepEqual(rect, { type: 'jpeg', ...items[i]?.header, jpeg: Buffer.from([1, 2, 3]) })
      else assertPixels(pixelsOf(rect), (e as Image).data, 40, 2, `rect ${i}`)
    })
  })

  test('Tight: under 12 bytes of filtered data are sent as they are, 12 and more through zlib', async () => {
    const enc = new TightEncoder()
    const items: Item[] = []
    const images: Image[] = []
    const add = async (pf: PixelFormat, img: Image, opts: TightOptions) => {
      items.push(item(E.tight, img.width, img.height, await enc.encode(img, pf, opts)))
      images.push(img)
    }
    // Copy filter: 11 and 12 bytes of 8-bit pixels, 10 and 12 bytes of 16-bit ones, 9 and 12 of TPIXELs.
    for (const [w, h] of [
      [11, 1],
      [1, 12],
      [4, 3],
    ]) {
      await add(bgr233, noiseImage(bgr233, w as number, h as number, 1), { method: 'copy', stream: 1 })
    }
    await add(rgb565, noiseImage(rgb565, 5, 1, 2), { method: 'copy', stream: 2 })
    await add(rgb565, noiseImage(rgb565, 3, 2, 3), { method: 'copy', stream: 2 })
    // Palette filter: 11 and 12 index bytes (3 colours), 11 and 12 bytes of 1-bit rows (2 colours).
    const colours = (k: number, w: number, h: number) =>
      imageFrom(bgr233, w, h, (x, y) => [9, 77, 200][(x + y) % k] as number)
    await add(bgr233, colours(3, 11, 1), { method: 'palette', stream: 3 })
    await add(bgr233, colours(3, 6, 2), { method: 'palette', stream: 3 })
    await add(bgr233, colours(2, 8, 11), { method: 'palette', stream: 3 })
    await add(bgr233, colours(2, 8, 12), { method: 'palette', stream: 3 })
    enc.close()
    assert.equal(enc.stats.raw, 4)
    assert.equal(enc.stats.compressed, 5)
    // Mixed formats, so decode rect by rect, on one Decoder.
    const decoder = new Decoder()
    for (const [i, it] of items.entries()) {
      const pf = (images[i] as Image).bpp === 2 ? rgb565 : bgr233
      const [rect] = await decodeAll(decoder, [it], pf, i)
      const img = images[i] as Image
      assertPixels(pixelsOf(rect), img.data, img.width, img.bpp, `rect ${i}`)
    }
    decoder.close()
  })

  test('a new zlib stream without the reset bit is corrupt data', async () => {
    const pf = bgrx
    const first = new TightEncoder()
    const second = new TightEncoder()
    const a = testImage(pf, 30, 30, 1)
    const b = testImage(pf, 30, 30, 2)
    const items = [
      item(E.tight, 30, 30, await first.encode(a, pf, { method: 'copy', stream: 2 })),
      item(E.tight, 30, 30, await second.encode(b, pf, { method: 'copy', stream: 2 })),
    ]
    first.close()
    second.close()
    await assert.rejects(decodeAll(new Decoder(), items, pf, 1), isProtocolError(/zlib/))
  })

  test('the Zlib and ZRLE streams are separate, and continue across Decoder.decode calls', async () => {
    const pf = rgbx
    const decoder = new Decoder()
    const zlibStream = new Deflater()
    const zrleStream = new Deflater()
    const imgs = [1, 2, 3].map((s) => testImage(pf, 33, 21, s))
    // Separate readers, one rect each: only the Decoder carries the state.
    for (const img of imgs) {
      for (const [encoding, bytes] of [
        [E.zlib, await encodeZlib(zlibStream, img)],
        [E.zrle, await encodeZrle(zrleStream, img, pf)],
      ] as const) {
        const [rect] = await decodeAll(decoder, [item(encoding, img.width, img.height, bytes)], pf, encoding)
        assertPixels(pixelsOf(rect), img.data, img.width, 4, `encoding ${encoding}`)
      }
    }
    zlibStream.close()
    zrleStream.close()
    decoder.close()
  })
})

// ---------------------------------------------------------------------------------------------
// JPEG

describe('Tight JPEG', () => {
  test('without decodeJpeg: the JPEG data, with 1-, 2- and 3-byte compact lengths', async () => {
    const enc = new TightEncoder()
    const r = rng(3)
    const jpegs = [5, 127, 128, 300, 16383, 16384, 20000].map((n) =>
      Buffer.from(Array.from({ length: n }, () => randInt(r, 256))),
    )
    const items = jpegs.map((j, i) => item(i % 2 ? E.tightPng : E.tight, 64, 48, enc.jpeg(j)))
    assert.equal(enc.stats.len1, 2)
    assert.equal(enc.stats.len2, 3)
    assert.equal(enc.stats.len3, 2)
    const rects = await decodeAll(new Decoder(), items, bgrx, 3)
    rects.forEach((rect, i) => {
      assert.equal(rect.type, 'jpeg')
      assert.deepEqual(rect, { type: 'jpeg', ...items[i]?.header, jpeg: jpegs[i] })
    })
  })

  for (const { name, pf } of FORMATS.filter((f) => f.pf.trueColor)) {
    test(`decodeJpeg returning RGB and RGBA, sync and async: ${name}`, async () => {
      const r = rng(name.length)
      const calls: [string, number, number][] = []
      const outputs: Uint8Array[] = []
      const decodeJpeg = (jpeg: Buffer, w: number, h: number): Uint8Array | Promise<Uint8Array> => {
        calls.push([jpeg.toString(), w, h])
        const [kind] = jpeg.toString().split(':')
        const pixels = new Uint8Array(Array.from({ length: w * h * (kind === 'rgba' ? 4 : 3) }, () => randInt(r, 256)))
        outputs.push(pixels)
        return kind === 'async' ? Promise.resolve(pixels) : pixels
      }
      const enc = new TightEncoder()
      const sizes: [number, number, string][] = [
        [1, 1, 'rgb'],
        [17, 5, 'rgba'],
        [70, 33, 'async'],
        [16, 16, 'rgb'],
      ]
      const items = sizes.map(([w, h, kind], i) => item(E.tight, w, h, enc.jpeg(Buffer.from(`${kind}:${i}`), i & 1)))
      const rects = await decodeAll(new Decoder({ decodeJpeg }), items, pf, 9)
      assert.deepEqual(
        calls,
        sizes.map(([w, h, kind], i) => [`${kind}:${i}`, w, h]),
      )
      rects.forEach((rect, i) => {
        const [w, h, kind] = sizes[i] as [number, number, string]
        const expected = modelPixels(pf, outputs[i] as Uint8Array, kind === 'rgba' ? 4 : 3, w * h)
        assertPixels(pixelsOf(rect), expected, w, pf.bitsPerPixel / 8, `${kind} ${w}×${h}`)
      })
    })
  }

  test('decodeJpeg returning the wrong number of bytes', async () => {
    const decoder = new Decoder({ decodeJpeg: (_j, w, h) => new Uint8Array(w * h * 2) })
    const items = [item(E.tight, 4, 4, new TightEncoder().jpeg(Buffer.from('x')))]
    await assert.rejects(decodeAll(decoder, items, bgrx, 1), isProtocolError(/RGB or RGBA/))
  })
})

// ---------------------------------------------------------------------------------------------
// Cursors

describe('cursor pseudo-encodings', () => {
  for (const { name, pf } of [
    { name: 'bgrx', pf: bgrx },
    { name: 'rgb565 big-endian', pf: { ...rgb565, bigEndian: true } },
    { name: 'bgr233', pf: bgr233 },
    { name: '8-bit colour map', pf: colourMap8 },
  ]) {
    test(`Cursor (pixels and a mask): ${name}`, async () => {
      const sizes: [number, number][] = [
        [1, 1],
        [9, 3],
        [32, 32],
        [17, 20],
        [0, 0],
      ]
      const r = rng(name.length + 11)
      const cursors = sizes.map(([w, h]) => {
        const img = noiseImage(pf, w, h, w * 100 + h)
        const mask = Array.from({ length: w * h }, () => r() < 0.6)
        return { img, mask, bytes: encodeRichCursor(img, (x, y) => mask[y * w + x] as boolean) }
      })
      const items = cursors.map(({ img, bytes }, i) => item(E.pseudoCursor, img.width, img.height, bytes, i, i + 1))
      const rects = await decodeAll(new Decoder(), items, pf, 4, COLOUR_MAP)
      rects.forEach((rect, i) => {
        const { img, mask } = cursors[i] as (typeof cursors)[number]
        assert.equal(rect.type, 'cursor')
        if (rect.type !== 'cursor') return
        assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [i, i + 1, img.width, img.height])
        const rgba = Buffer.alloc(img.width * img.height * 4)
        for (let p = 0; p < img.width * img.height; p++) {
          rgba.set([...modelRgb(pf, pixelValue(pf, img.data, p * img.bpp), COLOUR_MAP), mask[p] ? 255 : 0], p * 4)
        }
        assert.deepEqual(rect.rgba, rgba)
        assert.deepEqual(rect.data, img.data)
        assert.deepEqual(
          rect.mask,
          packBits(img.width, img.height, (x, y) => mask[y * img.width + x] as boolean),
        )
      })
    })
  }

  test('X Cursor', async () => {
    const r = rng(8)
    const sizes: [number, number][] = [
      [0, 0],
      [1, 1],
      [19, 7],
      [0, 5],
      [16, 16],
    ]
    const primary: [number, number, number] = [250, 10, 20]
    const secondary: [number, number, number] = [5, 200, 100]
    const cursors = sizes.map(([w, h]) => {
      const bitmap = Array.from({ length: w * h }, () => r() < 0.5)
      const mask = Array.from({ length: w * h }, () => r() < 0.7)
      const bytes = encodeXCursor(
        w,
        h,
        primary,
        secondary,
        (x, y) => bitmap[y * w + x] as boolean,
        (x, y) => mask[y * w + x] as boolean,
      )
      return { w, h, bitmap, mask, bytes }
    })
    const items = cursors.map((c) => item(E.pseudoXCursor, c.w, c.h, c.bytes))
    const rects = await decodeAll(new Decoder(), items, bgrx, 8)
    rects.forEach((rect, i) => {
      const c = cursors[i] as (typeof cursors)[number]
      const rgba = Buffer.alloc(c.w * c.h * 4)
      for (let p = 0; p < c.w * c.h; p++) rgba.set([...(c.bitmap[p] ? primary : secondary), c.mask[p] ? 255 : 0], p * 4)
      assert.deepEqual(rect, { type: 'cursor', ...items[i]?.header, rgba })
    })
  })

  test('Cursor With Alpha: raw, ZRLE, Hextile and Tight inside, premultiplied alpha undone', async () => {
    const r = rng(21)
    const zrleStream = new Deflater()
    const tight = new TightEncoder()
    const items: Item[] = []
    const expected: Buffer[] = []
    const pixelImages: Image[] = []
    // A ZRLE pixel rect before and after the cursor: the cursor's ZRLE data continues the same stream.
    const before = testImage(bgrx, 50, 40, 1)
    items.push(item(E.zrle, 50, 40, await encodeZrle(zrleStream, before, bgrx)))
    pixelImages.push(before)
    for (const [k, inner] of [E.raw, E.zrle, E.hextile, E.tight, E.raw].entries()) {
      const w = [1, 24, 33, 7, 64][k] as number
      const h = [1, 24, 18, 9, 64][k] as number
      const premultiplied = Buffer.alloc(w * h * 4)
      const straight = Buffer.alloc(w * h * 4)
      for (let p = 0; p < w * h; p++) {
        const roll = r()
        const a = roll < 0.3 ? 0 : roll < 0.6 ? 255 : 1 + randInt(r, 254)
        for (let c = 0; c < 3; c++) {
          const v = a === 0 ? 0 : randInt(r, a + 1) // a premultiplied channel is at most alpha
          premultiplied[p * 4 + c] = v
          straight[p * 4 + c] = a === 0 || a === 255 ? v : Math.min(255, Math.round((v * 255) / a))
        }
        premultiplied[p * 4 + 3] = a
        straight[p * 4 + 3] = a
      }
      const img: Image = { width: w, height: h, bpp: 4, data: premultiplied }
      let body: Buffer
      if (inner === E.raw) body = encodeRaw(img)
      else if (inner === E.zrle) body = await encodeZrle(zrleStream, img, rgbaFormat, { mode: 'cycle' })
      else if (inner === E.hextile) body = encodeHextile(img)
      else body = await tight.encode(img, rgbaFormat, { method: 'copy', stream: 1 })
      items.push(item(E.pseudoCursorWithAlpha, w, h, encodeCursorWithAlpha(inner, body), 2, 3))
      expected.push(straight)
    }
    const after = testImage(bgrx, 50, 40, 2)
    items.push(item(E.zrle, 50, 40, await encodeZrle(zrleStream, after, bgrx)))
    pixelImages.push(after)
    zrleStream.close()
    tight.close()

    const rects = await decodeAll(new Decoder(), items, bgrx, 21)
    assertPixels(pixelsOf(rects[0]), before.data, 50, 4, 'ZRLE before')
    assertPixels(pixelsOf(rects[rects.length - 1]), after.data, 50, 4, 'ZRLE after')
    rects.slice(1, -1).forEach((rect, i) => {
      assert.equal(rect.type, 'cursor')
      assert.deepEqual(rect, { type: 'cursor', ...items[i + 1]?.header, rgba: expected[i] })
    })
  })

  for (const { name, pf } of [
    { name: 'bgrx', pf: bgrx },
    { name: 'rgb565', pf: rgb565 },
    { name: 'shifts 24/16/8 big-endian', pf: pf32(24, 16, 8, { bigEndian: true }) },
    { name: '8-bit colour map', pf: colourMap8 },
  ]) {
    test(`VMware cursor, classic AND/XOR: ${name}`, async () => {
      const r = rng(31)
      const w = 13
      const h = 6
      const ones = 2 ** pf.bitsPerPixel - 1
      // transparent (AND all ones, XOR 0), opaque (AND 0), inverting (AND all ones, XOR a colour)
      const kinds = Array.from({ length: w * h }, () => randInt(r, 3))
      const colours = Array.from({ length: w * h }, () => 1 + randInt(r, Math.min(ones, 2 ** 24) - 1))
      const and = imageFrom(pf, w, h, (x, y) => (kinds[y * w + x] === 1 ? 0 : ones))
      const xor = imageFrom(pf, w, h, (x, y) => (kinds[y * w + x] === 0 ? 0 : (colours[y * w + x] as number)))
      const rgba = Buffer.alloc(w * h * 4)
      for (let p = 0; p < w * h; p++) {
        if (kinds[p] !== 0) rgba.set([...modelRgb(pf, pixelValue(pf, xor.data, p * xor.bpp), COLOUR_MAP), 255], p * 4)
      }
      const items = [item(E.pseudoVMwareCursor, w, h, encodeVMwareClassicCursor(and, xor), 4, 5)]
      const [rect] = await decodeAll(new Decoder(), items, pf, 31, COLOUR_MAP)
      assert.deepEqual(rect, { type: 'cursor', ...items[0]?.header, rgba })
    })
  }

  test('VMware cursor, alpha', async () => {
    const r = rng(41)
    const rgba = Buffer.from(Array.from({ length: 11 * 7 * 4 }, () => randInt(r, 256)))
    const items = [
      item(E.pseudoVMwareCursor, 11, 7, encodeVMwareAlphaCursor(rgba), 1, 2),
      item(E.pseudoVMwareCursor, 0, 0, encodeVMwareAlphaCursor(Buffer.alloc(0))),
    ]
    const rects = await decodeAll(new Decoder(), items, rgb565, 41)
    assert.deepEqual(rects, [
      { type: 'cursor', ...items[0]?.header, rgba },
      { type: 'cursor', ...items[1]?.header, rgba: Buffer.alloc(0) },
    ])
  })

  test('cursors larger than 1024 pixels are refused', async () => {
    for (const encoding of [E.pseudoCursor, E.pseudoXCursor, E.pseudoCursorWithAlpha, E.pseudoVMwareCursor]) {
      await assert.rejects(
        decodeAll(new Decoder(), [item(encoding, 1025, 1, Buffer.alloc(0))], bgrx, 1),
        isProtocolError(/cursor/),
      )
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Other pseudo-encodings and CopyRect

describe('non-pixel rects', () => {
  test('CopyRect and the pseudo-encodings with data', async () => {
    const screens = new ByteWriter()
      .u8(2)
      .bytes(Buffer.alloc(3))
      .u32(7)
      .u16(0)
      .u16(0)
      .u16(1920)
      .u16(1080)
      .u32(0)
      .u32(0x80000001)
      .u16(1920)
      .u16(0)
      .u16(1280)
      .u16(1024)
      .u32(5)
      .toBuffer()
    const name = Buffer.from('Ünïcode desktop ✓')
    const items = [
      item(E.copyRect, 10, 20, new ByteWriter().u16(300).u16(400).toBuffer(), 1, 2),
      item(E.pseudoDesktopSize, 800, 600, Buffer.alloc(0), 0, 0),
      item(E.pseudoExtendedDesktopSize, 3200, 1080, screens, 1, 0),
      item(E.pseudoDesktopName, 0, 0, new ByteWriter().u32(name.length).bytes(name).toBuffer(), 0, 0),
      item(E.pseudoQemuLedState, 0, 0, Buffer.from([0b101]), 0, 0),
      item(E.pseudoVMwareLedState, 0, 0, new ByteWriter().u32(0b010).toBuffer(), 0, 0),
      item(E.pseudoVMwareCursorState, 0, 0, new ByteWriter().u16(5).toBuffer(), 0, 0),
      item(E.pseudoPointerPos, 0, 0, Buffer.alloc(0), 40, 50),
      item(E.pseudoQemuPointerMotionChange, 0, 0, Buffer.alloc(0), 1, 0),
      item(E.pseudoQemuExtendedKeyEvent, 0, 0, Buffer.alloc(0), 0, 0),
    ]
    const rects = await decodeAll(new Decoder(), items, bgrx, 2)
    const h = (i: number) => items[i]?.header as RectHeader
    assert.deepEqual(rects, [
      { type: 'copy', ...h(0), src: { x: 300, y: 400 } },
      { type: 'desktopSize', ...h(1) },
      {
        type: 'extendedDesktopSize',
        ...h(2),
        reason: 1,
        status: 0,
        screens: [
          { id: 7, x: 0, y: 0, width: 1920, height: 1080, flags: 0 },
          { id: 0x80000001, x: 1920, y: 0, width: 1280, height: 1024, flags: 5 },
        ],
      },
      { type: 'desktopName', ...h(3), name: name.toString() },
      { type: 'ledState', ...h(4), scrollLock: true, numLock: false, capsLock: true },
      { type: 'ledState', ...h(5), scrollLock: false, numLock: true, capsLock: false },
      { type: 'cursorState', ...h(6), state: 5 },
      { type: 'cursorPosition', ...h(7) },
      { type: 'pointerMotion', ...h(8), absolute: true },
      { type: 'capability', ...h(9) },
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// Malformed data

/** Rect bytes from wire fields, for hand-made malformed rects. */
function bytes(...parts: (number[] | Buffer)[]): Buffer {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
}

/** A ZRLE rect whose (inflated) tile data is `tiles`. */
async function zrleRect(tiles: Buffer): Promise<Buffer> {
  const d = new Deflater()
  const z = await d.compress(tiles)
  d.close()
  return new ByteWriter().u32(z.length).bytes(z).toBuffer()
}

async function rejectsWith(encoding: number, w: number, h: number, data: Buffer, pf: PixelFormat, message: RegExp) {
  await assert.rejects(decodeAll(new Decoder(), [item(encoding, w, h, data)], pf, w * 31 + h), isProtocolError(message))
}

describe('malformed rects reject with PROTOCOL_ERROR', () => {
  // bgr233: one byte per pixel and per CPIXEL, so hand-made tiles stay short.
  const pf = bgr233

  test('corrupt zlib data (Zlib, ZRLE, Tight)', async () => {
    const garbage = Buffer.from([0x78, 0x9c, 0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0x00, 0x01, 0x02, 0x03])
    await rejectsWith(E.zlib, 4, 4, bytes([0, 0, 0, garbage.length], garbage), pf, /corrupt zlib/)
    await rejectsWith(E.zrle, 4, 4, bytes([0, 0, 0, garbage.length], garbage), pf, /corrupt zlib/)
    await rejectsWith(E.tight, 4, 4, bytes([0x00], compactLength(garbage.length), garbage), pf, /corrupt zlib/)
    // Not a zlib stream at all.
    await rejectsWith(E.zlib, 4, 4, bytes([0, 0, 0, 4], [1, 2, 3, 4]), pf, /corrupt zlib/)
  })

  test('zlib data of the wrong length', async () => {
    const d = new Deflater()
    const short = await d.compress(Buffer.alloc(15))
    d.close()
    await rejectsWith(E.zlib, 4, 4, bytes([0, 0, 0, short.length], short), pf, /15 bytes where 16/)
    const t = new Deflater()
    const long = await t.compress(Buffer.alloc(20))
    t.close()
    await rejectsWith(E.tight, 4, 4, bytes([0x00], compactLength(long.length), long), pf, /20 bytes where 16/)
  })

  test('ZRLE: palette index out of range', async () => {
    // Packed palette of 3 (2-bit indices), index 3.
    await rejectsWith(E.zrle, 1, 1, await zrleRect(bytes([3, 10, 20, 30, 0b11_000000])), pf, /palette index/)
    // Packed palette of 5 (4-bit indices), index 9 in the second pixel.
    await rejectsWith(E.zrle, 2, 1, await zrleRect(bytes([5, 1, 2, 3, 4, 5, 0x09])), pf, /palette index/)
    // Palette RLE of 2, index 5 (a run of one) and index 2 (with a run length).
    await rejectsWith(E.zrle, 2, 1, await zrleRect(bytes([130, 1, 2, 5, 0])), pf, /palette index/)
    await rejectsWith(E.zrle, 2, 1, await zrleRect(bytes([130, 1, 2, 0x82, 0])), pf, /palette index/)
  })

  test('ZRLE: a run past the end of the tile', async () => {
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([128, 7, 4])), pf, /past the end/) // plain RLE: 5 of 4
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([128, 7, 2, 7, 1])), pf, /past the end/) // 3 + 2
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([130, 1, 2, 0x80, 255, 0])), pf, /past the end/) // 257
    // 64×64 tile: 4096 pixels as one run is fine, 4097 is not.
    const run = (n: number) => [...new Array(Math.floor((n - 1) / 255)).fill(255), (n - 1) % 255]
    const [ok] = await decodeAll(
      new Decoder(),
      [item(E.zrle, 64, 64, await zrleRect(bytes([128, 9], run(4096))))],
      pf,
      1,
    )
    assert.deepEqual(pixelsOf(ok), Buffer.alloc(4096, 9))
    await rejectsWith(E.zrle, 64, 64, await zrleRect(bytes([128, 9], run(4097))), pf, /past the end/)
  })

  test('ZRLE: data ending mid-tile, invalid subencodings', async () => {
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([0, 1, 2, 3])), pf, /middle of a tile/)
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([128, 7])), pf, /middle of a tile/)
    await rejectsWith(E.zrle, 2, 2, bytes([0, 0, 0, 0]), pf, /middle of a tile/)
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([17, ...new Array(17).fill(1), 0])), pf, /subencoding 17/)
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([127, 0])), pf, /subencoding 127/)
    await rejectsWith(E.zrle, 2, 2, await zrleRect(bytes([129, 0])), pf, /subencoding 129/)
  })

  test('TRLE: palette index, run length, palette reuse without a palette', async () => {
    await rejectsWith(E.trle, 1, 1, bytes([3, 10, 20, 30, 0b11_000000]), pf, /palette index/)
    await rejectsWith(E.trle, 2, 1, bytes([131, 1, 2, 3, 3]), pf, /palette index/)
    await rejectsWith(E.trle, 2, 2, bytes([128, 7, 4]), pf, /past the end/)
    await rejectsWith(E.trle, 2, 2, bytes([127, 0]), pf, /reuse/)
    await rejectsWith(E.trle, 2, 2, bytes([129, 0]), pf, /reuse/)
    // Packed reuse after a palette RLE of more than 16 colours.
    const p17 = bytes(
      [128 + 17],
      new Array(17).fill(0).map((_, i) => i),
      [0x80, 255, 0],
    )
    await rejectsWith(E.trle, 32, 16, bytes(p17, [127]), pf, /reuse/)
    await rejectsWith(E.trle, 2, 2, bytes([17]), pf, /subencoding 17/)
  })

  test('Tight: palette index, controls, filters', async () => {
    // Palette of 3 colours, 8-bit indices (2×2 = 4 bytes: sent uncompressed), index 7.
    await rejectsWith(E.tight, 2, 2, bytes([0x40, 1, 2, 10, 20, 30, 0, 1, 7, 2]), pf, /palette index 7 of 3/)
    await rejectsWith(E.tight, 2, 2, bytes([0xe0, 1, 2, 10, 20, 30, 0, 1, 2, 3]), pf, /palette index 3 of 3/)
    for (const control of [0xb0, 0xc0, 0xd0, 0xf0]) {
      await rejectsWith(E.tight, 2, 2, bytes([control, 0, 0, 0, 0]), pf, /invalid compression control/)
    }
    await rejectsWith(E.tight, 2, 2, bytes([0x40, 3, 0, 0, 0, 0]), pf, /unknown filter 3/)
    await rejectsWith(E.tight, 2, 2, bytes([0x40, 2, 0, 0, 0, 0]), pf, /gradient filter needs 16 or 32/)
  })

  test('TightPNG: basic compression, a PNG of the wrong size, a corrupt PNG', async () => {
    await rejectsWith(E.tightPng, 2, 2, bytes([0x00, 0, 0, 0, 0]), bgrx, /invalid compression control/)
    await rejectsWith(E.tightPng, 2, 2, bytes([0x40, 0, 0, 0, 0]), bgrx, /invalid compression control/)
    const png = encodePng(3, 2, new Array(18).fill(9), { colorType: 2, bitDepth: 8 })
    await rejectsWith(E.tightPng, 2, 2, bytes([0xa0], compactLength(png.length), png), bgrx, /3×2 PNG for a 2×2 rect/)
    const bad = Buffer.from(png)
    bad[0] = 0
    await rejectsWith(E.tightPng, 3, 2, bytes([0xa0], compactLength(bad.length), bad), bgrx, /PNG: bad signature/)
  })

  test('Hextile: no background, no foreground', async () => {
    await rejectsWith(E.hextile, 4, 4, bytes([0]), pf, /without a background/)
    await rejectsWith(E.hextile, 4, 4, bytes([HEX.bg | HEX.any, 5, 1, 0x00, 0x00]), pf, /without a foreground/)
    // A raw tile, then a tile with no background of its own: the raw tile gave none.
    await rejectsWith(E.hextile, 17, 1, bytes([HEX.raw], new Array(16).fill(1), [0]), pf, /without a background/)
  })

  test('Cursor With Alpha: encodings that cannot carry the cursor', async () => {
    for (const inner of [E.copyRect, 3, E.pseudoCursor, E.tightPng + 1]) {
      await rejectsWith(
        E.pseudoCursorWithAlpha,
        2,
        2,
        encodeCursorWithAlpha(inner, Buffer.alloc(16)),
        pf,
        /can't carry/,
      )
    }
    const jpeg = new TightEncoder().jpeg(Buffer.from('jpeg'))
    await rejectsWith(E.pseudoCursorWithAlpha, 2, 2, encodeCursorWithAlpha(E.tight, jpeg), pf, /JPEG cursor/)
  })

  test('an encoding nobody asked for', async () => {
    await assert.rejects(
      decodeAll(new Decoder(), [item(3, 2, 2, Buffer.alloc(4))], pf, 1),
      (err: unknown) => err instanceof RfbError && err.code === 'UNSUPPORTED_ENCODING',
    )
  })

  test('the stream ending mid-rect rejects with the stream error', async () => {
    const img = testImage(bgrx, 40, 40, 3)
    const d = new Deflater()
    for (const [encoding, data] of [
      [E.raw, encodeRaw(img)],
      [E.hextile, encodeHextile(img)],
      [E.trle, encodeTrle(img, bgrx)],
      [E.zrle, await encodeZrle(d, img, bgrx)],
      [E.rre, encodeRre(img, false)],
    ] as const) {
      const reader = new ByteReader()
      const decoding = new Decoder().decode(reader, { x: 0, y: 0, width: 40, height: 40, encoding }, bgrx, [])
      await feed(reader, data.subarray(0, data.length - 1), rng(encoding))
      const end = new Error('connection closed')
      reader.destroy(end)
      await assert.rejects(decoding, (err) => err === end)
    }
    d.close()
  })
})
