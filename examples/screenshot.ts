// Saves the remote screen as a PNG.
//   node examples/screenshot.ts [host] [port] [password] > screen.png
// (Run from the repository; with the published package, import from 'rfb2'.)

import zlib from 'node:zlib'
import { connect, Framebuffer } from '../src/index.ts'

const [host = '127.0.0.1', port = '5900', password] = process.argv.slice(2)
const client = await connect({ host, port: Number(port), password, initialUpdate: false })
const fb = Framebuffer.attach(client)
// The first update after a non-incremental request covers the whole screen on most servers.
for await (const _update of client.updates()) break
await client.close()
process.stdout.write(png(fb.width, fb.height, fb.toRgba()))

/** A minimal RGBA PNG encoder. */
function png(width: number, height: number, rgba: Buffer): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
