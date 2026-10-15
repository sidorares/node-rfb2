import { protocolError } from '../errors.ts'
import { checkZlibLength, type Inflator } from '../inflator.ts'
import { bytesPerPixel, cpixelOffset, type PixelFormat } from '../pixel-format.ts'
import type { ByteReader } from '../reader.ts'
import { PixelBuffer } from './util.ts'

// TRLE (16×16 tiles, sent as is) and ZRLE (64×64 tiles inside the connection's zlib stream) share
// the tile format: raw, solid, packed palette, plain RLE and palette RLE, with 3-byte CPIXELs for
// 32-bit formats whose colours fit in three bytes. TRLE adds palette reuse (subencodings 127, 129).

/** Thrown by the tile parser when the bytes at hand end mid-tile (TRLE then waits for more). */
const NEED_MORE = Symbol('need more data')

interface TileFormat {
  bpp: number
  /** Bytes per CPIXEL. */
  cp: number
  /** Where a 3-byte CPIXEL goes in a 4-byte pixel (0 or 1). */
  cpOffset: number
  trle: boolean
}

/** The palette (as pixel words) persists between tiles: TRLE can reuse it. */
interface TileState {
  palette: Uint32Array
  paletteSize: number
}

function tileFormat(pf: PixelFormat, trle: boolean): TileFormat {
  const bpp = bytesPerPixel(pf)
  const cpOffset = cpixelOffset(pf)
  return { bpp, cp: cpOffset < 0 ? bpp : 3, cpOffset: Math.max(0, cpOffset), trle }
}

/**
 * The most tile data a valid ZRLE rect of `w`×`h` pixels with `cp`-byte CPIXELs can inflate to.
 *
 * A tile of n = tw×th pixels (n ≤ 64×64) is a subencoding byte and then at most:
 * - raw: n·cp
 * - solid: cp
 * - packed palette (2 to 16 colours): 16·cp + th·⌈tw/2⌉ ≤ 16·cp + n (4-bit indices, rows padded to bytes)
 * - plain RLE: a CPIXEL and a run length of ⌊(len − 1) / 255⌋ + 1 bytes per run. Runs of one pixel
 *   cost the most per pixel: n·(cp + 1)
 * - palette RLE (2 to 127 colours): 127·cp, then at most 2 bytes per pixel (an index with the run bit
 *   and a one-byte length, for a run of one): 127·cp + 2·n
 * Every case is at most n·(cp + 1) + 127·cp (as cp ≥ 1, 2·n ≤ n·(cp + 1)). Summed over the tiles,
 * whose n add up to w·h: w·h·(cp + 1) + tiles·(1 + 127·cp), tiles = ⌈w/64⌉·⌈h/64⌉.
 *
 * For a full 7680×4320 (8K) screen with 3-byte CPIXELs that is 135.8 MB, 2% more than the 132.7 MB of
 * pixels it decodes to. Valid tile data never exceeds it; zlib data that inflates to more is cut off.
 */
export function zrleMaxLength(w: number, h: number, cp: number): number {
  const tiles = Math.ceil(w / 64) * Math.ceil(h / 64)
  return w * h * (cp + 1) + tiles * (1 + 127 * cp)
}

/** ZRLE: a U32 length, then that much of the connection's zlib stream, which inflates to 64×64 tiles. */
export async function decodeZrle(
  reader: ByteReader,
  inflator: Inflator,
  w: number,
  h: number,
  pf: PixelFormat,
): Promise<Buffer> {
  const f = tileFormat(pf, false)
  const max = zrleMaxLength(w, h, f.cp)
  const length = await reader.u32()
  checkZlibLength(length, max, 'ZRLE')
  const compressed = await reader.read(length)
  const data = length > 0 ? await inflator.inflate(compressed, max, false) : compressed
  const state: TileState = { palette: new Uint32Array(128), paletteSize: 0 }
  const out = new PixelBuffer(w, h, f.bpp)
  let pos = 0
  try {
    for (let ty = 0; ty < h; ty += 64) {
      for (let tx = 0; tx < w; tx += 64) {
        pos = decodeTile(data, pos, out, f, state, tx, ty, Math.min(64, w - tx), Math.min(64, h - ty))
      }
    }
  } catch (err) {
    if (err === NEED_MORE) throw protocolError('ZRLE: the zlib data ended in the middle of a tile')
    throw err
  }
  return out.data
}

/** TRLE: 16×16 tiles straight from the stream (not length-prefixed: each tile is parsed when complete). */
export async function decodeTrle(reader: ByteReader, w: number, h: number, pf: PixelFormat): Promise<Buffer> {
  const f = tileFormat(pf, true)
  const state: TileState = { palette: new Uint32Array(128), paletteSize: 0 }
  const out = new PixelBuffer(w, h, f.bpp)
  for (let ty = 0; ty < h; ty += 16) {
    for (let tx = 0; tx < w; tx += 16) {
      let buf = reader.peek()
      for (;;) {
        try {
          reader.consume(decodeTile(buf, 0, out, f, state, tx, ty, Math.min(16, w - tx), Math.min(16, h - ty)))
          break
        } catch (err) {
          if (err !== NEED_MORE) throw err
          buf = await reader.waitFor(buf.length + 1)
        }
      }
    }
  }
  return out.data
}

/** Decodes the tile at `src[pos]` into `out`; returns the position after it. */
function decodeTile(
  src: Buffer,
  pos: number,
  out: PixelBuffer,
  f: TileFormat,
  state: TileState,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): number {
  const { bpp, cp, cpOffset } = f
  const end = src.length
  const words = out.words
  const width = out.width
  const palette = state.palette
  const total = tw * th

  if (pos >= end) throw NEED_MORE
  const sub = src[pos++] as number
  let paletteSize = sub & 0x7f

  // The CPIXEL at `p` as a pixel word.
  const cpixel = (p: number) => (cp === bpp ? PixelBuffer.word(src, p, bpp) : PixelBuffer.cpixelWord(src, p, cpOffset))

  const readPalette = (size: number) => {
    if (pos + size * cp > end) throw NEED_MORE
    for (let i = 0; i < size; i++, pos += cp) palette[i] = cpixel(pos)
    state.paletteSize = size
  }

  // A run of `len` pixels from tile pixel `i`; runs wrap from row to row.
  const run = (i: number, len: number, word: number) => {
    if (i + len > total) throw protocolError('ZRLE/TRLE: a run goes past the end of the tile')
    while (len > 0) {
      const row = (i / tw) | 0
      const col = i - row * tw
      const n = Math.min(len, tw - col)
      const at = (ty + row) * width + tx + col
      words.fill(word, at, at + n)
      i += n
      len -= n
    }
  }

  // A run length: 1 plus every byte up to the first that isn't 255. A run can't be longer than the
  // `left` pixels of the tile, so a long string of 255s fails at once rather than being scanned to
  // its end (and for TRLE scanned again from the tile's start each time more data arrives).
  const runLength = (left: number) => {
    let len = 1
    for (;;) {
      if (pos >= end) throw NEED_MORE
      const b = src[pos++] as number
      len += b
      if (len > left) throw protocolError('ZRLE/TRLE: a run goes past the end of the tile')
      if (b !== 255) return len
    }
  }

  if ((sub & 0x80) === 0) {
    if (paletteSize === 0) {
      // Raw CPIXELs.
      if (pos + total * cp > end) throw NEED_MORE
      if (cp === bpp) {
        out.put(tx, ty, tw, th, src, pos)
        return pos + total * cp
      }
      for (let y = 0; y < th; y++) {
        const row = (ty + y) * width + tx
        for (let x = 0; x < tw; x++, pos += 3) words[row + x] = PixelBuffer.cpixelWord(src, pos, cpOffset)
      }
      return pos
    }
    if (paletteSize === 1) {
      if (pos + cp > end) throw NEED_MORE
      out.fill(tx, ty, tw, th, cpixel(pos))
      return pos + cp
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
    if (pos + rowBytes * th > end) throw NEED_MORE
    for (let y = 0; y < th; y++) {
      const rowStart = pos + y * rowBytes
      const row = (ty + y) * width + tx
      for (let x = 0; x < tw; x++) {
        const bit = x * bits
        const index = ((src[rowStart + (bit >> 3)] as number) >> (8 - bits - (bit & 7))) & mask
        if (index >= paletteSize) throw protocolError('ZRLE/TRLE: palette index out of range')
        words[row + x] = palette[index] as number
      }
    }
    return pos + rowBytes * th
  }

  if (paletteSize === 0) {
    // Plain RLE: (CPIXEL, run length) pairs.
    for (let i = 0; i < total; ) {
      if (pos + cp > end) throw NEED_MORE
      const word = cpixel(pos)
      pos += cp
      const len = runLength(total - i)
      run(i, len, word)
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
    if (pos >= end) throw NEED_MORE
    let index = src[pos++] as number
    let len = 1
    if (index & 0x80) {
      index &= 0x7f
      len = runLength(total - i)
    }
    if (index >= paletteSize) throw protocolError('ZRLE/TRLE: palette index out of range')
    if (len === 1 && i < total) {
      const row = (i / tw) | 0
      words[(ty + row) * width + tx + i - row * tw] = palette[index] as number
    } else {
      run(i, len, palette[index] as number)
    }
    i += len
  }
  return pos
}
