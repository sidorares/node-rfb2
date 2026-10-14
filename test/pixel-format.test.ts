import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RfbError } from '../src/errors.ts'
import {
  bytesPerPixel,
  type Color,
  cpixelOffset,
  isTightRgb,
  type PixelFormat,
  pixelFormats,
  pixelToRgb,
  readPixel,
  readPixelFormat,
  rgbToPixel,
  rgbToPixels,
  samePixelFormat,
  toRgba,
  validatePixelFormat,
  writePixel,
  writePixelFormat,
} from '../src/pixel-format.ts'
import { randInt, rng } from './helpers/encoders.ts'

const { bgrx, rgbx, rgb565, bgr233 } = pixelFormats

/** A 32-bit true-colour format, 8 bits per channel unless given. */
function pf32(redShift: number, greenShift: number, blueShift: number, more: Partial<PixelFormat> = {}): PixelFormat {
  return {
    bitsPerPixel: 32,
    depth: 24,
    bigEndian: false,
    trueColor: true,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift,
    greenShift,
    blueShift,
    ...more,
  }
}

const colourMap8: PixelFormat = { ...bgr233, trueColor: false }

/** Every byte layout: 8 bits, 16 and 32 bits in both byte orders. */
const LAYOUTS: { name: string; pf: PixelFormat }[] = [
  { name: '8-bit', pf: bgr233 },
  { name: '16-bit LE', pf: rgb565 },
  { name: '16-bit BE', pf: { ...rgb565, bigEndian: true } },
  { name: '32-bit LE', pf: bgrx },
  { name: '32-bit BE', pf: { ...bgrx, bigEndian: true } },
]

/** Independent model of channel scaling: the nearest value in the other range. */
const scaleTo = (v: number, from: number, to: number) => Math.round((v * to) / from)

describe('readPixel / writePixel', () => {
  test('byte order', () => {
    const buf = Buffer.alloc(6)
    writePixel(bgrx, 0x12345678, buf, 1)
    assert.deepEqual([...buf], [0, 0x78, 0x56, 0x34, 0x12, 0])
    writePixel({ ...bgrx, bigEndian: true }, 0x12345678, buf, 1)
    assert.deepEqual([...buf], [0, 0x12, 0x34, 0x56, 0x78, 0])
    buf.fill(0)
    writePixel(rgb565, 0xabcd, buf, 2)
    assert.deepEqual([...buf], [0, 0, 0xcd, 0xab, 0, 0])
    writePixel({ ...rgb565, bigEndian: true }, 0xabcd, buf, 2)
    assert.deepEqual([...buf], [0, 0, 0xab, 0xcd, 0, 0])
    writePixel(bgr233, 0xfe, buf, 5)
    assert.equal(buf[5], 0xfe)

    assert.equal(readPixel(bgrx, Buffer.from([0x78, 0x56, 0x34, 0x12]), 0), 0x12345678)
    assert.equal(readPixel({ ...bgrx, bigEndian: true }, Buffer.from([9, 0x12, 0x34, 0x56, 0x78]), 1), 0x12345678)
    assert.equal(readPixel(rgb565, Buffer.from([0xcd, 0xab]), 0), 0xabcd)
    assert.equal(readPixel({ ...rgb565, bigEndian: true }, Buffer.from([0xab, 0xcd]), 0), 0xabcd)
    // 8-bit pixels have no byte order.
    assert.equal(readPixel({ ...bgr233, bigEndian: true }, Buffer.from([0x81]), 0), 0x81)
  })

  test('32-bit values with the top bit set read back unsigned', () => {
    for (const bigEndian of [false, true]) {
      const pf = { ...bgrx, bigEndian }
      const buf = Buffer.alloc(4)
      writePixel(pf, 0xfedcba98, buf, 0)
      assert.equal(readPixel(pf, buf, 0), 0xfedcba98)
      writePixel(pf, 0xffffffff, buf, 0)
      assert.deepEqual([...buf], [255, 255, 255, 255])
      assert.equal(readPixel(pf, buf, 0), 0xffffffff)
    }
  })

  for (const { name, pf } of LAYOUTS) {
    test(`round trip, ${name}`, () => {
      const r = rng(name.length * 7919)
      const bpp = bytesPerPixel(pf)
      const top = 2 ** pf.bitsPerPixel
      const buf = Buffer.alloc(64 * bpp + 3)
      const values = Array.from({ length: 64 }, (_, i) => (i < 2 ? [0, top - 1][i] : randInt(r, top)) as number)
      values.forEach((v, i) => {
        writePixel(pf, v, buf, 3 + i * bpp)
      })
      values.forEach((v, i) => {
        assert.equal(readPixel(pf, buf, 3 + i * bpp), v)
      })
      // The bytes are those of the value in the format's byte order.
      const expected = Buffer.alloc(bpp)
      const v = values[5] as number
      if (bpp === 1) expected.writeUInt8(v)
      else if (bpp === 2) pf.bigEndian ? expected.writeUInt16BE(v) : expected.writeUInt16LE(v)
      else pf.bigEndian ? expected.writeUInt32BE(v) : expected.writeUInt32LE(v)
      assert.deepEqual(buf.subarray(3 + 5 * bpp, 3 + 6 * bpp), expected)
    })
  }
})

describe('rgbToPixel / pixelToRgb', () => {
  test('8 bits per channel: the bytes go to their shifts', () => {
    assert.equal(rgbToPixel(bgrx, 0x12, 0x34, 0x56), 0x123456)
    assert.equal(rgbToPixel(rgbx, 0x12, 0x34, 0x56), 0x563412)
    assert.equal(rgbToPixel(pf32(24, 16, 8), 0xff, 0x80, 0x01), 0xff800100)
    assert.deepEqual(pixelToRgb(bgrx, 0xff123456), [0x12, 0x34, 0x56])
    assert.deepEqual(pixelToRgb(pf32(24, 16, 8), 0xff800100), [0xff, 0x80, 0x01])
  })

  test('narrow channels scale to the nearest value', () => {
    assert.equal(rgbToPixel(rgb565, 255, 255, 255), 0xffff)
    assert.equal(rgbToPixel(rgb565, 0, 0, 0), 0)
    assert.equal(rgbToPixel(rgb565, 128, 128, 128), (16 << 11) | (32 << 5) | 16)
    assert.equal(rgbToPixel(bgr233, 255, 0, 0), 7)
    assert.equal(rgbToPixel(bgr233, 0, 255, 0), 7 << 3)
    assert.equal(rgbToPixel(bgr233, 0, 0, 255), 3 << 6)
    assert.deepEqual(pixelToRgb(rgb565, 0xffff), [255, 255, 255])
    assert.deepEqual(pixelToRgb(rgb565, (16 << 11) | (32 << 5) | 16), [132, 130, 132])
    assert.deepEqual(pixelToRgb(bgr233, (2 << 6) | (5 << 3) | 3), [109, 182, 170])
  })

  test('every 8-bit channel value maps as the nearest-value model says', () => {
    for (const pf of [rgb565, bgr233, pf32(20, 10, 0, { redMax: 1023, greenMax: 1023, blueMax: 1023, depth: 30 })]) {
      for (let v = 0; v < 256; v++) {
        const p = rgbToPixel(pf, v, v, v)
        assert.equal((p >>> pf.redShift) & pf.redMax, scaleTo(v, 255, pf.redMax))
        assert.equal((p >>> pf.greenShift) & pf.greenMax, scaleTo(v, 255, pf.greenMax))
        assert.equal((p >>> pf.blueShift) & pf.blueMax, scaleTo(v, 255, pf.blueMax))
      }
    }
  })

  test('channel values survive a round trip through 8 bits', () => {
    for (const pf of [rgb565, bgr233, pf32(20, 10, 0, { redMax: 1023, greenMax: 1023, blueMax: 1023, depth: 30 })]) {
      for (let v = 0; v <= Math.max(pf.redMax, pf.greenMax, pf.blueMax); v++) {
        const r = Math.min(v, pf.redMax)
        const g = Math.min(v, pf.greenMax)
        const b = Math.min(v, pf.blueMax)
        const p = ((r << pf.redShift) | (g << pf.greenShift) | (b << pf.blueShift)) >>> 0
        const [r8, g8, b8] = pixelToRgb(pf, p)
        assert.deepEqual(
          [r8, g8, b8],
          [scaleTo(r, pf.redMax, 255), scaleTo(g, pf.greenMax, 255), scaleTo(b, pf.blueMax, 255)],
        )
        // 10-bit channels can't survive 8 bits; the narrower ones must.
        if (pf.redMax <= 255) assert.equal(rgbToPixel(pf, r8, g8, b8), p)
      }
    }
  })

  test('bits outside the channels are ignored', () => {
    assert.deepEqual(pixelToRgb(bgrx, 0xab000000), [0, 0, 0])
    assert.deepEqual(pixelToRgb(pf32(24, 16, 8), 0x000000ff), [0, 0, 0])
  })

  test('colour-map formats look the value up (16 bits per channel, top byte used)', () => {
    const map: (Color | undefined)[] = []
    map[3] = { r: 0xffff, g: 0x8000, b: 0x01ff }
    assert.deepEqual(pixelToRgb(colourMap8, 3, map), [255, 128, 1])
    assert.deepEqual(pixelToRgb(colourMap8, 4, map), [0, 0, 0])
    assert.deepEqual(pixelToRgb(colourMap8, 3), [0, 0, 0])
  })
})

describe('toRgba', () => {
  /** RGBA from an independent model: read the value byte by byte, take the channels, scale. */
  function model(pf: PixelFormat, pixels: Uint8Array, map?: (Color | undefined)[]): Buffer {
    const bpp = pf.bitsPerPixel / 8
    const n = Math.floor(pixels.length / bpp)
    const out = Buffer.alloc(n * 4)
    for (let i = 0; i < n; i++) {
      let v = 0
      for (let k = 0; k < bpp; k++) v = v * 256 + (pixels[i * bpp + (pf.bigEndian ? k : bpp - 1 - k)] as number)
      let rgb: number[]
      if (!pf.trueColor) {
        const c = map?.[v]
        rgb = c ? [c.r >> 8, c.g >> 8, c.b >> 8] : [0, 0, 0]
      } else {
        rgb = (
          [
            [pf.redShift, pf.redMax],
            [pf.greenShift, pf.greenMax],
            [pf.blueShift, pf.blueMax],
          ] as const
        ).map(([s, m]) => scaleTo(Math.floor(v / 2 ** s) % (m + 1), m, 255))
      }
      out.set([...rgb, 255], i * 4)
    }
    return out
  }

  const map: Color[] = Array.from({ length: 256 }, (_, i) => ({ r: i * 257, g: (255 - i) * 256, b: (i * 7) % 65536 }))
  const formats: { name: string; pf: PixelFormat }[] = [
    { name: 'bgrx (fast path)', pf: bgrx },
    { name: 'rgbx (fast path)', pf: rgbx },
    { name: 'bgrx big-endian (fast path)', pf: { ...bgrx, bigEndian: true } },
    { name: 'shifts 24/16/8 (fast path)', pf: pf32(24, 16, 8) },
    { name: 'shifts 24/16/8 big-endian (fast path)', pf: pf32(24, 16, 8, { bigEndian: true }) },
    { name: 'depth 32 (fast path)', pf: pf32(0, 8, 16, { depth: 32 }) },
    { name: 'unaligned shifts (slow path)', pf: pf32(17, 9, 1) },
    { name: '10 bits per channel (slow path)', pf: pf32(20, 10, 0, { redMax: 1023, greenMax: 1023, blueMax: 1023 }) },
    { name: 'rgb565', pf: rgb565 },
    { name: 'rgb565 big-endian', pf: { ...rgb565, bigEndian: true } },
    { name: 'bgr233', pf: bgr233 },
    { name: 'colour map', pf: colourMap8 },
  ]
  for (const { name, pf } of formats) {
    test(name, () => {
      const r = rng(name.length)
      const pixels = Buffer.from(Array.from({ length: 37 * bytesPerPixel(pf) }, () => randInt(r, 256)))
      assert.deepEqual(toRgba(pf, pixels, map), model(pf, pixels, map))
    })
  }

  test('a trailing partial pixel is ignored', () => {
    assert.equal(toRgba(bgrx, Buffer.alloc(9)).length, 8)
    assert.equal(toRgba(rgb565, Buffer.alloc(5)).length, 8)
  })
})

describe('rgbToPixels', () => {
  const rgb = Buffer.from([0x11, 0x22, 0x33, 0xaa, 0xbb, 0xcc, 0x00, 0xff, 0x80])
  const rgba = Buffer.from([0x11, 0x22, 0x33, 0x01, 0xaa, 0xbb, 0xcc, 0x02, 0x00, 0xff, 0x80, 0x03])

  for (const pf of [bgrx, rgbx, { ...bgrx, bigEndian: true }, pf32(24, 16, 8), pf32(0, 8, 24), rgb565, bgr233]) {
    test(`3 and 4 bytes per colour: ${JSON.stringify(pf)}`, () => {
      const bpp = bytesPerPixel(pf)
      const expected = Buffer.alloc(3 * bpp + 2)
      for (let i = 0; i < 3; i++) {
        const v = rgbToPixel(pf, rgb[i * 3] as number, rgb[i * 3 + 1] as number, rgb[i * 3 + 2] as number)
        writePixel(pf, v, expected, 2 + i * bpp)
      }
      const out = Buffer.alloc(3 * bpp + 2, 0xee) // padding bytes must be zeroed
      out[0] = 0
      out[1] = 0
      rgbToPixels(pf, rgb, 3, 3, out, 2)
      assert.deepEqual(out, expected)
      out.fill(0xee, 2)
      rgbToPixels(pf, rgba, 4, 3, out, 2)
      assert.deepEqual(out, expected)
    })
  }

  test('bgrx bytes in memory', () => {
    const out = Buffer.alloc(4)
    rgbToPixels(bgrx, Buffer.from([1, 2, 3]), 3, 1, out)
    assert.deepEqual([...out], [3, 2, 1, 0])
    rgbToPixels(rgbx, Buffer.from([1, 2, 3]), 3, 1, out)
    assert.deepEqual([...out], [1, 2, 3, 0])
  })
})

describe('cpixelOffset', () => {
  // TigerVNC / libvncserver: colours in the low 3 bytes of a little-endian pixel or the high 3 bytes
  // of a big-endian one are the first 3 bytes in memory (offset 0); the other way round, offset 1.
  test('colour bits in the low three bytes', () => {
    assert.equal(cpixelOffset(bgrx), 0)
    assert.equal(cpixelOffset(rgbx), 0)
    assert.equal(cpixelOffset({ ...bgrx, bigEndian: true }), 1)
  })

  test('colour bits in the high three bytes', () => {
    assert.equal(cpixelOffset(pf32(24, 16, 8)), 1)
    assert.equal(cpixelOffset(pf32(24, 16, 8, { bigEndian: true })), 0)
  })

  test('colour bits that fit both: the first three bytes in memory', () => {
    const mid = pf32(19, 13, 8, { depth: 16, redMax: 31, greenMax: 63, blueMax: 31 })
    assert.equal(cpixelOffset(mid), 0)
    assert.equal(cpixelOffset({ ...mid, bigEndian: true }), 0)
  })

  test('full pixels', () => {
    assert.equal(cpixelOffset(pf32(0, 8, 24)), -1, 'colours spread over all four bytes')
    assert.equal(cpixelOffset(pf32(0, 8, 24, { bigEndian: true })), -1)
    assert.equal(cpixelOffset(pf32(0, 8, 16, { depth: 32 })), -1, 'depth 32')
    assert.equal(cpixelOffset({ ...bgrx, trueColor: false }), -1, 'colour map')
    assert.equal(cpixelOffset(rgb565), -1)
    assert.equal(cpixelOffset(bgr233), -1)
  })
})

describe('isTightRgb', () => {
  test('32-bit, depth 24, 8 bits per channel', () => {
    assert.equal(isTightRgb(bgrx), true)
    assert.equal(isTightRgb(rgbx), true)
    assert.equal(isTightRgb({ ...bgrx, bigEndian: true }), true)
    assert.equal(isTightRgb(pf32(24, 16, 8)), true)
    assert.equal(isTightRgb(pf32(0, 8, 16, { depth: 32 })), false)
    assert.equal(isTightRgb(pf32(20, 10, 0, { redMax: 1023 })), false)
    assert.equal(isTightRgb({ ...bgrx, trueColor: false }), false)
    assert.equal(isTightRgb(rgb565), false)
    assert.equal(isTightRgb(bgr233), false)
  })
})

describe('validatePixelFormat', () => {
  function rejects(pf: PixelFormat, message: RegExp, fromServer = false) {
    assert.throws(
      () => validatePixelFormat(pf, fromServer),
      (err: unknown) =>
        err instanceof RfbError &&
        err.code === (fromServer ? 'PROTOCOL_ERROR' : 'INVALID_ARGUMENT') &&
        message.test(err.message),
    )
  }

  test('the presets are valid', () => {
    for (const pf of Object.values(pixelFormats)) validatePixelFormat(pf)
    validatePixelFormat(pf32(24, 16, 8))
    validatePixelFormat(pf32(0, 8, 16, { depth: 32 }))
  })

  test('bits per pixel must be 8, 16 or 32', () => {
    rejects({ ...bgrx, bitsPerPixel: 24 }, /bitsPerPixel must be 8, 16 or 32, not 24/)
    rejects({ ...bgrx, bitsPerPixel: 24 }, /bitsPerPixel/, true)
    rejects({ ...colourMap8, bitsPerPixel: 4 }, /bitsPerPixel/)
  })

  test('channel maxima must be 2^n - 1', () => {
    rejects({ ...bgrx, redMax: 254 }, /redMax must be 2\^n - 1, not 254/)
    rejects({ ...bgrx, greenMax: 0 }, /greenMax/)
    rejects({ ...bgrx, blueMax: 0x1ffff }, /blueMax/)
    rejects({ ...bgrx, blueMax: 2.5 }, /blueMax/, true)
  })

  test('channels must lie inside the pixel', () => {
    rejects({ ...bgrx, redShift: 25 }, /redShift 25 puts red outside the 32-bit pixel/)
    rejects({ ...rgb565, greenShift: 11 }, /greenShift 11/)
    rejects({ ...bgr233, blueShift: 7 }, /blueShift 7/, true)
    rejects({ ...bgrx, redShift: -1 }, /redShift/)
    validatePixelFormat({ ...bgrx, redShift: 24 })
  })

  test('colour-map formats skip the channel checks', () => {
    validatePixelFormat({ ...colourMap8, redMax: 0, redShift: 99 })
  })
})

describe('PIXEL_FORMAT structure', () => {
  test('write and read back, padding zeroed', () => {
    for (const pf of [bgrx, rgb565, { ...bgrx, bigEndian: true }, colourMap8, pf32(24, 16, 8)]) {
      const buf = Buffer.alloc(18, 0xee)
      writePixelFormat(pf, buf, 1)
      assert.deepEqual([...buf.subarray(14, 17)], [0, 0, 0])
      assert.equal(buf[0], 0xee)
      assert.equal(buf[17], 0xee)
      assert.deepEqual(readPixelFormat(buf, 1), pf)
    }
    const buf = Buffer.alloc(16)
    writePixelFormat(bgrx, buf)
    assert.deepEqual([...buf], [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
  })

  test('samePixelFormat', () => {
    assert.equal(samePixelFormat(bgrx, { ...bgrx }), true)
    assert.equal(samePixelFormat(bgrx, rgbx), false)
    assert.equal(samePixelFormat(bgrx, { ...bgrx, bigEndian: true }), false)
    assert.equal(samePixelFormat(bgrx, { ...bgrx, depth: 32 }), true, 'depth does not change the pixels')
    assert.equal(samePixelFormat(bgr233, { ...bgr233, bigEndian: true }), true, '8-bit pixels have no byte order')
    assert.equal(samePixelFormat(colourMap8, { ...colourMap8, redMax: 1 }), true, 'colour maps ignore channels')
    assert.equal(samePixelFormat(colourMap8, bgr233), false)
    assert.equal(samePixelFormat(rgb565, bgr233), false)
  })

  test('bytesPerPixel', () => {
    assert.equal(bytesPerPixel(bgrx), 4)
    assert.equal(bytesPerPixel(rgb565), 2)
    assert.equal(bytesPerPixel(bgr233), 1)
  })
})
