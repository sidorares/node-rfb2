// Pseudo-encodings and extensions against real servers.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import jpeg from 'jpeg-js'
import {
  type CursorRect,
  connect,
  defaultEncodings,
  encodings as E,
  fenceFlags,
  jpegQuality,
  type RfbClient,
} from '../../src/index.ts'
import { grab, grabFrame, HOST, meanDifference, needServer } from './harness.ts'
import { PASSWORD, qemu, tigervncVnc, turbovnc, x11vnc } from './servers.ts'

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms)),
  ])

const event = <T>(client: RfbClient, name: string, ms = 5000): Promise<T> =>
  within(new Promise<T>((resolve) => client.once(name as 'bell', resolve as () => void)), ms, name)

/** Resolves with the first `name` event whose value passes `accept`. */
const eventWhere = <T>(client: RfbClient, name: string, accept: (value: T) => boolean, ms = 5000): Promise<T> =>
  within(
    new Promise<T>((resolve) => {
      const listener = (value: T) => {
        if (!accept(value)) return
        client.off(name as 'bell', listener as () => void)
        resolve(value)
      }
      client.on(name as 'bell', listener as () => void)
    }),
    ms,
    name,
  )

/** Waits until `condition()` holds (checked every 20 ms). */
async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`no ${what} within ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('cursor shapes', () => {
  const cases: [string, number, number][] = [
    ['TigerVNC Cursor', tigervncVnc.port, E.pseudoCursor],
    ['TigerVNC CursorWithAlpha', tigervncVnc.port, E.pseudoCursorWithAlpha],
    ['TigerVNC VMware cursor', tigervncVnc.port, E.pseudoVMwareCursor],
    ['x11vnc Cursor', x11vnc.port, E.pseudoCursor],
    ['x11vnc XCursor', x11vnc.port, E.pseudoXCursor],
  ]
  for (const [name, port, encoding] of cases) {
    test(name, async (t) => {
      if (!(await needServer(t, port, name))) return
      const client = await connect({
        host: HOST,
        port,
        password: PASSWORD,
        encodings: [E.zrle, E.raw, encoding],
        autoUpdate: true,
      })
      try {
        // TigerVNC draws the pointer itself (and sends an empty cursor) until this client moves it
        // (its rule: the pointer is where this client last put it), so move it first.
        const cursorShape = eventWhere<CursorRect>(client, 'cursor', (c) => c.width > 0)
        // Xvnc notices moves once per main-loop cycle: two moves apart in time always register.
        client.pointerEvent(480, 380, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
        client.pointerEvent(500, 400, 0)
        const cursor = await cursorShape
        assert.equal(cursor.encoding, encoding)
        assert.equal(cursor.rgba.length, cursor.width * cursor.height * 4)
        assert.ok(cursor.height > 0, 'a visible cursor')
        assert.ok(
          cursor.rgba.some((v, i) => i % 4 === 3 && v === 255),
          'with opaque pixels',
        )
        assert.ok(cursor.x < cursor.width && cursor.y < cursor.height, 'the hotspot is inside the cursor')
      } finally {
        await client.close()
      }
    })
  }
})

describe('TigerVNC extensions', () => {
  test('ExtendedDesktopSize: the screen layout, and resizing', async (t) => {
    if (!(await needServer(t, tigervncVnc.port, tigervncVnc.name))) return
    const { client } = await grab(tigervncVnc.port, { password: PASSWORD })
    try {
      assert.equal(client.supports.extendedDesktopSize, true)
      assert.equal(client.screens.length, 1)
      const resized = event<{ width: number; height: number }>(client, 'resize')
      client.autoUpdate = true
      client.requestUpdate(true)
      await client.setDesktopSize(800, 600)
      assert.deepEqual(await resized, { width: 800, height: 600, screens: client.screens })
      assert.equal(client.width, 800)
      await client.setDesktopSize(1000, 750)
      assert.equal(client.width, 1000)
    } finally {
      await client.close()
    }
  })

  test('Extended Clipboard: UTF-8 text from one client to another', async (t) => {
    if (!(await needServer(t, tigervncVnc.port, tigervncVnc.name))) return
    const a = await connect({ host: HOST, port: tigervncVnc.port, password: PASSWORD })
    const b = await connect({ host: HOST, port: tigervncVnc.port, password: PASSWORD })
    try {
      await until(() => a.supports.extendedClipboard && b.supports.extendedClipboard, 5000, 'clipboard capabilities')
      const text = `héllo ☃ 世界 ${Date.now()}\nsecond line`
      const received = event<string>(b, 'clipboard')
      a.updateClipboard(text)
      assert.equal(await received, text)
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  for (const server of [tigervncVnc, turbovnc]) {
    test(`Extended Clipboard, ${server.name}: no clipboardEmpty for a client's own change`, async (t) => {
      if (!(await needServer(t, server.port, server.name))) return
      const options = { host: HOST, port: server.port, password: server.password }
      const a = await connect(options)
      const b = await connect(options)
      try {
        await until(() => a.supports.unicodeClipboard && b.supports.unicodeClipboard, 5000, 'clipboard capabilities')
        // The server's clipboard gets text of its own: rfb2-clipboard (docker/src) takes over what a sets.
        const first = `first ${Date.now()}`
        const seen = Promise.all([a, b].map((c) => eventWhere<string>(c, 'clipboard', (text) => text === first)))
        a.updateClipboard(first)
        await seen
        await new Promise((resolve) => setTimeout(resolve, 500)) // the X selections settle
        const empty = { a: 0, b: 0 }
        a.on('clipboardEmpty', () => empty.a++)
        b.on('clipboardEmpty', () => empty.b++)
        // a replaces it: the server tells every client that its text is gone, then announces a's text.
        const second = `second ${Date.now()}`
        const both = Promise.all([a, b].map((c) => eventWhere<string>(c, 'clipboard', (text) => text === second)))
        a.updateClipboard(second)
        await both
        assert.deepEqual(empty, { a: 0, b: 1 })
      } finally {
        await Promise.all([a.close(), b.close()])
      }
    })
  }

  test('Latin-1 clipboard for a client without the Extended Clipboard', async (t) => {
    if (!(await needServer(t, tigervncVnc.port, tigervncVnc.name))) return
    const encodings = defaultEncodings.filter((e) => e !== E.pseudoExtendedClipboard)
    const a = await connect({ host: HOST, port: tigervncVnc.port, password: PASSWORD, encodings })
    const b = await connect({ host: HOST, port: tigervncVnc.port, password: PASSWORD, encodings })
    try {
      // Let both finish their setup (the first update) before the clipboard changes.
      for (const c of [a, b]) {
        const update = c.nextUpdate()
        c.requestUpdate(false)
        await within(update, 5000, 'update')
      }
      const received = event<string>(b, 'clipboard')
      a.updateClipboard(`café ${Date.now()}`)
      assert.match(await received, /^café \d+$/)
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  test('fences and continuous updates', async (t) => {
    if (!(await needServer(t, tigervncVnc.port, tigervncVnc.name))) return
    const { client } = await grab(tigervncVnc.port, { password: PASSWORD })
    try {
      assert.equal(client.supports.fence, true)
      const fence = event<{ flags: number; payload: Buffer }>(client, 'fence')
      client.fence(fenceFlags.blockBefore, Buffer.from('sync'))
      const answer = await fence
      assert.equal(answer.payload.toString(), 'sync')
      assert.equal(answer.flags & fenceFlags.request, 0)

      assert.equal(client.supports.continuousUpdates, true)
      client.enableContinuousUpdates(true)
      // Moving the pointer makes the server draw it: updates arrive without requests.
      const update = client.nextUpdate()
      client.pointerEvent(10, 10, 0)
      client.pointerEvent(200, 150, 0)
      await within(update, 5000, 'continuous update')
      const ended = event(client, 'endOfContinuousUpdates')
      client.enableContinuousUpdates(false)
      await ended
    } finally {
      await client.close()
    }
  })
})

describe('QEMU extensions', () => {
  test('extended key events, audio, LED state and pointer mode', async (t) => {
    if (!(await needServer(t, qemu.port, qemu.name))) return
    const client = await connect({
      host: HOST,
      port: qemu.port,
      encodings: [...defaultEncodings, E.pseudoQemuPointerMotionChange],
    })
    try {
      // QEMU confirms each extension in a small update of its own.
      await until(() => client.supports.qemuExtendedKeyEvent && client.supports.qemuAudio, 5000, 'QEMU extensions')
      await until(() => client.screens.length > 0, 5000, 'screen layout')
      // Shift via its scancode; QEMU accepts it without a keymap.
      client.qemuKeyEvent(0xffe1, 0x2a, true)
      client.qemuKeyEvent(0xffe1, 0x2a, false)
      client.enableAudio()
      client.disableAudio()
      assert.ok(['absolute', 'relative'].includes(client.pointerMode))
      const update = client.nextUpdate()
      client.requestUpdate(false)
      await within(update, 5000, 'update')
    } finally {
      await client.close()
    }
  })
})

describe('Tight JPEG (TurboVNC)', () => {
  test('lossy rects decode close to the lossless frame', async (t) => {
    if (!(await needServer(t, turbovnc.port, turbovnc.name))) return
    const lossless = await grabFrame(turbovnc.port, { encodings: [E.raw] })
    const lossy = await grabFrame(turbovnc.port, {
      encodings: [E.tight, jpegQuality(9)],
      decodeJpeg: (data) => jpeg.decode(data, { useTArray: true }).data,
    })
    assert.ok(lossy.used.has(E.tight))
    const difference = meanDifference(lossy.fb, lossless.fb)
    assert.ok(difference < 4, `mean difference ${difference.toFixed(2)} per channel`)
  })

  test('without a decoder, JPEG rects are handed over as they are', async (t) => {
    if (!(await needServer(t, turbovnc.port, turbovnc.name))) return
    const client = await connect({ host: HOST, port: turbovnc.port, encodings: [E.tight, jpegQuality(5)] })
    try {
      let jpegRects = 0
      client.on('rect', (r) => {
        if (r.type === 'jpeg') {
          jpegRects++
          assert.deepEqual([...r.jpeg.subarray(0, 2)], [0xff, 0xd8], 'a JPEG starts with SOI')
        }
      })
      await client.nextUpdate()
      assert.ok(jpegRects > 0, 'the test card has photo-like areas TurboVNC sends as JPEG')
    } finally {
      await client.close()
    }
  })
})
