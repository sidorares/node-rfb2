import type { ByteReader } from '../reader.ts'
import { checkCount, fill } from './util.ts'

/**
 * RRE (`compact` false: 16-bit subrect geometry) and CoRRE (`compact` true: 8-bit geometry):
 * a background pixel and a list of solid subrects. Subrects are clipped to the rect.
 */
export async function decodeRre(
  reader: ByteReader,
  w: number,
  h: number,
  bpp: number,
  compact: boolean,
): Promise<Buffer> {
  const head = await reader.read(4 + bpp)
  const n = head.readUInt32BE(0)
  checkCount(n, w * h, 'RRE subrects')
  const stride = w * bpp
  const out = Buffer.alloc(w * h * bpp)
  fill(out, stride, bpp, 0, 0, w, h, head.subarray(4))
  const size = bpp + (compact ? 4 : 8)
  // Read in batches so a huge subrect count doesn't buffer it all at once.
  const batch = 4096
  for (let done = 0; done < n; ) {
    const count = Math.min(batch, n - done)
    const body = await reader.read(count * size)
    for (let i = 0; i < count; i++) {
      const o = i * size
      const pixel = body.subarray(o, o + bpp)
      let sx: number
      let sy: number
      let sw: number
      let sh: number
      if (compact) {
        sx = body[o + bpp] as number
        sy = body[o + bpp + 1] as number
        sw = body[o + bpp + 2] as number
        sh = body[o + bpp + 3] as number
      } else {
        sx = body.readUInt16BE(o + bpp)
        sy = body.readUInt16BE(o + bpp + 2)
        sw = body.readUInt16BE(o + bpp + 4)
        sh = body.readUInt16BE(o + bpp + 6)
      }
      fill(out, stride, bpp, sx, sy, Math.min(sw, w - sx), Math.min(sh, h - sy), pixel)
    }
    done += count
  }
  return out
}
