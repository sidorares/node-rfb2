import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { describe, test } from 'node:test'
import zlib from 'node:zlib'
import {
  buttons,
  connect,
  createConnection,
  defaultEncodings,
  encodings as E,
  Framebuffer,
  pixelFormats,
  type Rect,
  RfbClient,
  RfbError,
  type Update,
} from '../src/index.ts'
import {
  acceptNone,
  connected,
  next,
  type Peer,
  pair,
  readSetup,
  rectHeader,
  s32,
  serverInit,
  str,
  u8,
  u16,
  u32,
} from './helpers/peer.ts'

const rejectsWith = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RfbError, `expected an RfbError, got ${err}`)
    assert.equal(err.code, code, err.message)
    if (message) assert.match(err.message, message)
    return true
  })
}

/** A FramebufferUpdate with `count` rects made of `parts`. */
const fbUpdate = (count: number, ...parts: Buffer[]) => Buffer.concat([u8(0, 0), u16(count), ...parts])

describe('handshake', () => {
  test('3.8 with security None: version, ClientInit, ServerInit, setup messages', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream })
    peer.write('RFB 003.008\n')
    assert.equal(await peer.string(12), 'RFB 003.008\n')
    peer.write(u8(2, 2, 1)) // VNC and None offered
    assert.equal(await peer.u8(), 1, 'None is preferred without a password')
    peer.write(u32(0))
    assert.equal(await peer.u8(), 1, 'shared')
    peer.write(serverInit(640, 480, 'desk ☃', pixelFormats.rgb565))
    const client = await connecting
    assert.equal(client.width, 640)
    assert.equal(client.height, 480)
    assert.equal(client.name, 'desk ☃')
    assert.equal(client.title, 'desk ☃')
    assert.equal(client.protocolVersion, '3.8')
    assert.equal(client.serverVersion, 'RFB 003.008\n')
    assert.equal(client.securityType, 1)
    assert.deepEqual(client.serverPixelFormat, pixelFormats.rgb565)
    assert.deepEqual(client.pixelFormat, pixelFormats.bgrx)
    assert.equal(client.bpp, 32)
    const setPixelFormat = await peer.read(20)
    assert.deepEqual([...setPixelFormat], [0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
    const head = await peer.read(4)
    assert.equal(head[0], 2)
    const list = await peer.read(4 * head.readUInt16BE(2))
    assert.deepEqual(
      Array.from({ length: head.readUInt16BE(2) }, (_, i) => list.readInt32BE(4 * i)),
      [...defaultEncodings],
    )
    assert.deepEqual([...(await peer.read(10))], [3, 0, 0, 0, 0, 0, 2, 128, 1, 224])
    client.destroy()
  })

  test('3.3: the server picks the type, None has no SecurityResult', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, initialUpdate: false })
    peer.write('RFB 003.003\n')
    assert.equal(await peer.string(12), 'RFB 003.003\n')
    peer.write(u32(1))
    assert.equal(await peer.u8(), 1)
    peer.write(serverInit(10, 10, 'old'))
    const client = await connecting
    assert.equal(client.protocolVersion, '3.3')
    client.destroy()
  })

  test('3.3 with VNC authentication', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, password: 'secret' })
    peer.write('RFB 003.003\n')
    await peer.string(12)
    peer.write(u32(2), Buffer.alloc(16, 7))
    const { vncAuthResponse } = await import('../src/des.ts')
    assert.deepEqual(await peer.read(16), vncAuthResponse(Buffer.alloc(16, 7), 'secret'))
    peer.write(u32(0))
    await peer.u8()
    peer.write(serverInit(10, 10, 'old'))
    ;(await connecting).destroy()
  })

  test('3.7: None has no SecurityResult; a failed VNC auth just closes', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream })
    peer.write('RFB 003.007\n')
    assert.equal(await peer.string(12), 'RFB 003.007\n')
    peer.write(u8(1, 1))
    await peer.u8()
    assert.equal(await peer.u8(), 1, 'ClientInit right after choosing None')
    peer.write(serverInit(10, 10, 'x'))
    ;(await connecting).destroy()

    const second = pair()
    const failing = connect({ stream: second.clientStream, password: 'p' })
    second.peer.write('RFB 003.007\n')
    await second.peer.string(12)
    second.peer.write(u8(1, 2), Buffer.alloc(16))
    await second.peer.read(17)
    second.peer.write(u32(1))
    second.peer.end()
    await rejectsWith(failing, 'AUTH_FAILED')
  })

  for (const [banner, expected] of [
    ['RFB 003.889\n', '3.8'],
    ['RFB 004.001\n', '3.8'],
    ['RFB 003.005\n', '3.3'],
    ['RFB 003.006\n', '3.3'],
  ] as const) {
    test(`answers ${JSON.stringify(banner)} with ${expected}`, async () => {
      const { clientStream, peer } = pair()
      const client = new RfbClient({ stream: clientStream })
      client.on('error', () => {})
      peer.write(banner)
      assert.equal(await peer.string(12), `RFB 003.00${expected[2]}\n`)
      client.destroy()
    })
  }

  test('maxVersion caps the version', async () => {
    const { clientStream, peer } = pair()
    const client = new RfbClient({ stream: clientStream, maxVersion: '3.7' })
    client.on('error', () => {})
    peer.write('RFB 003.008\n')
    assert.equal(await peer.string(12), 'RFB 003.007\n')
    client.destroy()
  })

  test('something that is not RFB', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream })
    peer.write('HTTP/1.1 400 Bad Request\r\n')
    await rejectsWith(connecting, 'NOT_RFB', /is this a VNC server port/)
  })

  test('the server refuses with a reason (3.8 and 3.3)', async () => {
    const a = pair()
    const refused = connect({ stream: a.clientStream })
    a.peer.write('RFB 003.008\n', u8(0), str('too many connections'))
    await assert.rejects(
      refused,
      (err: RfbError) => err.code === 'SERVER_REFUSED' && err.reason === 'too many connections',
    )
    const b = pair()
    const refused33 = connect({ stream: b.clientStream })
    b.peer.write('RFB 003.003\n', u32(0), str('go away'))
    await rejectsWith(refused33, 'SERVER_REFUSED', /go away/)
  })

  test('no security type in common', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, security: [2] })
    peer.write('RFB 003.008\n', u8(2, 30, 35))
    await rejectsWith(connecting, 'UNSUPPORTED_SECURITY', /ARD \(30\), Apple \(35\)/)
  })

  test('VNC authentication: a wrong password fails with the reason', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, password: 'nope' })
    peer.write('RFB 003.008\n', u8(1, 2))
    await peer.read(13)
    peer.write(Buffer.alloc(16))
    await peer.read(16)
    peer.write(u32(1), str('Authentication failure'))
    await assert.rejects(
      connecting,
      (err: RfbError) => err.code === 'AUTH_FAILED' && err.reason === 'Authentication failure',
    )
  })

  test('a password is needed and missing', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream })
    peer.write('RFB 003.008\n', u8(1, 2), Buffer.alloc(16))
    await rejectsWith(connecting, 'AUTH_REQUIRED', /pass `password`/)
  })

  test('credentials() and the 0.x credentialsCallback supply the password', async () => {
    const { vncAuthResponse } = await import('../src/des.ts')
    for (const options of [
      { credentials: async ({ needs }: { needs: string[] }) => (needs.includes('password') ? { password: 'cb' } : {}) },
      {
        credentialsCallback(this: RfbClient, done: (p: string) => void) {
          assert.ok(this instanceof RfbClient)
          done('cb')
        },
      },
    ]) {
      const { clientStream, peer } = pair()
      const connecting = connect({ stream: clientStream, ...options })
      peer.write('RFB 003.008\n', u8(1, 2))
      await peer.read(13)
      peer.write(Buffer.alloc(16, 3))
      assert.deepEqual(await peer.read(16), vncAuthResponse(Buffer.alloc(16, 3), 'cb'))
      peer.write(u32(0))
      await peer.u8()
      peer.write(serverInit(1, 1, 'x'))
      ;(await connecting).destroy()
    }
  })

  test('timeout during the handshake', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, timeout: 50 })
    peer.write('RFB 003.008\n')
    await rejectsWith(connecting, 'TIMEOUT', /50 ms/)
  })

  test('abort during the handshake, and after it', async () => {
    const ac = new AbortController()
    const { clientStream } = pair()
    const connecting = connect({ stream: clientStream, signal: ac.signal })
    ac.abort()
    await rejectsWith(connecting, 'ABORTED')

    const ac2 = new AbortController()
    const { client } = await connected({ signal: ac2.signal })
    const events: string[] = []
    client.on('error', () => events.push('error'))
    client.on('close', (hadError) => events.push(`close ${hadError}`))
    ac2.abort()
    await once(client, 'close')
    assert.deepEqual(events, ['close false'])
  })

  test('an UltraVNC repeater gets the ID first', async () => {
    const { clientStream, peer } = pair()
    const client = new RfbClient({ stream: clientStream, repeaterId: 'ID:1234' })
    client.on('error', () => {})
    peer.write('RFB 000.000\n')
    const id = await peer.read(250)
    assert.equal(id.toString('latin1').replace(/\0+$/, ''), 'ID:1234')
    peer.write('RFB 003.008\n')
    assert.equal(await peer.string(12), 'RFB 003.008\n')
    client.destroy()
  })

  test('connection refused', async () => {
    const server = net.createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as net.AddressInfo
    await new Promise<void>((r) => server.close(() => r()))
    await rejectsWith(connect({ port }), 'CONNECTION_FAILED', /ECONNREFUSED/)
  })

  test('unknown encodings and pixel formats are refused up front', () => {
    assert.throws(
      () => new RfbClient({ encodings: [E.raw, 12345] }),
      (err: RfbError) => err.code === 'UNSUPPORTED_ENCODING',
    )
    assert.throws(
      () => new RfbClient({ pixelFormat: { ...pixelFormats.bgrx, bitsPerPixel: 24 } }),
      (err: RfbError) => err.code === 'INVALID_ARGUMENT',
    )
    assert.throws(
      () => new RfbClient({ pixelFormat: 'argb' as 'rgbx' }),
      (err: RfbError) => err.code === 'INVALID_ARGUMENT',
    )
  })

  test("pixelFormat 'server' keeps the server's format and sends no SetPixelFormat", async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, pixelFormat: 'server' })
    peer.write('RFB 003.008\n', u8(1, 1))
    await peer.read(13)
    peer.write(u32(0))
    await peer.u8()
    peer.write(serverInit(2, 2, 'x', pixelFormats.rgb565))
    const client = await connecting
    assert.deepEqual(client.pixelFormat, pixelFormats.rgb565)
    assert.equal((await peer.read(1))[0], 2, 'SetEncodings comes first')
    client.destroy()
  })
})

describe('updates', () => {
  test('rects, update, resize and LastRect', async () => {
    const { client, peer } = await connected({}, { width: 4, height: 2 })
    const rects: Rect[] = []
    client.on('rect', (r) => rects.push(r))
    const resized = next<{ width: number }>(client, 'resize')
    const updated = client.nextUpdate()
    peer.write(
      u8(0, 0),
      u16(0xffff),
      rectHeader(0, 0, 2, 1, E.raw),
      Buffer.from([1, 2, 3, 0, 4, 5, 6, 0]),
      rectHeader(2, 0, 2, 1, E.copyRect),
      u16(0),
      u16(0),
      rectHeader(0, 0, 8, 6, E.pseudoDesktopSize),
      rectHeader(0, 0, 0, 0, E.pseudoLastRect),
    )
    const update = await updated
    assert.equal(update.rects.length, 3)
    assert.deepEqual(
      rects.map((r) => r.type),
      ['pixels', 'copy', 'desktopSize'],
    )
    const raw = rects[0] as Extract<Rect, { type: 'pixels' }>
    assert.deepEqual([...raw.data], [1, 2, 3, 0, 4, 5, 6, 0])
    assert.equal(raw.encoding, E.raw)
    assert.deepEqual((rects[1] as Extract<Rect, { type: 'copy' }>).src, { x: 0, y: 0 })
    assert.equal((await resized).width, 8)
    assert.equal(client.width, 8)
    assert.equal(client.height, 6)
    client.destroy()
  })

  test('a rect outside the framebuffer is a protocol error', async () => {
    const { client, peer } = await connected({}, { width: 4, height: 4 })
    const error = next<RfbError>(client, 'error')
    peer.write(fbUpdate(1, rectHeader(2, 2, 4, 4, E.raw)))
    assert.equal((await error).code, 'PROTOCOL_ERROR')
  })

  test('a framebuffer follows the updates', async () => {
    const { client, peer } = await connected({}, { width: 2, height: 2 })
    const fb = Framebuffer.attach(client)
    const updated = client.nextUpdate()
    peer.write(
      fbUpdate(1, rectHeader(0, 0, 2, 2, E.raw), Buffer.from([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 1, 2, 3, 0])),
    )
    await updated
    assert.deepEqual([...fb.toRgba()], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 3, 2, 1, 255])
    client.destroy()
  })

  test('updates() requests the next update only when the previous one was taken', async () => {
    const { client, peer } = await connected({ initialUpdate: false }, { width: 2, height: 1 })
    const seen: Update[] = []
    const consumer = (async () => {
      for await (const u of client.updates()) {
        seen.push(u)
        if (seen.length === 2) break
      }
    })()
    assert.deepEqual([...(await peer.read(10))], [3, 0, 0, 0, 0, 0, 0, 2, 0, 1], 'first request is non-incremental')
    peer.write(fbUpdate(1, rectHeader(0, 0, 1, 1, E.raw), Buffer.alloc(4)))
    assert.equal((await peer.read(10))[1], 1, 'then incremental')
    peer.write(fbUpdate(1, rectHeader(1, 0, 1, 1, E.raw), Buffer.alloc(4)))
    await consumer
    assert.equal(seen.length, 2)
    assert.equal(peer.reader.available, 0, 'no request after the consumer stopped')
    client.destroy()
  })

  test('updates() ends when the server closes the connection', async () => {
    const { client, peer } = await connected({ initialUpdate: false }, { width: 2, height: 1 })
    const consumer = (async () => {
      let n = 0
      for await (const _ of client.updates()) n++
      return n
    })()
    await peer.read(10)
    peer.write(fbUpdate(1, rectHeader(0, 0, 1, 1, E.raw), Buffer.alloc(4)))
    await peer.read(10)
    peer.end()
    assert.equal(await consumer, 1)
  })

  test('autoUpdate asks for the next incremental update', async () => {
    const { client, peer } = await connected({ autoUpdate: true }, { width: 2, height: 1 })
    peer.write(fbUpdate(0))
    assert.deepEqual([...(await peer.read(10))], [3, 1, 0, 0, 0, 0, 0, 2, 0, 1])
    client.destroy()
  })

  test('ExtendedDesktopSize and setDesktopSize', async () => {
    const { client, peer } = await connected({}, { width: 100, height: 80 })
    const screen = Buffer.concat([u32(7), u16(0), u16(0), u16(100), u16(80), u32(0)])
    let updated = client.nextUpdate()
    peer.write(fbUpdate(1, rectHeader(0, 0, 100, 80, E.pseudoExtendedDesktopSize), u8(1, 0, 0, 0), screen))
    await updated
    assert.equal(client.supports.extendedDesktopSize, true)
    assert.deepEqual(client.screens, [{ id: 7, x: 0, y: 0, width: 100, height: 80, flags: 0 }])

    const resizing = client.setDesktopSize(200, 100)
    const req = await peer.read(8 + 16)
    assert.deepEqual([...req.subarray(0, 8)], [251, 0, 0, 200, 0, 100, 1, 0])
    assert.equal(req.readUInt32BE(8), 7, 'keeps the screen id')
    const resized = next<{ width: number; height: number }>(client, 'resize')
    const answer = Buffer.concat([u32(7), u16(0), u16(0), u16(200), u16(100), u32(0)])
    peer.write(fbUpdate(1, rectHeader(1, 0, 200, 100, E.pseudoExtendedDesktopSize), u8(1, 0, 0, 0), answer))
    await resizing
    assert.deepEqual(await resized, {
      width: 200,
      height: 100,
      screens: [{ id: 7, x: 0, y: 0, width: 200, height: 100, flags: 0 }],
    })

    const refused = client.setDesktopSize(5000, 5000)
    await peer.read(24)
    updated = client.nextUpdate()
    peer.write(fbUpdate(1, rectHeader(1, 3, 200, 100, E.pseudoExtendedDesktopSize), u8(0, 0, 0, 0)))
    await rejectsWith(refused, 'SERVER_REFUSED', /invalid screen layout/)
    await updated
    assert.equal(client.width, 200, 'a refused resize changes nothing')
    client.destroy()
  })

  test('setDesktopSize needs the server to support it', async () => {
    const { client } = await connected()
    assert.throws(
      () => client.setDesktopSize(1, 1),
      (err: RfbError) => err.code === 'UNSUPPORTED_BY_SERVER',
    )
    client.destroy()
  })

  test('pseudo-rects: desktop name, cursor, cursor position, LEDs, QEMU capabilities, pointer mode', async () => {
    const { client, peer } = await connected({}, { width: 10, height: 10 })
    const name = next<string>(client, 'desktopName')
    const cursor = next<Extract<Rect, { type: 'cursor' }>>(client, 'cursor')
    const position = next<{ x: number; y: number }>(client, 'cursorPosition')
    const leds = next<{ capsLock: boolean; numLock: boolean }>(client, 'ledState')
    const updated = client.nextUpdate()
    peer.write(
      fbUpdate(
        7,
        rectHeader(0, 0, 0, 0, E.pseudoDesktopName),
        str('renamed ✓'),
        rectHeader(1, 0, 2, 1, E.pseudoCursor),
        Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]),
        u8(0b10000000),
        rectHeader(3, 4, 0, 0, E.pseudoVMwareCursorPosition),
        rectHeader(0, 0, 0, 0, E.pseudoQemuLedState),
        u8(0b110),
        rectHeader(0, 0, 0, 0, E.pseudoQemuExtendedKeyEvent),
        rectHeader(0, 0, 0, 0, E.pseudoQemuPointerMotionChange),
        rectHeader(0, 0, 0, 0, E.pseudoExtendedMouseButtons),
      ),
    )
    await updated
    assert.equal(await name, 'renamed ✓')
    assert.equal(client.name, 'renamed ✓')
    const c = await cursor
    assert.equal(c.x, 1)
    assert.deepEqual([...c.rgba], [255, 0, 0, 255, 0, 0, 255, 0])
    assert.equal(client.cursor, c)
    assert.deepEqual(await position, { x: 3, y: 4 })
    assert.deepEqual(await leds, { scrollLock: false, numLock: true, capsLock: true })
    assert.equal(client.supports.qemuExtendedKeyEvent, true)
    assert.equal(client.pointerMode, 'relative')
    assert.equal(client.supports.extendedMouseButtons, true)

    client.qemuKeyEvent(0x61, 0x1e, true)
    assert.deepEqual([...(await peer.read(12))], [255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 0x1e])
    client.pointerEvent(1, 2, 0x100 | buttons.left)
    assert.deepEqual([...(await peer.read(7))], [5, 0x81, 0, 1, 0, 2, 2])
    client.destroy()
  })

  test('colour map, bell, Latin-1 clipboard', async () => {
    const { client, peer } = await connected()
    const colormap = next<{ firstColor: number }>(client, 'colormap')
    const bell = next(client, 'bell')
    const clipboard = next<string>(client, 'clipboard')
    peer.write(u8(1, 0), u16(5), u16(1), u16(0xffff), u16(0x8000), u16(0))
    peer.write(u8(2))
    peer.write(u8(3, 0, 0, 0), u32(3), Buffer.from('caf\xe9', 'latin1').subarray(0, 3))
    assert.equal((await colormap).firstColor, 5)
    assert.deepEqual(client.colorMap[5], { r: 0xffff, g: 0x8000, b: 0 })
    await bell
    assert.equal(await clipboard, 'caf')
    client.destroy()
  })

  test('fences: server requests are answered, client fences after support', async () => {
    const { client, peer } = await connected()
    assert.throws(
      () => client.fence(0),
      (err: RfbError) => err.code === 'UNSUPPORTED_BY_SERVER',
    )
    peer.write(u8(248, 0, 0, 0), u32(0x80000000 | 0b111 | 0x100), u8(2), u8(9, 8))
    assert.deepEqual([...(await peer.read(11))], [248, 0, 0, 0, 0, 0, 0, 7, 2, 9, 8])
    assert.equal(client.supports.fence, true)
    client.fence(1, Buffer.from([5]))
    assert.deepEqual([...(await peer.read(10))], [248, 0, 0, 0, 0x80, 0, 0, 1, 1, 5])
    const fence = next<{ flags: number }>(client, 'fence')
    peer.write(u8(248, 0, 0, 0), u32(1), u8(1, 5))
    assert.equal((await fence).flags, 1)
    client.destroy()
  })

  test('xvp, continuous updates and QEMU audio', async () => {
    const { client, peer } = await connected({}, { width: 10, height: 10 })
    const xvp = next(client, 'xvp')
    peer.write(u8(250, 0, 1, 1))
    await xvp
    assert.equal(client.supports.xvp, 1)
    client.xvp('reboot')
    assert.deepEqual([...(await peer.read(4))], [250, 0, 1, 3])

    const eocu = next(client, 'endOfContinuousUpdates')
    peer.write(u8(150))
    await eocu
    client.enableContinuousUpdates()
    assert.deepEqual([...(await peer.read(10))], [150, 1, 0, 0, 0, 0, 0, 10, 0, 10])

    const updated = client.nextUpdate()
    peer.write(fbUpdate(1, rectHeader(0, 0, 0, 0, E.pseudoQemuAudio)))
    await updated
    client.enableAudio({ channels: 1, frequency: 8000 })
    assert.deepEqual([...(await peer.read(10))], [255, 1, 0, 2, 3, 1, 0, 0, 0x1f, 0x40])
    assert.deepEqual([...(await peer.read(4))], [255, 1, 0, 0])
    const audio: unknown[] = []
    client.on('audio', (e) => audio.push(e))
    peer.write(u8(255, 1), u16(1), u8(255, 1), u16(2), u32(2), u8(7, 8), u8(255, 1), u16(0))
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(audio, [{ type: 'start' }, { type: 'data', data: Buffer.from([7, 8]) }, { type: 'stop' }])
    client.destroy()
  })

  test('Extended Clipboard: caps, notify → request → provide, and sending', async () => {
    const { client, peer } = await connected()
    // Server caps: text up to 1000 bytes; accepts request/peek/notify/provide.
    const caps = (1 << 24) | 1 | (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28)
    peer.write(u8(3, 0, 0, 0), s32(-8), u32(caps), u32(1000))
    const reply = await peer.read(16)
    assert.equal(reply.readInt32BE(4), -8)
    assert.equal(reply.readUInt32BE(8), caps >>> 0)
    assert.equal(client.supports.extendedClipboard, true)

    peer.write(u8(3, 0, 0, 0), s32(-4), u32((1 << 27) | 1)) // notify: text available
    assert.deepEqual([...(await peer.read(12))], [6, 0, 0, 0, 0xff, 0xff, 0xff, 0xfc, 2, 0, 0, 1]) // request text
    const text = Buffer.from('héllo\r\nwörld ☃\0')
    const body = zlib.deflateSync(Buffer.concat([u32(text.length), text]))
    const clipboard = next<string>(client, 'clipboard')
    peer.write(u8(3, 0, 0, 0), s32(-(4 + body.length)), u32((1 << 28) | 1), body)
    assert.equal(await clipboard, 'héllo\nwörld ☃')

    client.updateClipboard('ok ✓\nline')
    const head = await peer.read(8)
    const payload = await peer.read(-head.readInt32BE(4))
    assert.equal(payload.readUInt32BE(0), ((1 << 28) | 1) >>> 0)
    const sent = zlib.inflateSync(payload.subarray(4))
    assert.equal(sent.subarray(4, 4 + sent.readUInt32BE(0)).toString(), 'ok ✓\r\nline\0')
    client.destroy()
  })

  test('without the Extended Clipboard, text goes as Latin-1', async () => {
    const { client, peer } = await connected()
    client.updateClipboard('café ☃')
    assert.deepEqual([...(await peer.read(14))], [6, 0, 0, 0, 0, 0, 0, 6, 0x63, 0x61, 0x66, 0xe9, 0x20, 0x3f])
    client.destroy()
  })

  test('input messages', async () => {
    const { client, peer } = await connected()
    client.pointerEvent(300, 2, buttons.left | buttons.right)
    client.keyEvent(0xffe1, true)
    client.keyEvent(0xffe1, 0)
    client.requestUpdate(true, 1, 2, 3, 4)
    assert.deepEqual([...(await peer.read(6))], [5, 5, 1, 44, 0, 2])
    assert.deepEqual([...(await peer.read(8))], [4, 1, 0, 0, 0, 0, 0xff, 0xe1])
    assert.deepEqual([...(await peer.read(8))], [4, 0, 0, 0, 0, 0, 0xff, 0xe1])
    assert.deepEqual([...(await peer.read(10))], [3, 1, 0, 1, 0, 2, 0, 3, 0, 4])
    assert.throws(
      () => client.pointerEvent(-1, 0),
      (err: RfbError) => err.code === 'INVALID_ARGUMENT',
    )
    client.destroy()
  })
})

describe('Extended Clipboard state', () => {
  const CLIP = {
    text: 1,
    dib: 1 << 3,
    caps: 1 << 24,
    request: 1 << 25,
    peek: 1 << 26,
    notify: 1 << 27,
    provide: 1 << 28,
  }
  const ALL = CLIP.text | CLIP.request | CLIP.peek | CLIP.notify | CLIP.provide

  /** A ServerCutText in the Extended Clipboard format (negative length). */
  const ext = (flags: number, data: Buffer = Buffer.alloc(0)) =>
    Buffer.concat([u8(3, 0, 0, 0), s32(-(4 + data.length)), u32(flags), data])
  /** A provide: size and data for each format, zlib-compressed. */
  const provide = (formats: number, ...values: Buffer[]) =>
    ext(CLIP.provide | formats, zlib.deflateSync(Buffer.concat(values.flatMap((v) => [u32(v.length), v]))))
  const text = (s: string) => Buffer.from(`${s}\0`)

  /** The client's next Extended Clipboard message. */
  async function readExt(peer: Peer): Promise<{ flags: number; data: Buffer }> {
    const head = await peer.read(8)
    assert.equal(head[0], 6, 'ClientCutText')
    assert.ok(head.readInt32BE(4) < 0, 'in the Extended Clipboard format')
    const body = await peer.read(-head.readInt32BE(4))
    return { flags: body.readUInt32BE(0), data: body.subarray(4) }
  }

  /** A client that got TigerVNC's caps (text, every action, 0 bytes unasked) and answered them. */
  async function withCaps() {
    const { client, peer } = await connected()
    peer.write(ext(CLIP.caps | ALL, u32(0)))
    assert.ok((await readExt(peer)).flags & CLIP.caps)
    const events: (string | null)[] = []
    client.on('clipboard', (t) => events.push(t))
    client.on('clipboardEmpty', () => events.push(null))
    /** Resolves once the client has handled what the server sent so far (a Bell behind it). */
    const sync = async () => {
      const bell = next(client, 'bell')
      peer.write(u8(2))
      await bell
    }
    return { client, peer, events, sync }
  }

  test('a notify or provide without text is clipboardEmpty (#36)', async () => {
    const { client, peer, events, sync } = await withCaps()
    peer.write(ext(CLIP.notify)) // emptied, or an image was copied
    peer.write(ext(CLIP.provide, zlib.deflateSync(Buffer.alloc(0)))) // no formats at all
    peer.write(provide(CLIP.dib, Buffer.from('BM'))) // an image only
    await sync()
    assert.deepEqual(events, [null, null, null])
    assert.equal(peer.reader.available, 0, 'no request without text')
    client.destroy()
  })

  test("TigerVNC's notify without text after the client's own change is no change", async () => {
    const { client, peer, events, sync } = await withCaps()
    peer.write(provide(CLIP.text, text('server text'))) // an X client copied text
    await sync()
    client.updateClipboard('client text')
    assert.equal((await readExt(peer)).flags, (CLIP.notify | CLIP.text) >>> 0)
    // Xvnc takes the selection: it asks the owner for the text to cache it, then tells every client
    // that its own text is gone.
    peer.write(ext(CLIP.request | CLIP.text), ext(CLIP.notify))
    assert.equal((await readExt(peer)).flags, (CLIP.provide | CLIP.text) >>> 0)
    await sync()
    assert.deepEqual(events, ['server text'])
    // The client still holds the clipboard.
    peer.write(ext(CLIP.request | CLIP.text))
    const answer = await readExt(peer)
    assert.equal(answer.flags, (CLIP.provide | CLIP.text) >>> 0)
    assert.equal(zlib.inflateSync(answer.data).subarray(4).toString(), 'client text\0')
    // Another change replaces nothing of the server's, so a notify without text after it is a change.
    client.updateClipboard('again')
    await readExt(peer)
    peer.write(ext(CLIP.notify))
    await sync()
    assert.deepEqual(events, ['server text', null])
    client.destroy()
  })

  test('right after connecting the server may hold text it never announced, so its notify is expected', async () => {
    const { client, peer, events, sync } = await withCaps()
    client.updateClipboard('client text')
    await readExt(peer)
    peer.write(ext(CLIP.notify))
    await sync()
    assert.deepEqual(events, [])
    client.destroy()
  })

  test('a notify without text is a change when the server had no text, or reported newer text', async () => {
    const { client, peer, events, sync } = await withCaps()
    peer.write(ext(CLIP.notify)) // the server's clipboard holds no text
    await sync()
    client.updateClipboard('one')
    await readExt(peer)
    peer.write(ext(CLIP.notify))
    await sync()
    assert.deepEqual(events, [null, null])

    peer.write(provide(CLIP.text, text('server text')))
    await sync()
    client.updateClipboard('two') // replaces the server's text: a notify is due...
    await readExt(peer)
    peer.write(provide(CLIP.text, text('newer'))) // ...but the server reports newer text first
    peer.write(ext(CLIP.notify))
    await sync()
    assert.deepEqual(events, [null, null, 'server text', 'newer', null])
    client.destroy()
  })

  for (const [name, change] of [
    ['a notify with text', ext(CLIP.notify | CLIP.text)],
    ['a provide', provide(CLIP.text, text('server text'))],
    ['a provide without text', provide(CLIP.dib, Buffer.from('BM'))],
    ['a plain ServerCutText', Buffer.concat([u8(3, 0, 0, 0), u32(6), Buffer.from('server')])],
  ] as const) {
    test(`after ${name} the client no longer holds the clipboard (#37)`, async () => {
      const { client, peer, sync } = await withCaps()
      client.updateClipboard('client text')
      await readExt(peer)
      peer.write(ext(CLIP.peek))
      assert.equal((await readExt(peer)).flags, (CLIP.notify | CLIP.text) >>> 0, 'holds text before')

      peer.write(change)
      if (name === 'a notify with text') {
        assert.equal((await readExt(peer)).flags, (CLIP.request | CLIP.text) >>> 0, 'asks for the new text')
      }
      // A request gets no provide, and a peek says the client holds nothing.
      peer.write(ext(CLIP.request | CLIP.text), ext(CLIP.peek))
      assert.equal((await readExt(peer)).flags, CLIP.notify)
      await sync()
      assert.equal(peer.reader.available, 0)
      client.destroy()
    })
  }

  test('supports.unicodeClipboard: text and the notify action; otherwise text may go as Latin-1 (#37)', async () => {
    const { client, peer } = await connected()
    assert.equal(client.supports.unicodeClipboard, false)
    const latin1 = async () => {
      const head = await peer.read(8)
      assert.equal(head[0], 6)
      return (await peer.read(head.readInt32BE(4))).toString('latin1')
    }

    // Text without notify, 20 bytes unasked: short text goes as UTF-8, longer as Latin-1.
    peer.write(ext(CLIP.caps | CLIP.text | CLIP.request | CLIP.provide, u32(20)))
    await readExt(peer)
    assert.equal(client.supports.extendedClipboard, true)
    assert.equal(client.supports.unicodeClipboard, false)
    client.updateClipboard('short ☃')
    assert.equal((await readExt(peer)).flags, (CLIP.provide | CLIP.text) >>> 0)
    client.updateClipboard('a longer text, ☃ and all')
    assert.equal(await latin1(), 'a longer text, ? and all')

    // Servers send caps again on every SetEncodings.
    peer.write(ext(CLIP.caps | ALL, u32(0)))
    await readExt(peer)
    assert.equal(client.supports.unicodeClipboard, true)
    client.updateClipboard('a longer text, ☃ and all')
    assert.equal((await readExt(peer)).flags, (CLIP.notify | CLIP.text) >>> 0)

    // No text format: no text through the Extended Clipboard at all.
    peer.write(ext(CLIP.caps | CLIP.dib | CLIP.notify | CLIP.provide, u32(1000)))
    await readExt(peer)
    assert.equal(client.supports.extendedClipboard, true)
    assert.equal(client.supports.unicodeClipboard, false)
    client.updateClipboard('☃')
    assert.equal(await latin1(), '?')
    client.destroy()
  })
})

describe('closing and errors', () => {
  test('a clean close by the server is not an error', async () => {
    const { client, peer } = await connected()
    const events: string[] = []
    client.on('error', (e) => events.push(`error ${e.code}`))
    client.on('close', (hadError) => events.push(`close ${hadError}`))
    peer.end()
    await once(client, 'close')
    assert.deepEqual(events, ['close false'])
    assert.equal(client.closed, true)
    client.keyEvent(1, true) // ignored after close
    await rejectsWith(client.nextUpdate(), 'CONNECTION_CLOSED')
  })

  test('a close in the middle of a message is an error', async () => {
    const { client, peer } = await connected()
    const events: string[] = []
    client.on('error', (e) => events.push(`error ${e.code}`))
    client.on('close', (hadError) => events.push(`close ${hadError}`))
    const closed = new Promise((resolve) => client.once('close', resolve))
    peer.write(u8(0, 0), u16(1), rectHeader(0, 0, 10, 10, E.raw), Buffer.alloc(10))
    peer.end()
    await closed
    assert.deepEqual(events, ['error CONNECTION_CLOSED', 'close true'])
  })

  test('an unknown server message fails the connection', async () => {
    const { client, peer } = await connected()
    const error = next<RfbError>(client, 'error')
    peer.write(u8(77))
    const err = await error
    assert.equal(err.code, 'UNSUPPORTED_MESSAGE')
    assert.match(err.message, /message type 77/)
  })

  test('an unknown encoding fails the connection', async () => {
    const { client, peer } = await connected()
    const error = next<RfbError>(client, 'error')
    peer.write(fbUpdate(1, rectHeader(0, 0, 1, 1, 99)))
    assert.equal((await error).code, 'UNSUPPORTED_ENCODING')
  })

  test('close() resolves once closed, and end() is the 0.x way', async () => {
    const { client, peer } = await connected()
    const closing = client.close()
    await peer.ended()
    peer.end()
    await closing
    assert.equal(client.closed, true)
    await client.close()
  })
})

describe('0.x compatibility', () => {
  test('createConnection, connect event, rect.data, pixel format fields', async () => {
    const { clientStream, peer } = pair()
    const r = createConnection({ stream: clientStream, encodings: [E.raw, E.copyRect, E.pseudoDesktopSize] })
    const server = acceptNone(peer, 2, 1, 'old api')
    await once(r, 'connect')
    await server
    assert.deepEqual((await readSetup(peer)).encodings, [0, 1, -223])
    assert.equal(r.title, 'old api')
    assert.equal(r.width, 2)
    assert.equal(r.isBigEndian, 0)
    assert.equal(r.isTrueColor, 1)
    assert.equal(r.redShift, 16)
    const rect = next<Rect>(r, 'rect')
    peer.write(fbUpdate(1, rectHeader(0, 0, 2, 1, E.raw), Buffer.alloc(8, 1)))
    const got = await rect
    assert.equal(got.encoding, E.raw)
    assert.ok(got.type === 'pixels' && got.data.length === 8)
    r.requestUpdate(false, 0, 0, r.width, r.height)
    assert.deepEqual([...(await peer.read(10))], [3, 0, 0, 0, 0, 0, 0, 2, 0, 1])
    r.end()
  })
})
