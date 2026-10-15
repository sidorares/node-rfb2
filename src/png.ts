import buffer from 'node:buffer'
import zlib from 'node:zlib'
import { protocolError } from './errors.ts'

// A minimal PNG decoder for TightPNG rects: every colour type and bit depth, non-interlaced
// (what QEMU and libvncserver send). Output is 8-bit RGBA.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngImage {
  width: number
  height: number
  rgba: Buffer
}

/** The bit depths each colour type allows. */
const DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

/**
 * Decodes a PNG. With `expected`, the image must have that size, which is checked before anything is
 * inflated. The image data inflates to at most the bytes an image of the size in IHDR holds, so a
 * small PNG can't decompress to more.
 */
export function decodePng(png: Buffer, expected?: { width: number; height: number }): PngImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw protocolError('PNG: bad signature')
  let width = 0
  let height = 0
  let depth = 0
  let colorType = -1
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = png.readUInt32BE(pos)
    const type = png.toString('latin1', pos + 4, pos + 8)
    const data = png.subarray(pos + 8, pos + 8 + length)
    if (data.length !== length) throw protocolError(`PNG: truncated ${type} chunk`)
    pos += 12 + length
    if (type === 'IHDR') {
      if (length < 13) throw protocolError('PNG: missing or invalid IHDR')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8] as number
      colorType = data[9] as number
      if (data[12] !== 0) throw protocolError('PNG: interlaced images are not supported')
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (channels === undefined || width === 0 || height === 0 || !DEPTHS[colorType]?.includes(depth)) {
    throw protocolError('PNG: missing or invalid IHDR')
  }
  if (expected && (width !== expected.width || height !== expected.height)) {
    throw protocolError(`PNG: a ${width}×${height} PNG for a ${expected.width}×${expected.height} rect`)
  }
  if (colorType === 3 && palette === null) throw protocolError('PNG: palette image without PLTE')

  const bitsPerPixel = channels * depth
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
  const filterStride = Math.max(1, bitsPerPixel >> 3)
  // A filter byte and the pixels of each row.
  const size = (rowBytes + 1) * height
  if (size > buffer.constants.MAX_LENGTH) throw protocolError(`PNG: a ${width}×${height} image is too large`)
  let raw: Buffer
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: size })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw protocolError(`PNG: the image data inflates to more than the ${size} bytes of a ${width}×${height} image`)
    }
    throw protocolError(`PNG: corrupt image data (${(err as Error).message})`)
  }
  if (raw.length < size) throw protocolError('PNG: image data too short')

  // Undo the per-row filters in place, into `rows` (no filter bytes).
  const rows = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)] as number
    const src = y * (rowBytes + 1) + 1
    const dst = y * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i] as number
      const a = i >= filterStride ? (rows[dst + i - filterStride] as number) : 0
      const b = y > 0 ? (rows[dst - rowBytes + i] as number) : 0
      const c = i >= filterStride && y > 0 ? (rows[dst - rowBytes + i - filterStride] as number) : 0
      let v: number
      switch (filter) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw protocolError(`PNG: unknown filter ${filter}`)
      }
      rows[dst + i] = v & 0xff
    }
  }

  // A sample (channel value) scaled to 8 bits.
  const sample = (row: number, index: number): number => {
    if (depth === 8) return rows[row + index] as number
    if (depth === 16) return rows[row + index * 2] as number
    const perByte = 8 / depth
    const byte = rows[row + Math.floor(index / perByte)] as number
    const v = (byte >> (8 - depth * ((index % perByte) + 1))) & ((1 << depth) - 1)
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1))
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0, o = 0; y < height; y++) {
    const row = y * rowBytes
    for (let x = 0; x < width; x++, o += 4) {
      switch (colorType) {
        case 0: {
          const g = sample(row, x)
          rgba[o] = g
          rgba[o + 1] = g
          rgba[o + 2] = g
          rgba[o + 3] = 255
          break
        }
        case 2:
          rgba[o] = sample(row, x * 3)
          rgba[o + 1] = sample(row, x * 3 + 1)
          rgba[o + 2] = sample(row, x * 3 + 2)
          rgba[o + 3] = 255
          break
        case 3: {
          const i = sample(row, x)
          const p = palette as Buffer
          rgba[o] = p[i * 3] ?? 0
          rgba[o + 1] = p[i * 3 + 1] ?? 0
          rgba[o + 2] = p[i * 3 + 2] ?? 0
          rgba[o + 3] = transparency?.[i] ?? 255
          break
        }
        case 4: {
          const g = sample(row, x * 2)
          rgba[o] = g
          rgba[o + 1] = g
          rgba[o + 2] = g
          rgba[o + 3] = sample(row, x * 2 + 1)
          break
        }
        default:
          rgba[o] = sample(row, x * 4)
          rgba[o + 1] = sample(row, x * 4 + 1)
          rgba[o + 2] = sample(row, x * 4 + 2)
          rgba[o + 3] = sample(row, x * 4 + 3)
      }
    }
  }
  return { width, height, rgba }
}
