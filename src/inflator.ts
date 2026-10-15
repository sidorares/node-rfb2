import zlib from 'node:zlib'
import { protocolError, RfbError } from './errors.ts'

/**
 * The most zlib data an encoder can need for `inflated` bytes. Deflate's worst case (stored blocks,
 * or fixed Huffman codes of up to 9 bits a byte) is under 1.15 times the input plus a few bytes per
 * block and flush; a quarter more plus 1 KiB for the header and flush markers is well above what any
 * encoder sends.
 */
export function zlibBound(inflated: number): number {
  return inflated + Math.ceil(inflated / 4) + 1024
}

/** Rejects a length from the wire that is more zlib data than `inflated` bytes can need. */
export function checkZlibLength(length: number, inflated: number, what: string): void {
  if (length > zlibBound(inflated)) {
    throw protocolError(`${what}: ${length} bytes of zlib data for at most ${inflated} bytes of output`)
  }
}

/**
 * One zlib stream that lasts as long as the connection: Zlib, ZRLE and Tight compress every rect
 * with the same stream, so its dictionary carries over. Each `inflate()` feeds the next part of the
 * stream and resolves with everything it decodes to (the server ends each part with a sync flush).
 *
 * Each part's output is bounded: inflating stops as soon as it passes the bound, so a few KB of zlib
 * data can't decode to gigabytes first. The stream is then out of step with the server's, so the
 * inflator fails for good (until `reset()`) and the connection has to end.
 */
export class Inflator {
  #z: zlib.Inflate | null = null
  #out: Buffer[] = []
  #outLength = 0
  #error: RfbError | null = null
  /** The inflate() in progress: its bound and how to fail it. */
  #current: { length: number; exact: boolean; reject: (err: RfbError) => void } | null = null

  /**
   * Feeds `data` and resolves with what it decodes to: exactly `length` bytes, or with `exact` false
   * at most `length`. Fails as soon as the output passes `length`, without inflating the rest.
   */
  async inflate(data: Buffer, length: number, exact = true): Promise<Buffer> {
    if (this.#error) throw this.#error
    const z = this.#stream()
    const out = await new Promise<Buffer>((resolve, reject) => {
      const onError = (err: Error) =>
        this.#fail(new RfbError('PROTOCOL_ERROR', `corrupt zlib data from the server (${err.message})`, { cause: err }))
      this.#current = {
        length,
        exact,
        reject: (err) => {
          z.off('error', onError)
          reject(err)
        },
      }
      z.once('error', onError)
      z.write(data)
      // zlib emits the output for everything written so far before the flush callback runs.
      z.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        // After a failure the promise is already rejected (and the callback gets ERR_STREAM_DESTROYED).
        if (this.#current === null || this.#z !== z) return
        z.off('error', onError)
        this.#current = null
        const result = this.#outLength === 0 ? Buffer.alloc(0) : Buffer.concat(this.#out, this.#outLength)
        this.#out = []
        this.#outLength = 0
        resolve(result)
      })
    })
    if (exact && out.length !== length) {
      throw protocolError(`zlib data decoded to ${out.length} bytes where ${length} were expected`)
    }
    return out
  }

  /** Starts a new stream (Tight's "reset stream" bits). */
  reset(): void {
    this.#z?.destroy()
    this.#z = null
    this.#out = []
    this.#outLength = 0
    this.#error = null
    this.#current = null
  }

  close(): void {
    this.reset()
  }

  /** Stops the stream where it is: the pending inflate() and every later one fail with `err`. */
  #fail(err: RfbError): void {
    if (this.#error) return
    this.#error = err
    this.#out = []
    this.#outLength = 0
    // zlib stops before the next chunk of output (destroying from a 'data' handler is safe).
    this.#z?.destroy()
    const current = this.#current
    this.#current = null
    current?.reject(err)
  }

  #stream(): zlib.Inflate {
    if (this.#z) return this.#z
    const z = zlib.createInflate({ chunkSize: 64 * 1024 })
    z.on('data', (chunk: Buffer) => {
      if (this.#z !== z || this.#error) return
      const current = this.#current
      const total = this.#outLength + chunk.length
      if (current === null || total > current.length) {
        const bound =
          current === null
            ? 'between rects'
            : current.exact
              ? `where ${current.length} were expected`
              : `where the rect holds at most ${current.length}`
        this.#fail(protocolError(`zlib data decoded to at least ${total} bytes ${bound}`))
        return
      }
      this.#out.push(chunk)
      this.#outLength = total
    })
    // Errors are handled per inflate() call; this keeps a late one from becoming uncaught.
    z.on('error', () => {})
    this.#z = z
    return z
  }
}
