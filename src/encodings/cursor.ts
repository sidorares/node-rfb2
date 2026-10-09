import { bytesPerPixel, type Color, type PixelFormat, pixelToRgb, readPixel } from '../pixel-format.ts'
import type { ByteReader } from '../reader.ts'

const maskBit = (mask: Uint8Array, rowBytes: number, x: number, y: number) =>
  ((mask[y * rowBytes + (x >> 3)] as number) >> (7 - (x & 7))) & 1

/** Cursor pseudo-encoding: pixels in the client's format, then a 1-bit transparency mask. */
export async function decodeRichCursor(
  reader: ByteReader,
  w: number,
  h: number,
  pf: PixelFormat,
  colorMap: readonly (Color | undefined)[],
): Promise<{ rgba: Buffer; data: Buffer; mask: Buffer }> {
  const bpp = bytesPerPixel(pf)
  const rowBytes = (w + 7) >> 3
  const data = await reader.read(w * h * bpp)
  const mask = await reader.read(rowBytes * h)
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const [r, g, b] = pixelToRgb(pf, readPixel(pf, data, i * bpp), colorMap)
      rgba[i * 4] = r
      rgba[i * 4 + 1] = g
      rgba[i * 4 + 2] = b
      rgba[i * 4 + 3] = maskBit(mask, rowBytes, x, y) ? 255 : 0
    }
  }
  return { rgba, data, mask }
}

/** X Cursor pseudo-encoding: two colours, a 1-bit image choosing between them and a 1-bit mask. */
export async function decodeXCursor(reader: ByteReader, w: number, h: number): Promise<{ rgba: Buffer }> {
  const rgba = Buffer.alloc(w * h * 4)
  if (w === 0 || h === 0) return { rgba }
  const rowBytes = (w + 7) >> 3
  const colors = await reader.read(6)
  const bitmap = await reader.read(rowBytes * h)
  const mask = await reader.read(rowBytes * h)
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const c = maskBit(bitmap, rowBytes, x, y) ? 0 : 3
      rgba[i] = colors[c] as number
      rgba[i + 1] = colors[c + 1] as number
      rgba[i + 2] = colors[c + 2] as number
      rgba[i + 3] = maskBit(mask, rowBytes, x, y) ? 255 : 0
    }
  }
  return { rgba }
}

/**
 * VMware cursor pseudo-encoding: type 0 is a classic AND/XOR cursor in the client's pixel format,
 * type 1 an RGBA image. XOR pixels that invert the screen are drawn opaque in their colour.
 */
export async function decodeVMwareCursor(
  reader: ByteReader,
  w: number,
  h: number,
  pf: PixelFormat,
  colorMap: readonly (Color | undefined)[],
): Promise<{ rgba: Buffer }> {
  const [type] = await reader.read(2)
  if (type === 1) return { rgba: Buffer.from(await reader.read(w * h * 4)) }
  const bpp = bytesPerPixel(pf)
  const and = await reader.read(w * h * bpp)
  const xor = await reader.read(w * h * bpp)
  const allOnes = pf.bitsPerPixel === 32 ? 0xffffffff : (1 << pf.bitsPerPixel) - 1
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const a = readPixel(pf, and, i * bpp)
    const x = readPixel(pf, xor, i * bpp)
    if (a === allOnes && x === 0) continue // transparent
    const [r, g, b] = pixelToRgb(pf, x, colorMap)
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 255
  }
  return { rgba }
}

/** RGBA with premultiplied alpha (CursorWithAlpha) to straight alpha, in place. */
export function unpremultiply(rgba: Buffer): Buffer {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] as number
    if (a === 0 || a === 255) continue
    rgba[i] = Math.min(255, Math.round(((rgba[i] as number) * 255) / a))
    rgba[i + 1] = Math.min(255, Math.round(((rgba[i + 1] as number) * 255) / a))
    rgba[i + 2] = Math.min(255, Math.round(((rgba[i + 2] as number) * 255) / a))
  }
  return rgba
}
