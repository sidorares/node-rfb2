import { protocolError } from '../errors.ts'
import type { Inflator } from '../inflator.ts'
import { bytesPerPixel, cpixelOffset, type PixelFormat } from '../pixel-format.ts'
import type { ByteReader } from '../reader.ts'
import { fill } from './util.ts'

// TRLE (16×16 tiles, sent as is) and ZRLE (64×64 tiles inside the connection's zlib stream) share
// the tile format: raw, solid, packed palette, plain RLE and palette RLE, with 3-byte CPIXELs for
// 32-bit formats whose colours fit in three bytes. TRLE adds palette reuse (subencodings 127, 129).

/** Thrown by the tile parser when the bytes at hand end mid-tile (TRLE then waits for more). */
const NEED_MORE = Symbol('need more data')

interface TileFormat {
  bpp: number
  /** Bytes per CPIXEL. */
  cp: number
  /** Where a 3-byte CPIXEL goes in a 4-byte pixel. */
  cpOffset: number
  trle: boolean
}

/** The palette persists between tiles (TRLE reuses it). */
interface TileState {
  palette: Buffer
  paletteSize: number
  pixel: Buffer
}

function tileFormat(pf: PixelFormat, trle: boolean): TileFormat {
  const bpp = bytesPerPixel(pf)
  const cpOffset = cpixelOffset(pf)
  return { bpp, cp: cpOffset < 0 ? bpp : 3, cpOffset: Math.max(0, cpOffset), trle }
}

function newState(bpp: number): TileState {
  return { palette: Buffer.alloc(128 * bpp), paletteSize: 0, pixel: Buffer.alloc(bpp) }
}

/** ZRLE: a U32 length, then that much of the connection's zlib stream, which inflates to 64×64 tiles. */
export async function decodeZrle(
  reader: ByteReader,
  inflator: Inflator,
  w: number,
  h: number,
  pf: PixelFormat,
): Promise<Buffer> {
  const length = await reader.u32()
  const compressed = await reader.read(length)
  const data = length > 0 ? await inflator.inflate(compressed) : compressed
  const f = tileFormat(pf, false)
  const state = newState(f.bpp)
  const out = Buffer.alloc(w * h * f.bpp)
  let pos = 0
  try {
    for (let ty = 0; ty < h; ty += 64) {
      for (let tx = 0; tx < w; tx += 64) {
        pos = decodeTile(data, pos, out, w, f, state, tx, ty, Math.min(64, w - tx), Math.min(64, h - ty))
      }
    }
  } catch (err) {
    if (err === NEED_MORE) throw protocolError('ZRLE: the zlib data ended in the middle of a tile')
    throw err
  }
  return out
}

/** TRLE: 16×16 tiles straight from the stream (not length-prefixed: each tile is parsed when complete). */
export async function decodeTrle(reader: ByteReader, w: number, h: number, pf: PixelFormat): Promise<Buffer> {
  const f = tileFormat(pf, true)
  const state = newState(f.bpp)
  const out = Buffer.alloc(w * h * f.bpp)
  for (let ty = 0; ty < h; ty += 16) {
    for (let tx = 0; tx < w; tx += 16) {
      let buf = reader.peek()
      for (;;) {
        try {
          reader.consume(decodeTile(buf, 0, out, w, f, state, tx, ty, Math.min(16, w - tx), Math.min(16, h - ty)))
          break
        } catch (err) {
          if (err !== NEED_MORE) throw err
          buf = await reader.waitFor(buf.length + 1)
        }
      }
    }
  }
  return out
}

/** Decodes the tile at `src[pos]` into `out` (a `w`-pixel-wide rect); returns the position after it. */
function decodeTile(
  src: Buffer,
  pos: number,
  out: Buffer,
  w: number,
  f: TileFormat,
  state: TileState,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): number {
  const { bpp, cp } = f
  const stride = w * bpp
  const end = src.length
  const need = (n: number) => {
    if (pos + n > end) throw NEED_MORE
  }

  need(1)
  const sub = src[pos++] as number
  let paletteSize = sub & 0x7f

  // Reads a CPIXEL at `pos` into `dst` at `d`.
  const cpixel = (dst: Buffer, d: number) => {
    if (cp === bpp) {
      for (let i = 0; i < bpp; i++) dst[d + i] = src[pos + i] as number
    } else {
      dst[d] = 0
      dst[d + 3] = 0
      dst[d + f.cpOffset] = src[pos] as number
      dst[d + f.cpOffset + 1] = src[pos + 1] as number
      dst[d + f.cpOffset + 2] = src[pos + 2] as number
    }
    pos += cp
  }

  const readPalette = (size: number) => {
    need(size * cp)
    for (let i = 0; i < size; i++) cpixel(state.palette, i * bpp)
    state.paletteSize = size
  }

  // Fills `len` pixels starting at tile pixel index `i` (runs wrap from row to row).
  const run = (i: number, len: number, pixel: Uint8Array) => {
    while (len > 0) {
      const row = Math.floor(i / tw)
      const col = i - row * tw
      const n = Math.min(len, tw - col)
      fill(out, stride, bpp, tx + col, ty + row, n, 1, pixel)
      i += n
      len -= n
    }
  }

  const runLength = () => {
    let len = 1
    for (;;) {
      need(1)
      const b = src[pos++] as number
      len += b
      if (b !== 255) return len
    }
  }

  const total = tw * th

  if ((sub & 0x80) === 0) {
    if (paletteSize === 0) {
      // Raw CPIXELs.
      need(total * cp)
      for (let y = 0; y < th; y++) {
        let d = (ty + y) * stride + tx * bpp
        if (cp === bpp) {
          src.copy(out, d, pos, pos + tw * bpp)
          pos += tw * bpp
        } else {
          for (let x = 0; x < tw; x++, d += bpp) cpixel(out, d)
        }
      }
      return pos
    }
    if (paletteSize === 1) {
      need(cp)
      cpixel(state.pixel, 0)
      fill(out, stride, bpp, tx, ty, tw, th, state.pixel)
      return pos
    }
    if (paletteSize === 127 && f.trle) {
      paletteSize = state.paletteSize
      if (paletteSize < 2 || paletteSize > 16) throw protocolError('TRLE: palette reuse without a packed palette')
    } else if (paletteSize > 16) {
      throw protocolError(`${f.trle ? 'TRLE' : 'ZRLE'}: invalid tile subencoding ${sub}`)
    } else {
      readPalette(paletteSize)
    }
    const bits = paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : 4
    const mask = (1 << bits) - 1
    const rowBytes = (tw * bits + 7) >> 3
    need(rowBytes * th)
    for (let y = 0; y < th; y++) {
      const rowStart = pos + y * rowBytes
      let d = (ty + y) * stride + tx * bpp
      for (let x = 0; x < tw; x++, d += bpp) {
        const bit = x * bits
        const index = ((src[rowStart + (bit >> 3)] as number) >> (8 - bits - (bit & 7))) & mask
        if (index >= paletteSize) throw protocolError('ZRLE/TRLE: palette index out of range')
        state.palette.copy(out, d, index * bpp, index * bpp + bpp)
      }
    }
    return pos + rowBytes * th
  }

  if (paletteSize === 0) {
    // Plain RLE: (CPIXEL, run length) pairs.
    for (let i = 0; i < total; ) {
      need(cp)
      cpixel(state.pixel, 0)
      const len = runLength()
      if (i + len > total) throw protocolError('ZRLE/TRLE: a run goes past the end of the tile')
      run(i, len, state.pixel)
      i += len
    }
    return pos
  }

  if (paletteSize === 1) {
    if (!f.trle) throw protocolError('ZRLE: invalid tile subencoding 129')
    paletteSize = state.paletteSize
    if (paletteSize < 2) throw protocolError('TRLE: palette reuse without a palette')
  } else {
    readPalette(paletteSize)
  }
  // Palette RLE: an index (top bit set: followed by a run length).
  for (let i = 0; i < total; ) {
    need(1)
    let index = src[pos++] as number
    let len = 1
    if (index & 0x80) {
      index &= 0x7f
      len = runLength()
    }
    if (index >= paletteSize) throw protocolError('ZRLE/TRLE: palette index out of range')
    if (i + len > total) throw protocolError('ZRLE/TRLE: a run goes past the end of the tile')
    run(i, len, state.palette.subarray(index * bpp, index * bpp + bpp))
    i += len
  }
  return pos
}
