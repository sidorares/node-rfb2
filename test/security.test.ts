import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import tls from 'node:tls'
import { Des, vncAuthResponse, vncKey } from '../src/des.ts'
import { connect, type RfbClient, type RfbError, security as S } from '../src/index.ts'
import { Eax, RsaAesCipher } from '../src/security/rsa-aes.ts'
import { type Peer, pair, serverInit, u8, u16, u32 } from './helpers/peer.ts'

const cert = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/test-key.pem', import.meta.url))

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ''), 'hex')
const cstr = (b: Buffer) => b.subarray(0, b.indexOf(0)).toString('utf8')

/** The end of a handshake after security: SecurityResult OK, ClientInit, ServerInit. */
async function finish(peer: Peer, result = true): Promise<void> {
  if (result) peer.write(u32(0))
  assert.equal(await peer.u8(), 1, 'ClientInit')
  peer.write(serverInit(8, 8, 'secure'))
}

/** Offers `type` in a 3.8 handshake. */
async function offer(peer: Peer, ...types: number[]): Promise<number> {
  peer.write('RFB 003.008\n')
  await peer.string(12)
  peer.write(u8(types.length, ...types))
  return peer.u8()
}

describe('DES', () => {
  test('FIPS 46 test vector and decryption', () => {
    const des = new Des(hex('133457799BBCDFF1'))
    const ct = des.encryptBlock(hex('0123456789ABCDEF'))
    assert.equal(Buffer.from(ct).toString('hex'), '85e813540f0ab405')
    assert.equal(Buffer.from(des.decryptBlock(ct)).toString('hex'), '0123456789abcdef')
  })

  test('matches OpenSSL triple DES with three equal keys', (t) => {
    if (!crypto.getCiphers().includes('des-ede3-ecb')) return t.skip('no des-ede3 in this runtime')
    for (let i = 0; i < 50; i++) {
      const k = crypto.randomBytes(8)
      const block = crypto.randomBytes(8)
      const c = crypto.createCipheriv('des-ede3-ecb', Buffer.concat([k, k, k]), null)
      c.setAutoPadding(false)
      assert.deepEqual(Buffer.from(new Des(k).encryptBlock(block)), c.update(block))
    }
  })

  test('VNC keys reverse the bits of each password byte, truncated to 8 bytes', () => {
    assert.deepEqual([...vncKey(Uint8Array.from([0x01, 0x80, 0x61, 0x62]))], [0x80, 0x01, 0x86, 0x46, 0, 0, 0, 0])
    assert.deepEqual([...vncKey('é')], [0xc3, 0x95, 0, 0, 0, 0, 0, 0], 'strings are UTF-8')
    assert.deepEqual(vncKey('passwordEXTRA'), vncKey('password'))
    const challenge = Buffer.from('0123456789abcdef')
    const response = vncAuthResponse(challenge, 'secret')
    const des = new Des(vncKey('secret'))
    assert.deepEqual(Buffer.from(des.decryptBlock(response.subarray(0, 8))), challenge.subarray(0, 8))
    assert.deepEqual(Buffer.from(des.decryptBlock(response.subarray(8))), challenge.subarray(8))
  })

  test('CBC round trip', () => {
    const des = new Des(crypto.randomBytes(8))
    const iv = crypto.randomBytes(8)
    const data = crypto.randomBytes(64)
    assert.deepEqual(des.decryptCbc(des.encryptCbc(data, iv), iv), data)
  })
})

describe('AES-EAX', () => {
  // Test vectors from the EAX paper (Bellare, Rogaway, Wagner).
  const vectors = [
    [
      '',
      '233952DEE4D5ED5F9B9C6D6FF80FF478',
      '62EC67F9C3A4A407FCB2A8C49031A8B3',
      '6BFB914FD07EAE6B',
      'E037830E8389F27B025A2D6527E79D01',
    ],
    [
      'F7FB',
      '91945D3F4DCBEE0BF45EF52255F095A4',
      'BECAF043B0A23D843194BA972C66DEBD',
      'FA3BFD4806EB53FA',
      '19DD5C4C9331049D0BDAB0277408F67967E5',
    ],
    [
      '1A47CB4933',
      '01F74AD64077F2E704C0F60ADA3DD523',
      '70C3DB4F0D26368400A10ED05D2BFF5E',
      '234A3463C1264AC6',
      'D851D5BAE03A59F238A23E39199DC9266626C40F80',
    ],
  ]
  for (const [msg, k, nonce, header, expected] of vectors) {
    test(`vector with a ${hex(msg as string).length}-byte message`, () => {
      const eax = new Eax(hex(k as string))
      const { ciphertext, tag } = eax.encrypt(hex(nonce as string), hex(header as string), hex(msg as string))
      assert.equal(Buffer.concat([ciphertext, tag]).toString('hex').toUpperCase(), expected)
      assert.deepEqual(eax.decrypt(hex(nonce as string), hex(header as string), ciphertext, tag), hex(msg as string))
      tag[0] = (tag[0] as number) ^ 1
      assert.equal(eax.decrypt(hex(nonce as string), hex(header as string), ciphertext, tag), null)
    })
  }

  test('the RA2 message layer round-trips, split at any byte', () => {
    const a = crypto.randomBytes(16)
    const b = crypto.randomBytes(16)
    const sender = new RsaAesCipher(a, b)
    const receiver = new RsaAesCipher(b, a)
    const messages = [Buffer.from('hello'), crypto.randomBytes(70000), Buffer.from('x')]
    const wire = Buffer.concat(messages.map((m) => sender.encrypt(m)))
    const got: Buffer[] = []
    for (let i = 0; i < wire.length; i += 7) receiver.decrypt(wire.subarray(i, i + 7), (p) => got.push(p))
    assert.deepEqual(Buffer.concat(got), Buffer.concat(messages))
    const tampered = sender.encrypt(Buffer.from('evil'))
    tampered[3] = (tampered[3] as number) ^ 1
    assert.throws(
      () => receiver.decrypt(tampered, () => {}),
      (err: RfbError) => err.code === 'PROTOCOL_ERROR',
    )
  })
})

describe('VeNCrypt', () => {
  async function vencrypt(peer: Peer, subtypes: number[]): Promise<number> {
    assert.equal(await offer(peer, S.VeNCrypt), S.VeNCrypt)
    peer.write(u8(0, 2))
    assert.deepEqual([...(await peer.read(2))], [0, 2])
    peer.write(u8(0), u8(subtypes.length), ...subtypes.map(u32))
    return peer.u32()
  }

  function startTls(peer: Peer, options: tls.TLSSocketOptions): Promise<void> {
    peer.write(u8(1))
    const socket = new tls.TLSSocket(peer.detach(), { isServer: true, ...options })
    peer.replace(socket)
    return new Promise((resolve, reject) => {
      socket.once('secure', resolve)
      socket.once('error', reject)
    })
  }

  test('Plain without TLS', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, username: 'ann', password: 'pässword', security: [S.Plain] })
    assert.equal(await vencrypt(peer, [S.TLSPlain, S.Plain]), S.Plain)
    const lengths = await peer.read(8)
    assert.equal((await peer.read(lengths.readUInt32BE(0))).toString(), 'ann')
    assert.equal((await peer.read(lengths.readUInt32BE(4))).toString(), 'pässword')
    await finish(peer)
    const client = await connecting
    assert.equal(client.securityType, S.VeNCrypt)
    client.destroy()
  })

  test('X509Vnc: TLS with a verified certificate, then VNC authentication', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({
      stream: clientStream,
      password: 'secret',
      security: [S.X509Vnc],
      tls: { ca: cert, servername: 'localhost' },
    })
    assert.equal(await vencrypt(peer, [S.TLSNone, S.X509Vnc]), S.X509Vnc)
    await startTls(peer, { key, cert })
    const challenge = crypto.randomBytes(16)
    peer.write(challenge)
    assert.deepEqual(await peer.read(16), vncAuthResponse(challenge, 'secret'))
    await finish(peer)
    const client = await connecting
    assert.ok(client.stream instanceof tls.TLSSocket)
    client.destroy()
  })

  test('X509: an untrusted certificate fails with TLS_FAILED', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, security: [S.X509None], tls: { servername: 'localhost' } })
    assert.equal(await vencrypt(peer, [S.X509None]), S.X509None)
    startTls(peer, { key, cert }).catch(() => {})
    await assert.rejects(connecting, (err: RfbError) => err.code === 'TLS_FAILED' && /self-signed/.test(err.message))
  })

  test('TLSNone: anonymous TLS', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, security: [S.TLSNone] })
    assert.equal(await vencrypt(peer, [S.TLSNone]), S.TLSNone)
    await startTls(peer, { ciphers: 'aNULL:!eNULL@SECLEVEL=0', maxVersion: 'TLSv1.2' })
    await finish(peer)
    const client = await connecting
    assert.match((client.stream as tls.TLSSocket).getCipher().name, /^A(EC)?DH/)
    client.destroy()
  })

  test('no common subtype', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, security: [S.X509Plain] })
    peer.write('RFB 003.008\n')
    await peer.string(12)
    peer.write(u8(1, S.VeNCrypt))
    await peer.u8()
    peer.write(u8(0, 2))
    await peer.read(2)
    peer.write(u8(0), u8(1), u32(263))
    await assert.rejects(
      connecting,
      (err: RfbError) => err.code === 'UNSUPPORTED_SECURITY' && /type 263/.test(err.message),
    )
  })
})

describe('Tight security type', () => {
  const cap = (code: number, vendor: string, signature: string) =>
    Buffer.concat([u32(code), Buffer.from(vendor, 'latin1'), Buffer.from(signature, 'latin1')])

  test('no tunnel, VNC auth, and the interaction capabilities after ServerInit', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, password: 'pw', security: [S.Tight, S.VNC] })
    assert.equal(await offer(peer, S.Tight, S.VNC), S.Tight)
    peer.write(u32(1), cap(0, 'TGHT', 'NOTUNNEL'))
    assert.equal(await peer.u32(), 0)
    peer.write(u32(2), cap(1, 'STDV', 'NOAUTH__'), cap(2, 'STDV', 'VNCAUTH_'))
    assert.equal(await peer.u32(), 2, 'VNC auth, the preferred type')
    const challenge = crypto.randomBytes(16)
    peer.write(challenge)
    assert.deepEqual(await peer.read(16), vncAuthResponse(challenge, 'pw'))
    peer.write(u32(0))
    await peer.u8()
    peer.write(
      serverInit(8, 8, 'tight'),
      u16(1),
      u16(1),
      u16(2),
      u16(0),
      cap(150, 'TGHT', 'CUS_EOCU'),
      cap(150, 'TGHT', 'CUC_ENCU'),
      cap(5, 'STDV', 'HEXTILE_'),
      cap(7, 'TGHT', 'TIGHT___'),
    )
    const client = await connecting
    assert.equal(client.tightCapabilities?.encodings.length, 2)
    assert.equal(client.tightCapabilities?.encodings[1]?.signature, 'TIGHT___')
    assert.equal(client.supports.continuousUpdates, true)
    client.destroy()
  })

  test('a capability list longer than any server sends is refused before it is read', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, security: [S.Tight] })
    assert.equal(await offer(peer, S.Tight), S.Tight)
    peer.write(u32(0x10000000))
    await assert.rejects(
      connecting,
      (err: RfbError) => err.code === 'PROTOCOL_ERROR' && /268435456 Tight capabilities/.test(err.message),
    )
  })

  test('no auth types means None', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, security: [S.Tight] })
    assert.equal(await offer(peer, S.Tight), S.Tight)
    peer.write(u32(0), u32(0), u32(0))
    await peer.u8()
    peer.write(serverInit(8, 8, 'tight'), u16(0), u16(0), u16(0), u16(0))
    ;(await connecting).destroy()
  })
})

describe('Apple Remote Desktop', () => {
  async function ardServer(peer: Peer): Promise<{ username: string; password: string }> {
    const dh = crypto.getDiffieHellman('modp2')
    dh.generateKeys()
    const prime = dh.getPrime()
    const size = prime.length
    const pad = (b: Buffer) => Buffer.concat([Buffer.alloc(size - b.length), b])
    assert.equal(await offer(peer, 35, S.ARD, S.VNC), S.ARD)
    peer.write(u16(2), u16(size), prime, pad(dh.getPublicKey()))
    const encrypted = await peer.read(128)
    const clientPublic = await peer.read(size)
    const aesKey = crypto
      .createHash('md5')
      .update(pad(dh.computeSecret(clientPublic)))
      .digest()
    const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return { username: cstr(plain.subarray(0, 64)), password: cstr(plain.subarray(64)) }
  }

  test('username and password, encrypted with the DH secret', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, username: 'andrey', password: 'a long password ✓' })
    assert.deepEqual(await ardServer(peer), { username: 'andrey', password: 'a long password ✓' })
    await finish(peer)
    const client = await connecting
    assert.equal(client.securityType, S.ARD)
    client.destroy()
  })

  test('a username is required', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, password: 'x', security: [S.ARD] })
    assert.equal(await offer(peer, S.ARD), S.ARD)
    peer.write(u16(2), u16(1), u8(23), u8(5))
    await assert.rejects(connecting, (err: RfbError) => err.code === 'AUTH_REQUIRED' && /username/.test(err.message))
  })
})

describe('MS Logon II', () => {
  test('64-bit DH and DES-CBC credentials', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, username: 'user', password: 'pass', security: [S.MSLogonII] })
    assert.equal(await offer(peer, S.MSLogonII), S.MSLogonII)
    const p = 0xffffffffffffffc5n
    const g = 5n
    const priv = 0x1234567890abcdn
    const pow = (b: bigint, e: bigint) => {
      let r = 1n
      for (b %= p; e > 0n; e >>= 1n, b = (b * b) % p) if (e & 1n) r = (r * b) % p
      return r
    }
    const be8 = (n: bigint) => Buffer.from(n.toString(16).padStart(16, '0'), 'hex')
    peer.write(be8(g), be8(p), be8(pow(g, priv)))
    const clientPublic = BigInt(`0x${(await peer.read(8)).toString('hex')}`)
    const secret = be8(pow(clientPublic, priv))
    const des = new Des(vncKey(secret))
    assert.equal(cstr(des.decryptCbc(await peer.read(256), secret)), 'user')
    assert.equal(cstr(des.decryptCbc(await peer.read(64), secret)), 'pass')
    await finish(peer)
    ;(await connecting).destroy()
  })
})

describe('RSA-AES', () => {
  const unsigned = (b: Buffer) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    return b.subarray(i)
  }
  const fixed = (b: Buffer, size: number) => Buffer.concat([Buffer.alloc(size - unsigned(b).length), unsigned(b)])

  /** The server side of RA2/RA2ne/RA2_256, up to and including SecurityResult. */
  async function rsaAesServer(
    peer: Peer,
    type: number,
    subtype: 1 | 2,
  ): Promise<{ username: string; password: string }> {
    const wide = type === S.RA2_256 || type === S.RA2ne_256
    const hash = wide ? 'sha256' : 'sha1'
    const randomSize = wide ? 32 : 16
    assert.equal(await offer(peer, type), type)
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = publicKey.export({ format: 'jwk' })
    const serverKey = Buffer.concat([
      u32(2048),
      fixed(Buffer.from(jwk.n as string, 'base64url'), 256),
      fixed(Buffer.from(jwk.e as string, 'base64url'), 256),
    ])
    peer.write(serverKey)
    const bits = await peer.u32()
    const size = Math.ceil(bits / 8)
    const clientKeyData = await peer.read(2 * size)
    const clientKey = Buffer.concat([u32(bits), clientKeyData])
    const clientPublic = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: unsigned(clientKeyData.subarray(0, size)).toString('base64url'),
        e: unsigned(clientKeyData.subarray(size)).toString('base64url'),
      },
      format: 'jwk',
    })
    const length = (await peer.read(2)).readUInt16BE(0)
    const block = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_NO_PADDING },
      await peer.read(length),
    )
    const clientRandom = block.subarray(block.indexOf(0, 2) + 1)
    assert.equal(clientRandom.length, randomSize)
    const serverRandom = crypto.randomBytes(randomSize)
    const encrypted = crypto.publicEncrypt(
      { key: clientPublic, padding: crypto.constants.RSA_PKCS1_PADDING },
      serverRandom,
    )
    peer.write(u16(encrypted.length), encrypted)
    const derive = (a: Buffer, b: Buffer) =>
      crypto
        .createHash(hash)
        .update(Buffer.concat([a, b]))
        .digest()
        .subarray(0, randomSize)
    // The server encrypts with ServerSessionKey and decrypts with ClientSessionKey.
    peer.cipher = new RsaAesCipher(derive(clientRandom, serverRandom), derive(serverRandom, clientRandom))
    peer.write(
      crypto
        .createHash(hash)
        .update(Buffer.concat([serverKey, clientKey]))
        .digest(),
    )
    assert.deepEqual(
      await peer.read(wide ? 32 : 20),
      crypto
        .createHash(hash)
        .update(Buffer.concat([clientKey, serverKey]))
        .digest(),
    )
    peer.write(u8(subtype))
    const user = (await peer.read(await peer.u8())).toString()
    const password = (await peer.read(await peer.u8())).toString()
    if (type === S.RA2ne || type === S.RA2ne_256) peer.cipher = null
    peer.write(u32(0))
    return { username: user, password }
  }

  for (const type of [S.RA2, S.RA2ne, S.RA2_256, S.RA2ne_256]) {
    test(`type ${type}: key exchange, credentials and the channel after it`, async () => {
      const { clientStream, peer } = pair()
      const connecting = connect({ stream: clientStream, username: 'u', password: 'p ✓', security: [type] })
      assert.deepEqual(await rsaAesServer(peer, type, 1), { username: 'u', password: 'p ✓' })
      await finish(peer, false)
      const client: RfbClient = await connecting
      assert.equal(client.name, 'secure')
      // Traffic after the handshake: encrypted for RA2 and RA2_256, plain for the "ne" types.
      client.keyEvent(0x41, true)
      const setup = await peer.read(20)
      assert.equal(setup[0], 0, 'SetPixelFormat arrives intact either way')
      client.destroy()
    })
  }

  test('password-only subtype', async () => {
    const { clientStream, peer } = pair()
    const connecting = connect({ stream: clientStream, password: 'only', security: [S.RA2] })
    assert.deepEqual(await rsaAesServer(peer, S.RA2, 2), { username: '', password: 'only' })
    await finish(peer, false)
    ;(await connecting).destroy()
  })
})
