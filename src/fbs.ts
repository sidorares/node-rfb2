import { Duplex, type Readable, type Writable } from 'node:stream'
import { protocolError } from './errors.ts'
import { ByteReader } from './reader.ts'

// FBS ("framebuffer stream", rfbproxy/vncrec) recordings: "FBS 001.000\n", then for every chunk the
// server sent: U32 length, the bytes padded to a multiple of 4, U32 milliseconds since the start.

const HEADER = 'FBS 001.000\n'

/**
 * Records everything `source` receives from the server into `out` as FBS. Call it before passing
 * `source` to the client (`connect({ stream: source })`); `out` is ended when `source` ends.
 */
export function recordFbs(source: Readable, out: Writable): void {
  const start = Date.now()
  out.write(HEADER)
  source.on('data', (chunk: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(chunk.length)
    const tail = Buffer.alloc(((4 - (chunk.length % 4)) % 4) + 4)
    tail.writeUInt32BE(Date.now() - start, tail.length - 4)
    out.write(Buffer.concat([head, chunk, tail]))
  })
  source.once('close', () => out.end())
}

export interface FbsReplayOptions {
  /** Playback speed: 1 is real time, 0 (default) as fast as possible. */
  speed?: number
}

/**
 * A stream that plays an FBS recording back as if it came from the server; what the client writes
 * is discarded. Use it as `connect({ stream: replayFbs(file) })` with the same pixel format and
 * encodings as when recording (the recorded server answered those), and any password.
 */
export function replayFbs(recording: Readable | Buffer, options: FbsReplayOptions = {}): Duplex {
  const speed = options.speed ?? 0
  const reader = new ByteReader()
  let wake: (() => void) | null = null
  let flowing = false
  const duplex = new Duplex({
    read() {
      flowing = true
      wake?.()
    },
    write(_chunk, _encoding, callback) {
      callback()
    },
    final(callback) {
      callback()
    },
  })
  const waitForDemand = () =>
    flowing
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          wake = resolve
        })

  if (Buffer.isBuffer(recording)) {
    reader.push(recording)
    reader.destroy(new Error('end of recording'))
  } else {
    recording.on('data', (chunk: Buffer) => reader.push(chunk))
    recording.once('end', () => reader.destroy(new Error('end of recording')))
    recording.once('error', (err) => reader.destroy(err))
  }

  void (async () => {
    const header = (await reader.read(12)).toString('latin1')
    if (!/^FBS 001\.00[01]\n$/.test(header)) throw protocolError(`not an FBS recording (${JSON.stringify(header)})`)
    const start = Date.now()
    for (;;) {
      if (reader.available === 0 && reader.destroyed) break
      let length: number
      try {
        length = await reader.u32()
      } catch {
        break
      }
      const data = Buffer.from(await reader.read(length))
      await reader.skip((4 - (length % 4)) % 4)
      const timestamp = await reader.u32()
      if (speed > 0) {
        const due = start + timestamp / speed - Date.now()
        if (due > 0) await new Promise((resolve) => setTimeout(resolve, due))
      }
      await waitForDemand()
      flowing = duplex.push(data)
    }
    duplex.push(null)
  })().catch((err: unknown) => duplex.destroy(err as Error))
  return duplex
}
