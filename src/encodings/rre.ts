import { protocolError } from '../errors.ts'
import type { ByteReader } from '../reader.ts'
import { checkCount, PixelBuffer } from './util.ts'

/**
 * How many times its own area the subrects of a rect may paint in all. Encoders split a rect into
 * subrects that don't overlap, so theirs add up to at most its area. Overlaps aren't forbidden, so a
 * few times that is allowed; more is refused, because a subrect costs the server 8 to 12 bytes but
 * can make the client paint the whole rect: a few MB of them would keep the client busy for minutes.
 */
const MAX_COVERAGE = 4

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
  const name = compact ? 'CoRRE' : 'RRE'
  const head = await reader.read(4 + bpp)
  const n = head.readUInt32BE(0)
  checkCount(n, w * h, `${name} subrects`)
  const out = new PixelBuffer(w, h, bpp)
  out.fill(0, 0, w, h, PixelBuffer.word(head, 4, bpp))
  const size = bpp + (compact ? 4 : 8)
  let budget = MAX_COVERAGE * w * h
  // Read in batches so a huge subrect count doesn't buffer it all at once.
  const batch = 4096
  for (let done = 0; done < n; ) {
    const count = Math.min(batch, n - done)
    const body = await reader.read(count * size)
    for (let i = 0; i < count; i++) {
      const o = i * size
      const word = PixelBuffer.word(body, o, bpp)
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
      const cw = Math.min(sw, w - sx)
      const ch = Math.min(sh, h - sy)
      if (cw <= 0 || ch <= 0) continue
      budget -= cw * ch
      if (budget < 0) {
        throw protocolError(`${name}: the subrects paint more than ${MAX_COVERAGE} times the ${w}×${h} rect`)
      }
      out.fill(sx, sy, cw, ch, word)
    }
    done += count
  }
  return out.data
}
