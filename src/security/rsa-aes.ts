import crypto from 'node:crypto'
import { security as S } from '../constants.ts'
import { protocolError, RfbError } from '../errors.ts'
import type { Cipher } from '../transport.ts'
import type { SecurityContext, SecurityOutcome } from './types.ts'

// RSA-AES (RA2, RA2ne and their -256 variants; TigerVNC 1.13+, RealVNC): an RSA key exchange,
// then AES-EAX encrypted messages. RA2 keeps the channel encrypted; RA2ne only the handshake.

const CLIENT_KEY_BITS = 2048
const MIN_KEY_BITS = 1024
const MAX_KEY_BITS = 8192

const BLOCK = 16

function aesEcb(key: Buffer, block: Buffer): Buffer {
  const c = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
  c.setAutoPadding(false)
  return c.update(block)
}

function shiftLeft(b: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK)
  for (let i = 0; i < BLOCK; i++) out[i] = (((b[i] as number) << 1) | ((b[i + 1] ?? 0) >> 7)) & 0xff
  if ((b[0] as number) & 0x80) out[BLOCK - 1] = (out[BLOCK - 1] as number) ^ 0x87
  return out
}

function xorInto(a: Buffer, b: Buffer, offset = 0): void {
  for (let i = 0; i < BLOCK; i++) a[i] = (a[i] as number) ^ (b[offset + i] as number)
}

/** AES-EAX (Bellare, Rogaway, Wagner) with a 16-byte tag, on Node's AES-ECB and AES-CTR. */
export class Eax {
  readonly #key: Buffer
  readonly #k1: Buffer
  readonly #k2: Buffer

  constructor(key: Buffer) {
    this.#key = key
    this.#k1 = shiftLeft(aesEcb(key, Buffer.alloc(BLOCK)))
    this.#k2 = shiftLeft(this.#k1)
  }

  /** OMAC^t(data): CMAC over a block holding `t`, then `data`. */
  #omac(t: number, data: Buffer): Buffer {
    const msg = Buffer.concat([Buffer.alloc(BLOCK - 1), Buffer.from([t]), data])
    const full = msg.length % BLOCK === 0
    const padded = full
      ? msg
      : Buffer.concat([msg, Buffer.from([0x80]), Buffer.alloc(BLOCK - 1 - (msg.length % BLOCK))])
    let mac: Buffer = Buffer.alloc(BLOCK)
    for (let o = 0; o < padded.length; o += BLOCK) {
      xorInto(mac, padded, o)
      if (o + BLOCK === padded.length) xorInto(mac, full ? this.#k1 : this.#k2)
      mac = aesEcb(this.#key, mac)
    }
    return mac
  }

  #ctr(iv: Buffer, data: Buffer): Buffer {
    const c = crypto.createCipheriv(`aes-${this.#key.length * 8}-ctr`, this.#key, iv)
    return Buffer.concat([c.update(data), c.final()])
  }

  encrypt(nonce: Buffer, header: Buffer, plain: Buffer): { ciphertext: Buffer; tag: Buffer } {
    const n = this.#omac(0, nonce)
    const h = this.#omac(1, header)
    const ciphertext = this.#ctr(n, plain)
    const tag = this.#omac(2, ciphertext)
    xorInto(tag, n)
    xorInto(tag, h)
    return { ciphertext, tag }
  }

  /** Returns the plaintext, or null when the tag doesn't match. */
  decrypt(nonce: Buffer, header: Buffer, ciphertext: Buffer, tag: Buffer): Buffer | null {
    const n = this.#omac(0, nonce)
    const h = this.#omac(1, header)
    const expected = this.#omac(2, ciphertext)
    xorInto(expected, n)
    xorInto(expected, h)
    if (!crypto.timingSafeEqual(expected, tag)) return null
    return this.#ctr(n, ciphertext)
  }
}

/** The RA2 message layer: U16 length, AES-EAX ciphertext, 16-byte tag; little-endian counter nonces. */
export class RsaAesCipher implements Cipher {
  readonly #out: Eax
  readonly #in: Eax
  #outCounter = 0n
  #inCounter = 0n
  #pending: Buffer = Buffer.alloc(0)

  constructor(clientKey: Buffer, serverKey: Buffer) {
    this.#out = new Eax(clientKey)
    this.#in = new Eax(serverKey)
  }

  static #nonce(counter: bigint): Buffer {
    const b = Buffer.alloc(BLOCK)
    b.writeBigUInt64LE(counter & 0xffffffffffffffffn, 0)
    b.writeBigUInt64LE(counter >> 64n, 8)
    return b
  }

  encrypt(plain: Buffer): Buffer {
    const parts: Buffer[] = []
    for (let o = 0; o < plain.length || o === 0; o += 0xffff) {
      const chunk = plain.subarray(o, o + 0xffff)
      const header = Buffer.alloc(2)
      header.writeUInt16BE(chunk.length)
      const { ciphertext, tag } = this.#out.encrypt(RsaAesCipher.#nonce(this.#outCounter++), header, chunk)
      parts.push(header, ciphertext, tag)
      if (plain.length === 0) break
    }
    return Buffer.concat(parts)
  }

  decrypt(chunk: Buffer, push: (plain: Buffer) => void): void {
    this.#pending = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk
    while (this.#pending.length >= 2) {
      const length = this.#pending.readUInt16BE(0)
      if (this.#pending.length < 2 + length + BLOCK) break
      const header = this.#pending.subarray(0, 2)
      const ciphertext = this.#pending.subarray(2, 2 + length)
      const tag = this.#pending.subarray(2 + length, 2 + length + BLOCK)
      const plain = this.#in.decrypt(RsaAesCipher.#nonce(this.#inCounter++), header, ciphertext, tag)
      if (plain === null) throw protocolError('RSA-AES: a message failed authentication (bad MAC)')
      this.#pending = this.#pending.subarray(2 + length + BLOCK)
      push(plain)
    }
  }

  /** Bytes received but not yet a whole message. */
  get pending(): number {
    return this.#pending.length
  }
}

/** Strips EME-PKCS1-v1_5 padding from an RSA-decrypted block. */
function unpadPkcs1(block: Buffer): Buffer {
  if (block[0] !== 0 || block[1] !== 2) throw protocolError('RSA-AES: bad padding in the server random')
  const zero = block.indexOf(0, 2)
  if (zero < 10) throw protocolError('RSA-AES: bad padding in the server random')
  return block.subarray(zero + 1)
}

const unsigned = (b: Buffer): Buffer => {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  return b.subarray(i)
}

/** The wire form of a public key: U32 bit length, modulus and exponent of ceil(bits/8) bytes each. */
function encodeKey(n: Buffer, e: Buffer, bits: number): Buffer {
  const size = Math.ceil(bits / 8)
  const out = Buffer.alloc(4 + 2 * size)
  out.writeUInt32BE(bits, 0)
  const nn = unsigned(n)
  const ee = unsigned(e)
  nn.copy(out, 4 + size - nn.length)
  ee.copy(out, 4 + 2 * size - ee.length)
  return out
}

export async function rsaAesAuth(ctx: SecurityContext, type: number): Promise<SecurityOutcome> {
  const { reader } = ctx
  const wide = type === S.RA2_256 || type === S.RA2ne_256
  const hash = wide ? 'sha256' : 'sha1'
  const randomSize = wide ? 32 : 16

  // The server's public key.
  const serverBits = await reader.u32()
  if (serverBits < MIN_KEY_BITS || serverBits > MAX_KEY_BITS) {
    throw new RfbError('UNSUPPORTED_SECURITY', `RSA-AES: the server's ${serverBits}-bit key is outside 1024..8192 bits`)
  }
  const serverSize = Math.ceil(serverBits / 8)
  const serverKeyData = await reader.read(2 * serverSize)
  const serverKeyWire = Buffer.concat([Buffer.alloc(4), serverKeyData])
  serverKeyWire.writeUInt32BE(serverBits, 0)
  const serverKey = crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: unsigned(serverKeyData.subarray(0, serverSize)).toString('base64url'),
      e: unsigned(serverKeyData.subarray(serverSize)).toString('base64url'),
    },
    format: 'jwk',
  })

  // Ours, then our random encrypted with the server's key.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: CLIENT_KEY_BITS })
  const jwk = publicKey.export({ format: 'jwk' })
  const clientKeyWire = encodeKey(
    Buffer.from(jwk.n as string, 'base64url'),
    Buffer.from(jwk.e as string, 'base64url'),
    CLIENT_KEY_BITS,
  )
  const clientRandom = crypto.randomBytes(randomSize)
  const encryptedRandom = crypto.publicEncrypt(
    { key: serverKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    clientRandom,
  )
  const randomHead = Buffer.alloc(2)
  randomHead.writeUInt16BE(encryptedRandom.length)
  ctx.write(Buffer.concat([clientKeyWire, randomHead, encryptedRandom]))

  // The server's random, encrypted with our key.
  const length = await reader.u16()
  if (length !== CLIENT_KEY_BITS / 8) throw protocolError(`RSA-AES: a ${length}-byte encrypted random`)
  const serverRandom = unpadPkcs1(
    crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, await reader.read(length)),
  )
  if (serverRandom.length !== randomSize) throw protocolError(`RSA-AES: a ${serverRandom.length}-byte random`)

  const derive = (a: Buffer, b: Buffer) =>
    crypto
      .createHash(hash)
      .update(Buffer.concat([a, b]))
      .digest()
      .subarray(0, randomSize)
  const cipher = new RsaAesCipher(derive(serverRandom, clientRandom), derive(clientRandom, serverRandom))
  ctx.setCipher(cipher)

  // Both sides prove they saw the same keys.
  ctx.write(
    crypto
      .createHash(hash)
      .update(Buffer.concat([clientKeyWire, serverKeyWire]))
      .digest(),
  )
  const serverHash = await reader.read(wide ? 32 : 20)
  const expected = crypto
    .createHash(hash)
    .update(Buffer.concat([serverKeyWire, clientKeyWire]))
    .digest()
  if (!serverHash.equals(expected)) throw protocolError('RSA-AES: the server hash does not match its key')

  const subtype = await reader.u8()
  if (subtype !== 1 && subtype !== 2) throw protocolError(`RSA-AES: unknown credentials subtype ${subtype}`)
  const { username, password } = await ctx.credentials(type, subtype === 1 ? ['username', 'password'] : ['password'])
  const user = Buffer.from(subtype === 1 ? (username ?? '') : '', 'utf8').subarray(0, 255)
  const pass = Buffer.from(password ?? '', 'utf8').subarray(0, 255)
  ctx.write(Buffer.concat([Buffer.from([user.length]), user, Buffer.from([pass.length]), pass]))

  if (type === S.RA2ne || type === S.RA2ne_256) {
    if (cipher.pending > 0 || reader.available > 0) throw protocolError('RSA-AES: unexpected encrypted data')
    ctx.setCipher(null)
  }
  return {}
}
