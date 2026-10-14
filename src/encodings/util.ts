import { protocolError } from '../errors.ts'
import type { ByteReader } from '../reader.ts'

/** `n` bytes, without a microtask hop when they are already buffered (hot loops: Hextile tiles). */
export function readFast(reader: ByteReader, n: number): Buffer | Promise<Buffer> {
  return reader.readNow(n) ?? reader.read(n)
}

/** Fills a `w`×`h` area at `x`, `y` of a `stride`-bytes-per-row pixel buffer with one pixel value. */
export function fill(
  out: Buffer,
  stride: number,
  bpp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  pixel: Uint8Array,
): void {
  if (w <= 0 || h <= 0) return
  const rowBytes = w * bpp
  let o = y * stride + x * bpp
  if (bpp === 1) {
    const v = pixel[0] as number
    for (let r = 0; r < h; r++, o += stride) out.fill(v, o, o + rowBytes)
    return
  }
  for (let r = 0; r < h; r++, o += stride) out.fill(pixel, o, o + rowBytes)
}

/** Copies `w`×`h` pixels from `src` (rows of `srcStride` bytes) to `x`, `y` of `out`. */
export function blit(
  out: Buffer,
  stride: number,
  bpp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  src: Uint8Array,
  srcStride = w * bpp,
): void {
  const rowBytes = w * bpp
  for (let r = 0; r < h; r++) {
    out.set(src.subarray(r * srcStride, r * srcStride + rowBytes), (y + r) * stride + x * bpp)
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/**
 * The pixels of one rect, written as "words": a pixel's bytes read as one native-endian number,
 * so a whole pixel is set with one typed-array store and areas filled with `TypedArray.fill`.
 */
export class PixelBuffer {
  readonly data: Buffer
  readonly width: number
  readonly bpp: number
  readonly words: Uint8Array | Uint16Array | Uint32Array

  constructor(width: number, height: number, bpp: number) {
    // Buffer.alloc never hands out a slice of the shared pool, so the data is word-aligned.
    this.data = Buffer.alloc(width * height * bpp)
    this.width = width
    this.bpp = bpp
    const n = width * height
    this.words =
      bpp === 4
        ? new Uint32Array(this.data.buffer, this.data.byteOffset, n)
        : bpp === 2
          ? new Uint16Array(this.data.buffer, this.data.byteOffset, n)
          : this.data
  }

  /** The word for the `bpp` pixel bytes at `src[offset]`. */
  static word(src: Uint8Array, offset: number, bpp: number): number {
    if (bpp === 4) {
      return LITTLE_ENDIAN
        ? ((src[offset] as number) |
            ((src[offset + 1] as number) << 8) |
            ((src[offset + 2] as number) << 16) |
            ((src[offset + 3] as number) << 24)) >>>
            0
        : (((src[offset] as number) << 24) |
            ((src[offset + 1] as number) << 16) |
            ((src[offset + 2] as number) << 8) |
            (src[offset + 3] as number)) >>>
            0
    }
    if (bpp === 2) {
      return LITTLE_ENDIAN
        ? (src[offset] as number) | ((src[offset + 1] as number) << 8)
        : ((src[offset] as number) << 8) | (src[offset + 1] as number)
    }
    return src[offset] as number
  }

  /** The word for a 3-byte CPIXEL at `src[offset]` placed at byte `at` (0 or 1) of a 4-byte pixel. */
  static cpixelWord(src: Uint8Array, offset: number, at: number): number {
    const b0 = src[offset] as number
    const b1 = src[offset + 1] as number
    const b2 = src[offset + 2] as number
    if (LITTLE_ENDIAN) return at === 0 ? b0 | (b1 << 8) | (b2 << 16) : ((b0 << 8) | (b1 << 16) | (b2 << 24)) >>> 0
    return at === 0 ? ((b0 << 24) | (b1 << 16) | (b2 << 8)) >>> 0 : (b0 << 16) | (b1 << 8) | b2
  }

  /** Fills a `w`×`h` area with one word (clipped to nothing when empty). */
  fill(x: number, y: number, w: number, h: number, word: number): void {
    if (w <= 0 || h <= 0) return
    const width = this.width
    for (let r = 0, i = y * width + x; r < h; r++, i += width) this.words.fill(word, i, i + w)
  }

  /** Copies `w`×`h` pixels of `bpp`-byte bytes from `src` (rows of `w * bpp`) to `x`, `y`. */
  put(x: number, y: number, w: number, h: number, src: Uint8Array, srcOffset = 0): void {
    const rowBytes = w * this.bpp
    const stride = this.width * this.bpp
    for (let r = 0; r < h; r++) {
      const from = srcOffset + r * rowBytes
      this.data.set(src.subarray(from, from + rowBytes), (y + r) * stride + x * this.bpp)
    }
  }
}

/** Guards allocations driven by numbers from the wire. */
export function checkCount(n: number, max: number, what: string): void {
  if (n > max) throw protocolError(`${what}: ${n} is more than the ${max} possible`)
}
