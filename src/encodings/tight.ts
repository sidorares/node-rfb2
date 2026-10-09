import { protocolError, RfbError } from '../errors.ts'
import type { Inflator } from '../inflator.ts'
import { bytesPerPixel, isTightRgb, type PixelFormat, readPixel, rgbToPixels, writePixel } from '../pixel-format.ts'
import { decodePng } from '../png.ts'
import type { ByteReader } from '../reader.ts'
import { fill } from './util.ts'

/**
 * Decodes JPEG data (Tight's lossy rects) to `width * height` pixels, 3 (RGB) or 4 (RGBA) bytes
 * each. For example with jpeg-js: `(jpeg) => decode(jpeg, { useTArray: true }).data`.
 */
export type JpegDecoder = (jpeg: Buffer, width: number, height: number) => Uint8Array | Promise<Uint8Array>

export type TightResult = { data: Buffer } | { jpeg: Buffer }

const FILL = 0x08
const JPEG = 0x09
const PNG_OR_NO_ZLIB = 0x0a
const NO_ZLIB_WITH_FILTER = 0x0e

const COPY_FILTER = 0
const PALETTE_FILTER = 1
const GRADIENT_FILTER = 2

/** Below this many bytes Tight sends filtered data uncompressed. */
const MIN_TO_COMPRESS = 12

/**
 * Tight (`png` false) and TightPNG (`png` true). `streams` are the connection's four zlib streams.
 * JPEG rects become pixels with `decodeJpeg`, else they are returned as `{ jpeg }`.
 */
export async function decodeTight(
  reader: ByteReader,
  streams: Inflator[],
  w: number,
  h: number,
  pf: PixelFormat,
  png: boolean,
  decodeJpeg?: JpegDecoder,
): Promise<TightResult> {
  const name = png ? 'TightPNG' : 'Tight'
  const control = await reader.u8()
  for (let i = 0; i < 4; i++) if (control & (1 << i)) (streams[i] as Inflator).reset()
  const bpp = bytesPerPixel(pf)
  const rgb = isTightRgb(pf)
  const tpixel = rgb ? 3 : bpp
  const comp = control >> 4

  if (comp === FILL) {
    const pixel = toPixels(pf, await reader.read(tpixel), 1, rgb)
    const out = Buffer.alloc(w * h * bpp)
    fill(out, w * bpp, bpp, 0, 0, w, h, pixel)
    return { data: out }
  }

  if (comp === JPEG) {
    const jpeg = await reader.read(await compactLength(reader))
    if (!decodeJpeg) return { jpeg }
    return { data: fromRgb(pf, await decodeJpeg(jpeg, w, h), w, h, 'JPEG') }
  }

  if (png) {
    if (comp !== PNG_OR_NO_ZLIB) throw protocolError(`TightPNG: invalid compression control 0x${control.toString(16)}`)
    const image = decodePng(await reader.read(await compactLength(reader)))
    if (image.width !== w || image.height !== h) {
      throw protocolError(`TightPNG: a ${image.width}×${image.height} PNG for a ${w}×${h} rect`)
    }
    return { data: fromRgb(pf, image.rgba, w, h, 'PNG') }
  }

  let filter = COPY_FILTER
  let compressed = true
  if (comp & 0x08) {
    // BasicCompression Without Zlib.
    if (comp !== PNG_OR_NO_ZLIB && comp !== NO_ZLIB_WITH_FILTER) {
      throw protocolError(`${name}: invalid compression control 0x${control.toString(16)}`)
    }
    compressed = false
    if (comp === NO_ZLIB_WITH_FILTER) filter = await reader.u8()
  } else if (comp & 0x04) {
    filter = await reader.u8()
  }
  const stream = streams[comp & 0x03] as Inflator

  const readData = async (size: number): Promise<Buffer> => {
    if (!compressed || size < MIN_TO_COMPRESS) return reader.read(size)
    const zlibData = await reader.read(await compactLength(reader))
    return stream.inflate(zlibData, size)
  }

  switch (filter) {
    case COPY_FILTER: {
      const data = await readData(w * h * tpixel)
      return { data: rgb ? toPixels(pf, data, w * h, true) : Buffer.from(data) }
    }
    case PALETTE_FILTER: {
      const colors = (await reader.u8()) + 1
      const palette = toPixels(pf, await reader.read(colors * tpixel), colors, rgb)
      const out = Buffer.alloc(w * h * bpp)
      if (colors === 2) {
        const rowBytes = (w + 7) >> 3
        const bits = await readData(rowBytes * h)
        for (let y = 0, d = 0; y < h; y++) {
          for (let x = 0; x < w; x++, d += bpp) {
            const index = ((bits[y * rowBytes + (x >> 3)] as number) >> (7 - (x & 7))) & 1
            palette.copy(out, d, index * bpp, index * bpp + bpp)
          }
        }
      } else {
        const indices = await readData(w * h)
        for (let i = 0, d = 0; i < w * h; i++, d += bpp) {
          const index = indices[i] as number
          if (index >= colors) throw protocolError(`${name}: palette index ${index} of ${colors} colours`)
          palette.copy(out, d, index * bpp, index * bpp + bpp)
        }
      }
      return { data: out }
    }
    case GRADIENT_FILTER: {
      if (pf.bitsPerPixel === 8) throw protocolError(`${name}: the gradient filter needs 16 or 32 bits per pixel`)
      const data = await readData(w * h * tpixel)
      return { data: rgb ? toPixels(pf, gradientRgb(data, w, h), w * h, true) : gradient(pf, data, w, h) }
    }
    default:
      throw protocolError(`${name}: unknown filter ${filter}`)
  }
}

/** Tight's compact length: 1 to 3 bytes, 7 bits each (the third byte 8), least significant first. */
async function compactLength(reader: ByteReader): Promise<number> {
  let b = await reader.u8()
  let length = b & 0x7f
  if (b & 0x80) {
    b = await reader.u8()
    length |= (b & 0x7f) << 7
    if (b & 0x80) length |= (await reader.u8()) << 14
  }
  return length
}

/** `count` TPIXELs as pixels: R, G, B triplets when `rgb`, else already pixels. */
function toPixels(pf: PixelFormat, tpixels: Buffer, count: number, rgb: boolean): Buffer {
  if (!rgb) return Buffer.from(tpixels)
  const out = Buffer.alloc(count * bytesPerPixel(pf))
  rgbToPixels(pf, tpixels, 3, count, out)
  return out
}

/** RGB or RGBA (by length) image data as pixels. */
function fromRgb(pf: PixelFormat, image: Uint8Array, w: number, h: number, what: string): Buffer {
  const stride = image.length === w * h * 4 ? 4 : image.length === w * h * 3 ? 3 : 0
  if (stride === 0) {
    throw new RfbError(
      'PROTOCOL_ERROR',
      `the ${what} decoder returned ${image.length} bytes for a ${w}×${h} rect; it must return RGB or RGBA pixels`,
    )
  }
  const out = Buffer.alloc(w * h * bytesPerPixel(pf))
  rgbToPixels(pf, image, stride, w * h, out)
  return out
}

/** Undoes the gradient filter on R, G, B bytes (TPIXELs). */
function gradientRgb(data: Buffer, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 3)
  const rowBytes = w * 3
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const i = row + x * 3 + c
        const up = y > 0 ? (out[i - rowBytes] as number) : 0
        const left = x > 0 ? (out[i - 3] as number) : 0
        const upLeft = x > 0 && y > 0 ? (out[i - rowBytes - 3] as number) : 0
        const predicted = Math.min(255, Math.max(0, up + left - upLeft))
        out[i] = (predicted + (data[i] as number)) & 0xff
      }
    }
  }
  return out
}

/** Undoes the gradient filter on 16/32-bit pixels: per colour component, modulo the component's range. */
function gradient(pf: PixelFormat, data: Buffer, w: number, h: number): Buffer {
  const bpp = bytesPerPixel(pf)
  const max = [pf.redMax, pf.greenMax, pf.blueMax] as const
  const shift = [pf.redShift, pf.greenShift, pf.blueShift] as const
  const out = Buffer.alloc(w * h * bpp)
  // Reconstructed components of the previous and the current row.
  let prev = new Int32Array(w * 3)
  let cur = new Int32Array(w * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const diff = readPixel(pf, data, (y * w + x) * bpp)
      let value = 0
      for (let c = 0; c < 3; c++) {
        const m = max[c] as number
        const up = prev[x * 3 + c] as number
        const left = x > 0 ? (cur[(x - 1) * 3 + c] as number) : 0
        const upLeft = x > 0 ? (prev[(x - 1) * 3 + c] as number) : 0
        const predicted = Math.min(m, Math.max(0, up + left - upLeft))
        const v = (predicted + ((diff >>> (shift[c] as number)) & m)) & m
        cur[x * 3 + c] = v
        value |= v << (shift[c] as number)
      }
      writePixel(pf, value >>> 0, out, (y * w + x) * bpp)
    }
    ;[prev, cur] = [cur, prev]
  }
  return out
}
