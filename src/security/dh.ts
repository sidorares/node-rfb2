import crypto from 'node:crypto'
import { security as S } from '../constants.ts'
import { Des, vncKey } from '../des.ts'
import { protocolError } from '../errors.ts'
import type { SecurityContext, SecurityOutcome } from './types.ts'

/** `text` as UTF-8, NUL-terminated, padded with random bytes to `size` (truncated to fit). */
function padded(text: string, size: number): Buffer {
  const out = crypto.randomBytes(size)
  const bytes = Buffer.from(text, 'utf8').subarray(0, size - 1)
  bytes.copy(out)
  out[bytes.length] = 0
  return out
}

function leftPad(b: Buffer, size: number): Buffer {
  if (b.length >= size) return b.subarray(b.length - size)
  return Buffer.concat([Buffer.alloc(size - b.length), b])
}

/**
 * Apple Remote Desktop authentication (RFB "Diffie-Hellman Authentication", type 30), what macOS
 * Screen Sharing uses for user accounts: DH key agreement, then the username and password
 * encrypted with AES-128-ECB under MD5(shared secret).
 */
export async function ardAuth(ctx: SecurityContext): Promise<SecurityOutcome> {
  const head = await ctx.reader.read(4)
  const generator = head.readUInt16BE(0)
  const keyLength = head.readUInt16BE(2)
  if (keyLength === 0 || keyLength > 1024) throw protocolError(`ARD: a ${keyLength}-byte key`)
  const prime = await ctx.reader.read(keyLength)
  const serverPublic = await ctx.reader.read(keyLength)
  const { username, password } = await ctx.credentials(S.ARD, ['username', 'password'])

  const dh = crypto.createDiffieHellman(prime, generator)
  const clientPublic = leftPad(dh.generateKeys(), keyLength)
  const secret = leftPad(dh.computeSecret(serverPublic), keyLength)
  const key = crypto.createHash('md5').update(secret).digest()
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  const plain = Buffer.concat([padded(username ?? '', 64), padded(password ?? '', 64)])
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  ctx.write(Buffer.concat([encrypted, clientPublic]))
  return {}
}

const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  let result = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return result
}

const toBigInt = (b: Buffer): bigint => BigInt(`0x${b.toString('hex') || '0'}`)
const toBytes8 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(16, '0'), 'hex')

/**
 * MS Logon II (UltraVNC, type 113): 64-bit DH, then the username (256 bytes) and password (64 bytes)
 * DES-CBC encrypted with the shared secret as key (VNC bit order) and as IV.
 */
export async function msLogonIIAuth(ctx: SecurityContext): Promise<SecurityOutcome> {
  const params = await ctx.reader.read(24)
  const g = toBigInt(params.subarray(0, 8))
  const p = toBigInt(params.subarray(8, 16))
  const serverPublic = toBigInt(params.subarray(16, 24))
  if (p < 2n) throw protocolError('MS Logon II: invalid modulus')
  const { username, password } = await ctx.credentials(S.MSLogonII, ['username', 'password'])

  const priv = toBigInt(crypto.randomBytes(8)) % p
  const clientPublic = toBytes8(modPow(g, priv, p))
  const secret = toBytes8(modPow(serverPublic, priv, p))
  const des = new Des(vncKey(secret))
  ctx.write(
    Buffer.concat([
      clientPublic,
      des.encryptCbc(padded(username ?? '', 256), secret),
      des.encryptCbc(padded(password ?? '', 64), secret),
    ]),
  )
  return {}
}
