import { RfbError } from './errors.ts'

/** RFB PIXEL_FORMAT: how a pixel value maps to bytes and colours. */
export interface PixelFormat {
  /** 8, 16 or 32. */
  bitsPerPixel: number
  depth: number
  bigEndian: boolean
  /** False: pixel values are colour-map indices (see the client's `colorMap`). */
  trueColor: boolean
  redMax: number
  greenMax: number
  blueMax: number
  redShift: number
  greenShift: number
  blueShift: number
}

/** One colour-map entry, 16 bits per channel as RFB sends it. */
export interface Color {
  r: number
  g: number
  b: number
}

/** Ready-made pixel formats; the name is the byte order in memory. */
export const pixelFormats = {
  /** 32-bit little-endian 0x00RRGGBB: bytes B, G, R, 0. The usual native format of X servers. */
  bgrx: {
    bitsPerPixel: 32,
    depth: 24,
    bigEndian: false,
    trueColor: true,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift: 16,
    greenShift: 8,
    blueShift: 0,
  },
  /** 32-bit little-endian 0x00BBGGRR: bytes R, G, B, 0 (canvas `ImageData` order, alpha byte not set). */
  rgbx: {
    bitsPerPixel: 32,
    depth: 24,
    bigEndian: false,
    trueColor: true,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift: 0,
    greenShift: 8,
    blueShift: 16,
  },
  /** 16-bit little-endian RGB 5-6-5. */
  rgb565: {
    bitsPerPixel: 16,
    depth: 16,
    bigEndian: false,
    trueColor: true,
    redMax: 31,
    greenMax: 63,
    blueMax: 31,
    redShift: 11,
    greenShift: 5,
    blueShift: 0,
  },
  /** 8-bit true colour, 3 bits red and green, 2 bits blue (the classic VNC low-colour format). */
  bgr233: {
    bitsPerPixel: 8,
    depth: 8,
    bigEndian: false,
    trueColor: true,
    redMax: 7,
    greenMax: 7,
    blueMax: 3,
    redShift: 0,
    greenShift: 3,
    blueShift: 6,
  },
} as const satisfies Record<string, PixelFormat>

export type PixelFormatName = keyof typeof pixelFormats

export function bytesPerPixel(pf: PixelFormat): number {
  return pf.bitsPerPixel >> 3
}

/** Throws `INVALID_ARGUMENT` (or `PROTOCOL_ERROR` for a format the server sent) unless RFB allows `pf`. */
export function validatePixelFormat(pf: PixelFormat, fromServer = false): void {
  const fail = (why: string) => {
    throw new RfbError(fromServer ? 'PROTOCOL_ERROR' : 'INVALID_ARGUMENT', `invalid pixel format: ${why}`)
  }
  if (pf.bitsPerPixel !== 8 && pf.bitsPerPixel !== 16 && pf.bitsPerPixel !== 32) {
    fail(`bitsPerPixel must be 8, 16 or 32, not ${pf.bitsPerPixel}`)
  }
  if (!pf.trueColor) return
  for (const c of ['red', 'green', 'blue'] as const) {
    const max = pf[`${c}Max`]
    const shift = pf[`${c}Shift`]
    if (!Number.isInteger(max) || max < 1 || max > 0xffff || (max & (max + 1)) !== 0) {
      fail(`${c}Max must be 2^n - 1, not ${max}`)
    }
    if (!Number.isInteger(shift) || shift < 0 || shift + Math.log2(max + 1) > pf.bitsPerPixel) {
      fail(`${c}Shift ${shift} puts ${c} outside the ${pf.bitsPerPixel}-bit pixel`)
    }
  }
}

/** Parses the 16-byte PIXEL_FORMAT structure. */
export function readPixelFormat(buf: Buffer, offset = 0): PixelFormat {
  return {
    bitsPerPixel: buf[offset] as number,
    depth: buf[offset + 1] as number,
    bigEndian: buf[offset + 2] !== 0,
    trueColor: buf[offset + 3] !== 0,
    redMax: buf.readUInt16BE(offset + 4),
    greenMax: buf.readUInt16BE(offset + 6),
    blueMax: buf.readUInt16BE(offset + 8),
    redShift: buf[offset + 10] as number,
    greenShift: buf[offset + 11] as number,
    blueShift: buf[offset + 12] as number,
  }
}

/** Writes the 16-byte PIXEL_FORMAT structure (padding zeroed). */
export function writePixelFormat(pf: PixelFormat, buf: Buffer, offset = 0): void {
  buf[offset] = pf.bitsPerPixel
  buf[offset + 1] = pf.depth
  buf[offset + 2] = pf.bigEndian ? 1 : 0
  buf[offset + 3] = pf.trueColor ? 1 : 0
  buf.writeUInt16BE(pf.redMax, offset + 4)
  buf.writeUInt16BE(pf.greenMax, offset + 6)
  buf.writeUInt16BE(pf.blueMax, offset + 8)
  buf[offset + 10] = pf.redShift
  buf[offset + 11] = pf.greenShift
  buf[offset + 12] = pf.blueShift
  buf.fill(0, offset + 13, offset + 16)
}

export function samePixelFormat(a: PixelFormat, b: PixelFormat): boolean {
  if (a.bitsPerPixel !== b.bitsPerPixel || a.trueColor !== b.trueColor) return false
  if (a.bitsPerPixel > 8 && a.bigEndian !== b.bigEndian) return false
  if (!a.trueColor) return true
  return (
    a.redMax === b.redMax &&
    a.greenMax === b.greenMax &&
    a.blueMax === b.blueMax &&
    a.redShift === b.redShift &&
    a.greenShift === b.greenShift &&
    a.blueShift === b.blueShift
  )
}

/** The pixel value at `offset` (a colour-map index when not true colour). */
export function readPixel(pf: PixelFormat, buf: Uint8Array, offset: number): number {
  switch (pf.bitsPerPixel) {
    case 8:
      return buf[offset] as number
    case 16:
      return pf.bigEndian
        ? ((buf[offset] as number) << 8) | (buf[offset + 1] as number)
        : (buf[offset] as number) | ((buf[offset + 1] as number) << 8)
    default:
      return pf.bigEndian
        ? (((buf[offset] as number) << 24) |
            ((buf[offset + 1] as number) << 16) |
            ((buf[offset + 2] as number) << 8) |
            (buf[offset + 3] as number)) >>>
            0
        : ((buf[offset] as number) |
            ((buf[offset + 1] as number) << 8) |
            ((buf[offset + 2] as number) << 16) |
            ((buf[offset + 3] as number) << 24)) >>>
            0
  }
}

export function writePixel(pf: PixelFormat, value: number, buf: Uint8Array, offset: number): void {
  switch (pf.bitsPerPixel) {
    case 8:
      buf[offset] = value
      return
    case 16:
      if (pf.bigEndian) {
        buf[offset] = value >>> 8
        buf[offset + 1] = value
      } else {
        buf[offset] = value
        buf[offset + 1] = value >>> 8
      }
      return
    default:
      if (pf.bigEndian) {
        buf[offset] = value >>> 24
        buf[offset + 1] = value >>> 16
        buf[offset + 2] = value >>> 8
        buf[offset + 3] = value
      } else {
        buf[offset] = value
        buf[offset + 1] = value >>> 8
        buf[offset + 2] = value >>> 16
        buf[offset + 3] = value >>> 24
      }
  }
}

/** The pixel value for an 8-bit-per-channel colour in a true-colour format. */
export function rgbToPixel(pf: PixelFormat, r: number, g: number, b: number): number {
  return (
    ((scale(r, 255, pf.redMax) << pf.redShift) |
      (scale(g, 255, pf.greenMax) << pf.greenShift) |
      (scale(b, 255, pf.blueMax) << pf.blueShift)) >>>
    0
  )
}

/** 8-bit-per-channel colour of a pixel value; colour-map formats look the value up in `colorMap`. */
export function pixelToRgb(
  pf: PixelFormat,
  value: number,
  colorMap?: readonly (Color | undefined)[],
): [number, number, number] {
  if (!pf.trueColor) {
    const c = colorMap?.[value]
    return c ? [c.r >>> 8, c.g >>> 8, c.b >>> 8] : [0, 0, 0]
  }
  return [
    scale((value >>> pf.redShift) & pf.redMax, pf.redMax, 255),
    scale((value >>> pf.greenShift) & pf.greenMax, pf.greenMax, 255),
    scale((value >>> pf.blueShift) & pf.blueMax, pf.blueMax, 255),
  ]
}

function scale(v: number, from: number, to: number): number {
  return from === to ? v : Math.round((v * to) / from)
}

/**
 * Converts `width`×`height` pixels to RGBA (alpha 255). Fast paths for the 32-bit formats;
 * colour-map formats need `colorMap`.
 */
export function toRgba(pf: PixelFormat, pixels: Uint8Array, colorMap?: readonly (Color | undefined)[]): Buffer {
  const bpp = bytesPerPixel(pf)
  const n = Math.floor(pixels.length / bpp)
  const out = Buffer.allocUnsafe(n * 4)
  if (pf.bitsPerPixel === 32 && pf.trueColor && pf.redMax === 255 && pf.greenMax === 255 && pf.blueMax === 255) {
    // Byte positions of each channel within the 4-byte pixel.
    const pos = (shift: number) => (pf.bigEndian ? 3 - (shift >> 3) : shift >> 3)
    if (pf.redShift % 8 === 0 && pf.greenShift % 8 === 0 && pf.blueShift % 8 === 0) {
      const ri = pos(pf.redShift)
      const gi = pos(pf.greenShift)
      const bi = pos(pf.blueShift)
      for (let i = 0, o = 0; i < n * 4; i += 4, o += 4) {
        out[o] = pixels[i + ri] as number
        out[o + 1] = pixels[i + gi] as number
        out[o + 2] = pixels[i + bi] as number
        out[o + 3] = 255
      }
      return out
    }
  }
  for (let i = 0; i < n; i++) {
    const [r, g, b] = pixelToRgb(pf, readPixel(pf, pixels, i * bpp), colorMap)
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  }
  return out
}

/**
 * ZRLE/TRLE send 3-byte "CPIXEL"s when the format is 32-bit true colour with depth <= 24 and all
 * colour bits fit in the low or the high three bytes. Returns where those 3 bytes go in a 4-byte
 * pixel (0 or 1), or -1 when CPIXELs are full pixels.
 */
export function cpixelOffset(pf: PixelFormat): number {
  if (pf.bitsPerPixel !== 32 || !pf.trueColor || pf.depth > 24) return -1
  const maxPixel = ((pf.redMax << pf.redShift) | (pf.greenMax << pf.greenShift) | (pf.blueMax << pf.blueShift)) >>> 0
  const fitsLow = maxPixel < 1 << 24
  const fitsHigh = (maxPixel & 0xff) === 0
  if ((fitsLow && !pf.bigEndian) || (fitsHigh && pf.bigEndian)) return 0
  if (fitsLow || fitsHigh) return 1
  return -1
}

/** Tight sends 3-byte R, G, B "TPIXEL"s for 32-bit true colour with depth 24 and 8 bits per channel. */
export function isTightRgb(pf: PixelFormat): boolean {
  return (
    pf.bitsPerPixel === 32 &&
    pf.depth === 24 &&
    pf.trueColor &&
    pf.redMax === 255 &&
    pf.greenMax === 255 &&
    pf.blueMax === 255
  )
}

/**
 * Writes packed 8-bit R, G, B (or R, G, B, A with `stride` 4) colours as pixels of `pf`.
 * Used for Tight's TPIXELs, JPEG/PNG output and cursors.
 */
export function rgbToPixels(
  pf: PixelFormat,
  rgb: Uint8Array,
  stride: 3 | 4,
  count: number,
  out: Uint8Array,
  outOffset = 0,
): void {
  const bpp = bytesPerPixel(pf)
  if (pf.bitsPerPixel === 32 && isByteAligned(pf)) {
    const ri = bytePos(pf, pf.redShift)
    const gi = bytePos(pf, pf.greenShift)
    const bi = bytePos(pf, pf.blueShift)
    // The byte that holds no colour (a padding byte) is zeroed.
    const xi = 6 - ri - gi - bi
    for (let i = 0, s = 0, o = outOffset; i < count; i++, s += stride, o += 4) {
      out[o + ri] = rgb[s] as number
      out[o + gi] = rgb[s + 1] as number
      out[o + bi] = rgb[s + 2] as number
      out[o + xi] = 0
    }
    return
  }
  for (let i = 0, s = 0, o = outOffset; i < count; i++, s += stride, o += bpp) {
    writePixel(pf, rgbToPixel(pf, rgb[s] as number, rgb[s + 1] as number, rgb[s + 2] as number), out, o)
  }
}

function isByteAligned(pf: PixelFormat): boolean {
  return (
    pf.trueColor &&
    pf.redMax === 255 &&
    pf.greenMax === 255 &&
    pf.blueMax === 255 &&
    pf.redShift % 8 === 0 &&
    pf.greenShift % 8 === 0 &&
    pf.blueShift % 8 === 0 &&
    pf.redShift !== pf.greenShift &&
    pf.greenShift !== pf.blueShift &&
    pf.redShift !== pf.blueShift
  )
}

function bytePos(pf: PixelFormat, shift: number): number {
  return pf.bigEndian ? 3 - (shift >> 3) : shift >> 3
}
