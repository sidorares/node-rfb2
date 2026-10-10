// Integration tests run against the VNC servers in docker/compose.yaml (`npm run servers:up`). A
// server that isn't reachable skips its tests, unless RFB_INTEGRATION=required (CI), which fails them.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import zlib from 'node:zlib'
import { type ConnectOptions, connect, Framebuffer, type RfbClient } from '../../src/index.ts'

export const HOST = process.env.RFB_HOST ?? '127.0.0.1'
const REQUIRED = process.env.RFB_INTEGRATION === 'required'

const reachability = new Map<number, Promise<boolean>>()

/** True when something answers on `port` with an RFB version string within a second. */
export function reachable(port: number): Promise<boolean> {
  let known = reachability.get(port)
  if (!known) {
    known = new Promise((resolve) => {
      const socket = net.connect({ host: HOST, port })
      const done = (ok: boolean) => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(1000, () => done(false))
      socket.once('error', () => done(false))
      socket.once('data', (d) => done(d.toString('latin1').startsWith('RFB ')))
    })
    reachability.set(port, known)
  }
  return known
}

/** `t.skip()`s the test (or fails it in CI) when the server on `port` isn't running. */
export async function needServer(t: { skip(message?: string): void }, port: number, name: string): Promise<boolean> {
  if (await reachable(port)) return true
  if (REQUIRED) assert.fail(`${name} is not reachable on ${HOST}:${port}; start it with npm run servers:up`)
  t.skip(`${name} is not running on ${HOST}:${port} (npm run servers:up)`)
  return false
}

export interface Grab {
  client: RfbClient
  fb: Framebuffer
  /** Encodings of the pixel rects that made up the frame. */
  used: Set<number>
}

/**
 * Connects, asks for the whole screen and resolves once every pixel has been received (possibly
 * over several updates). The client stays open; close it.
 */
export async function grab(port: number, options: ConnectOptions = {}, timeoutMs = 15000): Promise<Grab> {
  const client = await connect({ host: HOST, port, timeout: 10000, initialUpdate: false, ...options })
  try {
    const fb = Framebuffer.attach(client)
    const used = new Set<number>()
    let covered = new Uint8Array(client.width * client.height)
    let remaining = covered.length
    const deadline = Date.now() + timeoutMs
    for await (const update of client.updates()) {
      for (const rect of update.rects) {
        if (rect.type === 'desktopSize' || rect.type === 'extendedDesktopSize') {
          covered = new Uint8Array(client.width * client.height)
          remaining = covered.length
        }
        if (rect.type !== 'pixels' && rect.type !== 'copy' && rect.type !== 'jpeg') continue
        used.add(rect.encoding)
        for (let y = rect.y; y < rect.y + rect.height; y++) {
          for (let x = rect.x; x < rect.x + rect.width; x++) {
            const i = y * client.width + x
            if (!covered[i]) {
              covered[i] = 1
              remaining--
            }
          }
        }
      }
      if (remaining === 0) break
      if (Date.now() > deadline)
        throw new Error(`only ${covered.length - remaining} of ${covered.length} pixels arrived`)
    }
    return { client, fb, used }
  } catch (err) {
    client.destroy()
    throw err
  }
}

/** Grabs one full frame and closes the connection. */
export async function grabFrame(port: number, options: ConnectOptions = {}): Promise<Omit<Grab, 'client'>> {
  const { client, fb, used } = await grab(port, options)
  await client.close()
  return { fb, used }
}

/** Asserts two framebuffers are identical; on a mismatch writes both as PNGs to test/integration/out. */
export function assertSameFrame(actual: Framebuffer, expected: Framebuffer, label: string): void {
  assert.equal(actual.width, expected.width, `${label}: width`)
  assert.equal(actual.height, expected.height, `${label}: height`)
  if (actual.data.equals(expected.data)) return
  const bpp = actual.bytesPerPixel
  let mismatches = 0
  let first = ''
  for (let i = 0; i < actual.width * actual.height; i++) {
    if (actual.data.compare(expected.data, i * bpp, i * bpp + bpp, i * bpp, i * bpp + bpp) !== 0) {
      if (mismatches++ === 0) first = `${i % actual.width},${Math.floor(i / actual.width)}`
    }
  }
  const name = label.replace(/[^a-z0-9]+/gi, '-')
  writePng(`${name}-actual.png`, actual)
  writePng(`${name}-expected.png`, expected)
  assert.fail(`${label}: ${mismatches} pixels differ (first at ${first}); see test/integration/out/${name}-*.png`)
}

/** Mean absolute difference per channel, for lossy (JPEG) frames. */
export function meanDifference(a: Framebuffer, b: Framebuffer): number {
  const x = a.toRgba()
  const y = b.toRgba()
  let sum = 0
  for (let i = 0; i < x.length; i += 4) {
    sum += Math.abs((x[i] as number) - (y[i] as number))
    sum += Math.abs((x[i + 1] as number) - (y[i + 1] as number))
    sum += Math.abs((x[i + 2] as number) - (y[i + 2] as number))
  }
  return sum / ((x.length / 4) * 3)
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const byte of b) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Writes a framebuffer as an RGB PNG under test/integration/out (for looking at failures). */
export function writePng(file: string, fb: Framebuffer): void {
  const rgba = fb.toRgba()
  const raw = Buffer.alloc((fb.width * 3 + 1) * fb.height)
  for (let y = 0; y < fb.height; y++) {
    for (let x = 0; x < fb.width; x++)
      rgba.copy(raw, y * (fb.width * 3 + 1) + 1 + x * 3, (y * fb.width + x) * 4, (y * fb.width + x) * 4 + 3)
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(fb.width, 0)
  ihdr.writeUInt32BE(fb.height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const dir = new URL('./out/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    new URL(file, dir),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}
