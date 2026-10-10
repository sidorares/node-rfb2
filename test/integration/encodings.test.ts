// Every encoding against real servers: the screen is static, so a frame decoded from any encoding
// must be pixel-identical to the same frame sent Raw, in every pixel format.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { encodings as E, type PixelFormat, pixelFormats } from '../../src/index.ts'
import { assertSameFrame, grabFrame, needServer } from './harness.ts'
import { qemu, type TestServer, tigervnc, tightvncNone, turbovnc, x11vnc } from './servers.ts'

const ENCODINGS: [string, number][] = [
  ['RRE', E.rre],
  ['CoRRE', E.coRre],
  ['Hextile', E.hextile],
  ['Zlib', E.zlib],
  ['Tight', E.tight],
  ['TightPNG', E.tightPng],
  ['TRLE', E.trle],
  ['ZRLE', E.zrle],
]

const FORMATS: [string, PixelFormat][] = [
  ['bgrx', pixelFormats.bgrx],
  ['rgbx', pixelFormats.rgbx],
  ['32-bit big-endian', { ...pixelFormats.bgrx, bigEndian: true }],
  ['rgb565', pixelFormats.rgb565],
  ['bgr233', pixelFormats.bgr233],
]

/** Encodings each server must actually use when asked for them alone (the rest fall back to Raw). */
const EXPECTED: [TestServer, number[]][] = [
  [tigervnc, [E.rre, E.hextile, E.tight, E.zrle]],
  [x11vnc, [E.rre, E.coRre, E.hextile, E.zlib, E.tight, E.zrle]],
  [tightvncNone, [E.rre, E.coRre, E.hextile, E.zlib, E.tight]],
  [turbovnc, [E.tight]],
  [qemu, [E.hextile, E.zlib, E.tight, E.tightPng, E.zrle]],
]

for (const [server, expected] of EXPECTED) {
  describe(server.name, () => {
    for (const [formatName, pixelFormat] of FORMATS) {
      test(`every encoding matches Raw (${formatName})`, async (t) => {
        if (!(await needServer(t, server.port, server.name))) return
        const reference = await grabFrame(server.port, { encodings: [E.raw], pixelFormat })
        const again = await grabFrame(server.port, { encodings: [E.raw], pixelFormat })
        assertSameFrame(again.fb, reference.fb, `${server.name} ${formatName} raw twice (is the screen static?)`)
        const used = new Set<number>()
        for (const [name, encoding] of ENCODINGS) {
          const frame = await grabFrame(server.port, { encodings: [encoding], pixelFormat })
          for (const e of frame.used) used.add(e)
          // QEMU's TightPNG palette loads a big-endian client pixel as a host-endian
          // word (ui/vnc-enc-tight.c write_png_palette), which swaps red and green and
          // drops blue. Those PNG bytes are not the Raw pixels.
          if (server === qemu && pixelFormat.bigEndian && encoding === E.tightPng) continue
          assertSameFrame(frame.fb, reference.fb, `${server.name} ${formatName} ${name}`)
        }
        if (formatName === 'bgrx') {
          const missing = expected.filter((e) => !used.has(e))
          assert.deepEqual(missing, [], `${server.name} didn't use encodings ${missing.join(', ')}`)
        }
      })
    }
  })
}
