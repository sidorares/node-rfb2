// A small PNG encoder for tests (PNG specification, 2nd edition): colour types 0, 2, 3 (with
// tRNS), 4 and 6, bit depths 1/2/4 (grey and palette), 8 and 16, non-interlaced, with the filter
// type of every row chosen by the caller so the decoder's unfiltering is exercised.

import zlib from 'node:zlib'

/** CRC-32 (ISO 3309, as PNG uses it) of the concatenation of `parts`. */
export function crc32(...parts: Uint8Array[]): number {
  return parts.reduce((crc, part) => zlib.crc32(part, crc), 0)
}

export type PngColorType = 0 | 2 | 3 | 4 | 6
export type PngBitDepth = 1 | 2 | 4 | 8 | 16

/** Samples per pixel of each colour type. */
export const pngChannels: Record<PngColorType, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export interface PngOptions {
  colorType: PngColorType
  bitDepth: PngBitDepth
  /** Filter type (0 none, 1 sub, 2 up, 3 average, 4 Paeth) of every row, or per row. */
  filter?: number | ((y: number) => number)
  /** PLTE: R, G, B per entry (colour type 3). */
  palette?: Uint8Array
  /** tRNS: alpha per palette entry (colour type 3). */
  transparency?: Uint8Array
  /** Split the zlib data over this many IDAT chunks. */
  idatChunks?: number
  /** The IHDR interlace method byte (anything but 0 is for error tests). */
  interlace?: number
  /** Ancillary chunks to put before the image data (decoders skip them). */
  extraChunks?: { type: string; data: Uint8Array }[]
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** One chunk: length, type, data, CRC of type and data. */
export function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(head.subarray(4), data))
  return Buffer.concat([head, data, crc])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * A PNG of `width`×`height` pixels given as samples: `channels` per pixel (see `pngChannels`),
 * each 0 .. 2^bitDepth - 1 (palette indices for colour type 3), row after row.
 */
export function encodePng(width: number, height: number, samples: ArrayLike<number>, opts: PngOptions): Buffer {
  const { colorType, bitDepth } = opts
  const channels = pngChannels[colorType]
  const bitsPerPixel = channels * bitDepth
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
  // Filters work on bytes, comparing each with the byte of the pixel to its left (at least 1 back).
  const stride = Math.max(1, Math.ceil(bitsPerPixel / 8))

  // Pack the samples into rows.
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(rowBytes)
    for (let i = 0; i < width * channels; i++) {
      const v = samples[y * width * channels + i] as number
      if (bitDepth === 16) {
        row.writeUInt16BE(v, i * 2)
      } else if (bitDepth === 8) {
        row[i] = v
      } else {
        const bit = i * bitDepth
        row[bit >> 3] |= v << (8 - bitDepth - (bit & 7))
      }
    }
    rows.push(row)
  }

  // Filter each row against the unfiltered previous row.
  const filtered: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const type = typeof opts.filter === 'function' ? opts.filter(y) : (opts.filter ?? 0)
    const row = rows[y] as Buffer
    const prior = y > 0 ? (rows[y - 1] as Buffer) : Buffer.alloc(rowBytes)
    const out = Buffer.alloc(rowBytes + 1)
    out[0] = type
    for (let i = 0; i < rowBytes; i++) {
      const x = row[i] as number
      const a = i >= stride ? (row[i - stride] as number) : 0
      const b = prior[i] as number
      const c = i >= stride ? (prior[i - stride] as number) : 0
      let predictor: number
      switch (type) {
        case 0:
          predictor = 0
          break
        case 1:
          predictor = a
          break
        case 2:
          predictor = b
          break
        case 3:
          predictor = Math.floor((a + b) / 2)
          break
        case 4:
          predictor = paeth(a, b, c)
          break
        default:
          predictor = 0 // an invalid filter type, for error tests: the bytes are sent unfiltered
      }
      out[i + 1] = (x - predictor) & 0xff
    }
    filtered.push(out)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = opts.interlace ?? 0

  const z = zlib.deflateSync(Buffer.concat(filtered))
  const parts = Math.max(1, opts.idatChunks ?? 1)
  const idat: Buffer[] = []
  const size = Math.ceil(z.length / parts)
  for (let i = 0; i < parts; i++) idat.push(pngChunk('IDAT', z.subarray(i * size, (i + 1) * size)))

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...(opts.extraChunks ?? []).map((c) => pngChunk(c.type, c.data)),
    ...(opts.palette ? [pngChunk('PLTE', opts.palette)] : []),
    ...(opts.transparency ? [pngChunk('tRNS', opts.transparency)] : []),
    ...idat,
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
