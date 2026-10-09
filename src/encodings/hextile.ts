import { subEncodings } from '../constants.ts'
import { protocolError } from '../errors.ts'
import type { ByteReader } from '../reader.ts'
import { blit, fill, readFast } from './util.ts'

const {
  raw: RAW,
  backgroundSpecified: BG,
  foregroundSpecified: FG,
  anySubrects: ANY,
  subrectsColored: COLOURED,
} = subEncodings.hextile

/**
 * Hextile: 16×16 tiles left to right, top to bottom (the last column and row may be smaller), each
 * raw or a background plus subrects. Background and foreground carry over from tile to tile.
 */
export async function decodeHextile(reader: ByteReader, w: number, h: number, bpp: number): Promise<Buffer> {
  const stride = w * bpp
  const out = Buffer.alloc(w * h * bpp)
  let bg: Uint8Array | null = null
  let fg: Uint8Array | null = null
  for (let ty = 0; ty < h; ty += 16) {
    const th = Math.min(16, h - ty)
    for (let tx = 0; tx < w; tx += 16) {
      const tw = Math.min(16, w - tx)
      const sub = (await readFast(reader, 1))[0] as number
      if (sub & RAW) {
        blit(out, stride, bpp, tx, ty, tw, th, await readFast(reader, tw * th * bpp))
        continue
      }
      const headLength = (sub & BG ? bpp : 0) + (sub & FG ? bpp : 0) + (sub & ANY ? 1 : 0)
      const head = headLength > 0 ? await readFast(reader, headLength) : null
      let o = 0
      if (sub & BG) {
        bg = (head as Buffer).subarray(0, bpp)
        o = bpp
      }
      if (sub & FG) {
        fg = (head as Buffer).subarray(o, o + bpp)
        o += bpp
      }
      if (bg === null) throw protocolError('Hextile: a tile without a background before any background was given')
      fill(out, stride, bpp, tx, ty, tw, th, bg)
      if (!(sub & ANY)) continue
      const n = (head as Buffer)[o] as number
      if (n === 0) continue
      const coloured = (sub & COLOURED) !== 0
      if (!coloured && fg === null) throw protocolError('Hextile: subrects without a foreground colour')
      const size = coloured ? bpp + 2 : 2
      const body = await readFast(reader, n * size)
      for (let i = 0, p = 0; i < n; i++, p += size) {
        let colour = fg as Uint8Array
        if (coloured) {
          colour = body.subarray(p, p + bpp)
          fg = colour
        }
        const xy = body[p + size - 2] as number
        const wh = body[p + size - 1] as number
        const sx = xy >> 4
        const sy = xy & 15
        const sw = Math.min((wh >> 4) + 1, tw - sx)
        const sh = Math.min((wh & 15) + 1, th - sy)
        fill(out, stride, bpp, tx + sx, ty + sy, sw, sh, colour)
      }
    }
  }
  return out
}
