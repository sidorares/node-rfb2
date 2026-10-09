// Decoding speed: a 1920×1080 test image (solid areas, text, few-colour areas, gradients, noise)
// encoded once per encoding, then decoded repeatedly from a ByteReader in 64 KiB chunks.
//   node scripts/bench.ts

import { Decoder } from '../src/decoder.ts'
import { encodings as E, pixelFormats } from '../src/index.ts'
import { ByteReader } from '../src/reader.ts'
import {
  Deflater,
  encodeHextile,
  encodeRaw,
  encodeRre,
  encodeTrle,
  encodeZlib,
  encodeZrle,
  TightEncoder,
  testImage,
} from '../test/helpers/encoders.ts'

const pf = pixelFormats.bgrx
const width = 1920
const height = 1080
const img = testImage(pf, width, height, 42, 32)

async function body(name: string): Promise<Buffer> {
  switch (name) {
    case 'Raw':
      return encodeRaw(img)
    case 'RRE':
      return encodeRre(img, false)
    case 'Hextile':
      return encodeHextile(img)
    case 'TRLE':
      return encodeTrle(img, pf)
    case 'Zlib':
      return encodeZlib(new Deflater(), img)
    case 'ZRLE':
      return encodeZrle(new Deflater(), img, pf)
    default:
      return new TightEncoder().encode(img, pf, { method: 'copy' })
  }
}

const cases: [string, number][] = [
  ['Raw', E.raw],
  ['RRE', E.rre],
  ['Hextile', E.hextile],
  ['TRLE', E.trle],
  ['Zlib', E.zlib],
  ['ZRLE', E.zrle],
  ['Tight', E.tight],
]

console.log(`${width}×${height}, bgrx; ms per frame (median of 15)`)
for (const [name, encoding] of cases) {
  const data = await body(name)
  const times: number[] = []
  for (let i = 0; i < 15; i++) {
    const reader = new ByteReader()
    for (let o = 0; o < data.length; o += 65536) reader.push(data.subarray(o, o + 65536))
    const decoder = new Decoder()
    const t0 = performance.now()
    await decoder.decode(reader, { x: 0, y: 0, width, height, encoding }, pf, [])
    times.push(performance.now() - t0)
    decoder.close()
  }
  times.sort((a, b) => a - b)
  const ms = times[7] as number
  console.log(`${name.padEnd(8)} ${(data.length / 1024).toFixed(0).padStart(6)} KiB  ${ms.toFixed(1).padStart(6)} ms`)
}
