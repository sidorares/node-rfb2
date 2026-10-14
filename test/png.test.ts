import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RfbError } from '../src/errors.ts'
import { decodePng } from '../src/png.ts'
import { randInt, rng } from './helpers/encoders.ts'
import {
  crc32,
  encodePng,
  PNG_SIGNATURE,
  type PngBitDepth,
  type PngColorType,
  type PngOptions,
  pngChannels,
  pngChunk,
} from './helpers/png-encoder.ts'

/** Every colour type with the bit depths PNG allows for it. */
const COMBOS: [PngColorType, PngBitDepth[]][] = [
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]

/** Filter types for every row, and one that changes from row to row. */
const FILTERS: { name: string; filter: PngOptions['filter'] }[] = [
  { name: 'none', filter: 0 },
  { name: 'sub', filter: 1 },
  { name: 'up', filter: 2 },
  { name: 'average', filter: 3 },
  { name: 'paeth', filter: 4 },
  { name: 'mixed', filter: (y) => (y * 3 + 1) % 5 },
]

const SIZES: [number, number][] = [
  [1, 1],
  [13, 7],
  [37, 11],
]

/** Test samples for a colour type and depth, with the RGBA they stand for (8 bits per channel). */
function sampleImage(width: number, height: number, colorType: PngColorType, depth: PngBitDepth, seed: number) {
  const r = rng(seed)
  const channels = pngChannels[colorType]
  const top = 2 ** depth
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  let entries = 0
  if (colorType === 3) {
    entries = depth === 8 ? 200 : top
    palette = Buffer.from(Array.from({ length: entries * 3 }, () => randInt(r, 256)))
    // Fewer alpha values than entries: the rest are opaque.
    transparency = Buffer.from(Array.from({ length: Math.max(1, entries >> 1) }, () => randInt(r, 256)))
  }
  const samples: number[] = []
  // Smooth-ish data (each sample near the one above or to the left) mixed with noise, so every
  // filter has something to predict.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let v: number
        if (colorType === 3) v = randInt(r, entries)
        else if (r() < 0.3 || (x === 0 && y === 0)) v = randInt(r, top)
        else if (x > 0) v = Math.min(top - 1, (samples[samples.length - channels] as number) + randInt(r, 3))
        else v = samples[samples.length - width * channels] as number
        samples.push(v)
      }
    }
  }
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : (v * 255) / (top - 1))
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = samples.slice(i * channels, (i + 1) * channels)
    let px: number[]
    switch (colorType) {
      case 0:
        px = [to8(s[0] as number), to8(s[0] as number), to8(s[0] as number), 255]
        break
      case 2:
        px = [...s.map(to8), 255]
        break
      case 3: {
        const e = s[0] as number
        const p = palette as Buffer
        px = [p[e * 3] as number, p[e * 3 + 1] as number, p[e * 3 + 2] as number, (transparency as Buffer)[e] ?? 255]
        break
      }
      case 4:
        px = [to8(s[0] as number), to8(s[0] as number), to8(s[0] as number), to8(s[1] as number)]
        break
      default:
        px = s.map(to8)
    }
    rgba.set(px, i * 4)
  }
  return { samples, palette, transparency, rgba }
}

function isProtocolError(message: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof RfbError, `expected an RfbError, got ${String(err)}`)
    assert.equal(err.code, 'PROTOCOL_ERROR')
    assert.match(err.message, message)
    return true
  }
}

describe('decodePng', () => {
  let seed = 1
  for (const [colorType, depths] of COMBOS) {
    for (const depth of depths) {
      test(`colour type ${colorType}, ${depth}-bit, every filter type`, () => {
        for (const { name, filter } of FILTERS) {
          for (const [w, h] of SIZES) {
            const img = sampleImage(w, h, colorType, depth, seed++)
            const png = encodePng(w, h, img.samples, {
              colorType,
              bitDepth: depth,
              filter,
              ...(img.palette ? { palette: img.palette } : {}),
              ...(img.transparency ? { transparency: img.transparency } : {}),
            })
            const out = decodePng(png)
            assert.equal(out.width, w)
            assert.equal(out.height, h)
            assert.deepEqual(out.rgba, img.rgba, `${name} filter, ${w}×${h}`)
          }
        }
      })
    }
  }

  test('palette entries without a tRNS alpha are opaque', () => {
    const palette = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90])
    const png = encodePng(3, 1, [0, 1, 2], { colorType: 3, bitDepth: 8, palette })
    assert.deepEqual(decodePng(png).rgba, Buffer.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]))
    const withAlpha = encodePng(3, 1, [0, 1, 2], { colorType: 3, bitDepth: 2, palette, transparency: Buffer.from([0]) })
    assert.deepEqual(decodePng(withAlpha).rgba, Buffer.from([10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 255]))
  })

  test('image data split over several IDAT chunks, ancillary chunks skipped', () => {
    const img = sampleImage(37, 11, 6, 8, 99)
    const png = encodePng(37, 11, img.samples, {
      colorType: 6,
      bitDepth: 8,
      filter: 4,
      idatChunks: 5,
      extraChunks: [
        { type: 'gAMA', data: Buffer.from([0, 0, 0xb1, 0x8f]) },
        { type: 'tEXt', data: Buffer.from('Comment\0from a test') },
      ],
    })
    assert.deepEqual(decodePng(png).rgba, img.rgba)
  })

  test('chunks after IEND are ignored', () => {
    const img = sampleImage(5, 3, 2, 8, 7)
    const png = encodePng(5, 3, img.samples, { colorType: 2, bitDepth: 8, filter: 1 })
    const trailing = Buffer.concat([png, pngChunk('IDAT', Buffer.from('not zlib data at all'))])
    assert.deepEqual(decodePng(trailing).rgba, img.rgba)
  })

  describe('errors', () => {
    const good = encodePng(4, 4, new Array(16 * 3).fill(7), { colorType: 2, bitDepth: 8 })

    test('a bad signature', () => {
      assert.throws(() => decodePng(Buffer.from('not a png at all')), isProtocolError(/signature/))
      assert.throws(() => decodePng(PNG_SIGNATURE.subarray(0, 5)), isProtocolError(/signature/))
      const flipped = Buffer.from(good)
      flipped[1] = 0x51
      assert.throws(() => decodePng(flipped), isProtocolError(/signature/))
    })

    test('an interlaced image', () => {
      const png = encodePng(4, 4, new Array(16).fill(1), { colorType: 0, bitDepth: 8, interlace: 1 })
      assert.throws(() => decodePng(png), isProtocolError(/interlaced/))
    })

    test('no IHDR, or an invalid colour type', () => {
      const noHeader = Buffer.concat([PNG_SIGNATURE, pngChunk('IEND', Buffer.alloc(0))])
      assert.throws(() => decodePng(noHeader), isProtocolError(/IHDR/))
      const badType = Buffer.from(good)
      badType[8 + 8 + 9] = 5 // IHDR colour type
      assert.throws(() => decodePng(badType), isProtocolError(/IHDR/))
    })

    test('a palette image without PLTE', () => {
      const png = encodePng(2, 2, [0, 1, 1, 0], { colorType: 3, bitDepth: 1 })
      assert.throws(() => decodePng(png), isProtocolError(/PLTE/))
    })

    test('an unknown filter type', () => {
      const png = encodePng(4, 4, new Array(16).fill(3), {
        colorType: 0,
        bitDepth: 8,
        filter: (y) => (y === 2 ? 5 : 0),
      })
      assert.throws(() => decodePng(png), isProtocolError(/filter 5/))
    })

    test('a truncated chunk', () => {
      assert.throws(() => decodePng(good.subarray(0, good.length - 20)), isProtocolError(/truncated/))
    })

    test('image data shorter than the image', () => {
      // IHDR says 4 rows, IDAT holds 2.
      const short = encodePng(4, 2, new Array(8 * 3).fill(9), { colorType: 2, bitDepth: 8 })
      const ihdrHeight = 8 + 8 + 4
      const patched = Buffer.from(short)
      patched.writeUInt32BE(4, ihdrHeight)
      // Fix the IHDR CRC so only the size is wrong.
      patched.writeUInt32BE(crc32(patched.subarray(12, 12 + 4 + 13)), 12 + 4 + 13)
      assert.throws(() => decodePng(patched), isProtocolError(/too short/))
    })

    test('corrupt zlib data', () => {
      const ihdr = good.subarray(8, 8 + 25)
      const png = Buffer.concat([
        PNG_SIGNATURE,
        ihdr,
        pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0x00, 0x13])),
        pngChunk('IEND', Buffer.alloc(0)),
      ])
      assert.throws(() => decodePng(png), isProtocolError(/zlib|PNG/))
    })
  })
})
