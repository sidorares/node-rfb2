import { protocolError } from './errors.ts'

const EMPTY = Buffer.alloc(0)

/**
 * Collects the chunks a stream delivers and hands them out as exact-length reads:
 * `await reader.read(n)` resolves once `n` bytes have arrived. Typed helpers (`u8`, `u16`, `s32`, ...)
 * read big-endian integers, as RFB sends them.
 *
 * The protocol is parsed by one sequential `async` loop, so at most one read is pending at a time.
 * Reads that fit in one chunk are zero-copy (`subarray`); a read that spans chunks is copied once.
 * After `destroy(err)` the bytes already buffered can still be read; a read that needs more fails
 * with `err`.
 */
export class ByteReader {
  #chunks: Buffer[] = []
  #offset = 0
  #length = 0
  #pending: { n: number; consume: boolean; resolve: (b: Buffer) => void; reject: (err: Error) => void } | null = null
  #error: Error | null = null

  /** Bytes buffered and not yet read. */
  get available(): number {
    return this.#length
  }

  get destroyed(): boolean {
    return this.#error !== null
  }

  push(chunk: Buffer): void {
    if (this.#error !== null || chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
    const pending = this.#pending
    if (pending !== null && this.#length >= pending.n) {
      this.#pending = null
      pending.resolve(pending.consume ? this.#take(pending.n) : this.peek())
    }
  }

  /** Ends the stream: the pending read (and any later one that needs more data) fails with `err`. */
  destroy(err: Error): void {
    if (this.#error !== null) return
    this.#error = err
    const pending = this.#pending
    this.#pending = null
    pending?.reject(err)
  }

  /** Exactly `n` bytes. */
  read(n: number): Promise<Buffer> {
    if (this.#pending !== null) throw new Error('ByteReader: only one read may be pending at a time')
    if (this.#length >= n) return Promise.resolve(this.#take(n))
    if (this.#error !== null) return Promise.reject(this.#error)
    return new Promise((resolve, reject) => {
      this.#pending = { n, consume: true, resolve, reject }
    })
  }

  /** `n` bytes if they are already buffered, else `null` (nothing is consumed). */
  readNow(n: number): Buffer | null {
    return this.#length >= n ? this.#take(n) : null
  }

  /** Everything buffered, as one Buffer, without consuming it (chunks are merged once). */
  peek(): Buffer {
    if (this.#length === 0) return EMPTY
    if (this.#chunks.length > 1) {
      const merged = Buffer.concat([(this.#chunks[0] as Buffer).subarray(this.#offset), ...this.#chunks.slice(1)])
      this.#chunks = [merged]
      this.#offset = 0
    }
    return (this.#chunks[0] as Buffer).subarray(this.#offset)
  }

  /** Drops `n` buffered bytes (after `peek()`). */
  consume(n: number): void {
    if (n > this.#length) throw new Error('ByteReader: consuming more than is buffered')
    this.#take(n)
  }

  /** Resolves with `peek()` once at least `n` bytes are buffered. */
  waitFor(n: number): Promise<Buffer> {
    if (this.#pending !== null) throw new Error('ByteReader: only one read may be pending at a time')
    if (this.#length >= n) return Promise.resolve(this.peek())
    if (this.#error !== null) return Promise.reject(this.#error)
    return new Promise((resolve, reject) => {
      this.#pending = { n, consume: false, resolve, reject }
    })
  }

  async u8(): Promise<number> {
    return (await this.read(1))[0] as number
  }

  async u16(): Promise<number> {
    return (await this.read(2)).readUInt16BE(0)
  }

  async u32(): Promise<number> {
    return (await this.read(4)).readUInt32BE(0)
  }

  async s32(): Promise<number> {
    return (await this.read(4)).readInt32BE(0)
  }

  /** Drops the next `n` bytes as they arrive, without collecting them first. */
  async skip(n: number): Promise<void> {
    let left = n
    for (;;) {
      const k = Math.min(left, this.#length)
      this.#drop(k)
      left -= k
      if (left === 0) return
      await this.waitFor(1)
    }
  }

  /** A string of `n` bytes. */
  async string(n: number, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return (await this.read(n)).toString(encoding)
  }

  /** A U32 length followed by that many bytes, as a string (RFB's reason strings, names). */
  async lengthPrefixedString(encoding: BufferEncoding = 'utf8', max = 1 << 24): Promise<string> {
    const n = await this.u32()
    if (n > max) throw protocolError(`string of ${n} bytes is longer than the ${max} this client accepts`)
    return this.string(n, encoding)
  }

  #drop(n: number): void {
    this.#length -= n
    while (n > 0) {
      const chunk = this.#chunks[0] as Buffer
      const k = Math.min(chunk.length - this.#offset, n)
      n -= k
      if (this.#offset + k === chunk.length) {
        this.#chunks.shift()
        this.#offset = 0
      } else {
        this.#offset += k
      }
    }
  }

  #take(n: number): Buffer {
    if (n === 0) return EMPTY
    this.#length -= n
    const first = this.#chunks[0] as Buffer
    const end = this.#offset + n
    if (end <= first.length) {
      const out = first.subarray(this.#offset, end)
      if (end === first.length) {
        this.#chunks.shift()
        this.#offset = 0
      } else {
        this.#offset = end
      }
      return out
    }
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const chunk = this.#chunks[0] as Buffer
      const take = Math.min(chunk.length - this.#offset, n - filled)
      chunk.copy(out, filled, this.#offset, this.#offset + take)
      filled += take
      if (this.#offset + take === chunk.length) {
        this.#chunks.shift()
        this.#offset = 0
      } else {
        this.#offset += take
      }
    }
    return out
  }
}

/**
 * A synchronous cursor over an in-memory buffer, for payloads that arrive whole (inflated zlib data,
 * length-prefixed messages). Reading past the end is a protocol error.
 */
export class BufferCursor {
  readonly buf: Buffer
  pos: number

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf
    this.pos = pos
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }

  #need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) {
      throw protocolError(`${what}: needed ${n} more bytes, only ${this.buf.length - this.pos} left`)
    }
  }

  u8(what = 'data'): number {
    this.#need(1, what)
    return this.buf[this.pos++] as number
  }

  u16(what = 'data'): number {
    this.#need(2, what)
    const v = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return v
  }

  u32(what = 'data'): number {
    this.#need(4, what)
    const v = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return v
  }

  s32(what = 'data'): number {
    this.#need(4, what)
    const v = this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }

  bytes(n: number, what = 'data'): Buffer {
    this.#need(n, what)
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}
