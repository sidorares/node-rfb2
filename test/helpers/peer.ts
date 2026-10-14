// A scripted RFB server for tests: the other end of an in-memory duplex pair, read with the same
// ByteReader the client uses, written byte by byte so tests state the exact wire format.

import { once } from 'node:events'
import { type Duplex, duplexPair } from 'node:stream'
import { type ConnectOptions, connect, type RfbClient } from '../../src/client.ts'
import { type PixelFormat, pixelFormats, writePixelFormat } from '../../src/pixel-format.ts'
import { ByteReader } from '../../src/reader.ts'
import type { Cipher } from '../../src/transport.ts'

export const u8 = (...v: number[]) => Buffer.from(v)
export const u16 = (v: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(v)
  return b
}
export const u32 = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0)
  return b
}
export const s32 = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(v | 0)
  return b
}
export const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)])
export const rectHeader = (x: number, y: number, w: number, h: number, encoding: number) =>
  Buffer.concat([u16(x), u16(y), u16(w), u16(h), s32(encoding)])

export class Peer {
  reader = new ByteReader()
  stream: Duplex
  /** Encrypts what the peer writes and decrypts what it reads (RSA-AES tests). */
  cipher: Cipher | null = null

  constructor(stream: Duplex) {
    this.stream = stream
    this.#attach(stream)
  }

  #onData = (chunk: Buffer) => {
    if (this.cipher) this.cipher.decrypt(chunk, (plain) => this.reader.push(plain))
    else this.reader.push(chunk)
  }
  #onEnd = () => this.reader.destroy(new Error('peer: the client closed the connection'))
  #onError = (err: Error) => this.reader.destroy(err)

  #attach(stream: Duplex): void {
    stream.on('data', this.#onData)
    stream.on('end', this.#onEnd)
    stream.on('error', this.#onError)
  }

  /** Stops reading the current stream (before wrapping it in TLS). */
  detach(): Duplex {
    this.stream.off('data', this.#onData)
    this.stream.off('end', this.#onEnd)
    this.stream.off('error', this.#onError)
    return this.stream
  }

  /** Continues on a new stream (the TLS socket). */
  replace(stream: Duplex): void {
    this.stream = stream
    this.reader = new ByteReader()
    this.#attach(stream)
  }

  write(...parts: (Buffer | string)[]): void {
    const data = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)))
    this.stream.write(this.cipher ? this.cipher.encrypt(data) : data)
  }

  read(n: number): Promise<Buffer> {
    return this.reader.read(n)
  }

  async string(n: number): Promise<string> {
    return (await this.reader.read(n)).toString('latin1')
  }

  u8(): Promise<number> {
    return this.reader.u8()
  }

  u32(): Promise<number> {
    return this.reader.u32()
  }

  end(): void {
    this.stream.end()
  }

  /** Resolves when the client closes its end. */
  async ended(): Promise<void> {
    if (this.stream.readableEnded) return
    this.stream.resume()
    await once(this.stream, 'end')
  }
}

/** A client (constructed with `options`) connected to a Peer. */
export function pair(): { clientStream: Duplex; peer: Peer } {
  const [a, b] = duplexPair()
  return { clientStream: a, peer: new Peer(b) }
}

export function serverInit(width: number, height: number, name: string, pf: PixelFormat = pixelFormats.bgrx): Buffer {
  const b = Buffer.alloc(20)
  b.writeUInt16BE(width, 0)
  b.writeUInt16BE(height, 2)
  writePixelFormat(pf, b, 4)
  return Buffer.concat([b, str(name)])
}

/** Runs the server side of a 3.8 handshake with security None. */
export async function acceptNone(peer: Peer, width = 100, height = 80, name = 'test'): Promise<void> {
  peer.write('RFB 003.008\n')
  await peer.string(12)
  peer.write(u8(1, 1))
  await peer.u8()
  peer.write(u32(0))
  await peer.u8() // ClientInit
  peer.write(serverInit(width, height, name))
}

/** Reads the messages a client sends right after ServerInit: SetPixelFormat, SetEncodings, the first update request. */
export async function readSetup(peer: Peer, initialUpdate = true): Promise<{ encodings: number[] }> {
  const spf = await peer.read(20)
  if (spf[0] !== 0) throw new Error(`expected SetPixelFormat, got message ${spf[0]}`)
  const head = await peer.read(4)
  if (head[0] !== 2) throw new Error(`expected SetEncodings, got message ${head[0]}`)
  const data = await peer.read(4 * head.readUInt16BE(2))
  const encodings = Array.from({ length: head.readUInt16BE(2) }, (_, i) => data.readInt32BE(4 * i))
  if (initialUpdate) {
    const req = await peer.read(10)
    if (req[0] !== 3) throw new Error(`expected FramebufferUpdateRequest, got message ${req[0]}`)
  }
  return { encodings }
}

/** A client connected to a Peer through the 3.8/None handshake and its setup messages. */
export async function connected(
  options: ConnectOptions = {},
  size: { width: number; height: number } = { width: 100, height: 80 },
): Promise<{ client: RfbClient; peer: Peer }> {
  const { clientStream, peer } = pair()
  const server = acceptNone(peer, size.width, size.height)
  const client = await connect({ stream: clientStream, ...options })
  await server
  await readSetup(peer, options.initialUpdate !== false)
  return { client, peer }
}

/** Resolves with the next `event` of `emitter`'s, or rejects after `ms`. */
export async function next<T>(emitter: NodeJS.EventEmitter, event: string, ms = 2000): Promise<T> {
  const [value] = (await once(emitter, event, { signal: AbortSignal.timeout(ms) })) as [T]
  return value
}
