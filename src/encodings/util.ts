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

/** Guards allocations driven by numbers from the wire. */
export function checkCount(n: number, max: number, what: string): void {
  if (n > max) throw protocolError(`${what}: ${n} is more than the ${max} possible`)
}
