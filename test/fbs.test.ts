import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { connect, createServer, pixelFormats, type Rect, recordFbs, replayFbs } from '../src/index.ts'

test('a recorded session replays the same rects', async () => {
  const server = createServer({ width: 4, height: 2, name: 'recorded', password: 'pw' }, (conn) => {
    conn.on('updateRequest', () => {
      conn.sendUpdate([
        { type: 'pixels', x: 0, y: 0, width: 4, height: 2, data: Buffer.alloc(32, 7) },
        { type: 'copy', x: 0, y: 1, width: 2, height: 1, src: { x: 2, y: 0 } },
      ])
      conn.bell()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo

  const socket = net.connect({ host: '127.0.0.1', port })
  const recording = new PassThrough()
  const chunks: Buffer[] = []
  recording.on('data', (c: Buffer) => chunks.push(c))
  recordFbs(socket, recording)
  const live = await connect({ stream: socket, password: 'pw', pixelFormat: pixelFormats.rgb565 })
  const liveRects: Rect[] = []
  live.on('rect', (r) => liveRects.push(r))
  await live.nextUpdate()
  await once(live, 'bell')
  await live.close()
  await once(recording, 'end')
  server.close()

  const file = Buffer.concat(chunks)
  assert.equal(file.subarray(0, 12).toString(), 'FBS 001.000\n')
  const replay = await connect({ stream: replayFbs(file), password: 'anything', pixelFormat: pixelFormats.rgb565 })
  assert.equal(replay.name, 'recorded')
  const replayRects: Rect[] = []
  replay.on('rect', (r) => replayRects.push(r))
  await once(replay, 'close')
  assert.deepEqual(replayRects, liveRects)
})

test('replayFbs refuses something that is not FBS', async () => {
  const client = connect({ stream: replayFbs(Buffer.from('RFB 003.008\n')) })
  await assert.rejects(client)
})
