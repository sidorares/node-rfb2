import zlib from 'node:zlib'
import { RfbError } from './errors.ts'

/**
 * One zlib stream that lasts as long as the connection: Zlib, ZRLE and Tight compress every rect
 * with the same stream, so its dictionary carries over. Each `inflate()` feeds the next part of the
 * stream and resolves with everything it decodes to (the server ends each part with a sync flush).
 */
export class Inflator {
  #z: zlib.Inflate | null = null
  #out: Buffer[] = []
  #outLength = 0
  #error: Error | null = null

  async inflate(data: Buffer, expectedLength?: number): Promise<Buffer> {
    if (this.#error) throw this.#error
    const z = this.#stream()
    const out = await new Promise<Buffer>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      z.once('error', onError)
      z.write(data)
      // zlib emits the output for everything written so far before the flush callback runs.
      z.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        z.off('error', onError)
        const result = this.#outLength === 0 ? Buffer.alloc(0) : Buffer.concat(this.#out, this.#outLength)
        this.#out = []
        this.#outLength = 0
        resolve(result)
      })
    }).catch((err: unknown) => {
      this.#error = new RfbError('PROTOCOL_ERROR', `corrupt zlib data from the server (${(err as Error).message})`, {
        cause: err,
      })
      throw this.#error
    })
    if (expectedLength !== undefined && out.length !== expectedLength) {
      throw new RfbError(
        'PROTOCOL_ERROR',
        `zlib data decoded to ${out.length} bytes where ${expectedLength} were expected`,
      )
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
  }

  close(): void {
    this.reset()
  }

  #stream(): zlib.Inflate {
    if (this.#z) return this.#z
    const z = zlib.createInflate({ chunkSize: 64 * 1024 })
    z.on('data', (chunk: Buffer) => {
      this.#out.push(chunk)
      this.#outLength += chunk.length
    })
    // Errors are handled per inflate() call; this keeps a late one from becoming uncaught.
    z.on('error', () => {})
    this.#z = z
    return z
  }
}
