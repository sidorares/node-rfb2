import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { protocolError, RfbError } from './errors.ts'
import { ByteReader } from './reader.ts'

/** Encrypts outgoing and decrypts incoming bytes once a security type turns encryption on (RSA-AES). */
export interface Cipher {
  encrypt(plain: Buffer): Buffer
  /** Feeds received bytes; calls `push` with plaintext as complete messages decrypt. Throws on a bad MAC. */
  decrypt(chunk: Buffer, push: (plain: Buffer) => void): void
}

/**
 * The byte stream under the protocol: feeds a ByteReader from a Duplex and writes to it, can switch
 * to TLS mid-stream (VeNCrypt) or add a cipher (RSA-AES). Stream errors and the end of the stream
 * end the reader, so the parser's pending read fails with an RfbError.
 */
export class Transport {
  readonly reader = new ByteReader()
  #stream: Duplex
  #cipher: Cipher | null = null
  #connected: boolean
  #ended = false

  /** `connected` false: the stream is still connecting (a failure then is CONNECTION_FAILED). */
  constructor(stream: Duplex, connected: boolean) {
    this.#stream = stream
    this.#connected = connected
    this.#attach(stream)
    if (!connected) stream.once('connect', () => (this.#connected = true))
  }

  get stream(): Duplex {
    return this.#stream
  }

  write(data: Buffer): boolean {
    if (this.#ended || this.#stream.destroyed || !this.#stream.writable) return false
    return this.#stream.write(this.#cipher ? this.#cipher.encrypt(data) : data)
  }

  /** Ends the stream after pending writes (a graceful close). */
  end(): void {
    this.#ended = true
    this.#stream.end()
  }

  destroy(): void {
    this.#ended = true
    this.#stream.destroy()
    this.reader.destroy(new RfbError('CONNECTION_CLOSED', 'the connection was closed'))
  }

  /** Switches to TLS over the current stream (the server is waiting for our ClientHello). */
  async startTls(options: tls.ConnectionOptions): Promise<void> {
    if (this.reader.available > 0) throw protocolError('the server sent data before the TLS handshake')
    const raw = this.#stream
    this.#detach(raw)
    const socket = tls.connect({ ...options, socket: raw as Socket })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', resolve)
        socket.once('error', reject)
        socket.once('close', () => reject(new Error('the connection closed during the TLS handshake')))
      })
    } catch (err) {
      socket.destroy()
      raw.destroy()
      const message = (err as Error).message
      throw new RfbError(
        'TLS_FAILED',
        `the TLS handshake failed (${message}); check the \`tls\` options (ca, servername, rejectUnauthorized)`,
        { cause: err },
      )
    }
    this.#stream = socket
    this.#attach(socket)
  }

  /**
   * Encrypts everything from now on (`null`: stops encrypting). Bytes already buffered are
   * ciphertext and are moved through the new cipher.
   */
  setCipher(cipher: Cipher | null): void {
    this.#cipher = cipher
    const pending = cipher && this.reader.available > 0 ? this.reader.peek() : null
    if (cipher && pending) {
      this.reader.consume(pending.length)
      cipher.decrypt(Buffer.from(pending), (plain) => this.reader.push(plain))
    }
  }

  #onData = (chunk: Buffer) => {
    if (!this.#cipher) {
      this.reader.push(chunk)
      return
    }
    try {
      this.#cipher.decrypt(chunk, (plain) => this.reader.push(plain))
    } catch (err) {
      this.reader.destroy(err instanceof RfbError ? err : protocolError(`decryption failed: ${(err as Error).message}`))
      this.#stream.destroy()
    }
  }

  #onError = (err: NodeJS.ErrnoException) => {
    const code = err.code ? ` (${err.code})` : ''
    this.reader.destroy(
      this.#connected
        ? new RfbError('CONNECTION_CLOSED', `the connection broke: ${err.message}${code}`, { cause: err })
        : new RfbError('CONNECTION_FAILED', `can't connect: ${err.message}; is the VNC server running?`, {
            cause: err,
          }),
    )
  }

  #onClose = () => {
    this.reader.destroy(
      this.#connected
        ? new RfbError('CONNECTION_CLOSED', 'the server closed the connection')
        : new RfbError('CONNECTION_FAILED', "can't connect: the connection closed while connecting"),
    )
  }

  #attach(stream: Duplex): void {
    stream.on('data', this.#onData)
    stream.on('error', this.#onError)
    stream.on('end', this.#onClose)
    stream.on('close', this.#onClose)
  }

  #detach(stream: Duplex): void {
    stream.off('data', this.#onData)
    stream.off('error', this.#onError)
    stream.off('end', this.#onClose)
    stream.off('close', this.#onClose)
  }
}
